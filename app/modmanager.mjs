// Discovers mods on disk, tracks which are enabled and in what order, and
// generates the loader that pulls them into the game.
//
// Never concatenated into a bundle: that nulls document.currentScript, which a
// multi-file mod reads to find its own directory. Separate scripts also stop one
// syntax error taking down the rest.

import { readdir, readFile, writeFile, stat, mkdir, rm, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/** The game's info.txt format is JSON-ish but tolerant, so be tolerant too. */
function parseInfo(text) {
  try {
    return JSON.parse(text);
  } catch {
    const pick = (k) => text.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`))?.[1];
    return { Name: pick('Name'), ID: pick('ID'), Author: pick('Author') };
  }
}

/** Each mod is a subdirectory with a main.js. info.txt is optional. */
export async function scanMods(modsDir) {
  let entries;
  try {
    entries = await readdir(modsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const mods = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // An in-flight upload stages under a dot-name, so skipping hides it.
    if (e.name.startsWith('.')) continue;
    const dir = join(modsDir, e.name);
    let entry = 'main.js';
    try {
      await stat(join(dir, entry));
    } catch {
      continue; // no main.js, not a mod folder
    }
    let info = {};
    try {
      info = parseInfo(await readFile(join(dir, 'info.txt'), 'utf8'));
    } catch { /* no info.txt, fine */ }
    mods.push({
      folder: e.name,
      id: info.ID || e.name,
      name: info.Name || e.name,
      author: info.Author || '',
      entry,
    });
  }
  return mods;
}

const stateFile = (modsDir) => join(modsDir, 'mods.json');

async function readState(modsDir) {
  try {
    const parsed = JSON.parse(await readFile(stateFile(modsDir), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Merge disk with mods.json. New folders land last and disabled. */
export async function resolveMods(modsDir) {
  const found = await scanMods(modsDir);
  const state = await readState(modsDir);
  const byFolder = new Map(state.map((s) => [s.folder, s]));

  let maxOrder = state.reduce((m, s) => Math.max(m, s.order ?? 0), 0);
  const merged = found.map((m) => {
    const s = byFolder.get(m.folder);
    return {
      ...m,
      enabled: s ? !!s.enabled : false,
      order: s ? (s.order ?? ++maxOrder) : ++maxOrder,
    };
  });
  merged.sort((a, b) => a.order - b.order);
  return merged;
}

export async function saveState(modsDir, list) {
  const state = list.map((m) => ({ folder: m.folder, enabled: !!m.enabled, order: m.order }));
  await writeFile(stateFile(modsDir), JSON.stringify(state, null, 2) + '\n');
}

// Mods arrive from the control page as a flat map of relative path -> bytes. No
// path here is trusted.

/** An error the caller should turn into a 4xx rather than a 500. */
function userError(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// Folder names double as URL path segments and as mods.json keys.
export function safeFolderName(raw) {
  const name = String(raw ?? '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')   // one segment only
    .replace(/^[.\s]+/, '')
    .slice(0, 64)
    .trim();
  return !name || name === 'mods.json' ? null : name;
}

/** Cleaned relative path, or null for traversal, absolute paths and dot-junk. */
function safeRelPath(raw) {
  const path = String(raw ?? '').replace(/\\/g, '/');
  // Refused, not reinterpreted as relative: a browser never sends one.
  if (path.startsWith('/')) return null;
  const out = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    if (part.startsWith('.')) return null;
    if (/[\0<>:"|?*]/.test(part)) return null;
    out.push(part);
  }
  return out.length ? out.join('/') : null;
}

const ENTRY = 'main.js';

/**
 * A mod is any directory with a main.js directly inside it, so one mod folder, a
 * folder of mods and a Workshop content directory all work. Shallowest match
 * wins, so a mod's own subdirectories ride along.
 *
 * Returns [{folder, prefix}]; prefix '' means the upload is itself the mod.
 */
function findMods(paths, fallbackName) {
  const dirs = new Set();
  for (const p of paths) {
    if (p === ENTRY) dirs.add('');
    else if (p.endsWith('/' + ENTRY)) dirs.add(p.slice(0, -(ENTRY.length + 1)));
  }
  if (dirs.has('')) {
    if (!fallbackName) {
      throw userError('drop the mod\'s folder rather than the files inside it, ' +
                      'so the mod has a name');
    }
    return [{ folder: fallbackName, prefix: '' }];
  }
  const all = [...dirs];
  return all
    .filter((d) => !all.some((o) => o !== d && d.startsWith(o + '/')))
    .map((d) => ({ folder: safeFolderName(d.slice(d.lastIndexOf('/') + 1)), prefix: d + '/' }))
    .filter((m) => m.folder);
}

/**
 * `files` is [{path, data}], relative to whatever was picked. An existing mod is
 * replaced but keeps its mods.json entry, so re-uploading updates it in place.
 */
export async function installMods(modsDir, { name = '', files = [] } = {}) {
  const clean = [];
  let skipped = 0;
  for (const f of files) {
    const rel = safeRelPath(f.path);
    if (!rel) { skipped++; continue; }
    clean.push({ rel, data: f.data });
  }
  if (!clean.length) throw userError('nothing usable in that upload');

  const found = findMods(clean.map((c) => c.rel), safeFolderName(name));
  if (!found.length) {
    throw userError(`no ${ENTRY} found: a mod is a folder with a ${ENTRY} in it`);
  }

  await mkdir(modsDir, { recursive: true });
  const installed = [];
  for (const { folder, prefix } of found) {
    const mine = clean.filter((c) => c.rel.startsWith(prefix));
    if (!mine.length) continue;

    // Renamed in, so the mods directory only ever holds complete mods.
    const stage = join(modsDir, `.staging-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const dest = join(modsDir, folder);
    try {
      for (const c of mine) {
        const target = join(stage, c.rel.slice(prefix.length));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, c.data);
      }
      await rm(dest, { recursive: true, force: true });
      await rename(stage, dest);
      installed.push({ folder, files: mine.length });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  return { installed, skipped };
}

export async function removeMod(modsDir, folder) {
  // Strict rather than sanitising: cleaning could delete a different mod.
  if (!folder || safeFolderName(folder) !== folder) throw userError('bad mod name');
  const dir = join(modsDir, folder);
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw userError('no such mod');

  await rm(dir, { recursive: true, force: true });
  const state = (await readState(modsDir)).filter((s) => s.folder !== folder);
  await writeFile(stateFile(modsDir), JSON.stringify(state, null, 2) + '\n');
  return folder;
}

/**
 * The single PRESETMODS entry. Loads each mod's main.js in order, awaiting each
 * so dependencies resolve, and collects failures on window.__cookieModErrors.
 *
 * Errors are attributed by URL, not by whichever mod is loading at the time:
 * mods load sibling files and call Game.LoadMod long after the loader has moved
 * on, so a by-the-clock guess blames the next mod in the list.
 */
export function buildLoader(enabledMods) {
  const list = enabledMods.map((m) => ({
    id: m.id,
    name: m.name,
    dir: `/mods/${encodeURIComponent(m.folder)}/`,
    url: `/mods/${encodeURIComponent(m.folder)}/${m.entry}`,
  }));

  return `// generated by modmanager.mjs, do not edit
(function () {
  var MODS = ${JSON.stringify(list)};
  var errors = (window.__cookieModErrors = window.__cookieModErrors || {});
  var loaded = (window.__cookieModsLoaded = []);
  var current = null;

  window.__cookieModsDone = false;

  function blame(id, message) {
    if (!id) return;
    var list = (errors[id] = errors[id] || []);
    if (list.indexOf(message) < 0) list.push(message);
  }

  function pathOf(url) {
    try { return new URL(String(url), location.href).pathname; } catch (e) { return String(url || ''); }
  }

  // The whole directory, so a mod's own helper files count as its.
  function ownerOfUrl(url) {
    if (!url) return null;
    var path = pathOf(url);
    for (var i = 0; i < MODS.length; i++) {
      if (path.indexOf(MODS[i].dir) === 0) return MODS[i].id;
    }
    return null;
  }

  // The game fetches minigames 10ms after asking (main.js:8933), landing in the
  // middle of mod loading, so its own scripts must never be charged to a mod.
  function isGameOwned(url) {
    if (!url) return false;
    var u;
    try { u = new URL(String(url), location.href); } catch (e) { return false; }
    if (u.origin !== location.origin) return false;
    return !ownerOfUrl(url);
  }

  // Tagged at insertion time, the only record left by the time a Game.LoadMod
  // script fails seconds later.
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.tagName !== 'SCRIPT' || !current || n.dataset.cookieOwner) continue;
        if (isGameOwned(n.src || n.getAttribute('src'))) continue;
        n.dataset.cookieOwner = current;
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Capture phase: a failed subresource fires an error that does not bubble.
  window.addEventListener('error', function (e) {
    var el = e.target;
    if (el && el.tagName === 'SCRIPT') {
      var src = el.src || '';
      if (isGameOwned(src)) {
        console.error('[cookie-idler] the game could not load ' + src + ' (not a mod)');
        return;
      }
      blame(ownerOfUrl(src) || el.dataset.cookieOwner || current,
            'could not load ' + (src || 'a script'));
      return;
    }
    if (isGameOwned(e.filename)) return;
    blame(ownerOfUrl(e.filename) || current,
          String((e && e.message) || (e && e.error) || 'error'));
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    blame(current, 'unhandled rejection: ' + String((e && e.reason) || 'unknown'));
  });

  function next(i) {
    if (i >= MODS.length) {
      current = null;
      window.__cookieModsDone = true;
      console.log('[cookie-idler] mods loaded:', loaded.join(', ') || '(none)');
      return;
    }
    var m = MODS[i];
    current = m.id;
    var s = document.createElement('script');
    s.dataset.cookieOwner = m.id;
    s.src = m.url;
    // 'current' until main.js has run, so synchronous work is attributed to it.
    s.onload = function () { loaded.push(m.id); next(i + 1); };
    s.onerror = function () { next(i + 1); };
    document.head.appendChild(s);
  }
  next(0);
})();
`;
}
