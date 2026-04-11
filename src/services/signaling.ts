import { WS_URL } from '../core/config';

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

export class SignalingService {
  private ws: WebSocket | null = null;
  private localName: string = '';

  joinRoom(
    roomId: string,
    localName: string,
    onPeerPosition: OnPeerPosition,
    onSignal: OnSignal,
    onPeerLeave: OnPeerLeave,
    onPeerJoined?: OnPeerJoined,
  ): void {
    this.localName = localName;
    this.leaveRoom();

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.addEventListener('open', () => {
      console.log('[Signaling] WebSocket connected');
      ws.send(JSON.stringify({ type: 'join', room: roomId, name: localName }));
    });

    ws.addEventListener('message', (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        console.warn('[Signaling] Failed to parse message:', event.data);
        return;
      }

      switch (msg.type) {
        case 'room_state': {
          // Existing peers already in the room
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
            payload: msg.payload,
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

    ws.addEventListener('close', () => {
      console.log('[Signaling] WebSocket disconnected');
    });

    ws.addEventListener('error', (err) => {
      console.error('[Signaling] WebSocket error:', err);
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

  sendSignal(signal: SignalMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'signal',
        to: signal.to,
        payload: signal.payload,
      }));
    }
  }

  leaveRoom(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
