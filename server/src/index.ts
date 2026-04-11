import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { handleConnection } from './ws-handler.js';
import { generateTurnCredentials } from './turn.js';

const PORT = parseInt(process.env.PORT || '3100');
const TURN_SERVER = process.env.TURN_SERVER || '';
const TURN_SECRET = process.env.TURN_SECRET || '';

const rooms = new RoomManager();

const httpServer = createServer((req, res) => {
  // CORS headers on all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.roomCount }));
    return;
  }

  if (req.url === '/turn-credentials') {
    generateTurnCredentials(TURN_SERVER, TURN_SECRET).then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  handleConnection(ws, rooms);
});

httpServer.listen(PORT, () => {
  console.log(`proxchat-server listening on :${PORT}`);
});
