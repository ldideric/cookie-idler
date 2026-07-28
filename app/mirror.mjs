// Mirror the web build into /game. The live site is behind a bot challenge that
// blocks headless Chromium, and mirroring also pins the version for Steam.
//
//   docker compose run --rm cookie node mirror.mjs

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const BASE = process.env.MIRROR_BASE ?? 'https://orteil.dashnet.org/cookieclicker/';
const OUT = process.env.GAME_DIR ?? '/game';
const LANGS = (process.env.MIRROR_LANGS ?? 'EN').split(',').map((s) => s.trim());
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
         + 'Chrome/126.0.0.0 Safari/537.36';

// Entry points. Everything else is discovered by scanning these.
const SEEDS = [
  'index.html',
  'main.js',
  'base64.js',
  'style.css',
  'excanvas.compiled.js',
  ...LANGS.map((l) => `loc/${l}.js`),
];

const strip = (p) => p.split('?')[0].split('#')[0];

// The edge fingerprints the TLS ClientHello: undici and curl at their defaults
// get a 403 on the HTML (--http1.1 403, --http2 403, --tlsv1.3 200).
const HEADERS = [
  '-A', UA,
  '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  '-H', 'Accept-Language: en-US,en;q=0.9',
  '-H', 'Sec-Fetch-Dest: document',
  '-H', 'Sec-Fetch-Mode: navigate',
  '-H', 'Sec-Fetch-Site: none',
  '-H', 'Upgrade-Insecure-Requests: 1',
];

