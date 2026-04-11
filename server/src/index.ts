import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { handleConnection } from './ws-handler.js';

const PORT = parseInt(process.env.PORT || '3100');

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
