// Servidor estático mínimo para desarrollo y tests (sirve la raíz del repo).
// Uso: node test/tools/serve.mjs [puerto]   → http://localhost:8080/docs/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip', // tesseract descomprime él mismo: NO enviar Content-Encoding
  '.ics': 'text/calendar; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function startServer(port = 0, root = ROOT) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      let file = path.join(root, p);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + p); return; }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({ url: `http://127.0.0.1:${p}`, port: p, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8080);
  startServer(port).then(({ url }) => console.log(`Sirviendo ${ROOT} en ${url}/docs/`));
}
