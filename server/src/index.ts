import { createServer } from 'http';

const PORT = parseInt(process.env.PORT || '3100');

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

httpServer.listen(PORT, () => {
  console.log(`proxchat-server listening on :${PORT}`);
});
