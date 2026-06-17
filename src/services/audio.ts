import { PeerConnection } from './peer-connection';
import { SignalingService, SignalMessage } from './signaling';
import { AudioSettings, InputMode } from '../core/types';
import { getStoredInputDeviceId, getStoredOutputDeviceId, getCaptureConstraints } from './devices';
import { loadAudioSettings, saveAudioSettings, savePlayerVolume } from './audio-prefs';
import { AudioWorkletHost } from './audio-worklet/host';
import { SileroVadService } from './audio-worklet/silero-vad';
import { isTransmitIndicatorLive } from './audio-transmit';
import {
  computeFinalPeerVolume,
  resolveProximityTargets,
} from './audio-volume';

const DEFAULT_SETTINGS: AudioSettings = {
  inputMode: 'vad',
  inputVolume: 1.0,
  playerVolumes: {},
  vadSensitivity: 50,
  vadHangoverMs: 300,
  vadEngine: 'energy',
  noiseMode: 'native',
  opusQuality: 'standard',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export type OverlayAudioState = {
  micLevel: number;
  micTransmitting: boolean;
  speakingPeers: Record<string, boolean>;
};

export class AudioService {
  private localStream: MediaStream | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private signaling: SignalingService;
  private localName: string;
  private selfMuted = false;
  private muteAll = false;
  private mutedPlayers: Set<string> = new Set();
  private lastAppliedVolume: Map<string, string> = new Map();
  private lastProximityVolumes: Map<string, number> = new Map();
  private silenceStreak: Map<string, number> = new Map();
  private lastVolumeLogLine = '';
  private lastVolumeLogMs = 0;
  private settings: AudioSettings = { ...DEFAULT_SETTINGS, ...loadAudioSettings() };

  private audioContext: AudioContext | null = null;
  private workletHost: AudioWorkletHost | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private outputStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;

  private connectingPeers: Set<string> = new Set();
  private pendingSignals: Map<string, SignalMessage[]> = new Map();

  private pttHeld = false;
  private speechActive = false;
  private sileroVad: SileroVadService | null = null;
  private sileroFailed = false;

  private micLevel = 0;
  private lastMicLogMs = 0;
  private remoteSpeaking: Map<string, boolean> = new Map();
  private overlayAudioCallback: ((state: OverlayAudioState) => void) | null = null;

  constructor(signaling: SignalingService, localName: string) {
    this.signaling = signaling;
    this.localName = localName;
    PeerConnection.setGlobalOpusQuality(this.settings.opusQuality, this.settings.inputMode);
  }

  setOverlayAudioCallback(cb: ((state: OverlayAudioState) => void) | null): void {
    this.overlayAudioCallback = cb;
    this.emitOverlayAudioState();
  }

  private emitOverlayAudioState(): void {
    if (!this.overlayAudioCallback) return;
    this.overlayAudioCallback(this.getOverlaySnapshot());
  }

  /** Current mic meter / transmit state for overlay (no stale cache). */
  getOverlaySnapshot(): OverlayAudioState {
    const speakingPeers: Record<string, boolean> = {};
    for (const [name, speaking] of this.remoteSpeaking) {
      if (speaking) speakingPeers[name] = true;
    }
    return {
      micLevel: this.micLevel,
      micTransmitting: this.isTransmitIndicatorLive(),
      speakingPeers,
    };
  }

  getInputMode(): InputMode {
    return this.settings.inputMode;
  }

/** Header LIVE/IDLE — voice activity for VAD; key held for PTT. */
  private isTransmitIndicatorLive(): boolean {
    return isTransmitIndicatorLive(
      this.settings.inputMode,
      this.selfMuted,
      this.speechActive,
      this.pttHeld,
    );
  }

  /** Energy VAD in the worklet when VAD mode uses the energy engine (or Silero failed). */
  private shouldUseEnergyVad(): boolean {
    if (this.settings.inputMode !== 'vad') return false;
    return this.settings.vadEngine === 'energy' || this.sileroFailed;
  }

  async initMicrophone(): Promise<void> {
    this.localStream = await this.acquireMicStream();

    this.audioContext = new AudioContext();
    await this.resumePipeline();

    this.micSource = this.audioContext.createMediaStreamSource(this.localStream);
    this.destination = this.audioContext.createMediaStreamDestination();
    this.workletHost = new AudioWorkletHost();

    await this.workletHost.connect(
      this.audioContext,
      this.micSource,
      this.destination,
      this.workletCallbacks(),
    );

    this.applyWorkletConfig();
    await this.setupSileroIfNeeded();

    this.outputStream = this.destination.stream;
    this.updateLocalTrackState();

    const nsLabel = this.settings.noiseMode === 'rnnoise' ? 'RNNoise worklet' : 'native browser NS';
    console.log('[Audio] Mic pipeline ready (' + nsLabel + '), context=' + this.audioContext.state);
  }

  /** WebView audio stays suspended until the user interacts with the overlay. */
  isPipelineSuspended(): boolean {
    return this.audioContext?.state === 'suspended';
  }

  async resumePipeline(): Promise<boolean> {
    if (!this.audioContext) return false;
    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        console.log('[Audio] AudioContext resumed →', this.audioContext.state);
      } catch (e) {
        console.warn('[Audio] AudioContext resume failed:', e);
        return false;
      }
    }
    await this.applyStoredOutputDevice();
    this.emitOverlayAudioState();
    return this.audioContext.state === 'running';
  }

  private workletCallbacks() {
    return {
      onLevel: (rms: number) => this.onWorkletLevel(rms),
      onSpeechChange: (active: boolean) => this.onEnergySpeechChange(active),
      onSileroChunk: (chunk: Float32Array) => this.sileroVad?.feedSamples(chunk),
    };
  }

  private applyWorkletConfig(): void {
    const wantsVoiceDetect = this.settings.inputMode === 'vad';
    const energyVad = this.shouldUseEnergyVad();
    const sileroActive = this.settings.inputMode === 'vad'
      && this.settings.vadEngine === 'silero'
      && !this.sileroFailed
      && this.sileroVad !== null;
    this.workletHost?.setConfig({
      gain: this.settings.inputVolume,
      vadEnabled: wantsVoiceDetect && energyVad,
      vadSensitivity: this.settings.vadSensitivity,
      vadHangoverMs: this.settings.vadHangoverMs,
      rnnoiseEnabled: this.settings.noiseMode === 'rnnoise',
      sileroFeed: sileroActive,
    });
  }

  private async setupSileroIfNeeded(): Promise<void> {
    this.sileroVad?.stop();
    this.sileroVad = null;
    if (this.settings.inputMode !== 'vad' || this.settings.vadEngine !== 'silero' || this.sileroFailed) {
      return;
    }
    this.sileroVad = new SileroVadService();
    const ok = await this.sileroVad.start(
      { onSpeechChange: (active) => this.onSileroSpeechChange(active) },
      this.settings.vadSensitivity,
    );
    if (!ok) {
      this.sileroFailed = true;
      this.sileroVad = null;
      this.applyWorkletConfig();
    } else {
      this.applyWorkletConfig();
    }
  }

  private onWorkletLevel(rms: number): void {
    this.micLevel = Math.min(1, rms * 8);
    const now = performance.now();
    if (now - this.lastMicLogMs >= 2000) {
      this.lastMicLogMs = now;
      console.log(
        '[Audio] mic=' + rms.toFixed(3) +
        ' transmit=' + this.isTransmitting() +
        ' inputMode=' + this.settings.inputMode +
        ' selfMuted=' + this.selfMuted,
      );
    }
    this.emitOverlayAudioState();
  }

  private onEnergySpeechChange(active: boolean): void {
    if (this.settings.inputMode === 'vad'
      && this.settings.vadEngine === 'silero'
      && !this.sileroFailed) {
      return;
    }
    if (this.settings.inputMode !== 'vad') {
      return;
    }
    this.setSpeechActive(active);
  }

  private onSileroSpeechChange(active: boolean): void {
    if (this.settings.vadEngine !== 'silero' || this.sileroFailed) return;
    this.workletHost?.reportExternalSpeech(active);
    this.setSpeechActive(active);
  }

  private setSpeechActive(active: boolean): void {
    if (this.speechActive === active) return;
    this.speechActive = active;
    this.updateLocalTrackState();
    this.emitOverlayAudioState();
  }

  private clearSpeechIndicator(): void {
    this.workletHost?.syncSpeechDebounced(false);
    if (!this.speechActive) {
      this.emitOverlayAudioState();
      return;
    }
    this.speechActive = false;
    this.updateLocalTrackState();
  }

  /** Feed Silero from worklet audio chunks. */
  feedSileroSamples(samples: Float32Array): void {
    this.sileroVad?.feedSamples(samples, this.audioContext?.sampleRate ?? 48000);
  }

  private isTransmitting(): boolean {
    if (this.selfMuted) return false;
    if (this.settings.inputMode === 'ptt') return this.pttHeld;
    if (this.settings.inputMode === 'vad') return this.speechActive;
    return false;
  }

  setPTTState(held: boolean): void {
    console.log('[Audio] setPTTState(' + held + '), inputMode=' + this.settings.inputMode);
    this.pttHeld = held;
    this.updateLocalTrackState();
  }

  private lastTrackEnabled: boolean | null = null;
  private updateLocalTrackState(): void {
    if (this.outputStream) {
      const enabled = !this.selfMuted && this.isTransmitting();
      for (const track of this.outputStream.getAudioTracks()) {
        track.enabled = enabled;
      }
      if (enabled !== this.lastTrackEnabled) {
        this.lastTrackEnabled = enabled;
        let reason = 'off';
        if (this.selfMuted) reason = 'selfMuted';
        else if (this.settings.inputMode === 'ptt') reason = 'ptt=' + this.pttHeld;
        else if (this.settings.inputMode === 'vad') reason = 'vad=' + this.speechActive;
        console.log('[Audio] Local mic transmit → ' + enabled + ' (' + reason + ')');
      }
    }
    this.emitOverlayAudioState();
  }

  async connectToPeer(remoteName: string, isInitiator?: boolean): Promise<void> {
    if (this.peers.has(remoteName) || this.connectingPeers.has(remoteName)) return;
    this.connectingPeers.add(remoteName);

    console.log('[Audio] Connecting to peer:', remoteName);
    let peer: PeerConnection;
    try {
      peer = await PeerConnection.create(remoteName);
      void peer.setOutputDevice(getStoredOutputDeviceId());
    } catch (e) {
      this.connectingPeers.delete(remoteName);
      throw e;
    }
    this.peers.set(remoteName, peer);
    this.connectingPeers.delete(remoteName);

    if (this.outputStream) {
      peer.addLocalStream(this.outputStream);
    }

    if (this.audioContext) {
      peer.startSpeakingMonitor(this.audioContext, (speaking) => {
        this.remoteSpeaking.set(remoteName, speaking);
        this.emitOverlayAudioState();
      });
    }

    peer.onIceCandidate = (candidate) => {
      this.signaling.sendSignal({
        type: 'ice-candidate',
        from: this.localName,
        to: remoteName,
        payload: candidate.toJSON(),
      });
    };

    const shouldInitiate = isInitiator ?? (this.localName < remoteName);

    if (shouldInitiate) {
      peer.onIceFailed = () => {
        peer.createOffer({ iceRestart: true })
          .then((offer) => {
            console.log('[Audio] Sending ICE-restart offer to:', remoteName);
            this.signaling.sendSignal({
              type: 'offer',
              from: this.localName,
              to: remoteName,
              payload: offer,
            });
          })
          .catch((e) => console.warn('[Audio] ICE-restart offer failed for', remoteName, e));
      };
    }

    if (shouldInitiate) {
      console.log('[Audio] Creating offer (initiator) to:', remoteName);
      try {
        const offer = await peer.createOffer();
        this.signaling.sendSignal({
          type: 'offer',
          from: this.localName,
          to: remoteName,
          payload: offer,
        });
      } catch (e) {
        console.error('[Audio] Failed to create offer for:', remoteName, e);
        this.peers.delete(remoteName);
        peer.close();
      }
    }

    const pending = this.pendingSignals.get(remoteName);
    if (pending) {
      this.pendingSignals.delete(remoteName);
      for (const sig of pending) {
        this.handleSignal(sig).catch(e =>
          console.error('[Audio] Failed to replay buffered signal:', sig.type, e));
      }
    }
  }

  async handleSignal(signal: SignalMessage): Promise<void> {
    console.log('[Audio] Received signal:', signal.type, 'from:', signal.from);
    try {
      let peer = this.peers.get(signal.from);

      if (signal.type === 'offer') {
        if (!peer) {
          console.log('[Audio] Peer created via incoming offer: ' + signal.from);
          peer = await PeerConnection.create(signal.from);
          void peer.setOutputDevice(getStoredOutputDeviceId());
          this.peers.set(signal.from, peer);
          if (this.outputStream) peer.addLocalStream(this.outputStream);
          if (this.audioContext) {
            peer.startSpeakingMonitor(this.audioContext, (speaking) => {
              this.remoteSpeaking.set(signal.from, speaking);
              this.emitOverlayAudioState();
            });
          }

          peer.onIceCandidate = (candidate) => {
            this.signaling.sendSignal({
              type: 'ice-candidate',
              from: this.localName,
              to: signal.from,
              payload: candidate.toJSON(),
            });
          };
        }
        const answer = await peer.handleOffer(signal.payload);
        this.signaling.sendSignal({
          type: 'answer',
          from: this.localName,
          to: signal.from,
          payload: answer,
        });
      } else if (signal.type === 'answer' && peer) {
        await peer.handleAnswer(signal.payload);
      } else if (signal.type === 'ice-candidate' && peer) {
        await peer.addIceCandidate(signal.payload);
      } else if (!peer && (signal.type === 'answer' || signal.type === 'ice-candidate')) {
        let pending = this.pendingSignals.get(signal.from);
        if (!pending) {
          pending = [];
          this.pendingSignals.set(signal.from, pending);
        }
        pending.push(signal);
      }
    } catch (e) {
      console.error('[Audio] Signal handling failed:', signal.type, 'from:', signal.from, e);
    }
  }

  disconnectPeer(remoteName: string): void {
    const peer = this.peers.get(remoteName);
    if (peer) {
      peer.close();
      this.peers.delete(remoteName);
    }
    this.remoteSpeaking.delete(remoteName);
    this.silenceStreak.delete(remoteName);
    this.emitOverlayAudioState();
  }

  applyPeerVolumes(volumes: Record<string, number>): void {
    const entries = Object.entries(volumes);
    const summary = entries.length
      ? entries.map(([n, v]) => `${n}=${v.toFixed(2)}`).join(' ')
      : '(none)';
    const skipped = entries.filter(([n]) => !this.peers.has(n)).map(([n]) => n);
    const skippedTag = skipped.length ? `(skipped no-peer: ${skipped.join(',')})` : '';
    const fullLine = summary + (skippedTag ? ' ' + skippedTag : '');
    const now = performance.now();
    if (fullLine !== this.lastVolumeLogLine || now - this.lastVolumeLogMs >= 1000) {
      console.log('[Audio] applyPeerVolumes:', fullLine);
      this.lastVolumeLogLine = fullLine;
      this.lastVolumeLogMs = now;
    }

    const raw = resolveProximityTargets(volumes, this.peers.keys());
    const targets = new Map<string, number>();
    for (const [name, volume] of raw) {
      if (volume > 0) {
        this.silenceStreak.set(name, 0);
        targets.set(name, volume);
      } else {
        const streak = (this.silenceStreak.get(name) ?? 0) + 1;
        this.silenceStreak.set(name, streak);
        if (streak >= 2) {
          targets.set(name, 0);
        } else {
          targets.set(name, this.lastProximityVolumes.get(name) ?? 0);
        }
      }
    }

    for (const [name, volume] of targets) {
      this.lastProximityVolumes.set(name, volume);

      const peer = this.peers.get(name);
      if (!peer) continue;
      const playerVolume = this.settings.playerVolumes[name] ?? 1.0;
      const finalVol = computeFinalPeerVolume(volume, playerVolume);
      const wasState = this.lastAppliedVolume.get(name);
      peer.setVolume(finalVol);
      const muteNow = this.muteAll || this.mutedPlayers.has(name);
      if (muteNow) {
        peer.mute();
      } else {
        peer.unmute();
      }
      const stateNow = muteNow ? 'silent' : finalVol.toFixed(2);
      if (wasState !== stateNow) {
        console.log('[Audio] peer ' + name + ' → ' + stateNow +
          (wasState !== undefined ? ' (was ' + wasState + ')' : ''));
        this.lastAppliedVolume.set(name, stateNow);
      }
    }
  }

  toggleSelfMute(): boolean {
    this.setSelfMuted(!this.selfMuted);
    return this.selfMuted;
  }

  setSelfMuted(value: boolean): void {
    if (this.selfMuted === value) return;
    this.selfMuted = value;
    this.updateLocalTrackState();
  }

  toggleMuteAll(): boolean {
    this.setMuteAll(!this.muteAll);
    return this.muteAll;
  }

  setMuteAll(value: boolean): void {
    if (this.muteAll === value) return;
    this.muteAll = value;
    for (const [name, peer] of this.peers) {
      if (this.muteAll || this.mutedPlayers.has(name)) {
        peer.mute();
      } else {
        peer.unmute();
      }
    }
  }

  toggleMutePlayer(name: string): boolean {
    if (this.mutedPlayers.has(name)) {
      this.mutedPlayers.delete(name);
    } else {
      this.mutedPlayers.add(name);
    }
    const peer = this.peers.get(name);
    if (peer) {
      if (this.mutedPlayers.has(name)) {
        peer.mute();
      } else {
        peer.unmute();
      }
    }
    return this.mutedPlayers.has(name);
  }

  setPlayerVolume(name: string, volume: number): void {
    this.settings.playerVolumes[name] = Math.max(0, Math.min(1, volume));
    savePlayerVolume(name, this.settings.playerVolumes[name]);
    const peer = this.peers.get(name);
    if (peer) {
      const proximityVol = this.lastProximityVolumes.get(name) ?? 0;
      peer.setVolume(computeFinalPeerVolume(proximityVol, this.settings.playerVolumes[name]));
    }
  }

  isSelfMuted(): boolean { return this.selfMuted; }
  isMuteAll(): boolean { return this.muteAll; }
  isPlayerMuted(name: string): boolean { return this.mutedPlayers.has(name); }

  getPeer(name: string): PeerConnection | undefined {
    return this.peers.get(name);
  }

  hasPeer(name: string): boolean {
    return this.peers.has(name);
  }

  updateSettings(settings: Partial<AudioSettings>): void {
    const prev = { ...this.settings };
    Object.assign(this.settings, settings);
    saveAudioSettings(settings);

    const dspChanged = prev.echoCancellation !== this.settings.echoCancellation
      || prev.noiseSuppression !== this.settings.noiseSuppression
      || prev.autoGainControl !== this.settings.autoGainControl
      || prev.noiseMode !== this.settings.noiseMode;

    const opusChanged = prev.opusQuality !== this.settings.opusQuality
      || prev.inputMode !== this.settings.inputMode;

    if (opusChanged) {
      PeerConnection.setGlobalOpusQuality(this.settings.opusQuality, this.settings.inputMode);
    }

    this.applyWorkletConfig();

    if (prev.vadEngine !== this.settings.vadEngine
      || prev.inputMode !== this.settings.inputMode) {
      void this.setupSileroIfNeeded();
    }

    if (dspChanged && this.audioContext) {
      void this.reacquireMic();
    } else {
      this.workletHost?.setGain(this.settings.inputVolume);
    }

    if (prev.inputMode !== this.settings.inputMode
      && (prev.inputMode === 'vad') !== (this.settings.inputMode === 'vad')) {
      this.clearSpeechIndicator();
    }

    this.updateLocalTrackState();
  }

  private async acquireMicStream(): Promise<MediaStream> {
    const inputId = getStoredInputDeviceId();
    const constraints = getCaptureConstraints(this.settings);
    if (inputId) constraints.deviceId = { exact: inputId };
    return navigator.mediaDevices.getUserMedia({ audio: constraints });
  }

  private async reacquireMic(): Promise<void> {
    if (!this.audioContext || !this.destination) return;
    try {
      const newStream = await this.acquireMicStream();
      this.micSource?.disconnect();
      this.localStream?.getTracks().forEach((t) => t.stop());
      this.localStream = newStream;
      this.micSource = this.audioContext.createMediaStreamSource(newStream);
      await this.workletHost?.connect(
        this.audioContext,
        this.micSource,
        this.destination,
        this.workletCallbacks(),
      );
      this.applyWorkletConfig();
      this.updateLocalTrackState();
      console.log('[Audio] Mic re-acquired with updated DSP settings');
    } catch (e) {
      console.warn('[Audio] reacquireMic failed:', e);
    }
  }

  private async applyStoredOutputDevice(): Promise<void> {
    const outputId = getStoredOutputDeviceId();
    if (!outputId) return;
    for (const peer of this.peers.values()) {
      await peer.setOutputDevice(outputId);
    }
    console.log('[Audio] Output device applied to', this.peers.size, 'peer(s):', outputId);
  }

  async applyInputDevice(_id: string | null): Promise<void> {
    if (!this.audioContext || !this.destination) {
      console.log('[Audio] applyInputDevice: not initialized yet, will pick up on next session');
      return;
    }
    try {
      const newStream = await this.acquireMicStream();
      this.micSource?.disconnect();
      this.localStream?.getTracks().forEach((t) => t.stop());
      this.localStream = newStream;
      this.micSource = this.audioContext.createMediaStreamSource(newStream);
      await this.workletHost?.connect(
        this.audioContext,
        this.micSource,
        this.destination,
        this.workletCallbacks(),
      );
      this.applyWorkletConfig();
      this.updateLocalTrackState();
      console.log('[Audio] Input device switched');
    } catch (e) {
      console.warn('[Audio] applyInputDevice failed:', e);
    }
  }

  async applyOutputDevice(_id: string | null): Promise<void> {
    if (!this.audioContext) {
      console.log('[Audio] applyOutputDevice: not initialized yet, will pick up on next session');
      return;
    }
    await this.applyStoredOutputDevice();
  }

  cleanup(): void {
    this.sileroVad?.stop();
    this.sileroVad = null;
    this.workletHost?.destroy();
    this.workletHost = null;
    for (const [, peer] of this.peers) {
      peer.close();
    }
    this.peers.clear();
    this.outputStream?.getTracks().forEach((t) => t.stop());
    this.outputStream = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.audioContext?.close();
    this.audioContext = null;
  }
}
