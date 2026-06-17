import { Rnnoise, DenoiseState } from '@shiguredo/rnnoise-wasm';

export interface AudioWorkletHostCallbacks {
  onLevel?: (rms: number) => void;
  onSpeechChange?: (active: boolean) => void;
  onSileroChunk?: (chunk: Float32Array) => void;
}

export interface AudioWorkletHostConfig {
  gain: number;
  vadEnabled: boolean;
  vadSensitivity: number;
  vadHangoverMs: number;
  rnnoiseEnabled: boolean;
  sileroFeed: boolean;
}

const DEFAULT_CONFIG: AudioWorkletHostConfig = {
  gain: 1,
  vadEnabled: false,
  vadSensitivity: 50,
  vadHangoverMs: 300,
  rnnoiseEnabled: false,
  sileroFeed: false,
};

const WORKLET_URL = '/background/audio-processor.js';

export class AudioWorkletHost {
  private node: AudioWorkletNode | null = null;
  private fallbackGain: GainNode | null = null;
  private useWorklet = true;
  private config: AudioWorkletHostConfig = { ...DEFAULT_CONFIG };
  private callbacks: AudioWorkletHostCallbacks = {};
  private rnnoise: Rnnoise | null = null;
  private denoiseState: DenoiseState | null = null;
  private speechDebounced = false;

  get isWorkletActive(): boolean {
    return this.node !== null;
  }

  async connect(
    context: AudioContext,
    source: AudioNode,
    destination: AudioNode,
    callbacks?: AudioWorkletHostCallbacks,
  ): Promise<AudioNode> {
    this.callbacks = callbacks ?? {};
    if (this.node) {
      this.node.disconnect();
      this.node = null;
    }
    if (this.fallbackGain) {
      this.fallbackGain.disconnect();
      this.fallbackGain = null;
    }
    if (typeof context.audioWorklet?.addModule !== 'function') {
      console.warn('[AudioWorklet] audioWorklet unavailable — falling back to GainNode');
      this.useWorklet = false;
      return this.connectFallback(context, source, destination);
    }
    try {
      await context.audioWorklet.addModule(WORKLET_URL);
      this.node = new AudioWorkletNode(context, 'lolproxchat-audio', {
        processorOptions: {
          gain: this.config.gain,
          vadEnabled: this.config.vadEnabled,
          vadSensitivity: this.config.vadSensitivity,
          vadHangoverMs: this.config.vadHangoverMs,
          rnnoiseEnabled: this.config.rnnoiseEnabled,
          sileroFeed: this.config.sileroFeed,
        },
      });
      this.node.port.onmessage = (ev) => this.handleWorkletMessage(ev.data);
      source.connect(this.node);
      this.node.connect(destination);
      if (this.config.rnnoiseEnabled) {
        await this.initRnnoise();
      }
      this.applyConfig();
      return this.node;
    } catch (e) {
      console.warn('[AudioWorklet] Failed to load processor — falling back to GainNode:', e);
      this.useWorklet = false;
      this.node = null;
      return this.connectFallback(context, source, destination);
    }
  }

  private connectFallback(
    context: AudioContext,
    source: AudioNode,
    destination: AudioNode,
  ): GainNode {
    this.fallbackGain = context.createGain();
    this.fallbackGain.gain.value = this.config.gain;
    source.connect(this.fallbackGain);
    this.fallbackGain.connect(destination);
    return this.fallbackGain;
  }

  private async initRnnoise(): Promise<void> {
    try {
      this.rnnoise = await Rnnoise.load();
      this.denoiseState = this.rnnoise.createDenoiseState();
      this.node?.port.postMessage({
        type: 'rnnoise-ready',
        frameSize: this.rnnoise.frameSize,
      });
      console.log('[Audio] RNNoise loaded, frameSize=', this.rnnoise.frameSize);
    } catch (e) {
      console.warn('[Audio] RNNoise init failed — continuing without:', e);
      this.rnnoise = null;
      this.denoiseState = null;
    }
  }

  private handleWorkletMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'level' && typeof msg.rms === 'number') {
      this.callbacks.onLevel?.(msg.rms);
    } else if (msg.type === 'speech' && typeof msg.active === 'boolean') {
      this.debounceSpeech(msg.active);
    } else if (msg.type === 'rnnoise-in' && msg.frame instanceof Float32Array) {
      this.processRnnoiseFrame(msg.frame);
    } else if (msg.type === 'silero-chunk' && msg.chunk instanceof Float32Array) {
      this.callbacks.onSileroChunk?.(msg.chunk);
    }
  }

  private processRnnoiseFrame(frame: Float32Array): void {
    if (!this.denoiseState || !this.node) return;
    try {
      const out = new Float32Array(frame);
      this.denoiseState.processFrame(out);
      this.node.port.postMessage({ type: 'rnnoise-out', frame: out }, [out.buffer]);
    } catch (e) {
      console.warn('[Audio] RNNoise frame failed:', e);
    }
  }

  private debounceSpeech(active: boolean): void {
    if (active === this.speechDebounced) return;
    this.speechDebounced = active;
    this.callbacks.onSpeechChange?.(active);
  }

  setConfig(partial: Partial<AudioWorkletHostConfig>): void {
    const prevRnnoise = this.config.rnnoiseEnabled;
    Object.assign(this.config, partial);
    if (this.fallbackGain) {
      this.fallbackGain.gain.value = this.config.gain;
    }
    this.applyConfig();
    if (this.config.rnnoiseEnabled && !prevRnnoise && !this.rnnoise) {
      void this.initRnnoise();
    }
    if (!this.config.rnnoiseEnabled && prevRnnoise) {
      this.denoiseState?.destroy();
      this.denoiseState = null;
      this.rnnoise = null;
    }
  }

  private applyConfig(): void {
    if (!this.node) return;
    this.node.port.postMessage({
      type: 'config',
      gain: this.config.gain,
      vadEnabled: this.config.vadEnabled,
      vadSensitivity: this.config.vadSensitivity,
      vadHangoverMs: this.config.vadHangoverMs,
      rnnoiseEnabled: this.config.rnnoiseEnabled,
      sileroFeed: this.config.sileroFeed,
    });
  }

  /** External speech state (Silero VAD on main thread). */
  reportExternalSpeech(active: boolean): void {
    this.debounceSpeech(active);
  }

  setGain(gain: number): void {
    this.setConfig({ gain });
  }

  destroy(): void {
    this.denoiseState?.destroy();
    this.denoiseState = null;
    this.rnnoise = null;
    this.node?.disconnect();
    this.node = null;
    this.fallbackGain?.disconnect();
    this.fallbackGain = null;
  }
}
