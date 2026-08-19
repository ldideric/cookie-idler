// The profile XML is not a documented API, so every failure is reported rather
// than guessed at and the caller stays quiet when it cannot be read.

const APPID = 1454400;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: '\u00E9', egrave: '\u00E8', agrave: '\u00E0',
  ccedil: '\u00E7', ocirc: '\u00F4',
  uuml: '\u00FC', ndash: '\u2013', mdash: '\u2014',
};

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

// The two lists are authored independently and differ only in presentation: the
// game keeps markup and entities, Steam keeps rendered text. Folding to ASCII
// settles it, with no collisions across the full pair; checknames.mjs re-proves.
export function normalizeName(s) {
  return decodeEntities(s)
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/['"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSteamAchievements(xml) {
  const text = String(xml ?? '');
  const privacy = text.match(/<privacyState>\s*(\w+)\s*<\/privacyState>/)?.[1] ?? '';
  const out = [];
  for (const block of text.matchAll(/<achievement\b([^>]*)>([\s\S]*?)<\/achievement>/g)) {
    const name = block[2].match(/<name>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/name>/);
    if (!name) continue;
    out.push({
      name: decodeEntities(name[1]).trim(),
      closed: /closed="1"/.test(block[1]),
    });
  }
  return { privacy, achievements: out.filter((a) => a.name) };
}

export function profileUrl(profile) {
  const p = encodeURIComponent(String(profile ?? '').trim());
  const kind = /^\d{17}$/.test(p) ? 'profiles' : 'id';
  return `https://steamcommunity.com/${kind}/${p}/stats/${APPID}/achievements/?xml=1`;
}

export async function fetchSteamAchievements(profile, { timeoutMs = 20000, fetchImpl = fetch } = {}) {
  if (!String(profile ?? '').trim()) return { ok: false, reason: 'no profile set' };
  let res;
  try {
    res = await fetchImpl(profileUrl(profile), { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, reason: `could not reach Steam: ${e.message}` };
  }
  if (!res.ok) return { ok: false, reason: `Steam answered ${res.status}` };

  const { privacy, achievements } = parseSteamAchievements(await res.text());
  if (!achievements.length) {
    return { ok: false, reason: privacy && privacy !== 'public'
      ? `that profile's game details are ${privacy}, not public`
      : 'no achievements in that response; check the profile name' };
  }
  return { ok: true, achievements };
}

/**
 * Indexed by both `name` and `dname`: achievement 289 shows "Here he comes"
 * but Steam carries its zalgo original, which folds to "he comes".
 *
 * Anything the join cannot place has no Steam counterpart and is excluded,
 * covering the dungeon pool, "Third-party" and "Cheated cookies taste awful"
 * without naming them, so a game update cannot strand the list.
 */
export function matchAchievements(gameList, steamList) {
  const steamByName = new Map();
  const steamCollisions = [];
  for (const s of steamList) {
    const key = normalizeName(s.name);
    if (!key) continue;
    if (steamByName.has(key)) steamCollisions.push(s.name);
    else steamByName.set(key, s);
  }

  const pending = [];
  const excluded = [];
  const seen = new Set();
  let matched = 0;
  for (const a of gameList) {
    const hit = steamByName.get(normalizeName(a.dname)) ?? steamByName.get(normalizeName(a.name));
    if (!hit) { excluded.push(a); continue; }
    matched++;
    seen.add(hit.name);
    if (a.won && !hit.closed) pending.push({ id: a.id, name: a.dname, pool: a.pool });
  }

  return {
    pending: pending.sort((x, y) => x.id - y.id),
    matched,
    excluded,
    steamCollisions,
    unmatchedSteam: steamList.filter((s) => !seen.has(s.name)).map((s) => s.name),
  };
}
