# Mods

Each mod is one folder with at least a `main.js`, and usually an `info.txt` (the
Steam Workshop layout), so a Workshop item copied out of
`steamapps/workshop/content/1454400/<id>/` works unchanged.

There are two ways in. Normally you **upload it from the control page**, which
needs no shell access. Dropping a folder in *this* directory instead makes it a
seed, copied into the live mods volume on first boot, for mods you want present
before anyone opens the page.

```
mods/
├── my_mod/
│   ├── info.txt        # optional; gives the display name and canonical ID
│   └── main.js         # required; the entry point
└── mods.json           # generated: which mods are on, and in what order
```

`main.js` is a normal Cookie Clicker mod: it calls
`Game.registerMod("id", { init, save, load })`. Multi-file mods work too. A mod
whose `main.js` loads its siblings relative to `document.currentScript.src` is
served at its real path, so those loads resolve.

## Adding a mod from the control page

On the **Mods** tab, drag the mod's folder onto the page or pick it with the
folder chooser. Send the folder itself, the one with `main.js` directly inside,
not the loose files: the folder's name becomes the mod's name on disk.

Point it at a folder that *contains* mod folders (your Workshop content
directory, for instance) and every mod inside is installed at once.
Subdirectories inside a mod come along untouched, so multi-file mods keep
working.

Uploaded mods arrive **disabled**, like any other newly-found folder. Uploading a
mod that is already installed replaces its files but keeps its switch and load
order, so updating a mod is just uploading the new version. **Remove** deletes a
mod's files and forgets its `mods.json` entry.

Dotfiles and dot-directories (`.DS_Store`, `.git/`) are dropped on the way in.

## Enabling and ordering

Nothing runs until you enable it. Use the **Mods** tab to toggle mods, set load
order and see per-mod load errors, or edit `mods.json` directly:

```json
[
  { "folder": "CCSE",   "enabled": true, "order": 10 },
  { "folder": "my_mod", "enabled": true, "order": 20 }
]
```

Lower `order` loads first. Put dependencies (CCSE, for example) above the mods
that need them. Mods load one at a time, so ordering is guaranteed and one broken
mod cannot take down the others or the game.

## Notes

- Loading any mod grants Cookie Clicker's hidden **Third-party** achievement. It
  is a shadow achievement (no effect on milk or completion) but it shows on your
  Steam profile once you import an idled save.
- Mods that mint cookies directly trip the **Cheated cookies taste awful** shadow
  achievement. Mods that only automate normal play do not.
- When `MODS_SEED_DIR` is set, the contents here are a **seed**: copied into the
  live mods volume on first boot, then managed through the control page. A new
  folder here appears (disabled) after the next restart. Seeding is additive and
  never overwrites a mod already in the volume, so an upload always wins.
