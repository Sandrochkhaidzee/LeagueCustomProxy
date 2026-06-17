import { invoke } from '@tauri-apps/api/core';

export interface HostAdminClient {
  clientId: string;
  label: string | null;
  roomId: string | null;
  name: string | null;
  team: string | null;
  connectedAt: number;
}

export interface HostAdminLog {
  id: number;
  ts: number;
  level: 'info' | 'warn';
  message: string;
}

export async function fetchHostClients(port: number): Promise<HostAdminClient[]> {
  const data = await invoke<{ clients?: HostAdminClient[] }>('host_admin_status', { port });
  return data.clients ?? [];
}

export async function fetchHostLogs(port: number, afterId: number): Promise<HostAdminLog[]> {
  const data = await invoke<{ logs?: HostAdminLog[] }>('host_admin_logs', { port, after: afterId });
  return data.logs ?? [];
}

export async function kickHostClient(port: number, clientId: string): Promise<void> {
  await invoke('host_admin_kick', { port, clientId });
}

export function formatLogLine(entry: HostAdminLog): string {
  const time = new Date(entry.ts).toLocaleTimeString();
  const tag = entry.level === 'warn' ? 'WARN' : 'INFO';
  return `[${time}] ${tag}  ${entry.message}`;
}

export function formatClientLabel(client: HostAdminClient): string {
  const who = client.label ?? client.name ?? 'Unknown';
  if (client.name && client.roomId) {
    const summoner = client.label && client.label !== client.name ? ` · ${client.name}` : '';
    const team = client.team ? ` · ${client.team}` : '';
    return `${who}${summoner} · ${client.roomId}${team}`;
  }
  if (client.label) {
    return `${client.label} · waiting to join`;
  }
  return `${who} · waiting to join`;
}
