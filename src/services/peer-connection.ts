import { getIceServers } from '../core/config';
import { getForceTurnRelay } from './privacy';
import type { InputMode, OpusQuality } from '../core/types';
import { OPUS_BITRATES } from './audio-prefs';
import { nextSmoothedVolume } from './volume-slew';

export { nextSmoothedVolume } from './volume-slew';

/** Find Opus payload type from SDP (avoids hardcoding fmtp:111). */
export function findOpusPayloadType(sdp: string): number | null {
  const lines = sdp.split('\r\n');
  let opusPt: string | null = null;
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+) opus\/48000/);
    if (m) opusPt = m[1];
  }
  return opusPt !== null ? parseInt(opusPt, 10) : null;
}

export interface OpusSdpOptions {
  bitrate: number;
  usedtx: boolean;
}

export function enhanceOpusSdp(sdp: string, options: OpusSdpOptions): string {
  const pt = findOpusPayloadType(sdp);
  if (pt === null) return sdp;
  const re = new RegExp(`a=fmtp:${pt} (.*)`, 'g');
  return sdp.replace(re, (_match, params: string) => {
    let enhanced = params;
    if (!enhanced.includes('maxaveragebitrate')) {
      enhanced += `;maxaveragebitrate=${options.bitrate}`;
    } else {
      enhanced = enhanced.replace(/maxaveragebitrate=\d+/, `maxaveragebitrate=${options.bitrate}`);
    }
    const dtxVal = options.usedtx ? '1' : '0';
    if (!enhanced.includes('usedtx')) {
      enhanced += `;usedtx=${dtxVal}`;
    } else {
      enhanced = enhanced.replace(/usedtx=[01]/, `usedtx=${dtxVal}`);
    }
    return `a=fmtp:${pt} ${enhanced}`;
  });
}

export function shouldUseDtx(inputMode: InputMode): boolean {
  return inputMode === 'ptt' || inputMode === 'vad';
}


/**
 * Render an ICE candidate as `type addr:port proto` for diagnostic logs.
 * Parses the SDP "candidate:..." line because not every browser exposes the
 * convenience getters (.address, .type, etc.) on RTCIceCandidate.
 */
function describeCandidate(c: RTCIceCandidateInit | null): string {
  if (!c) return 'end-of-candidates';
  const cand = c.candidate || '';
  if (!cand) return 'end-of-candidates';
  const parts = cand.split(' ');
  // Format: "candidate:foundation component proto priority addr port typ TYPE ..."
  const proto = parts[2] || '?';
  const addr = parts[4] || '?';
  const port = parts[5] || '?';
  const typeIdx = parts.indexOf('typ');
  const type = typeIdx > 0 ? parts[typeIdx + 1] : '?';
  return `${type} ${addr}:${port} ${proto.toLowerCase()}`;
}

export class PeerConnection {
  private pc: RTCPeerConnection;
  private remoteStream: MediaStream = new MediaStream();
  private audioElement: HTMLAudioElement;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  readonly remoteName: string;

  // Playback is element-only: the remote stream plays through `audioElement`,
  // whose .volume carries the proximity gain. An earlier parallel WebAudio
  // gain-node path was removed — the muted element wasn't reliably silent in
  // WebView2, so both played at once, causing echo/double + a muddied level
  // (issues #19 / #21).
  // Default to silent. Volume is supposed to come from the proximity pipeline
  // (applyPeerVolumes → setVolume). If a peer connects before that pipeline
  // has produced a value for them (e.g. during tracking SCANNING state where
  // only allies get a volume), defaulting to 1.0 would play them at full
  // volume regardless of in-game distance — exactly the "hear across the
  // map at startup" bug reported on #6 / #7.
  private targetVolume = 0;
  private muted = false;
  // Outer-loop EMA on volume targets so brief CV tracking glitches don't
  // produce audible dropouts. null = first call (snap to value, no smoothing).
  private smoothedVolume: number | null = null;
  private lastSetVolumeMs = 0;
  private opusBitrate = OPUS_BITRATES.standard;
  private inputMode: InputMode = 'vad';

  static setGlobalOpusQuality(quality: OpusQuality, inputMode: InputMode): void {
    PeerConnection.globalOpusQuality = quality;
    PeerConnection.globalInputMode = inputMode;
  }

  private static globalOpusQuality: OpusQuality = 'standard';
  private static globalInputMode: InputMode = 'vad';

  onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  // Fired when ICE has fully failed. The audio layer is responsible for
  // re-issuing an offer (initiator side only) so we don't restart from both
  // ends and race. Capped retry counter lives here to avoid loops.
  onIceFailed: (() => void) | null = null;
  iceRestartAttempts = 0;
  static readonly MAX_ICE_RESTARTS = 2;

