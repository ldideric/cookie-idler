// Launches Chromium on the mirrored game, keeps it idling with rendering off,
// and serves the control page.
//
// Game.visible=false makes main.js:17211 skip Game.Draw() while the logic loop
// runs at full speed regardless, so an unwatched idler pays for logic only.

import { createServer } from 'node:http';
import { readFile, writeFile, readdir, unlink, mkdir, access, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  launchChrome, waitForDevTools, CDP, attachToPage, evaluate, waitFor, sleep,
} from './cdp.mjs';
import { startGameServer } from './gameserver.mjs';
import { resolveMods, saveState, buildLoader, installMods, removeMod } from './modmanager.mjs';
import { runMirror } from './mirror.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = process.env.GAME_DIR ?? '/game';
const MODS_DIR = process.env.MODS_DIR ?? '/mods';
// Optional read-only template copied into MODS_DIR on first boot.
const MODS_SEED_DIR = process.env.MODS_SEED_DIR ?? '';
const SAVES_DIR = process.env.SAVES_DIR ?? '/saves';
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 3000);
const GAME_PORT = Number(process.env.GAME_PORT ?? 8080);
const STEAM_VERSION = process.env.COOKIE_STEAM_VERSION ?? '';
const BACKUP_EVERY_MS = Number(process.env.BACKUP_EVERY_MS ?? 30 * 60 * 1000);
const BACKUP_KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS ?? 14);
const WATCHDOG_EVERY_MS = Number(process.env.WATCHDOG_EVERY_MS ?? 60 * 1000);
const NTFY_URL = process.env.COOKIE_NTFY_URL ?? '';   // e.g. http://ntfy/cookie
// Roomy next to the largest mods (CCSE is about a megabyte).
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 32 * 1024 * 1024);

// 16:9-ish, so the game's three columns get horizontal room.
const VIEW_W = Number(process.env.COOKIE_VIEW_W ?? 1707);
const VIEW_H = Number(process.env.COOKIE_VIEW_H ?? 960);

// Only the prefs that affect the logic loop; visual settings stay the player's.
//   timeout=0  sleep mode freezes cookie production (main.js:17176).
//   focus=0    a headless page is never focused, and focus=1 redraws sluggishly.
//
// Applied again after the save lands: Game.ready=1 goes up as soon as the load
// starts (main.js:16501), so pinning at ready alone is overwritten by the save.
//
// #darken is the intro overlay, faded out only inside Game.Draw. With rendering
// off it stays opaque forever, painting the view black and eating every click.
const IDLE_PREFS = `
  Game.prefs.timeout = 0;
  Game.prefs.focus = 0;
  Game.visible = false;
  (function(){
    if (document.getElementById('idlerStyle')) return;
    var s = document.createElement('style');
    s.id = 'idlerStyle';
    s.textContent = '#darken{pointer-events:none!important;opacity:0!important}';
    document.head.appendChild(s);
  })();
  true;
`;

const state = {
  cdp: null,
  sessionId: null,
  targetId: null,
  chrome: null,
  screencasting: false,
  lastVersion: null,
};

const GAME_URL = `http://127.0.0.1:${GAME_PORT}/`;

let enabledMods = [];

async function refreshMods() {
  const all = await resolveMods(MODS_DIR);
  enabledMods = all.filter((m) => m.enabled);
  return all;
}

