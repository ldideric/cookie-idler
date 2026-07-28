// Serves the mirrored game on localhost, which flips the game's LOCAL flag
// (index.html:10) and disables the tracking pixel, consent banner and ad slots.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

export function startGameServer({
  gameDir, modsDir, port = 8080, presetMods = () => [], modLoader = () => '// no mods\n',
}) {
  const serveFile = async (res, file, cache = 'public, max-age=31536000') => {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': cache,
    });
    createReadStream(file).pipe(res);
  };

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);

    // Generated per request, so toggling a mod needs a reload, not a restart.
    if (path === '/mods-loader.js') {
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
      res.end(modLoader());
      return;
    }

    // Real directory paths, so document.currentScript.src resolves for a mod
    // loading its own siblings.
    if (path.startsWith('/mods/') && modsDir) {
      const rel = normalize(path.slice('/mods/'.length)).replace(/^(\.\.[/\\])+/, '');
      const file = join(modsDir, rel);
      if (!file.startsWith(modsDir)) { res.writeHead(403).end('nope'); return; }
      try {
        await serveFile(res, file, 'no-store');
      } catch {
        // A re-mirror can add a file that 404'd before, and the game keeps one
        // Image per filename, so a cached 404 would outlive the fix.
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('404');
      }
      return;
    }

    const rel = path === '/' ? 'index.html' : normalize(path).replace(/^(\.\.[/\\])+/, '').slice(1);
    const file = join(gameDir, rel);
    if (!file.startsWith(gameDir)) { res.writeHead(403).end('nope'); return; }

    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');

      if (rel === 'index.html') {
        // The game loads every URL in PRESETMODS before starting (main.js:17285),
        // so rewriting that one line is its own intended way in for mods.
        let html = await readFile(file, 'utf8');
        const list = presetMods().map((u) => JSON.stringify(u)).join(',');
        html = html.replace(/var\s+PRESETMODS\s*=\s*\[[^\]]*\]\s*;/, `var PRESETMODS=[${list}];`);
        res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      await serveFile(res, file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('404');
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
