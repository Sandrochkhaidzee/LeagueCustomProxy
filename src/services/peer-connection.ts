import { getIceServers } from '../core/config';
import { getForceTurnRelay } from './privacy';

// Time-based EMA on per-peer volume targets. Damps CV-jitter spikes without
// introducing audible ramp delay on normal updates. Two important properties:
//   • First call (prev == null) snaps to the new value so new peers don't
//     start playing at 1.0 before the proximity pipeline catches up.
//   • Alpha is capped at 0.3 so even a long gap between updates (e.g. a peer
//     re-entering hearing range after going far away) ramps over multiple
//     ticks instead of snapping to a loud value. At ~3 FPS update cadence,
//     the smoother reaches ~95% of target in about a second.
// Exported so tests can verify the math without a real RTCPeerConnection.
export function nextSmoothedVolume(
  prev: number | null,
  target: number,
  nowMs: number,
  lastUpdateMs: number,
): number {
  const clamped = Math.max(0, Math.min(1, target));
  if (prev === null) return clamped;
  const dtSec = (nowMs - lastUpdateMs) / 1000;
  const alpha = Math.min(0.3, 1 - Math.exp(-dtSec / 0.3));
  return prev * (1 - alpha) + clamped * alpha;
}

// Time constant for gain ramping (seconds). setTargetAtTime reaches ~63% in
// timeConstant; ~95% in 3*timeConstant. 50ms = smooth-feeling steps without
// audible lag between volume tick updates.
const VOLUME_RAMP_TC = 0.05;

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
  private dataChannel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  readonly remoteName: string;

  // WebAudio routing for smooth volume ramping. When audioContext is present
  // the audioElement is muted and used only to prime the WebRTC stream in
  // Chromium; real output flows through gainNode → destination.
  private audioContext: AudioContext | null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
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

  onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  onDataMessage: ((data: string) => void) | null = null;
  // Fired when ICE has fully failed. The audio layer is responsible for
  // re-issuing an offer (initiator side only) so we don't restart from both
  // ends and race. Capped retry counter lives here to avoid loops.
  onIceFailed: (() => void) | null = null;
  iceRestartAttempts = 0;
  static readonly MAX_ICE_RESTARTS = 2;

  private constructor(
    remoteName: string,
    iceServers: RTCIceServer[],
    audioContext: AudioContext | null,
    iceTransportPolicy: RTCIceTransportPolicy = 'all',
  ) {
    this.remoteName = remoteName;
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    if (iceTransportPolicy === 'relay') {
      console.log('[WebRTC] Forcing TURN relay for', remoteName, '— no direct P2P candidates will be used');
    }
    this.audioContext = audioContext;

    this.audioElement = new Audio();
    this.audioElement.autoplay = true;
    this.audioElement.srcObject = this.remoteStream;
    // When routing via WebAudio, silence the element via volume=0 rather than
    // muted=true. Chromium can stop decoding *muted* remote streams, which
    // leaves createMediaStreamSource producing silence — using volume=0 keeps
    // the decode pipeline alive while preventing double-playback.
    if (audioContext) {
      this.audioElement.volume = 0;
    }

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
      this.ensureWebAudioRoute();
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

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannel();
    };
  }

  static async create(remoteName: string, audioContext: AudioContext | null = null): Promise<PeerConnection> {
    const iceServers = await getIceServers();
    const policy: RTCIceTransportPolicy = getForceTurnRelay() ? 'relay' : 'all';
    return new PeerConnection(remoteName, iceServers, audioContext, policy);
  }

  private ensureWebAudioRoute(): void {
    if (!this.audioContext || this.sourceNode) return;
    if (this.remoteStream.getAudioTracks().length === 0) return;
    try {
      this.sourceNode = this.audioContext.createMediaStreamSource(this.remoteStream);
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.muted ? 0 : this.targetVolume;
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);
      console.log('[WebRTC] WebAudio route ready for ' + this.remoteName +
        ' (gain=' + this.gainNode.gain.value.toFixed(2) + ')');
    } catch (e) {
      console.warn('[WebRTC] WebAudio routing failed for', this.remoteName, '— falling back to element volume:', e);
      this.sourceNode = null;
      this.gainNode = null;
      // Restore the element as the audible path
      this.audioElement.volume = this.muted ? 0 : this.targetVolume;
      this.audioElement.muted = false;
    }
  }

  private applyGain(value: number): void {
    if (this.gainNode && this.audioContext) {
      this.gainNode.gain.setTargetAtTime(value, this.audioContext.currentTime, VOLUME_RAMP_TC);
    } else {
      // Fallback path — no smoothing available without WebAudio.
      this.audioElement.volume = value;
    }
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

  private setupDataChannel(): void {
    if (!this.dataChannel) return;
    this.dataChannel.onopen = () => {
      console.log('[WebRTC] Data channel OPEN with', this.remoteName);
    };
    this.dataChannel.onclose = () => {
      console.log('[WebRTC] Data channel CLOSED with', this.remoteName);
    };
    this.dataChannel.onmessage = (event) => {
      if (this.onDataMessage) this.onDataMessage(event.data);
    };
    this.dataChannel.onerror = (event) => {
      console.warn('[WebRTC] Data channel error with', this.remoteName, ':', event);
    };
  }

  createDataChannel(): void {
    this.dataChannel = this.pc.createDataChannel('position', { ordered: false, maxRetransmits: 0 });
    this.setupDataChannel();
  }

  sendData(data: string): void {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(data);
    }
  }

  addLocalStream(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  async createOffer(options?: { iceRestart?: boolean }): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer(options);
    offer.sdp = this.enhanceOpusSdp(offer.sdp || '');
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    answer.sdp = this.enhanceOpusSdp(answer.sdp || '');
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Modify SDP to set Opus bitrate to 128kbps and disable DTX.
   * DTX (Discontinuous Transmission) stops sending packets during silence
   * to save bandwidth, but the ramp out of silence-mode at speech onset
   * clips the first packet or two — audible as missing word starts. The
   * bandwidth cost of always-on transmission is trivial for voice.
   */
  private enhanceOpusSdp(sdp: string): string {
    return sdp.replace(
      /a=fmtp:111 (.*)/g,
      (match, params) => {
        let enhanced = params;
        if (!enhanced.includes('maxaveragebitrate')) {
          enhanced += ';maxaveragebitrate=128000';
        }
        // Explicitly disable DTX so word starts/ends aren't clipped.
        if (!enhanced.includes('usedtx')) {
          enhanced += ';usedtx=0';
        }
        return 'a=fmtp:111 ' + enhanced;
      }
    );
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
    if (this.gainNode) {
      this.applyGain(0);
    } else {
      this.audioElement.muted = true;
    }
  }

  unmute(): void {
    this.muted = false;
    if (this.gainNode) {
      this.applyGain(this.targetVolume);
    } else {
      this.audioElement.muted = false;
    }
  }

  close(): void {
    if (this.statsIntervalId !== null) {
      clearInterval(this.statsIntervalId);
      this.statsIntervalId = null;
    }
    this.dataChannel?.close();
    this.remoteStream.getTracks().forEach((t) => t.stop());
    this.pc.close();
    this.audioElement.pause();
    this.audioElement.srcObject = null;
    try {
      this.sourceNode?.disconnect();
      this.gainNode?.disconnect();
    } catch { /* ignore */ }
    this.sourceNode = null;
    this.gainNode = null;
  }

  // Periodic getStats snapshot — selected candidate pair, RTT, bytes flowing.
  // Logged via the standard console.log path which is gated by Debug toggle.
  // Without these, ICE failures are opaque (we only see "failed" with no
  // context about which pair was tried or what the RTT looked like).
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
