// Re-proves that the save rewrite still gives back Steam's own bytes.
//
//   node checksave.mjs <save exported from Steam>
//
// The rewrite reaches into a field of someone's save file, so this asserts the
// whole round trip rather than a sample. Exits non-zero on any mismatch.

import { readFile } from 'node:fs/promises';
import {
  decodeSave, encodeSave, fingerprint, readModMeta, modMetaIds, withModMeta,
} from './savefile.mjs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node checksave.mjs <save exported from Steam>');
  process.exit(2);
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failed++;
};

const code = (await readFile(path, 'utf8')).trim();
const raw = decodeSave(code);
if (!raw) { console.error(`${path} does not decode as a save`); process.exit(2); }

const fp = fingerprint(code);
check('decodes and fingerprints', !!fp, fp && `version ${raw.split('|')[0]}, ${fp.ascensions} ascension(s)`);
check('re-encodes byte for byte', encodeSave(raw) === code);

const meta = readModMeta(code);
check('carries Steam\'s mod list', !!meta, meta && modMetaIds(meta).join(', '));
if (!meta) {
  console.error('nothing to check: export from Steam with at least one mod enabled');
  process.exit(2);
}

// What the web build leaves behind: every pair in the field but Steam's.
const fields = raw.split('|');
const kept = fields[9].split(';').filter((e) => e && !e.startsWith('META:'));
const web = fields.with(9, kept.join(';') + ';').join('|');
check('the drop is what breaks it', readModMeta(encodeSave(web)) === null);
check('the other mods\' own data is untouched', kept.length === fields[9].split(';').filter(Boolean).length - 1);

check('restoring gives back Steam\'s bytes', withModMeta(web, meta) === raw);
check('a save that already has the list is left alone', withModMeta(raw, meta) === null);

process.exit(failed ? 1 : 0);