  private constructor(
    remoteName: string,
    iceServers: RTCIceServer[],
    iceTransportPolicy: RTCIceTransportPolicy = 'all',
  ) {
    this.remoteName = remoteName;
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    if (iceTransportPolicy === 'relay') {
      console.log('[WebRTC] Forcing TURN relay for', remoteName, '— no direct P2P candidates will be used');
    }
    this.audioElement = new Audio();
    this.audioElement.autoplay = true;
    this.audioElement.srcObject = this.remoteStream;
    // Start silent; the proximity pipeline (applyPeerVolumes → setVolume) sets
    // the real gain. The element is the sole audible path (see field comment).
    this.audioElement.volume = 0;

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        console.log('[WebRTC] Local ICE → ' + remoteName + ':', describeCandidate(event.candidate.toJSON()));
        this.onIceCandidate(event.candidate);
      } else if (!event.candidate) {
        console.log('[WebRTC] Local ICE gathering complete for ' + remoteName);
      }
    };

    this.pc.ontrack = (event) => {
      console.log('[WebRTC] Got remote track from', remoteName, 'kind:', event.track.kind);
      this.remoteStream.addTrack(event.track);
      // Ensure audio plays (autoplay may be blocked by Chromium policy)
      this.tryPlay();
    };

    this.pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state with', remoteName, ':', this.pc.connectionState);
      if (this.pc.connectionState === 'connected') {
        // Successful (re)connect — reset the restart budget for any future failure.
        this.iceRestartAttempts = 0;
      }
      if (this.pc.connectionState === 'failed' &&
          this.iceRestartAttempts < PeerConnection.MAX_ICE_RESTARTS) {
        this.iceRestartAttempts++;
        console.warn('[WebRTC] Connection failed with', remoteName,
          '— triggering ICE restart attempt', this.iceRestartAttempts);
        this.onIceFailed?.();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state with', remoteName, ':', this.pc.iceConnectionState);
    };

    this.startStatsLogging();
  }

  static async create(remoteName: string): Promise<PeerConnection> {
    const iceServers = await getIceServers();
    const policy: RTCIceTransportPolicy = getForceTurnRelay() ? 'relay' : 'all';
    const pc = new PeerConnection(remoteName, iceServers, policy);
    pc.opusBitrate = OPUS_BITRATES[PeerConnection.globalOpusQuality];
    pc.inputMode = PeerConnection.globalInputMode;
    return pc;
  }

  /** Route this peer's audio to the chosen output device via the element sink. */
  async setOutputDevice(deviceId: string | null): Promise<void> {
    const el = this.audioElement as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (!deviceId || typeof el.setSinkId !== 'function') return;
    try {
      await el.setSinkId(deviceId);
    } catch (e) {
      console.warn('[WebRTC] setSinkId failed for ' + this.remoteName + ':', e);
    }
  }

  private applyGain(value: number): void {
    // Element-only playback. Per-tick EMA smoothing (setVolume) keeps the steps
    // small enough to be click-free without WebAudio ramping.
    this.audioElement.volume = Math.max(0, Math.min(1, value));
  }

  private tryPlay(): void {
    this.audioElement.play().catch((err) => {
      // Autoplay blocked by browser policy — retry on next user gesture.
      // Log explicitly so a user reporting "voice doesn't work" with Debug on
      // can be told to click anywhere in the overlay to unblock playback.
      console.warn('[WebRTC] Autoplay blocked for', this.remoteName,
        '— will retry on next user gesture:', err?.name || err);
      const resume = () => {
        this.audioElement.play().catch((retryErr) => {
          console.warn('[WebRTC] Autoplay retry still blocked for', this.remoteName, ':',
            retryErr?.name || retryErr);
        });
        document.removeEventListener('click', resume);
        document.removeEventListener('keydown', resume);
      };
      document.addEventListener('click', resume, { once: true });
      document.addEventListener('keydown', resume, { once: true });
    });
  }

  addLocalStream(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  async createOffer(options?: { iceRestart?: boolean }): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer(options);
    offer.sdp = this.enhanceOpusSdpLocal(offer.sdp || '');
    await this.pc.setLocalDescription(offer);
    await this.applySenderBitrate();
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    answer.sdp = this.enhanceOpusSdpLocal(answer.sdp || '');
    await this.pc.setLocalDescription(answer);
    await this.applySenderBitrate();
    return answer;
  }

  private enhanceOpusSdpLocal(sdp: string): string {
    return enhanceOpusSdp(sdp, {
      bitrate: this.opusBitrate,
      usedtx: shouldUseDtx(this.inputMode),
    });
  }

  private async applySenderBitrate(): Promise<void> {
    try {
      const senders = this.pc.getSenders().filter((s) => s.track?.kind === 'audio');
      for (const sender of senders) {
        const params = sender.getParameters();
        if (!params.encodings?.length) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = this.opusBitrate;
        await sender.setParameters(params);
      }
    } catch (e) {
      console.warn('[WebRTC] setParameters maxBitrate failed for', this.remoteName, e);
    }
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    console.log('[WebRTC] Remote ICE ← ' + this.remoteName + ':', describeCandidate(candidate));
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  private async flushPendingCandidates(): Promise<void> {
    for (const c of this.pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(c));
    }
    this.pendingCandidates = [];
  }

  setVolume(volume: number): void {
    const now = performance.now();
    this.smoothedVolume = nextSmoothedVolume(this.smoothedVolume, volume, now, this.lastSetVolumeMs);
    this.lastSetVolumeMs = now;
    this.targetVolume = this.smoothedVolume;
    if (!this.muted) this.applyGain(this.smoothedVolume);
  }

  mute(): void {
    this.muted = true;
    this.audioElement.muted = true;
  }

  unmute(): void {
    this.muted = false;
    this.audioElement.muted = false;
    this.applyGain(this.targetVolume);
  }

  close(): void {
    if (this.statsIntervalId !== null) {
      clearInterval(this.statsIntervalId);
      this.statsIntervalId = null;
    }
    if (this.speakingMonitorId !== null) {
      clearInterval(this.speakingMonitorId);
      this.speakingMonitorId = null;
    }
    this.speakingAnalyser?.disconnect();
    this.speakingAnalyser = null;
    this.remoteStream.getTracks().forEach((t) => t.stop());
    this.pc.close();
    this.audioElement.pause();
    this.audioElement.srcObject = null;
  }

  private speakingAnalyser: AnalyserNode | null = null;
  private speakingMonitorId: number | null = null;
  private speaking = false;
  private static readonly SPEAKING_RMS = 0.012;

  /** UI-only remote voice activity indicator (~10 Hz). */
  startSpeakingMonitor(
    context: AudioContext,
    onChange: (speaking: boolean) => void,
  ): void {
    if (this.speakingMonitorId !== null) return;
    try {
      const source = context.createMediaStreamSource(this.remoteStream);
      this.speakingAnalyser = context.createAnalyser();
      this.speakingAnalyser.fftSize = 512;
      source.connect(this.speakingAnalyser);
      const buf = new Float32Array(this.speakingAnalyser.fftSize);
      this.speakingMonitorId = window.setInterval(() => {
        if (!this.speakingAnalyser) return;
        this.speakingAnalyser.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
        const rms = Math.sqrt(sumSq / buf.length);
        const nowSpeaking = rms >= PeerConnection.SPEAKING_RMS;
        if (nowSpeaking !== this.speaking) {
          this.speaking = nowSpeaking;
          onChange(nowSpeaking);
        }
      }, 100) as unknown as number;
    } catch (e) {
      console.warn('[WebRTC] speaking monitor failed for', this.remoteName, e);
    }
  }

  private statsIntervalId: number | null = null;
  private startStatsLogging(): void {
    this.statsIntervalId = window.setInterval(() => {
      this.logStatsSnapshot().catch(() => { /* non-fatal */ });
    }, 10_000) as unknown as number;
  }

  private async logStatsSnapshot(): Promise<void> {
    const stats = await this.pc.getStats();
    let pair: any = null;
    let outAudio: any = null;
    let inAudio: any = null;
    const byId = new Map<string, any>();
    stats.forEach((r: any) => {
      byId.set(r.id, r);
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      if (r.type === 'outbound-rtp' && r.kind === 'audio') outAudio = r;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') inAudio = r;
    });
    const parts: string[] = [
      'conn=' + this.pc.connectionState,
      'ice=' + this.pc.iceConnectionState,
    ];
    if (pair) {
      const local = byId.get(pair.localCandidateId);
      const remote = byId.get(pair.remoteCandidateId);
      const fmt = (c: any) => c ? `${c.candidateType}:${c.address || c.ip || '?'}:${c.port || '?'}/${c.protocol || '?'}` : '?';
      parts.push('pair=' + fmt(local) + '<->' + fmt(remote));
      if (typeof pair.currentRoundTripTime === 'number') {
        parts.push('rtt=' + Math.round(pair.currentRoundTripTime * 1000) + 'ms');
      }
    } else {
      parts.push('pair=none');
    }
    if (outAudio) parts.push('outBytes=' + outAudio.bytesSent);
    if (inAudio) parts.push('inBytes=' + inAudio.bytesReceived);
    if (inAudio && typeof inAudio.packetsLost === 'number') parts.push('lost=' + inAudio.packetsLost);
    console.log('[WebRTC stats]', this.remoteName, parts.join(' '));
  }
}
