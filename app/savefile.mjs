// WriteSave(1) returns escape(utf8_to_b64(raw)+'!END!') (main.js:3048), pipe-
// delimited once decoded. Every field read here is ASCII, so latin1 carries the
// rest through a decode/encode round trip byte for byte.

export function decodeSave(code) {
  try {
    const b64 = unescape(String(code ?? '')).split('!END!')[0];
    if (!b64) return null;
    const raw = Buffer.from(b64, 'base64').toString('latin1');
    return raw.includes('|') ? raw : null;
  } catch {
    return null;
  }
}

export const encodeSave = (raw) =>
  escape(Buffer.from(raw, 'latin1').toString('base64') + '!END!');

// lineage is the legacy start date (main.js:2881), changing only on replace or
// wipe; baked is this run plus what past runs carried in, so within one lineage
// it only ever grows.
export function fingerprint(saveString) {
  const raw = decodeSave(saveString);
  if (!raw) return null;
  try {
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

// The last field holds `id:data;` pairs, one per mod (main.js:1231). Steam
// appends one more under the id META naming the mods it has enabled
// (main.js:1246), which the web build drops on load (main.js:3443).
const MOD_FIELD = 9;
const META = 'META:';

const modField = (raw) => {
  const fields = raw.split('|');
  return fields.length > MOD_FIELD ? fields[MOD_FIELD] : null;
};

const isMeta = (entry) => entry.startsWith(META);

export function readModMeta(code) {
  const raw = decodeSave(code);
  if (raw === null) return null;
  return (modField(raw) ?? '').split(';').find(isMeta) ?? null;
}

// The leading * marks a local mod, not a Workshop one.
export const modMetaIds = (meta) =>
  String(meta ?? '').slice(META.length).split(',')
    .map((id) => id.replace(/^\*/, '').trim())
    .filter(Boolean);

// Null when there is nothing to do: a save straight from Steam keeps its own pair.
export function withModMeta(raw, meta) {
  const fields = raw.split('|');
  if (fields.length <= MOD_FIELD || !meta) return null;
  const mods = fields[MOD_FIELD];
  if (mods.split(';').some(isMeta)) return null;
  fields[MOD_FIELD] = (mods && !mods.endsWith(';') ? mods + ';' : mods) + meta + ';';
  return fields.join('|');
}
