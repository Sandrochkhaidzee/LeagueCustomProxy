import { getIceServers } from '../core/config';

// Time constant for gain ramping (seconds). setTargetAtTime reaches ~63% in
// timeConstant; ~95% in 3*timeConstant. 50ms = smooth-feeling steps without
// audible lag between volume tick updates.
const VOLUME_RAMP_TC = 0.05;

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
  private targetVolume = 1;
  private muted = false;

  onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  onDataMessage: ((data: string) => void) | null = null;

  private constructor(remoteName: string, iceServers: RTCIceServer[], audioContext: AudioContext | null) {
    this.remoteName = remoteName;
    this.pc = new RTCPeerConnection({ iceServers });
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
        this.onIceCandidate(event.candidate);
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
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state with', remoteName, ':', this.pc.iceConnectionState);
    };

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannel();
    };
  }

  static async create(remoteName: string, audioContext: AudioContext | null = null): Promise<PeerConnection> {
    const iceServers = await getIceServers();
    return new PeerConnection(remoteName, iceServers, audioContext);
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
    this.audioElement.play().catch(() => {
      // Autoplay blocked — retry on next user gesture (click/keydown)
      const resume = () => {
        this.audioElement.play().catch(() => {});
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

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
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
   * Modify SDP to set Opus bitrate to 128kbps and enable DTX.
   * DTX (Discontinuous Transmission) stops sending packets during silence,
   * saving bandwidth without affecting audio quality.
   */
  private enhanceOpusSdp(sdp: string): string {
    return sdp.replace(
      /a=fmtp:111 (.*)/g,
      (match, params) => {
        let enhanced = params;
        // Set max bitrate to 128kbps
        if (!enhanced.includes('maxaveragebitrate')) {
          enhanced += ';maxaveragebitrate=128000';
        }
        // Enable DTX (silence suppression)
        if (!enhanced.includes('usedtx')) {
          enhanced += ';usedtx=1';
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
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  private async flushPendingCandidates(): Promise<void> {
    for (const c of this.pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(c));
    }
    this.pendingCandidates = [];
  }

  setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.targetVolume = clamped;
    if (!this.muted) this.applyGain(clamped);
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
}
