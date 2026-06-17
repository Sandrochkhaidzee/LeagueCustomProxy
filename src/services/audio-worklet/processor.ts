// @ts-nocheck
/// <reference lib="webworker" />

import { highPassSample, sensitivityToThresholds, stepEnergyVad } from './vad-math';

interface ProcessorOptions {
  gain?: number;
  vadEnabled?: boolean;
  vadSensitivity?: number;
  vadHangoverMs?: number;
  rnnoiseEnabled?: boolean;
  rnnoiseFrameSize?: number;
  sileroFeed?: boolean;
}

interface RnnoisePending {
  input: Float32Array;
  output: Float32Array | null;
}

class LolProxChatAudioProcessor extends AudioWorkletProcessor {
  private gain: number;
  private vadEnabled: boolean;
  private vadSensitivity: number;
  private vadHangoverMs: number;
  private vadState = { speechActive: false, hangoverSamplesRemaining: 0 };
  private hpPrevIn = 0;
  private hpPrevOut = 0;
  private readonly hpCoeff = 0.995;

  private rnnoiseEnabled: boolean;
  private rnnoiseFrameSize: number;
  private rnnoiseBuffer: Float32Array;
  private rnnoiseBufLen = 0;
  private rnnoisePending: RnnoisePending[] = [];
  private rnnoiseReady = false;

  private sileroFeed: boolean;
  private sileroBuffer: Float32Array;
  private sileroBufLen = 0;
  private readonly sileroChunkSize: number;

  private levelIntervalSamples: number;
  private samplesSinceLevel = 0;
  private windowSumSq = 0;
  private windowSamples = 0;
  private readonly windowSize: number;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const opts: ProcessorOptions = options?.processorOptions ?? {};
    this.gain = opts.gain ?? 1;
    this.vadEnabled = opts.vadEnabled ?? false;
    this.vadSensitivity = opts.vadSensitivity ?? 50;
    this.vadHangoverMs = opts.vadHangoverMs ?? 300;
    this.rnnoiseEnabled = opts.rnnoiseEnabled ?? false;
    this.rnnoiseFrameSize = opts.rnnoiseFrameSize ?? 480;
    this.rnnoiseBuffer = new Float32Array(this.rnnoiseFrameSize);
    this.sileroFeed = opts.sileroFeed ?? false;
    this.sileroChunkSize = 3072;
    this.sileroBuffer = new Float32Array(this.sileroChunkSize);
    this.windowSize = Math.max(128, Math.floor(sampleRate / 50));
    this.levelIntervalSamples = this.windowSize;

    this.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (msg?.type === 'config') {
        if (typeof msg.gain === 'number') this.gain = msg.gain;
        if (typeof msg.vadEnabled === 'boolean') this.vadEnabled = msg.vadEnabled;
        if (typeof msg.vadSensitivity === 'number') this.vadSensitivity = msg.vadSensitivity;
        if (typeof msg.vadHangoverMs === 'number') this.vadHangoverMs = msg.vadHangoverMs;
        if (typeof msg.rnnoiseEnabled === 'boolean') this.rnnoiseEnabled = msg.rnnoiseEnabled;
        if (typeof msg.sileroFeed === 'boolean') this.sileroFeed = msg.sileroFeed;
      } else if (msg?.type === 'rnnoise-ready') {
        this.rnnoiseReady = true;
        if (typeof msg.frameSize === 'number') {
          this.rnnoiseFrameSize = msg.frameSize;
          this.rnnoiseBuffer = new Float32Array(this.rnnoiseFrameSize);
          this.rnnoiseBufLen = 0;
        }
      } else if (msg?.type === 'rnnoise-out' && msg.frame instanceof Float32Array) {
        const pending = this.rnnoisePending.shift();
        if (pending) {
          pending.output = msg.frame;
        }
      }
    };
  }

  private emitLevelAndVad(rms: number): void {
    if (this.vadEnabled) {
      const { open, close } = sensitivityToThresholds(this.vadSensitivity);
      const hangoverSamples = Math.floor((this.vadHangoverMs / 1000) * sampleRate);
      const prev = this.vadState.speechActive;
      this.vadState = stepEnergyVad(rms, this.vadState, open, close, hangoverSamples);
      if (this.vadState.speechActive !== prev) {
        this.port.postMessage({ type: 'speech', active: this.vadState.speechActive });
      }
    }
    this.port.postMessage({ type: 'level', rms });
  }

  private pushRnnoiseSample(sample: number): number {
    this.rnnoiseBuffer[this.rnnoiseBufLen++] = sample;
    if (this.rnnoiseBufLen < this.rnnoiseFrameSize) {
      return sample;
    }
    const frame = this.rnnoiseBuffer.slice(0);
    this.rnnoiseBufLen = 0;
    const pending: RnnoisePending = { input: frame, output: null };
    this.rnnoisePending.push(pending);
    if (this.rnnoiseReady) {
      this.port.postMessage({ type: 'rnnoise-in', frame }, [frame.buffer]);
    }
    const oldest = this.rnnoisePending[0];
    if (oldest?.output) {
      this.rnnoisePending.shift();
      return oldest.output[0] ?? sample;
    }
    return sample;
  }

  private pushSileroSample(sample: number): void {
    this.sileroBuffer[this.sileroBufLen++] = sample;
    if (this.sileroBufLen < this.sileroChunkSize) return;
    const chunk = this.sileroBuffer.slice(0);
    this.sileroBufLen = 0;
    this.port.postMessage({ type: 'silero-chunk', chunk }, [chunk.buffer]);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    for (let i = 0; i < input.length; i++) {
      let s = input[i] * this.gain;
      const hp = highPassSample(s, this.hpPrevIn, this.hpPrevOut, this.hpCoeff);
      this.hpPrevIn = hp.prevIn;
      this.hpPrevOut = hp.prevOut;

      if (this.rnnoiseEnabled && this.rnnoiseReady) {
        s = this.pushRnnoiseSample(s);
      }

      output[i] = s;

      if (this.sileroFeed) {
        this.pushSileroSample(s);
      }

      this.windowSumSq += hp.out * hp.out;
      this.windowSamples++;
      this.samplesSinceLevel++;
      if (this.samplesSinceLevel >= this.levelIntervalSamples) {
        const rms = this.windowSamples > 0
          ? Math.sqrt(this.windowSumSq / this.windowSamples)
          : 0;
        this.windowSumSq = 0;
        this.windowSamples = 0;
        this.samplesSinceLevel = 0;
        this.emitLevelAndVad(rms);
      }
    }

    return true;
  }
}

registerProcessor('lolproxchat-audio', LolProxChatAudioProcessor);
