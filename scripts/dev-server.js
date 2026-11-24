'use strict';

/* Лёгкий статический сервер для предпросмотра рендерера в браузере.
   Десктопный режим запускается через `npm start` (Electron). */

const http = require('http');
const fs = require('fs');
const path = require('path');

function cliArg(name, fallback) {
  const prefix = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return fallback;
}

const port = Number(process.env.PORT || cliArg('port', 7100));
const host = process.env.HOST || cliArg('host', '127.0.0.1');
const root = path.join(__dirname, '..', 'src', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(root, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`Предпросмотр: http://${host}:${port}/`);
  console.log('Десктопный режим: npm start');
});
