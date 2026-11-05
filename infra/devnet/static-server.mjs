import http from 'node:http';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || './public');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml',
  '.png':'image/png','.woff2':'font/woff2','.ico':'image/x-icon'};
http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {response.writeHead(405).end(); return;}
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/healthz') {response.writeHead(200).end('ok'); return;}
    if (pathname === '/explorer') pathname = '/';
    if (pathname.startsWith('/explorer/')) pathname = pathname.slice('/explorer'.length);
    let file = path.resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) {response.writeHead(403).end(); return;}
    let info;
    try {info = await stat(file);} catch {}
    if (!info?.isFile()) {
      if (path.extname(pathname)) {response.writeHead(404).end(); return;}
      file = path.join(root, 'index.html'); info = await stat(file);
    }
    response.writeHead(200, {'content-type':types[path.extname(file)] || 'application/octet-stream',
      'content-length':info.size, 'cache-control':pathname.startsWith('/assets/') ? 'public,max-age=31536000,immutable' : 'no-cache',
      'x-content-type-options':'nosniff'});
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  } catch {response.writeHead(400).end();}
}).listen(Number(process.argv[3] || 8080), '0.0.0.0');
