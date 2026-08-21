// Minimal Chrome DevTools Protocol client over Node's global WebSocket.
// The Playwright image ships Chromium but not the npm package.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';

const MS_PLAYWRIGHT = '/ms-playwright';
const SEND_TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS ?? 30_000);

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const dirs = readdirSync(MS_PLAYWRIGHT).filter((d) => d.startsWith('chromium-'));
  for (const d of dirs) {
    // x64 unpacks Chrome for Testing into chrome-linux64; arm64 is Playwright's
    // own build, in chrome-linux.
    for (const layout of ['chrome-linux64', 'chrome-linux']) {
      const p = `${MS_PLAYWRIGHT}/${d}/${layout}/chrome`;
      if (existsSync(p)) return p;
    }
  }
  throw new Error(`no chromium found under ${MS_PLAYWRIGHT}`);
}

export const CHROME_ARGS = [
  // Background throttling clamps setTimeout to 1 Hz; the logic loop is
  // setTimeout-driven (main.js:17243) and only compensates 5s (main.js:17231).
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  // /dev/shm defaults to 64 MB in a container, and Swarm ignores `shm_size:`.
  '--disable-dev-shm-usage',
  // A second tab is a second game, autosaving over the first one's save.
  '--block-new-web-contents',
  '--no-sandbox',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  // Not setDeviceMetricsOverride, which silently stops the screencast emitting.
  // Headless reserves ~143px of height, leaving a ~1707x960 viewport.
  `--window-size=${process.env.COOKIE_WIN_W ?? 1707},${process.env.COOKIE_WIN_H ?? 1103}`,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A killed container leaves these behind and the next start refuses to launch.
// Only one Chromium runs against this profile, so a lock here is always stale.
function clearStaleLocks(profileDir) {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { unlinkSync(`${profileDir}/${name}`); } catch { /* absent, fine */ }
  }
}

export function launchChrome({ profileDir = '/profile', port = 9222, extraArgs = [] } = {}) {
  clearStaleLocks(profileDir);
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=0.0.0.0',
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    ...CHROME_ARGS,
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(findChrome(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (b) => {
    const s = b.toString().trim();
    if (/ERROR|FATAL/.test(s)) console.error(`[chrome] ${s.slice(0, 200)}`);
  });
  return proc;
}

export async function waitForDevTools(port = 9222, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('devtools endpoint did not come up');
}

// One WebSocket, with `sessionId` routing to reach a page target through the
// browser-level socket.
export class CDP {
  #ws; #nextId = 1; #pending = new Map(); #handlers = new Map();

  static async connect(wsUrl) {
    const c = new CDP();
    await c.#open(wsUrl);
    return c;
  }

  #open(wsUrl) {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.addEventListener('open', () => resolve());
      this.#ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e.message ?? e}`)));
      this.#ws.addEventListener('close', () => {
        for (const { reject: rj } of this.#pending.values()) rj(new Error('cdp socket closed'));
        this.#pending.clear();
        this.#emit('__closed', {});
      });
      this.#ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    });
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) this.#emit(msg.method, msg.params ?? {}, msg.sessionId);
  }

  #emit(method, params, sessionId) {
    for (const h of this.#handlers.get(method) ?? []) h(params, sessionId);
  }

  on(method, handler) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, new Set());
    this.#handlers.get(method).add(handler);
    return () => this.#handlers.get(method)?.delete(handler);
  }

  // A browser killed outright can leave the socket open with the request never
  // answered, and the close event that would reject it never arrives. Without a
  // deadline the caller waits forever: the watchdog stops striking and /up stops
  // answering, both silently.
  send(method, params = {}, sessionId, { timeoutMs = SEND_TIMEOUT_MS } = {}) {
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      const settle = (fn) => (arg) => { clearTimeout(timer); fn(arg); };
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      try {
        this.#ws.send(JSON.stringify(payload));
      } catch (e) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  close() { try { this.#ws.close(); } catch { /* already gone */ } }
}

/** Attach to a page target, creating one if there is none. */
export async function attachToPage(cdp, { url = 'about:blank' } = {}) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  let target = targetInfos.find((t) => t.type === 'page');
  if (!target) {
    const { targetId } = await cdp.send('Target.createTarget', { url });
    target = { targetId };
  }
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  return { sessionId, targetId: target.targetId };
}

export async function evaluate(cdp, sessionId, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(d.exception?.description ?? d.text ?? 'evaluate failed');
  }
  return res.result?.value;
}

export async function waitFor(cdp, sessionId, expression, { timeoutMs = 90_000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, sessionId, expression)) return true;
    } catch { /* page may be mid-navigation */ }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for: ${expression}`);
}

export { sleep };
