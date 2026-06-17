import { FrameProcessor, defaultFrameProcessorOptions, validateOptions } from '@ricky0123/vad-web/dist/frame-processor';
import { Message } from '@ricky0123/vad-web/dist/messages';
import { SileroLegacy } from '@ricky0123/vad-web/dist/models/legacy';
import * as ort from 'onnxruntime-web/wasm';
import { Resampler } from '@ricky0123/vad-web/dist/resampler';

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = '/background/';
ort.env.wasm.proxy = false;

const MODEL_URL = '/models/silero_vad_legacy.onnx';
const FRAME_SAMPLES = 1536;

export interface SileroVadCallbacks {
  onSpeechChange: (active: boolean) => void;
}

/**
 * Main-thread Silero VAD — feeds on 48 kHz float chunks from the mic worklet
 * level monitor, resamples to 16 kHz, and drives speech gating when
 * vadEngine === 'silero'. Falls back to energy VAD in the worklet on failure.
 */
export class SileroVadService {
  private frameProcessor: FrameProcessor | null = null;
  private resampler: Resampler | null = null;
  private speaking = false;
  private active = false;
  private callbacks: SileroVadCallbacks | null = null;
  private loadFailed = false;

  async start(callbacks: SileroVadCallbacks, sensitivity: number): Promise<boolean> {
    this.callbacks = callbacks;
    if (this.loadFailed) return false;
    try {
      const modelFetcher = () => fetch(MODEL_URL).then((r) => {
        if (!r.ok) throw new Error(`Silero model HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      const model = await SileroLegacy.new(ort, modelFetcher);
      const thresholds = sensitivityToSileroThresholds(sensitivity);
      const opts = {
        ...defaultFrameProcessorOptions,
        positiveSpeechThreshold: thresholds.positive,
        negativeSpeechThreshold: thresholds.negative,
        redemptionMs: 300,
        minSpeechMs: 80,
        preSpeechPadMs: 0,
      };
      validateOptions(opts);
      this.frameProcessor = new FrameProcessor(
        model.process.bind(model),
        model.reset_state.bind(model),
        opts,
        FRAME_SAMPLES / 16,
      );
      this.frameProcessor.resume();
      this.resampler = new Resampler({
        nativeSampleRate: 48000,
        targetSampleRate: 16000,
        targetFrameSize: FRAME_SAMPLES,
      });
      this.active = true;
      console.log('[Audio] Silero VAD loaded');
      return true;
    } catch (e) {
      console.warn('[Audio] Silero VAD load failed — using energy VAD:', e);
      this.loadFailed = true;
      this.active = false;
      return false;
    }
  }

  /** Push 48 kHz mono samples from the worklet silero tap. */
  feedSamples(samples: Float32Array, sampleRate = 48000): void {
    if (!this.active || !this.frameProcessor || !this.resampler) return;
    void this.processSamples(samples, sampleRate);
  }

  private async processSamples(samples: Float32Array, sampleRate: number): Promise<void> {
    if (sampleRate !== 48000 || !this.frameProcessor || !this.resampler) return;
    for await (const frame of this.resampler.stream(samples)) {
      await this.frameProcessor.process(frame, (ev) => {
        if (ev.msg === Message.SpeechStart || ev.msg === Message.SpeechRealStart) {
          this.setSpeaking(true);
        } else if (ev.msg === Message.SpeechEnd) {
          this.setSpeaking(false);
        }
      });
    }
  }

  stop(): void {
    this.active = false;
    this.frameProcessor = null;
    this.resampler = null;
    this.setSpeaking(false);
  }

  private setSpeaking(active: boolean): void {
    if (this.speaking === active) return;
    this.speaking = active;
    this.callbacks?.onSpeechChange(active);
  }
}

function sensitivityToSileroThresholds(sensitivity: number): { positive: number; negative: number } {
  const s = Math.max(0, Math.min(100, sensitivity));
  const positive = 0.85 - (s / 100) * 0.55;
  const negative = Math.max(0.1, positive - 0.15);
  return { positive, negative };
}
