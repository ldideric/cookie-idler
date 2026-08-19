// Re-proves that the game's achievement names still join onto Steam's list.
//
//   docker exec <container> node /app/checknames.mjs [profile]
//
// The join is the one fragile joint in the collect check, and a game update can
// rename an achievement, so this asserts the whole thing rather than a sample.
// Exits non-zero on any unmatched name, any collision, or a broken count.

import { CDP, waitForDevTools, attachToPage, evaluate } from './cdp.mjs';
import { fetchSteamAchievements, matchAchievements, normalizeName } from './steam.mjs';
import { readSettings } from './settings.mjs';

const SAVES_DIR = process.env.SAVES_DIR ?? '/saves';

const profile = process.argv[2] || (await readSettings(SAVES_DIR)).steamProfile;
if (!profile) {
  console.error('no Steam profile: pass one as an argument or set it on the control page');
  process.exit(2);
}

const steam = await fetchSteamAchievements(profile);
if (!steam.ok) { console.error(`Steam: ${steam.reason}`); process.exit(2); }

const cdp = await CDP.connect((await waitForDevTools()).webSocketDebuggerUrl);
const { sessionId } = await attachToPage(cdp);

const game = await evaluate(cdp, sessionId, `(function () {
  var out = [];
  for (var i in Game.AchievementsById) {
    var a = Game.AchievementsById[i];
    out.push({ id: a.id, name: a.name, dname: a.dname || a.name,
               won: a.won ? 1 : 0, pool: a.pool || 'normal' });
  }
  return out;
})()`);
cdp.close();

const m = matchAchievements(game, steam.achievements);

const gameKeys = new Map();
const gameCollisions = [];
for (const a of game) {
  for (const key of new Set([normalizeName(a.name), normalizeName(a.dname)])) {
    if (!key) continue;
    const prev = gameKeys.get(key);
    if (prev && prev !== a.id) gameCollisions.push(`${key}: ${prev} and ${a.id}`);
    else gameKeys.set(key, a.id);
  }
}

const fail = [];
if (m.unmatchedSteam.length) fail.push(`${m.unmatchedSteam.length} Steam name(s) unmatched`);
if (gameCollisions.length) fail.push(`${gameCollisions.length} game name collision(s)`);
if (m.steamCollisions.length) fail.push(`${m.steamCollisions.length} Steam name collision(s)`);
if (m.matched !== steam.achievements.length) {
  fail.push(`matched ${m.matched} but Steam lists ${steam.achievements.length}`);
}

console.log(`game achievements   ${game.length}`);
console.log(`steam achievements  ${steam.achievements.length}`);
console.log(`matched             ${m.matched}`);
console.log(`no Steam entry      ${m.excluded.length}`);
for (const a of m.excluded) console.log(`    ${a.id} [${a.pool}] ${a.dname}`);
for (const n of m.unmatchedSteam) console.log(`    unmatched on Steam: ${n}`);
for (const c of [...gameCollisions, ...m.steamCollisions]) console.log(`    collision: ${c}`);

if (fail.length) { console.error(`\nFAILED: ${fail.join('; ')}`); process.exit(1); }
console.log('\nOK: every Steam achievement maps onto exactly one in the game.');