async function get(path) {
  const url = new URL(strip(path), BASE).href;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { stdout } = await execFileP(
        'curl',
        ['-sS', '--tlsv1.3', '--compressed', '--fail', '--max-time', '60', ...HEADERS, url],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      );
      if (!stdout.length) throw new Error('empty response');
      return stdout;
    } catch (e) {
      const msg = e.stderr?.toString().trim() || e.message;
      if (attempt === 3) throw new Error(`${path}: ${msg.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

async function save(path, buf) {
  const dest = join(OUT, strip(path));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return dest;
}

// Game.Loader sets `domain = Game.resPath + 'img/'` (main.js:2034) and Pic() is
// called with just `'filler.png'`, so bare filenames carry no directory.
function scanAssets(text) {
  const found = new Set();

  const explicit = /(?:img|snd)\/[A-Za-z0-9_.\-/]+\.(?:png|jpg|jpeg|gif|ico|mp3|ogg|wav|svg)/g;
  for (const m of text.matchAll(explicit)) found.add(m[0]);

  // The optional query matters: the game asks for 'youAddons.png?v='+version.
  const bare = /'([A-Za-z0-9_-]+\.(?:png|jpg|jpeg|gif))(?:\?[^']*)?'/g;
  for (const m of text.matchAll(bare)) found.add(`img/${m[1]}`);

  return found;
}

// Drop cache-busting query strings so paths match disk, and strip every external
// resource: the ad scripts are not behind `if (!LOCAL)` and would still load.
function cleanIndex(html) {
  let out = html;

  // main.js?v=13g -> main.js
  out = out.replace(/(src|href)="([^"?]+)\?[^"]*"/g, (m, attr, path) =>
    /^(https?:)?\/\//.test(path) ? m : `${attr}="${path}"`);

  out = out.replace(/<script[^>]+src="(?:https?:)?\/\/[^"]*"[^>]*>\s*<\/script>/gi, '');
  out = out.replace(/<link[^>]+href="(?:https?:)?\/\/fonts\.googleapis[^"]*"[^>]*>/gi, '');
  out = out.replace(/<iframe[^>]+src="https?:\/\/serve\.app\.playsaurus[^"]*"[^>]*>\s*<\/iframe>/gi, '');
  out = out.replace(/<noscript>\s*<img[^>]+facebook\.com[^>]*>\s*<\/noscript>/gi, '');
  // Local file, but it exists only to place ads.
  out = out.replace(/<script[^>]+src="showads\.js"[^>]*>\s*<\/script>/gi, '');

  // CDN-injected, at absolute paths on its edge, so mirrored they 404 locally.
  out = out.replace(/<style[^>]*>[^<]*cf-fonts[^<]*<\/style>/gi, '');
  out = out.replace(/<script[^>]*>[^<]*cdn-cgi\/challenge-platform[^<]*<\/script>/gi, '');
  out = out.replace(/<script[^>]+src="\/cdn-cgi\/[^"]*"[^>]*>\s*<\/script>/gi, '');

  return out;
}

// Minigames are named only as `Game.last.minigameUrl=...` (main.js:9113) and
// fetched once a building levels up, so nothing else references them. Anchored
// to skip the commented-out Dungeon entry (main.js:9135).
function scanMinigameScripts(js) {
  const out = new Set();
  for (const [, url] of js.matchAll(/^\s*Game\.last\.minigameUrl\s*=\s*'([^']+\.js)'/gm)) {
    out.add(url);
  }
  return out;
}

// Filenames the game assembles at runtime, which a scan for quoted names cannot
// see. Matching the patterns picks up new buildings and wallpapers for free.
function scanConstructedAssets(js) {
  const out = new Set();
  // art.pic=art.base+'.png', art.bg=art.base+'Background.png' (main.js:8043).
  for (const [, base] of js.matchAll(/\bbase:'([A-Za-z]+)'/g)) {
    out.add(`img/${base}.png`);
    out.add(`img/${base}Background.png`);
  }
  // No base; her variants are bare names, as in list.push('witchGrandma').
  for (const [, name] of js.matchAll(/'([A-Za-z]+Grandma)'/g)) out.add(`img/${name}.png`);
  if (js.includes("bg:'grandmaBackground.png'")) out.add('img/grandma.png');
  // Wallpapers, listed as {pic:'bgBlue'} and requested as pic+'.jpg'.
  for (const [, name] of js.matchAll(/pic:'(bg[A-Za-z]+)'/g)) out.add(`img/${name}.jpg`);
  return out;
}

/** Mirror the game into OUT. Returns {version, files, broken}. */
export async function runMirror() {
  console.log(`mirroring ${BASE}\n     into ${OUT}`);
  await mkdir(OUT, { recursive: true });

  const written = new Map();
  const failed = [];
  const discovered = new Set();
  const scripts = new Set();

  const fetchScript = async (path) => {
    try {
      const buf = await get(path);
      if (/\.(js|css|html)$/.test(path)) {
        const text = buf.toString('utf8');
        for (const a of scanAssets(text)) discovered.add(a);
        if (path.endsWith('.js')) {
          for (const a of scanConstructedAssets(text)) discovered.add(a);
          for (const s of scanMinigameScripts(text)) scripts.add(s);
        }
      }
      await save(path, path === 'index.html' ? Buffer.from(cleanIndex(buf.toString('utf8'))) : buf);
      written.set(path, buf.length);
      console.log(`  ${path}  (${(buf.length / 1024).toFixed(0)} KB)`);
    } catch (e) {
      failed.push(e.message);
      console.log(`  MISS ${e.message}`);
    }
  };

  for (const seed of SEEDS) await fetchScript(seed);

  // Scanned too, since a minigame's own artwork is referenced only inside it.
  for (const script of scripts) {
    if (!written.has(script)) await fetchScript(script);
  }

  for (const extra of ['img/favicon.ico']) discovered.add(extra);

  console.log(`\ndiscovered ${discovered.size} media assets, fetching...`);

  const queue = [...discovered];
  let ok = 0;
  const worker = async () => {
    while (queue.length) {
      const path = queue.shift();
      try {
        const buf = await get(path);
        await save(path, buf);
        written.set(path, buf.length);
        ok++;
      } catch (e) {
        failed.push(e.message);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`  fetched ${ok}/${discovered.size}`);

  if (!written.has('index.html')) {
    throw new Error('index.html was not mirrored; cannot continue');
  }

  const indexText = await readFile(join(OUT, 'index.html'), 'utf8');
  const version = indexText.match(/var\s+VERSION\s*=\s*([0-9.]+)/)?.[1] ?? 'unknown';
  await writeFile(join(OUT, 'version.txt'), `${version}\n`);

  const totalKB = [...written.values()].reduce((a, b) => a + b, 0) / 1024;
  console.log(`\nversion ${version}, ${written.size} files, ${(totalKB / 1024).toFixed(1)} MB`);

  // Upstream references assets it never published (img/bgWheat.jpg), so only a
  // non-404 means the mirror itself is broken.
  const dead = failed.filter((f) => /error: 404/.test(f));
  const broken = failed.filter((f) => !/error: 404/.test(f));

  if (dead.length) {
    console.log(`\n${dead.length} dead upstream reference(s), ignored:`);
    for (const f of dead) console.log(`  ${f.split(':')[0]}`);
  }
  if (broken.length) {
    console.log(`\n${broken.length} failed:`);
    for (const f of broken.slice(0, 15)) console.log(`  ${f}`);
  }
  console.log(broken.length ? '\nmirror incomplete' : '\nmirror complete');
  return { version, files: written.size, broken: broken.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { broken } = await runMirror();
  process.exit(broken ? 1 : 0);
}
