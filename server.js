const http = require('http');
const PORT = process.env.PORT || 4100;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>Hypnosis Studio</title></head><body style="font-family:system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0b0b12;color:#e8e6f0;margin:0"><div style="text-align:center"><h1 style="font-weight:300;letter-spacing:.2em">HYPNOSIS STUDIO</h1><p style="opacity:.6">Deployed by CI — the studio is being built.</p></div></body></html>');
});
server.listen(PORT, '127.0.0.1', () => console.log('listening on 127.0.0.1:' + PORT));
