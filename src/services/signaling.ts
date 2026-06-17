import { getWsUrl } from '../core/config';
import { getStoredConnectionName } from '../core/server-prefs';

export type SignalType = 'offer' | 'answer' | 'ice-candidate';

export interface SignalMessage {
  type: SignalType;
  from: string;
  to: string;
  payload: any;
}

export interface PositionBroadcast {
  summonerName: string;
  championName: string;
  team: string;
  isMuted: boolean;
  isDead: boolean;
}

type OnPeerPosition = (peer: PositionBroadcast) => void;
type OnSignal = (signal: SignalMessage) => void;
type OnPeerLeave = (summonerName: string) => void;
type OnPeerJoined = (name: string) => void;
type OnConnectionLost = (reason?: string) => void;

/** Server policy-violation close — kicked by host. Do not auto-reconnect. */
const WS_CLOSE_KICKED = 1008;

/** Reconnect attempts after an unexpected close before notifying the app. */
const MAX_RECONNECT_ATTEMPTS = 4;

export class SignalingService {
  private ws: WebSocket | null = null;
  private localName: string = '';
  private currentRoomId: string | null = null;
  private currentTeam: 'ORDER' | 'CHAOS' | null = null;
  private currentHandlers: {
    onPeerPosition: OnPeerPosition;
    onSignal: OnSignal;
    onPeerLeave: OnPeerLeave;
    onPeerJoined?: OnPeerJoined;
  } | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private onConnectionLost: OnConnectionLost | null = null;
  /** Connected to host with hello only — visible in host admin before in-game join. */
  private inLobby = false;
  private messageHandlerWs: WebSocket | null = null;