async function bootGame() {
  state.chrome = launchChrome({ profileDir: process.env.PROFILE_DIR ?? '/profile' });
  const info = await waitForDevTools();
  state.cdp = await CDP.connect(info.webSocketDebuggerUrl);
  const { sessionId, targetId } = await attachToPage(state.cdp);
  state.sessionId = sessionId;
  state.targetId = targetId;

  await state.cdp.send('Runtime.enable', {}, sessionId);
  await state.cdp.send('Page.enable', {}, sessionId);
  await state.cdp.send('Network.enable', {}, sessionId);

  // Headless throttles the sole tab's compositor, and Page.startScreencast then
  // emits zero frames for the game's canvas.
  for (const [method, params] of [
    ['Page.setWebLifecycleState', { state: 'active' }],
    ['Emulation.setFocusEmulationEnabled', { enabled: true }],
    ['Page.bringToFront', {}],
  ]) {
    try { await state.cdp.send(method, params, sessionId); } catch { /* best effort */ }
  }

  // Or a fresh profile stops on the language chooser, which blocks clicks.
  await state.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('CookieClickerLang', ${JSON.stringify(process.env.COOKIE_LANG ?? 'EN')}); } catch (e) {}`,
  }, sessionId);

  // The live view has no Back button, so a link that navigates away is fatal.
  state.cdp.on('Page.frameNavigated', ({ frame }) => {
    if (frame.parentId || !/^https?:/.test(frame.url) || frame.url.startsWith(GAME_URL)) return;
    console.log(`[sidecar] tab wandered off to ${frame.url.slice(0, 80)}, going back to the game`);
    loadGame().catch((e) => console.error('[sidecar] could not return to the game:', e.message));
  });

  state.cdp.on('Page.screencastFrame', async ({ data, sessionId: sid }, evSid) => {
    broadcastFrame(data);
    try {
      await state.cdp.send('Page.screencastFrameAck', { sessionId: sid }, evSid || state.sessionId);
    } catch { /* viewer race, ignore */ }
  });

  await loadGame();
}

async function pinIdlePrefs() {
  await evaluate(state.cdp, state.sessionId, IDLE_PREFS).catch(() => {});
}

// A second tab is a second copy of the game, autosaving over the shared storage
// key every minute until one run is gone.
async function closeStrayPages() {
  let targetInfos;
  try { ({ targetInfos } = await state.cdp.send('Target.getTargets')); } catch { return; }
  for (const t of targetInfos) {
    if (t.type !== 'page' || t.targetId === state.targetId) continue;
    console.log(`[sidecar] closing stray page ${t.targetId.slice(0, 12)} (${t.url.slice(0, 60)})`);
    await state.cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
  }
}

async function loadGame() {
  await refreshMods();
  await closeStrayPages();
  // The game's loader keeps one Image per filename for the life of the page, so
  // a cached 404 would survive the re-mirror that fixed it.
  await state.cdp.send('Network.clearBrowserCache', {}, state.sessionId).catch(() => {});
  await state.cdp.send('Page.navigate', { url: GAME_URL }, state.sessionId);
  await waitFor(state.cdp, state.sessionId, 'window.Game && Game.ready === 1');
  await pinIdlePrefs();

  // Game.ready goes up before the save has landed (main.js:16491), so wait for
  // a second's worth of ticks before judging the run.
  await waitFor(state.cdp, state.sessionId, 'Game.loopT >= 30', { timeoutMs: 30_000 })
    .catch(() => { /* judged on the fingerprints below, not on this */ });
  await pinIdlePrefs();

  state.lastVersion = await evaluate(state.cdp, state.sessionId, 'Game.version');

  // Before the mods, so a mod reading the run on init sees the save being kept.
  await restoreIfLost();
  await initLateMods();

  resetWatchdogBaseline();
  console.log(`[sidecar] game ready, version ${state.lastVersion}, ` +
              `${enabledMods.length} mod(s) enabled`);
}

/**
 * Game.launchMods() runs at main.js:16482 while the loader is still pulling mod
 * scripts, and registerMod self-initialises only once Game.ready is up
 * (main.js:1154). A mod registering between the two is never initialised.
 */
async function initLateMods() {
  if (!enabledMods.length) return;
  await waitFor(state.cdp, state.sessionId, 'window.__cookieModsDone === true', { timeoutMs: 30_000 })
    .catch(() => console.error('[sidecar] mods did not finish loading in time'));
  await evaluate(state.cdp, state.sessionId, 'Game.launchMods(); true;').catch(() => {});
}

/**
 * Which run a save belongs to and how far it got. Null if it does not decode.
 *
 * WriteSave(1) returns escape(utf8_to_b64(raw)+'!END!') (main.js:3048). Decoded
 * as latin1, since every field read here is ASCII digits.
 *
 *   lineage  legacy start date (main.js:2881), changing only on replace or wipe.
 *   baked    earned this run plus carried from past runs, so within one lineage
 *            it only ever grows.
 */
function fingerprint(saveString) {
  try {
    const b64 = unescape(String(saveString)).split('!END!')[0];
    if (!b64) return null;
    const raw = Buffer.from(b64, 'base64').toString('latin1');
    const parts = raw.split('|');
    if (parts.length < 5) return null;
    const details = parts[2].split(';');
    const misc = parts[4].split(';');
    const lineage = parseInt(details[1]);
    const earned = parseFloat(misc[1]);
    const fromPastRuns = parseFloat(misc[8]);
    const lastDate = parseInt(details[2]);
    if (!Number.isFinite(lineage) || !Number.isFinite(earned)) return null;
    return {
      lineage,
      baked: earned + (Number.isFinite(fromPastRuns) ? fromPastRuns : 0),
      lastDate: Number.isFinite(lastDate) ? lastDate : 0,
      ascensions: parseInt(misc[14]) || 0,
    };
  } catch {
    return null;
  }
}

const describe = (fp) => fp
  ? `run ${new Date(fp.lineage).toISOString().slice(0, 10)}, ` +
    `${fp.baked.toExponential(3)} baked, ${fp.ascensions} ascension(s)`
  : 'unreadable';

/** Every backup that decodes, oldest first. Names sort chronologically. */
async function listBackups() {
  let files;
  try { files = await readdir(SAVES_DIR); } catch { return []; }
  const out = [];
  for (const name of files.filter((f) => /^cookieclicker-.*\.txt$/.test(f)).sort()) {
    let text;
    try { text = await readFile(join(SAVES_DIR, name), 'utf8'); } catch { continue; }
    const fp = fingerprint(text);
    if (fp) out.push({ name, fp });
  }
  return out;
}

async function liveFingerprint() {
  try {
    const r = await evaluate(state.cdp, state.sessionId,
      '({ lastDate: Game.lastDate || 0, save: Game.WriteSave(1) })');
    const fp = fingerprint(r?.save);
    // WriteSave stamps lastDate with the current time (main.js:2875), but what
    // matters is the age of the copy the game booted from.
    if (fp) fp.lastDate = r.lastDate;
    return fp;
  } catch {
    return null;
  }
}

/**
 * localStorageSet swallows every exception (main.js:140) and the game's own check
 * only notices a missing key, so a browser that has stopped persisting looks
 * healthy until the next reload. Hence the read-back.
 */
async function persistSave() {
  let r;
  try {
    r = await evaluate(state.cdp, state.sessionId, `(function () {
      Game.WriteSave();
      var stored = '';
      try { stored = localStorage.getItem(Game.SaveTo) || ''; } catch (e) {}
      return { stored: stored, live: Game.WriteSave(1) };
    })()`);
  } catch (e) {
    console.error('[sidecar] could not write the save:', e.message);
    return false;
  }
  const live = fingerprint(r?.live);
  const stored = fingerprint(r?.stored);
  const ok = !!live && !!stored
    && stored.lineage === live.lineage && stored.baked === live.baked;
  if (!ok) {
    console.error(`[sidecar] the browser did not persist the save ` +
                  `(live: ${describe(live)}, stored: ${describe(stored)})`);
    await notify('Cookie idler cannot save',
      'The game wrote its save but the browser did not keep it. Progress since the ' +
      'last backup is only in memory; export a save now.', 'urgent');
  }
  return ok;
}

/**
 * After every load, not just a cold boot: if localStorage has gone empty the game
 * silently starts a new run (main.js:16491) and reports itself ready. Timestamps
 * cannot see this, since the fresh run is the newer one, so this compares the
 * lineage and the all-time bake count instead.
 */
async function restoreIfLost() {
  const backups = await listBackups();
  if (!backups.length) return;
  const newest = backups[backups.length - 1];

  const live = await liveFingerprint();
  if (!live) {
    console.error('[sidecar] could not read the live save; leaving it alone');
    return;
  }

  const lostProgress = newest.fp.baked > live.baked;
  // Chromium buffers localStorage, so an unclean stop loses the last writes and
  // the shutdown backup is the truer copy.
  const staleStorage = newest.fp.lineage === live.lineage && newest.fp.lastDate > live.lastDate;
  if (!lostProgress && !staleStorage) return;

  let text;
  try { text = await readFile(join(SAVES_DIR, newest.name), 'utf8'); } catch { return; }
  await evaluate(state.cdp, state.sessionId,
    `Game.ImportSaveCode(${JSON.stringify(text)})`).catch(() => {});
  // Importing replays Game.LoadSave, restoring the save's own prefs.
  await pinIdlePrefs();

  // ImportSaveCode reports nothing useful, so check the game. ">=" because the
  // loaded run bakes while being read back; the lineage is the identity check.
  const now = await liveFingerprint();
  const took = !!now && now.lineage === newest.fp.lineage && now.baked >= newest.fp.baked;
  await persistSave();

  console.log(`[sidecar] ${took ? 'restored' : 'FAILED to restore'} ${newest.name} ` +
              `over the loaded save (loaded: ${describe(live)}; ` +
              `backup: ${describe(newest.fp)}; now: ${describe(now)})`);

  // A different lineage is a different run, not a routine catch-up.
  if (newest.fp.lineage !== live.lineage || !took) {
    await notify(took ? 'Cookie idler lost its save' : 'Cookie idler could not restore its save',
      `The game came back as ${describe(live)}. ${took ? 'Restored' : 'Tried to restore'} ` +
      `${newest.name} (${describe(newest.fp)}).`, took ? 'high' : 'urgent');
  }
}

const frameClients = new Set();   // SSE responses receiving base64 JPEG frames

// Liveness is writableEnded/destroyed only: res.write() returning false is
// backpressure, normal for a frame stream, and treating it as death drops every
// viewer and hangs the page on "connecting".
function broadcastFrame(b64) {
  const chunk = `data: ${b64}\n\n`;
  for (const res of frameClients) {
    if (res.writableEnded || res.destroyed) { dropClient(res); continue; }
    if (res.writableLength > 2_000_000) continue;   // backpressured: skip a frame
    res.write(chunk);
  }
}

function dropClient(res) {
  if (!frameClients.delete(res)) return;
  try { res.end(); } catch { /* already gone */ }
  if (frameClients.size === 0) stopScreencast();
}

async function startScreencast() {
  if (state.screencasting) return;
  state.screencasting = true;
  await evaluate(state.cdp, state.sessionId, 'Game.visible = true; true;').catch(() => {});
  await state.cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 72, maxWidth: VIEW_W, maxHeight: VIEW_H, everyNthFrame: 1,
  }, state.sessionId);
  console.log('[sidecar] view on');
}

async function stopScreencast() {
  if (!state.screencasting) return;
  state.screencasting = false;
  try { await state.cdp.send('Page.stopScreencast', {}, state.sessionId); } catch {}
  await evaluate(state.cdp, state.sessionId, 'Game.visible = false; true;').catch(() => {});
  console.log('[sidecar] view off (idle)');
}

function addClient(res) { frameClients.add(res); if (frameClients.size === 1) startScreencast(); }

// DOM MouseEvents, not CDP input: an OS-level press/release synthesises no
// `click` here. detail:1 keeps the click rate-limit on its fast path
// (main.js:4993).
async function dispatchClick(x, y) {
  const expr = `(function(x,y){
    var el = document.elementFromPoint(x,y);
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click',
      {bubbles:true,cancelable:true,clientX:x,clientY:y,detail:1}));
    return true;
  })(${Math.round(x)},${Math.round(y)})`;
  await evaluate(state.cdp, state.sessionId, expr);
}

// A real CDP wheel event; a synthetic WheelEvent does not scroll natively.
async function dispatchScroll(x, y, deltaY) {
  await state.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY,
  }, state.sessionId);
}

// windowsVirtualKeyCode is set for the keys the game reads via keyCode.
async function dispatchKey(key) {
  const code = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
  const base = { key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await state.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, state.sessionId);
  await state.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, state.sessionId);
}

/**
 * Game.WriteSave(1) exports without touching disk (main.js:2871). The patched
 * variant is a community workaround for a version mismatch with Steam.
 */
async function exportSave() {
  const raw = await evaluate(state.cdp, state.sessionId, 'Game.WriteSave(1)');
  let patched = null;
  if (STEAM_VERSION && state.lastVersion && String(state.lastVersion) !== STEAM_VERSION) {
    try {
      const decoded = Buffer.from(decodeURIComponent(raw.split('!END!')[0]), 'base64');
      const text = decoded.toString('binary');
      patched = text.replace(/^[0-9.]+\|/, `${STEAM_VERSION}|`);
    } catch { /* leave patched null */ }
  }
  return { raw, patched, version: state.lastVersion };
}

async function notify(title, message, priority = 'default') {
  if (!NTFY_URL) return;
  try {
    await fetch(NTFY_URL, {
      method: 'POST',
      headers: { Title: title, Priority: priority, Tags: 'cookie' },
      body: message,
    });
  } catch (e) {
    console.error('[sidecar] ntfy failed:', e.message);
  }
}

/**
 * A timestamped export, written .part then renamed so an external backup never
 * catches a half-written file. One that would lose ground is refused: a game
 * that reset itself would otherwise write its empty state every half hour until
 * the good save aged out of retention.
 */
async function backupSave(reason = 'periodic') {
  try {
    const { raw } = await exportSave();
    if (!raw || raw.length < 20) throw new Error('export looked empty');

    if (reason !== 'import') {
      const backups = await listBackups();
      const newest = backups[backups.length - 1];
      const fp = fingerprint(raw);
      if (!fp) throw new Error('export did not decode');
      if (newest && newest.fp.baked > fp.baked) {
        console.error(`[sidecar] refusing to back up a save that lost ground ` +
                      `(live: ${describe(fp)}; newest backup ${newest.name}: ${describe(newest.fp)})`);
        await notify('Cookie idler save went backwards',
          `Not writing a backup: the game is at ${describe(fp)} but ${newest.name} ` +
          `holds ${describe(newest.fp)}. The good save is kept.`, 'high');
        return null;
      }
    }

    await mkdir(SAVES_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `cookieclicker-${stamp}.txt`;
    const part = join(SAVES_DIR, name + '.part');
    await writeFile(part, raw);
    await (await import('node:fs/promises')).rename(part, join(SAVES_DIR, name));
    await pruneBackups();
    console.log(`[sidecar] backup written (${reason}): ${name}`);
    return name;
  } catch (e) {
    console.error(`[sidecar] backup failed (${reason}):`, e.message);
    return null;
  }
}

/**
 * Never ages out the newest or the one holding the most progress: after a reset
 * the best save is also the oldest, and retention would delete it a fortnight on.
 */
async function pruneBackups() {
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400_000;
  let files;
  try { files = await readdir(SAVES_DIR); } catch { return; }

  const backups = await listBackups();
  const keep = new Set();
  if (backups.length) {
    keep.add(backups[backups.length - 1].name);
    keep.add(backups.reduce((a, b) => (b.fp.baked > a.fp.baked ? b : a)).name);
  }

  for (const f of files) {
    if (!/^cookieclicker-.*\.txt(\.part)?$/.test(f)) continue;
    if (keep.has(f)) continue;
    const m = f.match(/cookieclicker-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
    if (t && t < cutoff) {
      try { await unlink(join(SAVES_DIR, f)); } catch {}
    }
  }
}

/**
 * Game.loopT ticks once per logic frame (main.js:17241), so a stuck loopT means
 * no cookies. Escalates rather than reloading on one sample, because a busy page
 * can crawl for a minute of its own accord (main.js:17193). Sleep mode is the
 * exception: Game.Resume fixes it in place (main.js:2057).
 */
const STALL_STRIKES = Number(process.env.STALL_STRIKES ?? 3);
let lastLoopT = -1;
let strikes = 0;

function resetWatchdogBaseline() { lastLoopT = -1; strikes = 0; }

async function watchdog() {
  let s = null;
  try {
    s = await evaluate(state.cdp, state.sessionId,
      '({loopT: Game.loopT, timedout: !!Game.timedout})');
  } catch { /* browser gone */ }

  if (s?.timedout) {
    console.error('[sidecar] watchdog: game dropped into sleep mode, resuming');
    await evaluate(state.cdp, state.sessionId, 'Game.Resume(); true;').catch(() => {});
    // Resume replays Game.LoadSave, restoring the save's own prefs.
    await pinIdlePrefs();
    resetWatchdogBaseline();
    return;
  }

  const loopT = s?.loopT ?? null;
  if (loopT != null && loopT !== lastLoopT) {
    lastLoopT = loopT;
    strikes = 0;
    return;
  }

  strikes++;
  console.error(`[sidecar] watchdog: loop not advancing (loopT=${loopT}), ` +
                `strike ${strikes}/${STALL_STRIKES}`);
  if (strikes < STALL_STRIKES) return;

  await notify('Cookie idler stalled',
    `loopT stuck at ${loopT} for ${STALL_STRIKES} checks; reloading the game.`, 'high');
  try {
    await loadGame();
  } catch (e) {
    console.error('[sidecar] reload failed, rebooting browser:', e.message);
    try { state.chrome?.kill('SIGKILL'); } catch {}
    await sleep(1000);
    await bootGame();
  }
  resetWatchdogBaseline();
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      req.destroy();
      const e = new Error(`body larger than ${limit} bytes`);
      e.status = 413;
      throw e;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

async function handleControl(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  try {
    if (path === '/' || path === '/index.html') {
      const html = await readFile(join(HERE, 'public', 'control.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (path === '/shot.jpg') {
      const wasCasting = state.screencasting;
      if (!wasCasting) await evaluate(state.cdp, state.sessionId, 'Game.visible = true; true;');
      await sleep(400);
      const shot = await state.cdp.send('Page.captureScreenshot',
        { format: 'jpeg', quality: 70 }, state.sessionId);
      if (!wasCasting && frameClients.size === 0) {
        await evaluate(state.cdp, state.sessionId, 'Game.visible = false; true;').catch(() => {});
      }
      const buf = Buffer.from(shot.data, 'base64');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length,
        'Cache-Control': 'no-store' });
      res.end(buf);
      return;
    }

    if (path === '/up') {
      // Whether the game is ticking, not merely whether the process is up.
      let loopT = null, cookies = null, cps = null;
      try {
        const s = await evaluate(state.cdp, state.sessionId,
          '({loopT: Game.loopT, cookies: Game.cookies, cps: Game.cookiesPs})');
        loopT = s.loopT; cookies = s.cookies; cps = s.cps;
      } catch { /* browser down */ }
      json(res, loopT == null ? 503 : 200, {
        ok: loopT != null, loopT, cookies, cps,
        version: state.lastVersion, viewers: frameClients.size,
      });
      return;
    }

    if (path === '/frames') {
      // One base64 JPEG per message; input comes back over plain POSTs.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      addClient(res);
      req.on('close', () => dropClient(res));
      return;
    }

    if (path === '/input/click' && req.method === 'POST') {
      const { x, y } = JSON.parse(await readBody(req));
      await dispatchClick(x, y);
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/input/scroll' && req.method === 'POST') {
      const { x, y, deltaY } = JSON.parse(await readBody(req));
      await dispatchScroll(x, y, deltaY);
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/input/key' && req.method === 'POST') {
      const { key } = JSON.parse(await readBody(req));
      await dispatchKey(key);
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/api/mods' && req.method === 'GET') {
      const all = await resolveMods(MODS_DIR);
      const errors = await evaluate(state.cdp, state.sessionId, 'window.__cookieModErrors || {}')
        .catch(() => ({}));
      json(res, 200, { mods: all, errors });
      return;
    }

    if (path === '/api/mods' && req.method === 'POST') {
      // Body: [{folder, enabled, order}]. Takes effect on the next reload.
      const list = JSON.parse(await readBody(req));
      await saveState(MODS_DIR, list);
      await refreshMods();
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/api/mods/upload' && req.method === 'POST') {
      // Body: {name, files: {"<relative path>": "<base64>"}}. No reload: a new
      // mod arrives disabled, and enabling it is a deliberate act.
      const body = JSON.parse(await readBody(req));
      const files = Object.entries(body?.files ?? {}).map(([p, b64]) => ({
        path: p, data: Buffer.from(String(b64), 'base64'),
      }));
      if (!files.length) { json(res, 400, { error: 'no files in that upload' }); return; }
      const { installed, skipped } = await installMods(MODS_DIR, { name: body?.name, files });
      console.log(`[sidecar] installed ${installed.map((m) => m.folder).join(', ') || '(none)'}` +
                  `${skipped ? `, skipped ${skipped} file(s)` : ''}`);
      json(res, 200, { ok: true, installed, skipped });
      return;
    }

    if (path.startsWith('/api/mods/') && req.method === 'DELETE') {
      const removed = await removeMod(MODS_DIR, decodeURIComponent(path.slice('/api/mods/'.length)));
      // Rebuild the loader, or an enabled mod 404s from it on the next reload.
      await refreshMods();
      console.log(`[sidecar] removed mod ${removed}`);
      json(res, 200, { ok: true, removed });
      return;
    }

    if (path === '/api/reload' && req.method === 'POST') {
      await loadGame();
      json(res, 200, { ok: true, version: state.lastVersion });
      return;
    }

    if (path === '/save/import' && req.method === 'POST') {
      const code = (await readBody(req)).trim();
      if (!code) { json(res, 400, { error: 'empty' }); return; }
      const wanted = fingerprint(code);
      if (!wanted) { json(res, 422, { error: 'that does not decode as a save' }); return; }

      await evaluate(state.cdp, state.sessionId, `Game.ImportSaveCode(${JSON.stringify(code)})`);
      // Importing replays Game.LoadSave, restoring the save's own prefs.
      await pinIdlePrefs();

      // Backed up straight away: until that file exists the import lives only in
      // the browser. ">=" because the run bakes while being read back.
      const live = await liveFingerprint();
      const ok = !!live && live.lineage === wanted.lineage && live.baked >= wanted.baked;
      const persisted = ok ? await persistSave() : false;
      if (ok) await backupSave('import');
      json(res, ok ? 200 : 422, { ok, persisted });
      return;
    }

    if (path === '/save') {
      const { raw, patched, version } = await exportSave();
      const wantPatched = url.searchParams.get('patched') === '1' && patched;
      const body = wantPatched ? patched : raw;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="cookieclicker-${version}-${stamp}.txt"`,
      });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404');
  } catch (e) {
    console.error('[sidecar] control error:', e.message);
    json(res, e.status ?? 500, { error: e.message });
  }
}

