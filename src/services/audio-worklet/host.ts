import {
  bufferRms,
  sensitivityToThresholds,
  stepEnergyVad,
  type EnergyVadState,
} from './vad-math';
import { Rnnoise, DenoiseState } from '@shiguredo/rnnoise-wasm';

const FALLBACK_FFT = 2048;
const FALLBACK_POLL_MS = 50;

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

const WORKLET_URL = new URL('../background/audio-processor.js', window.location.href).href;

export class AudioWorkletHost {
  private node: AudioWorkletNode | null = null;
  private fallbackGain: GainNode | null = null;
  private fallbackAnalyser: AnalyserNode | null = null;
  private fallbackVadState: EnergyVadState = { speechActive: false, hangoverSamplesRemaining: 0 };
  private fallbackPollId: number | null = null;
  private fallbackTimeBuf: Float32Array | null = null;
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
      this.stopFallbackPoll();
      this.fallbackGain.disconnect();
      this.fallbackGain = null;
      this.fallbackAnalyser = null;
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
    this.fallbackAnalyser = context.createAnalyser();
    this.fallbackAnalyser.fftSize = FALLBACK_FFT;
    this.fallbackTimeBuf = new Float32Array(this.fallbackAnalyser.fftSize);
    source.connect(this.fallbackGain);
    this.fallbackGain.connect(this.fallbackAnalyser);
    this.fallbackAnalyser.connect(destination);
    this.startFallbackPoll();
    return this.fallbackGain;
  }

  private startFallbackPoll(): void {
    this.stopFallbackPoll();
    const tick = () => {
      if (!this.fallbackAnalyser || !this.fallbackTimeBuf) return;
      this.fallbackAnalyser.getFloatTimeDomainData(this.fallbackTimeBuf);
      const rms = bufferRms(this.fallbackTimeBuf);
      this.callbacks.onLevel?.(rms);
      if (this.config.vadEnabled) {
        const { open, close } = sensitivityToThresholds(this.config.vadSensitivity);
        const windowMs = (this.fallbackTimeBuf.length / this.fallbackAnalyser.context.sampleRate) * 1000;
        const hangoverSteps = Math.max(1, Math.round(this.config.vadHangoverMs / windowMs));
        const prev = this.fallbackVadState.speechActive;
        this.fallbackVadState = stepEnergyVad(rms, this.fallbackVadState, open, close, hangoverSteps);
        if (this.fallbackVadState.speechActive !== prev) {
          this.debounceSpeech(this.fallbackVadState.speechActive);
        }
      }
      this.fallbackPollId = window.setTimeout(tick, FALLBACK_POLL_MS);
    };
    this.fallbackPollId = window.setTimeout(tick, FALLBACK_POLL_MS);
  }

  private stopFallbackPoll(): void {
    if (this.fallbackPollId !== null) {
      clearTimeout(this.fallbackPollId);
      this.fallbackPollId = null;
    }
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
    if (this.fallbackAnalyser && !this.config.vadEnabled) {
      this.fallbackVadState = { speechActive: false, hangoverSamplesRemaining: 0 };
      this.syncSpeechDebounced(false);
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

  /** Keep host debounce aligned when clearing indicator state (e.g. input mode change). */
  syncSpeechDebounced(active: boolean): void {
    this.speechDebounced = active;
  }

  setGain(gain: number): void {
    this.setConfig({ gain });
  }

  destroy(): void {
    this.stopFallbackPoll();
    this.denoiseState?.destroy();
    this.denoiseState = null;
    this.rnnoise = null;
    this.node?.disconnect();
    this.node = null;
    this.fallbackGain?.disconnect();
    this.fallbackGain = null;
    this.fallbackAnalyser = null;
  }
}
