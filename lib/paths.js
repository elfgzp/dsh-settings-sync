/**
 * What counts as "a DSH setting", and how to copy it in and out of a snapshot.
 *
 * The snapshot is a plain directory tree — the repository's working copy — laid
 * out by *origin*, not by absolute path, so it can be restored on another
 * machine whose home directory is somewhere else:
 *
 * ```
 * manifest.json                 what produced this snapshot and when
 * profile/package.json          the profile manifest (installed plugins, bundles)
 * profile/cordis.patch.yml      the profile patch layer (per-plugin config)
 * profile/cordis.yml            the root entry list
 * profile/pnpm-workspace.yaml   workspace + release-age settings
 * profile/<other>/…             any other profile config file the user has
 * homes/dsh/<file>              $DSH_HOME files (per-plugin state, not credentials)
 * homes/dsh/skills/<name>/…     user-level skills under $DSH_HOME/skills
 * homes/agents/skills/<name>/…  shared agent skills under $DSH_AGENTS_HOME/skills
 * ```
 *
 * Three rules drive every exclusion:
 *
 *   1. **Never credentials.** `$DSH_HOME/.credentials.yaml`, `tencent-intranet-auth.json`,
 *      `.env`, `*.token`, and anything matching the secret patterns stays out.
 *      A snapshot repository is private, but a backup that quietly carries a
 *      live token is a backup that leaks the day the repository is misconfigured.
 *   2. **Never dependencies or caches.** `node_modules`, `pnpm-lock.yaml`, and
 *      hidden cache directories are rebuilt locally; syncing them would blow the
 *      size budget and restore stale binaries.
 *   3. **Never sessions or logs.** Conversation history is not a setting, and it
 *      is by far the largest thing in `$DSH_HOME`.
 *
 * @module dsh-settings-sync/paths
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix, relative, resolve, sep } from 'node:path'

/** Snapshot entry kinds. */
export const KIND_FILE = 'file'
export const KIND_SKILL = 'skill'

/**
 * Profile files with credentials in them.
 *
 * `package.json` is on the allow list (it is the plugin inventory), but the
 * profile directory as a whole is user data that may contain API keys —
 * `config.toml`, `.env`, `secrets.json` — so the same secret rules apply there.
 */
const SECRET_NAME = /(^|[/\\])(\.credentials(\.\w+)?|credentials(\.\w+)?|secrets?(\.\w+)?|\.env(\.\w+)?|\.npmrc|\.netrc|id_[a-z0-9]+|tencent-intranet-auth\.json)$/i
const SECRET_SUFFIX = /\.(pem|key|p12|pfx|jks|keystore|token|secret)$/i
const SECRET_CONTENT_HINT = /(access[_-]?token|refresh[_-]?token|api[_-]?key|secret[_-]?key|client[_-]?secret|BEGIN [A-Z ]*PRIVATE KEY)/i

/** Directory/file names that never belong in a snapshot, at any depth. */
const SKIP_NAMES = new Set([
  'node_modules',
  '.git',
  'pnpm-lock.yaml',
  '.DS_Store',
  'Thumbs.db',
  // Python build residue: skills ship helper scripts, and their bytecode caches
  // are per-interpreter, per-machine, and useless on the other side.
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'venv',
  '.venv',
])

/** `$DSH_HOME` top-level entries that are never settings. */
const DSH_HOME_SKIP = new Set([
  '.credentials.yaml',
  '.anonymous-user-id',
  'sessions',
  'storages',
  'logs',
  'cache',
  'attachments',
  'state',
  'dsh-runtimes',
  'cua',
  'profiles',
  'settings-sync',
  'minimax-usage-samples.json',
  'tencent-intranet-auth.json',
  'dsh-godot-live.json',
])

/**
 * Per-plugin state files under `$DSH_HOME/<plugin>/` that are caches, logs, or
 * credentials rather than settings.
 *
 * The distinction is deliberate: `starred.json`, `settings.json`, and `tasks.json`
 * are choices the user made and want on the other machine, while `pairing.json`
 * (a device pairing secret), `settings.log` (a diagnostics log), `files-v3.json`
 * (an attachment index pointing at this machine's blobs), and
 * `session-insights.json` (live session runtime state) are all specific to *this*
 * install and would be wrong — or unsafe — to copy.
 */
const PLUGIN_STATE_SKIP = /(pairing|auth|token|credential|secret|usage|samples|lock|cache|\blog\b|\.log$|session-insights|files-v\d+|downloads|screenshots|tmp)/i

/** Skill entry points. A skill is a directory with `SKILL.md` or a flat `.md`. */
export const SKILL_FILE = 'SKILL.md'

/** Whether a path segment is a secret by name. */
export function isSecretName(name) {
  return SECRET_NAME.test(name) || SECRET_SUFFIX.test(name)
}

/** Whether a top-level `$DSH_HOME` entry is worth syncing at all. */
export function isSyncedDshHomeEntry(name) {
  if (DSH_HOME_SKIP.has(name)) return false
  if (name.startsWith('.')) return false
  return true
}

