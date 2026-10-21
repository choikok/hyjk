// PC에서 테스트할 때 쓰는 간단한 웹 서버:  node serve.js  →  http://localhost:5173
// (아이폰에서 쓰려면 HTTPS 주소로 배포해야 한다 — README 참고)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 5173;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    // 배포된(https) 사이트에서 이 로컬 서버의 테스트 파일을 불러올 수 있게 허용
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Private-Network': 'true',
    });
    res.end();
    return;
  }
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*', // 배포된 사이트에서 로컬 수정본을 불러와 시험할 수 있게
      'Access-Control-Allow-Private-Network': 'true',
    });
    res.end(data);
  });
}).listen(PORT, () => console.log(`HYJK: http://localhost:${PORT}`));
