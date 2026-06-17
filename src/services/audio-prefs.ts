import type { AudioSettings, InputMode, NoiseMode, OpusQuality, VadEngine } from '../core/types';

const KEYS = {
  inputMode: 'lolproxchat.inputMode',
  inputVolume: 'lolproxchat.inputVolume',
  vadSensitivity: 'lolproxchat.vadSensitivity',
  vadHangoverMs: 'lolproxchat.vadHangoverMs',
  vadEngine: 'lolproxchat.vadEngine',
  noiseMode: 'lolproxchat.noiseMode',
  opusQuality: 'lolproxchat.opusQuality',
  echoCancellation: 'lolproxchat.echoCancellation',
  noiseSuppression: 'lolproxchat.noiseSuppression',
  autoGainControl: 'lolproxchat.autoGainControl',
  playerVolumes: 'lolproxchat.playerVolumes',
} as const;

/** Teammates use distance falloff like enemies — always on, no user toggle. */
export function getAllyProximity(): boolean {
  return true;
}

function readBool(key: string, defaultValue: boolean): boolean {
  const v = localStorage.getItem(key);
  if (v === null) return defaultValue;
  return v === '1';
}

function writeBool(key: string, value: boolean): void {
  if (value) localStorage.setItem(key, '1');
  else localStorage.setItem(key, '0');
}

export function loadAudioSettings(): Partial<AudioSettings> {
  const inputMode = localStorage.getItem(KEYS.inputMode);
  const resolvedMode = inputMode === 'always' ? 'vad' : inputMode;
  const inputVolume = localStorage.getItem(KEYS.inputVolume);
  const vadSensitivity = localStorage.getItem(KEYS.vadSensitivity);
  const vadHangoverMs = localStorage.getItem(KEYS.vadHangoverMs);
  const vadEngine = localStorage.getItem(KEYS.vadEngine) as VadEngine | null;
  const noiseMode = localStorage.getItem(KEYS.noiseMode) as NoiseMode | null;
  const opusQuality = localStorage.getItem(KEYS.opusQuality) as OpusQuality | null;
  let playerVolumes: Record<string, number> = {};
  try {
    const raw = localStorage.getItem(KEYS.playerVolumes);
    if (raw) playerVolumes = JSON.parse(raw);
  } catch { /* ignore corrupt */ }

  return {
    inputMode: resolvedMode === 'ptt' || resolvedMode === 'vad' ? resolvedMode : 'vad',
    inputVolume: inputVolume !== null ? Math.max(0, Math.min(1, parseFloat(inputVolume))) : 1,
    vadSensitivity: vadSensitivity !== null ? Math.max(0, Math.min(100, parseInt(vadSensitivity, 10))) : 50,
    vadHangoverMs: vadHangoverMs !== null ? Math.max(50, Math.min(1000, parseInt(vadHangoverMs, 10))) : 300,
    vadEngine: vadEngine === 'silero' ? 'silero' : 'energy',
    noiseMode: noiseMode === 'rnnoise' ? 'rnnoise' : 'native',
    opusQuality: opusQuality === 'voice' || opusQuality === 'high' ? opusQuality : 'standard',
    echoCancellation: readBool(KEYS.echoCancellation, true),
    noiseSuppression: readBool(KEYS.noiseSuppression, true),
    autoGainControl: readBool(KEYS.autoGainControl, true),
    playerVolumes,
  };
}

export function saveAudioSettings(partial: Partial<AudioSettings>): void {
  if (partial.inputMode !== undefined) {
    localStorage.setItem(KEYS.inputMode, partial.inputMode);
  }
  if (partial.inputVolume !== undefined) {
    localStorage.setItem(KEYS.inputVolume, String(partial.inputVolume));
  }
  if (partial.vadSensitivity !== undefined) {
    localStorage.setItem(KEYS.vadSensitivity, String(Math.round(partial.vadSensitivity)));
  }
  if (partial.vadHangoverMs !== undefined) {
    localStorage.setItem(KEYS.vadHangoverMs, String(Math.round(partial.vadHangoverMs)));
  }
  if (partial.vadEngine !== undefined) {
    localStorage.setItem(KEYS.vadEngine, partial.vadEngine);
  }
  if (partial.noiseMode !== undefined) {
    localStorage.setItem(KEYS.noiseMode, partial.noiseMode);
  }
  if (partial.opusQuality !== undefined) {
    localStorage.setItem(KEYS.opusQuality, partial.opusQuality);
  }
  if (partial.echoCancellation !== undefined) {
    writeBool(KEYS.echoCancellation, partial.echoCancellation);
  }
  if (partial.noiseSuppression !== undefined) {
    writeBool(KEYS.noiseSuppression, partial.noiseSuppression);
  }
  if (partial.autoGainControl !== undefined) {
    writeBool(KEYS.autoGainControl, partial.autoGainControl);
  }
  if (partial.playerVolumes !== undefined) {
    localStorage.setItem(KEYS.playerVolumes, JSON.stringify(partial.playerVolumes));
  }
}

export function savePlayerVolume(name: string, volume: number): void {
  const settings = loadAudioSettings();
  const playerVolumes = { ...settings.playerVolumes, [name]: volume };
  saveAudioSettings({ playerVolumes });
}

export const OPUS_BITRATES: Record<OpusQuality, number> = {
  voice: 32000,
  standard: 64000,
  high: 128000,
};