// The game is not ours to redistribute, so the mirror is fetched at runtime.
// After a game update, run `node mirror.mjs` in the container and reload.
try {
  await access(join(GAME_DIR, 'index.html'));
} catch {
  console.log('[sidecar] game mirror missing, fetching it now...');
  await runMirror();
}

// Additive, so it never clobbers uploads or runtime enable/order changes.
if (MODS_SEED_DIR) {
  let seedEntries = null;
  try {
    await access(MODS_SEED_DIR);
    seedEntries = await readdir(MODS_SEED_DIR, { withFileTypes: true });
  } catch {
  }
  if (seedEntries) try {
    await mkdir(MODS_DIR, { recursive: true });
    for (const e of seedEntries) {
      const isMod = e.isDirectory();
      if (!isMod && e.name !== 'mods.json') continue;
      const dest = join(MODS_DIR, e.name);
      try { await access(dest); continue; } catch { /* missing, seed it */ }
      await cp(join(MODS_SEED_DIR, e.name), dest, { recursive: true });
      console.log(`[sidecar] seeded ${e.name}`);
    }
  } catch (e) {
    console.error('[sidecar] mod seeding failed:', e.message);
  }
}

await startGameServer({
  gameDir: GAME_DIR,
  modsDir: MODS_DIR,
  port: GAME_PORT,
  presetMods: () => ['/mods-loader.js'],
  modLoader: () => buildLoader(enabledMods),
});
console.log(`[sidecar] game server on 127.0.0.1:${GAME_PORT}`);

await bootGame();

const control = createServer(handleControl);
control.listen(CONTROL_PORT, '0.0.0.0', () =>
  console.log(`[sidecar] control on 0.0.0.0:${CONTROL_PORT}`));

// First backup shortly after boot, so a save exists early.
const backupTimer = setInterval(() => backupSave('periodic'), BACKUP_EVERY_MS);
const watchdogTimer = setInterval(watchdog, WATCHDOG_EVERY_MS);
setTimeout(() => backupSave('startup'), 15_000);

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[sidecar] ${sig}, shutting down`);
  clearInterval(backupTimer);
  clearInterval(watchdogTimer);
  // The backup is the authoritative final state, so continuity does not depend
  // on the localStorage flush. Chromium still gets a graceful close, under a
  // timeout.
  try { await backupSave('shutdown'); } catch {}
  try { await stopScreencast(); } catch {}
  const exited = state.chrome
    ? new Promise((r) => state.chrome.once('exit', r))
    : Promise.resolve();
  try { state.cdp?.close(); } catch {}
  try { state.chrome?.kill('SIGTERM'); } catch {}
  await Promise.race([exited, sleep(4000)]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