/** Convert an absolute path under `root` into a POSIX snapshot path. */
export function snapshotPath(root, absolute) {
  return relative(root, absolute).split(sep).join('/')
}

/**
 * Walk one skill root and collect skill directories.
 *
 * Discovery is one level deep, the same rule the filesystem skill provider uses:
 * `<root>/<name>/SKILL.md` or `<root>/<name>.md`. Symlinks are followed only when
 * they resolve inside the root, because a skill symlinked out to another
 * checkout is somebody else's working tree, not this machine's config.
 *
 * @param {string} root - A skill root, e.g. `~/.agents/skills`.
 * @param {string} label - Snapshot prefix, e.g. `homes/agents/skills`.
 * @param {number} maxFiles - Total file budget shared by the caller.
 * @returns {Promise<{ entries: Array, files: Array<{ source: string, target: string }>, skipped: string[] }>} Discovered skills.
 */
export async function collectSkills(root, label, maxFiles) {
  const entries = []
  const files = []
  const skipped = []
  let dirents
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch {
    return { entries, files, skipped }
  }

  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    if (dirent.name.startsWith('.')) continue
    const absolute = join(root, dirent.name)

    // Flat file form: `<name>.md`.
    if (dirent.isFile() && dirent.name.endsWith('.md')) {
      if (files.length >= maxFiles) break
      const name = dirent.name.slice(0, -3)
      entries.push({ name, kind: KIND_FILE, path: `${label}/${dirent.name}` })
      files.push({ source: absolute, target: `${label}/${dirent.name}` })
      continue
    }

    // Directory form: `<name>/SKILL.md` plus its resources.
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
    const skillFile = join(absolute, SKILL_FILE)
    let info
    try {
      info = await stat(resolve(absolute))
    } catch {
      skipped.push(`${label}/${dirent.name}`)
      continue
    }
    if (!info.isDirectory()) continue
    try {
      const front = await readFile(skillFile, 'utf8')
      if (!/^---/m.test(front.slice(0, 8))) {
        skipped.push(`${label}/${dirent.name}`)
        continue
      }
    } catch {
      // A directory without SKILL.md is not a skill: it may be a bundle's
      // `references/` folder from a flat install. Ignore it quietly.
      continue
    }
    const bundle = []
    try {
      await walkInto(absolute, `${label}/${dirent.name}`, bundle, maxFiles)
    } catch {
      skipped.push(`${label}/${dirent.name}`)
      continue
    }
    if (bundle.length === 0) continue
    entries.push({ name: dirent.name, kind: KIND_SKILL, path: `${label}/${dirent.name}` })
    for (const file of bundle) {
      if (files.length >= maxFiles) break
      files.push(file)
    }
  }
  return { entries, files, skipped }
}

/**
 * Walk a skill bundle's resources.
 *
 * Skills are the one place where nested trees are legitimate (`references/`,
 * `scripts/`, `assets/`), so this recursion is bounded by depth rather than
 * flattened. Secrets and dependencies are still excluded — a skill that vendors a
 * token in `assets/` must not ship it.
 */
async function walkInto(directory, label, out, maxFiles, depth = 0) {
  if (depth > 6 || out.length >= maxFiles) return
  let dirents
  try {
    dirents = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    if (SKIP_NAMES.has(dirent.name) || isSecretName(dirent.name)) continue
    if (dirent.name.startsWith('.')) continue
    const absolute = join(directory, dirent.name)
    const target = `${label}/${dirent.name}`
    if (dirent.isDirectory()) {
      await walkInto(absolute, target, out, maxFiles, depth + 1)
    } else if (dirent.isFile()) {
      out.push({ source: absolute, target })
    }
  }
}

/**
 * Collect one `$DSH_HOME` subtree as flat files.
 *
 * Per-plugin state directories (`gongfeng-mr/`, `itfs-workbench/`, …) hold real
 * settings — starred items, default projects, panel preferences — so they are
 * synced. Their caches, tokens, and pairing records are not.
 *
 * @param {string} dshHome - `$DSH_HOME`.
 * @param {Set<string>} wanted - Top-level entry names to include.
 * @param {object} limits - `{ maxFiles, maxFileBytes }`.
 * @returns {Promise<{ files: Array<{ source: string, target: string }>, skipped: string[] }>} Files to copy.
 */
