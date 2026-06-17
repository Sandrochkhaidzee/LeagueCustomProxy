export interface Player {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  isDead: boolean;
  respawnTimer: number;
}

export interface Position {
  x: number;
  y: number;
}

export interface PeerState {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  position: Position;
  isMuted: boolean;
  isDead: boolean;
}

export type InputMode = 'always' | 'ptt' | 'vad';
export type VadEngine = 'energy' | 'silero';
export type NoiseMode = 'native' | 'rnnoise';
export type OpusQuality = 'voice' | 'standard' | 'high';

export interface AudioSettings {
  inputMode: InputMode;
  inputVolume: number;       // 0.0 - 1.0
  playerVolumes: Record<string, number>; // summonerName -> 0.0-1.0
  vadSensitivity: number;    // 0–100
  vadHangoverMs: number;
  vadEngine: VadEngine;
  noiseMode: NoiseMode;
  opusQuality: OpusQuality;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export type MapType = 'summoners_rift' | 'howling_abyss' | 'unknown';

export const MAP_DIMENSIONS: Record<MapType, { width: number; height: number }> = {
  summoners_rift: { width: 14870, height: 14980 },
  howling_abyss: { width: 12988, height: 12988 },
  unknown: { width: 14870, height: 14980 },
};
