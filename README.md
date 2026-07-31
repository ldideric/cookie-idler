# Cookie Idler

Runs [Cookie Clicker](https://orteil.dashnet.org/cookieclicker/) 24/7 in a small
headless container, with your own mods, a live control page you can watch and
click from anywhere, and one-click save export so progress can move to the Steam
copy (Steam achievements pop on import).

It idles the **web** build. The Steam build has no native Linux binary, so
running it would mean Xvfb plus Proton plus Steam, and Steam's
one-session-per-account rule would fight every other game you play. You bridge to
Steam with a save file whenever you feel like collecting.

- **Cheap.** ~200 MB RAM idle. The logic loop runs at full speed headless, but
  rendering is off until you open the control page.
- **Modded.** Upload Steam Workshop folders or your own mods from the control
  page, no shell needed. Load order is respected and one broken mod can't take
  down the rest.
- **Self-contained.** Zero npm dependencies and no build step: it mirrors the web
  build into a volume on first boot and serves it locally, which also disables
  the site's ads and trackers.

<!-- A screenshot of the control page goes well here. -->

## Quick start

```bash
git clone https://github.com/ldideric/cookie-idler
cd cookie-idler
docker compose up --build -d
# open http://localhost:3000
```

Or reference the published image in your own stack instead of building:

```yaml
services:
  cookie:
    image: ghcr.io/ldideric/cookie-idler:latest
    init: true
    ports:
      - "3000:3000"
    volumes:
      - ./mods:/mods-seed:ro
      - cookie_game:/game
      - cookie_mods:/mods
      - cookie_profile:/profile
      - cookie_saves:/saves
    restart: unless-stopped
volumes:
  cookie_game:
  cookie_mods:
  cookie_profile:
  cookie_saves:
```

> **Put it behind auth.** The game has no login of its own. On a LAN or tailnet
> that may be fine; anywhere reachable, front it with a reverse proxy and basic
> auth. See [Behind a reverse proxy](#behind-a-reverse-proxy).

## The control page

`http://<host>:3000` has three tabs:

- **Game** streams the live game and forwards your clicks and keys, so you can
  buy buildings, pop golden cookies and poke mod settings. Opening this tab turns
  rendering on, leaving it turns rendering back off.
- **Mods** lists every mod with an enable toggle, load order, and its last load
  error. Reload applies changes. Below the list you can add a mod by dragging its
  folder in, or remove one.
- **Save** downloads the live save for importing into Steam, and imports a save
  to seed the idler with existing progress.

## Moving progress to and from Steam

**Seed the idler:** in Steam, Options, then Export save; copy the code; paste it
into the control page's Save tab, Import.

**Collect into Steam:** Save tab, Download save; in Steam, Options, then Import
save, and paste the file's contents. Achievements pop on import, though Steam may
take a while to work through a backlog. This step is manual so the idler and your
Steam sessions never collide.

If your Steam build runs a different version than the web mirror, set
`COOKIE_STEAM_VERSION` and the export also offers a version-patched variant.

## Mods

One folder per mod, Steam Workshop layout (`info.txt` plus `main.js`), so a
Workshop item copied out of `steamapps/workshop/content/1454400/<id>/` works
unchanged.

Add them from the **Mods** tab: drag the mod's folder onto the page, or pick it
with the folder chooser. Drop a folder holding several mods (a Workshop content
directory, say) and each one is installed in a single go. Uploads land switched
**off**; enable and order them in the list above, then Save & reload.
Re-uploading a mod replaces it and keeps its switch and load order, which is how
you update one. Remove deletes a mod's files. Details in
[`mods/README.md`](mods/README.md).

The `mods/` folder here is only a **seed**, copied into the live mods volume on
first boot, for mods you want present before anyone opens the page. Nothing
third-party ships in the image; bring your own.

## Configuration

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `COOKIE_STEAM_VERSION` | (unset) | Your Steam build's version, if it differs from the web mirror. Enables a version-patched export. |
| `COOKIE_NTFY_URL` | (unset) | [ntfy](https://ntfy.sh) topic URL for alerts, for example `https://ntfy.sh/my-cookie-idler`. Unset means no alerts. |
| `COOKIE_NTFY_TOKEN` | (unset) | ntfy access token, sent as a bearer token. Needed on any server that does not allow anonymous publishing. |
| `NTFY_REPEAT_MS` | `1800000` | How long the same alert is held back while its condition lasts (30 min). |
| `COOKIE_LANG` | `EN` | Game language, seeded so a fresh profile never stops on the chooser. |
| `CONTROL_PORT` | `3000` | Control page port. |
| `BACKUP_EVERY_MS` | `1800000` | Save-export backup interval (30 min). |
| `BACKUP_KEEP_DAYS` | `14` | Backup retention. |
| `WATCHDOG_EVERY_MS` | `60000` | Loop-health check interval. |
| `STALL_STRIKES` | `3` | Consecutive stalled checks before the watchdog reloads. |
| `CDP_TIMEOUT_MS` | `30000` | Deadline on a single DevTools call. |
| `COOKIE_MEMORY_LIMIT` | - | If you cap memory, give it 1G. Chromium settles around 590M, and squeezing it is not a clean failure: the browser drops save writes silently. |

Volumes: `/game` (mirror), `/mods` (live mod set), `/profile` (Chromium profile,
which is the game's autosave), `/saves` (timestamped exports). Mount your mods
read-only at `/mods-seed`.

## Durability

The idler assumes the browser will lose the save eventually, so losing one costs
half an hour rather than the run.

- The Chromium profile persists the game's autosave, so restarts resume where
  they left off.
- Separately, the save is exported to `/saves` every 30 minutes, on a clean
  shutdown, and on every import. Point your backups at that volume.
- **After every load**, the run the game came back with is checked against the
  newest export and replaced if it lost ground. This covers the failure that
  actually bites: the browser comes up with empty storage and the game quietly
  starts a new run. Timestamps cannot catch it, because the fresh run is the
  newer one, so the check compares which run it is and how many cookies it has
  ever baked.
- Backups that would move the save backwards are refused, and retention never
  deletes the newest export or the one holding the most progress. To start over,
  import the save you want (imports are always taken at face value) or empty
  `/saves` first.
- Saving is verified by reading it back, because the game drops the exception
  when a write fails.
- A watchdog checks the logic loop every minute. Sleep mode is resumed in place;
  a genuine stall takes three consecutive checks before a reload, since a busy
  page can crawl for a minute on its own. Checks never overlap, and every
  DevTools call has a deadline, so a browser that dies without closing its socket
  fails the check instead of parking it forever.
- Anything that looks like real trouble pings ntfy, if it is configured: a save
  the browser refused to keep, a run that came back short, a backup refused for
  losing ground, a stall the watchdog had to reload, and a ping back when each
  clears. The same alert is held back for `NTFY_REPEAT_MS` while its cause
  lasts. A quiet ping at startup proves the wiring, and a refused publish is
  logged with its status rather than swallowed.

## Behind a reverse proxy

Route your proxy to port `3000` and add auth. Traefik labels, for example:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.cookie.rule=Host(`cookie.example.com`)
  - traefik.http.routers.cookie.entrypoints=websecure
  - traefik.http.routers.cookie.tls.certresolver=letsencrypt
  - traefik.http.routers.cookie.middlewares=basic-auth@file
  - traefik.http.services.cookie.loadbalancer.server.port=3000
```

`/up` answers with the loop state and is worth pointing an uptime probe at. It
reports whether the game is still ticking rather than whether the process is
running, so exclude it from basic auth if your probe only counts 2xx as up.

## How it works

- **CDP, no dependencies.** The sidecar drives Chromium over the DevTools
  protocol using Node's built-in WebSocket, so the image is Playwright's browser
  image plus a few `.mjs` files.
- **Rendering off, logic on.** The logic loop is `setTimeout`-driven and runs at
  full 30 fps in a headless tab, while `Game.visible` stays false so `Game.Draw()`
  never runs until a viewer connects. Golden cookies keep ticking because they
  live in the logic loop, not in drawing.
- **Local mirror.** The live site is behind a bot challenge that blocks headless
  Chromium, so the game is mirrored into a volume and served from localhost,
  which also flips the game's `LOCAL` flag and disables its ads and trackers. The
  mirror follows the game's second-hand references too: sprites whose filenames
  are assembled at runtime, and the minigame scripts (Garden, Stock Market,
  Pantheon, Grimoire) the game only fetches once a building levels up.
- **Mod loader.** Enabled mods load in order, each in its own `<script>`, so one
  failure cannot stop the rest. Failures are attributed by URL rather than by
  whatever was loading at the time, which is the only way to get it right for the
  two things mods do after their `main.js` finishes: load sibling files, and call
  `Game.LoadMod` to fetch a script off the internet. Both fail late, and a
  by-the-clock guess pins them on the next mod in the list.

## Acknowledgements

Cookie Clicker is by [Orteil / DashNet](https://orteil.dashnet.org/cookieclicker/).
This project only automates a browser running the freely available web version;
it does not include or redistribute the game. Please support the developers and
the official Steam release. The game is mirrored locally at runtime for a single
private instance and is never re-hosted publicly.

## License

The sidecar code in this repository is MIT licensed. Cookie Clicker itself, and
any mods you add, are under their own terms.
