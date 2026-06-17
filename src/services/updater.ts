import { invoke } from '@tauri-apps/api/core';

export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  download_url: string | null;
  notes: string | null;
}

/** Tauri invoke errors are not always `Error` instances with a `.message`. */
export function formatInvokeError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.message === 'string' && o.message) return o.message;
    if (typeof o.error === 'string') return o.error;
  }
  return e != null ? String(e) : 'unknown error';
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>('check_for_update');
}

export async function downloadAndApply(downloadUrl: string): Promise<void> {
  await invoke('download_and_apply_update', { url: downloadUrl });
}
