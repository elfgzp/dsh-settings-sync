# dsh-settings-sync

Back up and restore **every** DeepSeek Harness setting through a private Git
repository you own — profile configuration, per-plugin settings, skills,
installed plugins, and MCP servers. Push from one machine, restore on another,
with a restore point written before anything is overwritten.

[中文说明](README.zh.md)

---

## Why this exists

DSH keeps its configuration in a few places, and they are all easy to lose:

| What | Where |
|---|---|
| The plugin inventory and the profile's bundle list | `~/.dsh/profiles/<profile>/package.json` |
| Per-plugin configuration (models, MCP servers, panel settings) | `~/.dsh/profiles/<profile>/cordis.patch.yml` |
| Skills | `~/.dsh/skills/`, `~/.agents/skills/` |
| Per-plugin state (starred items, default projects, tasks) | `~/.dsh/<plugin>/` |

`dsh export` copies that once, to a file you then have to move around yourself.
This plugin makes it continuous: one private repository, one button in each
direction, and a diff you can read before you commit to either.

## What gets synced

```
manifest.json                 what produced this snapshot, and when
profile/package.json          the plugin inventory and bundle list
profile/cordis.patch.yml      every plugin's configuration
profile/cordis.yml            the profile's root entry list
profile/pnpm-workspace.yaml   workspace and release-age settings
homes/dsh/<plugin>/*.json     per-plugin settings (starred, defaults, tasks)
homes/dsh/skills/<name>/…     user-level skills under $DSH_HOME
homes/agents/skills/<name>/…  shared agent skills under $DSH_AGENTS_HOME
```

And what deliberately does **not**:

- **Credentials.** `~/.dsh/.credentials.yaml`, `tencent-intranet-auth.json`,
  `.env`, `*.pem`, `*.token`, `pairing.json` — excluded by name *and* by content.
  On top of that, live values that appear inside otherwise-synced config — an
  `apiKey:` line in `cordis.patch.yml`, say — are replaced with
  `<redacted by dsh-settings-sync>` before the snapshot leaves the machine. The
  configuration's *shape* is preserved, so restoring still tells you a key
  belongs there; you just fill it in again.

  Redaction is **one-way**. A pull never writes the placeholder over a real local
  value: the restorer matches credential lines by key name and keeps the machine's
  own secret, so restoring on the machine the snapshot came from leaves its API
  keys working. Only a machine that has no value yet receives the placeholder,
  where it is exactly the right message — "a key is owed here".
- **Dependencies and caches.** `node_modules`, `pnpm-lock.yaml`, `__pycache__`,
  `.plugin-manager` logs, attachment blobs.
- **Sessions and history.** `~/.dsh/sessions`, `~/.dsh/storages` — history is not
  a setting, and it is by far the largest thing in a DSH home.
- **Backups of previous edits.** Anything matching `.bak` in the profile.

A real machine — 21 installed plugins, 66 skills, six per-plugin state
directories — collects to **263 files and 1.4 MB**.

## Install

```bash
git clone https://github.com/elfgzp/dsh-settings-sync.git ~/Work/Github/dsh-settings-sync
```

Then, in DSH, either use **Settings → Plugins → Install**, or from a terminal:

```
dsh plugin install ~/Work/Github/dsh-settings-sync
```

The plugin adds a **Settings Sync** page under **Settings**, and on first launch
asks one question: pull the remote settings down, or push these ones up.

Requirements: `git` on `PATH` (or set its absolute path in the plugin config),
and — only if you want the one-click "create repository" button — the
[GitHub CLI](https://cli.github.com/) logged in with `gh auth login`.

## Use

1. **Set a repository.** Paste the URL of an empty private repository
   (`git@github.com:you/dsh-settings.git` and
   `https://github.com/you/dsh-settings.git` both work), or press
   **Create private repo** to have `gh` make one.
2. **Push** to upload this machine's settings.
3. On the other machine, install the plugin, paste the same URL, and **Pull**.

The diff panel shows exactly what a push would change — `+added`, `~modified`,
`-removed` — before you press anything.

### Automatic sync

| Setting | Meaning |
|---|---|
| **Redact secrets** | Replace live keys with a placeholder before upload. On by default. |
| **Auto push** | Push after a settings change, on the check interval. |
| **Remote policy** | `never` — ignore the remote; `ask` — offer a choice (default); `always` — pull when the remote is ahead and local is clean. |
| **Check interval** | Off, 5 minutes, 30 minutes, or 1 hour. |

### Safety model

- **Nothing is overwritten without a restore point.** Pull writes a full copy of
  the current state under `<stateDir>/backups/<timestamp>-snapshot/` first, and
  that path is reported when the pull finishes. The restore points are listed on
  the settings page and can be restored in one click.
- **A push that collects nothing is refused.** A mis-resolved `HOME` looks like
  "the user deleted everything", and silently replacing a good backup with an
  empty snapshot is unrecoverable. The same guard refuses a push that would
  delete most of the tracked files unless you explicitly force it.
- **The snapshot is a real Git repository**, in `<stateDir>/mirror`. History is
  the backup: `git log` in there shows every sync, and `git show <commit>:profile/cordis.patch.yml`
  gets you any earlier file. That is also why this plugin never needs its own
  format for undo.

Everything lives under `$DSH_HOME/settings-sync` by default:

```
config.json   repository, branch, policies, commit identity
mirror/       the local clone whose history is the snapshot history
backups/      restore points
last-run.json the most recent push or pull result
```

## Toolchain

```bash
pnpm test    # or: node --test test/*.test.js
pnpm check   # node --check over every module
```

The tests run the real code against the real `git` binary and a scratch home
directory with a fake profile, two skill roots, a per-plugin state directory, a
credential that must not be synced, and a bare repository standing in for the
remote. Nothing about git is mocked, because git is the part most likely to be
wrong.

## Design notes

**The mirror is a clone, not a database.** Keeping the snapshot as a normal
repository means the entire undo mechanism is "check out an earlier commit", the
diff is `git status`, and the user can inspect or repair a sync from a terminal
without this plugin's help.

**Push and pull are serialized.** One operation at a time, one `busy` flag. A
second click waits rather than interleaving, and an automatic timer that fires
mid-pull is skipped.

**Authentication is the user's own.** Nothing in this plugin stores a token: it
runs the same `git` the user runs, so osxkeychain, an SSH agent, or a
`credential.helper` applies unchanged. The corollary is honest — if `git push`
does not work in a terminal for that repository, it will not work here either,
and the error says so.

**The browser half holds no state that matters.** It renders and it calls; the
Host owns the filesystem, the repository, and the restore points.

## Layout

| Path | Role |
|---|---|
| `index.js` | Host entry: routes, the automatic-sync timer |
| `lib/config.js` | Path resolution and deployment config |
| `lib/state.js` | User configuration and last-run state |
| `lib/paths.js` | What counts as a setting; secret and cache exclusion |
| `lib/snapshot.js` | Collect, materialize, diff, restore, restore points |
| `lib/git.js` | The one place that runs `git` |
| `lib/engine.js` | Serialized sync engine: push, pull, preview, recover |
| `client.js` | Settings page and the first-run dialog |

## License

MIT
