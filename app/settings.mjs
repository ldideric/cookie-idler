// Settings the control page owns. Kept out of the environment because none of
// it is secret and all of it should be changeable without a redeploy.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const HOUR = 60 * 60 * 1000;

export const DEFAULTS = {
  steamProfile: '',        // vanity name or 17-digit id; empty disables the check
  pendingThreshold: 1,
  steamCheckEveryMs: 6 * HOUR,
};

// Lives beside the backups, where the prune ignores it: listBackups and
// pruneBackups both match ^cookieclicker-.*\.txt$ only.
const stateFile = (dir) => join(dir, 'settings.json');

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function coerce(raw = {}) {
  return {
    steamProfile: String(raw.steamProfile ?? DEFAULTS.steamProfile).trim().slice(0, 64),
    pendingThreshold: clampInt(raw.pendingThreshold, 1, 500, DEFAULTS.pendingThreshold),
    steamCheckEveryMs: clampInt(raw.steamCheckEveryMs, 5 * 60 * 1000, 7 * 24 * HOUR,
      DEFAULTS.steamCheckEveryMs),
  };
}

export async function readSettings(dir) {
  try {
    return coerce(JSON.parse(await readFile(stateFile(dir), 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(dir, patch) {
  const next = coerce({ ...await readSettings(dir), ...patch });
  await writeFile(stateFile(dir), JSON.stringify(next, null, 2) + '\n');
  return next;
}