  /** Open WebSocket and send hello so the host admin panel lists this client. */
  connectLobby(onConnectionLost?: OnConnectionLost): void {
    this.inLobby = true;
    this.currentRoomId = null;
    this.currentTeam = null;
    this.currentHandlers = null;
    this.onConnectionLost = onConnectionLost ?? null;
    this.intentionallyClosed = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendHello();
      return;
    }
    this.openSocket();
  }

  joinRoom(
    roomId: string,
    localName: string,
    team: 'ORDER' | 'CHAOS',
    onPeerPosition: OnPeerPosition,
    onSignal: OnSignal,
    onPeerLeave: OnPeerLeave,
    onPeerJoined?: OnPeerJoined,
    onConnectionLost?: OnConnectionLost,
  ): void {
    this.inLobby = false;
    this.localName = localName;
    this.currentRoomId = roomId;
    this.currentTeam = team;
    this.currentHandlers = { onPeerPosition, onSignal, onPeerLeave, onPeerJoined };
    this.onConnectionLost = onConnectionLost ?? null;
    this.intentionallyClosed = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.attachMessageHandler(this.ws);
      this.sendHello();
      this.sendJoin();
      return;
    }
    this.openSocket();
  }

  private openSocket(): void {
    const wsUrl = getWsUrl();
    if (!wsUrl) {
      console.warn('[Signaling] No signaling server URL configured — not connecting');
      return;
    }
    if (!this.inLobby && (!this.currentRoomId || !this.currentHandlers)) {
      return;
    }

    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.messageHandlerWs = null;
    }

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.addEventListener('open', () => {
      console.log('[Signaling] WebSocket connected');
      this.reconnectAttempt = 0;
      this.sendHello();
      if (!this.inLobby) {
        this.sendJoin();
      }
    });

    this.attachMessageHandler(ws);
    this.attachCloseHandler(ws);

    ws.addEventListener('error', (err) => {
      console.error('[Signaling] WebSocket error:', err);
    });
  }

  private sendHello(): void {
    const label = getStoredConnectionName();
    if (label && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'hello', label }));
    }
  }

  private sendJoin(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.currentRoomId || !this.currentHandlers) return;
    this.ws.send(JSON.stringify({
      type: 'join',
      room: this.currentRoomId,
      name: this.localName,
      team: this.currentTeam,
    }));
  }

  private attachMessageHandler(ws: WebSocket): void {
    if (this.messageHandlerWs === ws) return;
    this.messageHandlerWs = ws;
    ws.addEventListener('message', (event) => {
      if (!this.currentHandlers) return;

      const { onPeerPosition, onSignal, onPeerLeave, onPeerJoined } = this.currentHandlers;
      let msg: any;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        console.warn('[Signaling] Failed to parse message:', event.data);
        return;
      }

      switch (msg.type) {
        case 'room_state': {
          const peers: string[] = msg.peers || [];
          for (const name of peers) {
            onPeerJoined?.(name);
          }
          break;
        }

        case 'peer_joined': {
          if (msg.name !== this.localName) {
            onPeerJoined?.(msg.name);
          }
          break;
        }

        case 'peer_left': {
          onPeerLeave(msg.name);
          break;
        }

        case 'signal': {
          onSignal({
            type: msg.payload?.type,
            from: msg.from,
            to: this.localName,
            payload: msg.payload?.payload,
          });
          break;
        }

        case 'position': {
          if (msg.from !== this.localName) {
            try {
              const broadcast: PositionBroadcast = JSON.parse(msg.blob);
              onPeerPosition(broadcast);
            } catch {
              console.warn('[Signaling] Failed to parse position blob from:', msg.from);
            }
          }
          break;
        }

        case 'error': {
          console.error('[Signaling] Server error:', msg.message);
          break;
        }
      }
    });
  }

  private attachCloseHandler(ws: WebSocket): void {
    ws.addEventListener('close', (ev: CloseEvent) => {
      console.log('[Signaling] WebSocket disconnected', ev.code, ev.reason);
      if (this.intentionallyClosed) return;

      const reason = ev.reason?.toLowerCase() ?? '';
      const kicked = ev.code === WS_CLOSE_KICKED || reason.includes('kick');
      if (kicked) {
        console.log('[Signaling] Kicked by host — not reconnecting');
        this.intentionallyClosed = true;
        this.reconnectAttempt = MAX_RECONNECT_ATTEMPTS + 1;
        if (this.reconnectTimer !== null) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.onConnectionLost?.('Kicked by host. Use Connect to rejoin.');
        return;
      }

      this.reconnectAttempt++;
      if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
        console.log('[Signaling] Host server unreachable — stopping reconnect');
        if (this.reconnectTimer !== null) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.onConnectionLost?.();
        return;
      }
      const delayMs = Math.min(30000, 500 * Math.pow(2, this.reconnectAttempt - 1));
      console.log('[Signaling] Reconnecting in ' + delayMs + 'ms (attempt ' + this.reconnectAttempt + ')');
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.intentionallyClosed) return;
        this.openSocket();
      }, delayMs);
    });
  }

  broadcastPosition(data: PositionBroadcast): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'position',
        blob: JSON.stringify(data),
      }));
    }
  }

  sendCoords(x: number, y: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'coords', x, y }));
    }
  }

  getCurrentRoom(): string | null { return this.currentRoomId; }
  getLocalName(): string { return this.localName; }

  isLobbyConnected(): boolean {
    return this.inLobby && this.ws?.readyState === WebSocket.OPEN;
  }

  isLobbyConnecting(): boolean {
    return this.inLobby && this.ws?.readyState === WebSocket.CONNECTING;
  }

  sendSignal(signal: SignalMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'signal',
        to: signal.to,
        payload: { type: signal.type, payload: signal.payload },
      }));
    }
  }

  private closePromise: Promise<void> | null = null;

  reconnect(): void {
    if (!this.inLobby && (!this.currentRoomId || !this.currentHandlers)) return;
    this.intentionallyClosed = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.openSocket();
  }

  leaveRoom(): void {
    this.intentionallyClosed = true;
    this.inLobby = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.currentRoomId = null;
    this.currentTeam = null;
    this.currentHandlers = null;
    this.onConnectionLost = null;
    void this.closeSocket();
  }

  /** Wait for the WebSocket to close (used on app exit so the host drops the client). */
  closeSocket(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.intentionallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.messageHandlerWs = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.closePromise = new Promise((resolve) => {
      const finish = () => {
        this.closePromise = null;
        resolve();
      };
      ws.addEventListener('close', finish, { once: true });
      try {
        ws.close(1000, 'client shutdown');
      } catch {
        finish();
        return;
      }
      window.setTimeout(finish, 500);
    });
    return this.closePromise;
  }
}