export async function collectDshHome(dshHome, wanted, limits) {
  const files = []
  const skipped = []
  for (const name of [...wanted].sort()) {
    if (!isSyncedDshHomeEntry(name) || isSecretName(name)) continue
    const absolute = join(dshHome, name)
    let info
    try {
      info = await stat(absolute)
    } catch {
      continue
    }
    if (info.isFile()) {
      if (info.size > limits.maxFileBytes) {
        skipped.push(name)
        continue
      }
      if (await looksSecret(absolute)) {
        skipped.push(name)
        continue
      }
      files.push({ source: absolute, target: `homes/dsh/${name}` })
      continue
    }
    if (!info.isDirectory()) continue
    // A per-plugin state directory: its JSON/toml-ish files are settings, its
    // caches are not. Skip by pattern, then by size, then by content sniff.
    for (const nested of await listTopLevelFiles(absolute)) {
      if (PLUGIN_STATE_SKIP.test(nested.name) || isSecretName(nested.name)) continue
      if (nested.size > limits.maxFileBytes) {
        skipped.push(`${name}/${nested.name}`)
        continue
      }
      if (await looksSecret(nested.path)) {
        skipped.push(`${name}/${nested.name}`)
        continue
      }
      files.push({ source: nested.path, target: `homes/dsh/${name}/${nested.name}` })
      if (files.length >= limits.maxFiles) return { files, skipped }
    }
  }
  return { files, skipped }
}

/** Direct children of a directory that are ordinary files. */
async function listTopLevelFiles(directory) {
  try {
    const dirents = await readdir(directory, { withFileTypes: true })
    const out = []
    for (const dirent of dirents) {
      if (!dirent.isFile() || dirent.name.startsWith('.')) continue
      const path = join(directory, dirent.name)
      try {
        const info = await stat(path)
        out.push({ name: dirent.name, path, size: info.size })
      } catch {
        // Vanished between readdir and stat: not a file we can copy.
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Content sniff for a credential that the file name does not advertise.
 *
 * Only the first 8 KiB are read, and only for small files: a file that is mostly
 * a token is a token, while a large config that merely mentions `api_key` in a
 * comment is ordinary config.
 */
async function looksSecret(path) {
  let info
  try {
    info = await stat(path)
  } catch {
    return true
  }
  if (info.size > 256 * 1024) return false
  try {
    const head = (await readFile(path, 'utf8')).slice(0, 8192)
    if (!SECRET_CONTENT_HINT.test(head)) return false
    // A real credential document is short and dense; a config file that speaks
    // about keys is long and full of unrelated structure. Treat short files
    // carrying a live-looking value as secrets, large ones as ordinary config.
    return info.size <= 4096
  } catch {
    return true
  }
}

/**
 * Package names actually present in a profile's `node_modules`.
 *
 * This is what decides whether a bundle can activate: the profile manifest's
 * `dependencies` is a request, and a bundle whose package is not on disk only
 * produces a startup warning. Scoped names are read one directory deeper.
 *
 * @param {string} profileDir - The profile directory.
 * @returns {Promise<string[]>} Installed package names, including `@scope/name` forms.
 */
export async function readInstalledPackages(profileDir) {
  const root = join(profileDir, 'node_modules')
  const names = []
  let dirents
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch {
    return names
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
    if (dirent.name.startsWith('.')) continue
    if (dirent.name.startsWith('@')) {
      try {
        for (const scoped of await readdir(join(root, dirent.name), { withFileTypes: true })) {
          if (scoped.isDirectory() || scoped.isSymbolicLink()) names.push(`${dirent.name}/${scoped.name}`)
        }
      } catch {
        // An unreadable scope contributes nothing.
      }
      continue
    }
    names.push(dirent.name)
  }
  return names
}

/**
 * Profile files to snapshot.
 *
 * The profile directory is walked one level deep with an allow list rather than
 * a deny list: the manifest and the patch layers are configuration, everything
 * else is either a dependency tree, a cache, or a backup of a previous edit.
 *
 * @param {string} profileDir - The active profile directory.
 * @returns {Promise<{ files: Array<{ source: string, target: string }>, skipped: string[] }>} Profile config files.
 */
export async function collectProfile(profileDir) {
  const preferred = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml']
  const files = []
  const skipped = []
  const seen = new Set()

  for (const name of preferred) {
    const source = join(profileDir, name)
    try {
      const info = await stat(source)
      if (!info.isFile()) continue
      files.push({ source, target: posix.join('profile', name) })
      seen.add(name)
    } catch {
      // Absent: a profile need not have every layer.
    }
  }

  let dirents = []
  try {
    dirents = await readdir(profileDir, { withFileTypes: true })
  } catch {
    return { files, skipped }
  }
  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!dirent.isFile() || seen.has(dirent.name)) continue
    if (dirent.name.startsWith('.') || SKIP_NAMES.has(dirent.name)) continue
    if (isSecretName(dirent.name) || dirent.name.includes('.bak')) {
      skipped.push(`profile/${dirent.name}`)
      continue
    }
    // Profiles may hold side files (`config.toml` with API keys). Keep the
    // documented config shapes and refuse anything else the content sniff flags.
    const source = join(profileDir, dirent.name)
    if (await looksSecret(source)) {
      skipped.push(`profile/${dirent.name}`)
      continue
    }
    files.push({ source, target: posix.join('profile', dirent.name) })
  }
  return { files, skipped }
}

/** Whether a snapshot-relative path is one this plugin may delete on restore. */
export function isRestorableTarget(absolute, roots) {
  const resolved = resolve(absolute)
  return roots.some((root) => {
    const base = resolve(root)
    return resolved === base || resolved.startsWith(`${base}${sep}`)
  })
}
