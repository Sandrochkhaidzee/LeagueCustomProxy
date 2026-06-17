// Persisted audio-device selection. Stored in localStorage so the user's
// pick survives restarts (and stays sticky between game sessions).

import type { AudioSettings } from '../core/types';
import { loadAudioSettings } from './audio-prefs';

const INPUT_KEY = 'lolproxchat.inputDeviceId';
const OUTPUT_KEY = 'lolproxchat.outputDeviceId';

export function getStoredInputDeviceId(): string | null {
  return localStorage.getItem(INPUT_KEY);
}

export function setStoredInputDeviceId(id: string | null): void {
  if (id) localStorage.setItem(INPUT_KEY, id);
  else localStorage.removeItem(INPUT_KEY);
}

export function getStoredOutputDeviceId(): string | null {
  return localStorage.getItem(OUTPUT_KEY);
}

export function setStoredOutputDeviceId(id: string | null): void {
  if (id) localStorage.setItem(OUTPUT_KEY, id);
  else localStorage.removeItem(OUTPUT_KEY);
}

export interface AudioDevices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

export async function listAudioDevices(): Promise<AudioDevices> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const isSynthetic = (d: MediaDeviceInfo) =>
    d.deviceId === 'default' || d.deviceId === 'communications';
  return {
    inputs: devices.filter((d) => d.kind === 'audioinput' && !isSynthetic(d)),
    outputs: devices.filter((d) => d.kind === 'audiooutput' && !isSynthetic(d)),
  };
}

/** Production capture constraints — matches AudioService.acquireMicStream(). */
export function getCaptureConstraints(settings?: Partial<AudioSettings>): MediaTrackConstraints {
  const prefs = settings ?? loadAudioSettings();
  const noiseMode = prefs.noiseMode ?? 'native';
  return {
    echoCancellation: prefs.echoCancellation !== false,
    noiseSuppression: noiseMode === 'native' && prefs.noiseSuppression !== false,
    autoGainControl: prefs.autoGainControl !== false,
  };
}

export async function probeMicPermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: getCaptureConstraints(),
  });
  stream.getTracks().forEach((t) => t.stop());
}
