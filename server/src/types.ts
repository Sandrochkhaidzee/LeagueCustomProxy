import type { WebSocket } from 'ws';

// Client → Server messages
export interface ClientMessage {
  type: 'join' | 'signal' | 'position';
  room?: string;    // required for 'join'
  name?: string;    // required for 'join'
  to?: string;      // required for 'signal' (target player name)
  payload?: any;    // for 'signal' (SDP/ICE data)
  blob?: string;    // for 'position' (encrypted position data)
}

// Server → Client messages
export interface ServerMessage {
  type: 'peer_joined' | 'peer_left' | 'signal' | 'position' | 'room_state' | 'error';
  name?: string;    // for peer_joined/peer_left
  from?: string;    // for signal/position (who sent it)
  peers?: string[]; // for room_state (list of existing peers)
  payload?: any;    // for signal relay
  blob?: string;    // for position relay
  message?: string; // for error
}

export interface ClientInfo {
  roomId: string;
  name: string;
  ws: WebSocket;
}
