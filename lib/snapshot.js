/**
 * Building, applying, and reversing a snapshot.
 *
 * A snapshot is built in three steps, and separating them is what makes the diff
 * trustworthy:
 *
 *   1. **Collect** reads the live machine and produces a plan — a list of
 *      `{ source, target }` file pairs plus the skill and plugin inventory.
 *      Nothing on disk is touched.
 *   2. **Materialize** writes that plan into the mirror clone's working tree and
 *      prunes whatever the plan no longer contains, so the mirror is always an
 *      exact image of the current settings rather than a union of every past run.
 *   3. **Diff** asks git what that writing changed. Because the mirror is a real
 *      repository and the commit history is the snapshot history, `git status`
 *      is both the preview shown in Settings and the commit boundary.
 *
 * Restoring runs the same pipeline backwards and — this is the part that has to
 * be right — always writes a restore point first. Overwriting somebody's config
 * is unrecoverable otherwise, and "I pressed the wrong button" is the most
 * likely thing to happen on a first install.
 *
 * @module dsh-settings-sync/snapshot
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'

import { mergeManifest } from './manifest.js'
import { readInstalledPackages } from './paths.js'
import { collectDshHome, collectProfile, collectSkills, isSecretName, isSyncedDshHomeEntry } from './paths.js'

/** Snapshot format version, bumped when the layout changes incompatibly. */
export const SNAPSHOT_FORMAT = 1

/**
 * What a redacted credential value is replaced with.
 *
 * One constant, used by the writer and recognised by the restorer, so the two can
 * never disagree about which bytes mean "a secret used to be here".
 */
export const REDACTION_PLACEHOLDER = '<redacted by dsh-settings-sync>'

/** Snapshot-relative path of the descriptor written by every run. */
const MANIFEST_PATH = 'manifest.json'

/** Snapshot subdirectories this plugin owns and may prune. */
const MANAGED_PREFIXES = ['profile/', 'homes/dsh/', 'homes/agents/skills/']

/** Where a snapshot path lives on this machine. */
export function targetOf(snapshotPath, config) {
  if (snapshotPath.startsWith('profile/')) return join(config.profileDir, snapshotPath.slice('profile/'.length))
  if (snapshotPath.startsWith('homes/dsh/')) return join(config.dshHome, snapshotPath.slice('homes/dsh/'.length))
  if (snapshotPath.startsWith('homes/agents/skills/')) {
    return join(config.agentsHome, 'skills', snapshotPath.slice('homes/agents/skills/'.length))
  }
  return undefined
}

/** Classify a snapshot path for the UI, so a diff row can say what it is. */
export function classify(snapshotPath) {
  if (snapshotPath === MANIFEST_PATH) return 'meta'
  if (snapshotPath.startsWith('profile/')) return 'profile'
  if (snapshotPath.startsWith('homes/agents/skills/') || snapshotPath.includes('/skills/')) return 'skill'
  return 'plugin-state'
}

/**
 * Collect everything worth syncing on this machine.
 *
 * The returned plan is complete but not yet written anywhere, so a diff can be
 * produced without touching the mirror.
 *
 * @param {object} config - Resolved deployment config (`stateDir`, roots, caps).
 * @returns {Promise<{ files: Array<{source: string, target: string}>, skills: Array<object>, plugins: string[], skipped: string[], bytes: number }>} The plan.
 */
export async function collectSnapshot(config) {
  const files = []
  const skills = []
  const skipped = []
  let bytes = 0

  // 1. Profile configuration: the manifest and the patch layers.
  const profile = await collectProfile(config.profileDir)
  for (const file of profile.files) {
    files.push(file)
    bytes += await sizeOf(file.source)
  }
  skipped.push(...profile.skipped)

  // 2. User-level skills from both skill roots DSH scans.
  for (const [root, label] of [
    [join(config.dshHome, 'skills'), 'homes/dsh/skills'],
    [join(config.agentsHome, 'skills'), 'homes/agents/skills'],
  ]) {
    const found = await collectSkills(root, label, config.maxFiles - files.length)
    for (const file of found.files) {
      if (files.length >= config.maxFiles) break
      files.push(file)
      bytes += await sizeOf(file.source)
    }
    skills.push(...found.entries)
    skipped.push(...found.skipped)
  }

  // 3. Per-plugin state directories under `$DSH_HOME` (starred items, default
  //    projects, panel preferences). The allow list is "everything except what
  //    paths.js knows is a cache, a session store, or a credential".
  const wanted = await syncedDshHomeEntries(config.dshHome)
  const pluginState = await collectDshHome(config.dshHome, wanted, {
    maxFiles: Math.max(0, config.maxFiles - files.length),
    maxFileBytes: config.maxFileBytes,
  })
  for (const file of pluginState.files) {
    if (files.length >= config.maxFiles) break
    if (bytes + await sizeOf(file.source) > config.maxBytes) break
    files.push(file)
    bytes += await sizeOf(file.source)
  }
  skipped.push(...pluginState.skipped)

  const plugins = await readInstalledPlugins(config.profileDir)
  return { files, skills, plugins, skipped: dedupe(skipped), bytes }
}

/** Top-level `$DSH_HOME` entries that are settings rather than runtime data. */
async function syncedDshHomeEntries(dshHome) {
  const wanted = new Set()
  for (const entry of await readdirSafe(dshHome)) {
    const name = entry.name
    // `skills` and `agents` are handled by collectSkills with their own rules.
    if (name === 'skills' || name === 'agents') continue
    if (!isSyncedDshHomeEntry(name)) continue
    wanted.add(name)
  }
  return wanted
}

/** The plugin inventory, read from the profile manifest. */
async function readInstalledPlugins(profileDir) {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const names = new Set(Object.keys(manifest?.dependencies ?? {}))
    for (const name of manifest?.dsh?.profile?.bundles ?? []) names.add(String(name))
    return [...names].sort()
  } catch {
    return []
  }
}

/** `readdir` that returns an empty list instead of throwing. */
async function readdirSafe(directory) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

/** File size, or 0 when it vanishes mid-walk. */
async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** Stable dedupe that preserves the first occurrence. */
function dedupe(values) {
  return [...new Set(values)]
}

/**
 * Write a plan into a working tree, pruning everything the plan no longer has.
 *
 * "Prune" only ever removes files under this plugin's own managed prefixes, so a
 * repository that happens to hold a README or an unrelated directory is left
 * alone.
 *
 * @param {string} workTree - The mirror clone's working directory.
 * @param {ReturnType<typeof collectSnapshot> extends Promise<infer T> ? T : never} plan - Collected plan.
 * @param {{ redactSecrets?: boolean }} [options] - Snapshot options; `redactSecrets` replaces live credential values before they leave this machine.
 * @returns {Promise<{ written: number, removed: number, bytes: number, redacted: number }>} What changed on disk.
 */
export async function materialize(workTree, plan, options = {}) {
  await mkdir(workTree, { recursive: true })
  const wanted = new Set(plan.files.map((file) => file.target))

  let written = 0
  let bytes = 0
  let redacted = 0
  for (const file of plan.files) {
    const destination = join(workTree, file.target)
    await mkdir(dirname(destination), { recursive: true })
    try {
      if (options.redactSecrets === true) {
        const outcome = await copyRedacted(file.source, destination)
        if (outcome.redacted > 0) redacted += outcome.redacted
      } else {
        await copyFile(file.source, destination)
      }
      written += 1
      bytes += await sizeOf(destination)
    } catch {
      // A file that disappeared between collection and copy is simply not in
      // this snapshot; the next run picks up whatever replaced it.
    }
  }

  const removed = await prune(workTree, wanted)
  await writeManifest(workTree, plan, { written, removed, bytes, redacted })
  return { written, removed, bytes, redacted }
}

/**
 * Merge the snapshot's profile manifest onto this machine's.
 *
 * A thin file wrapper around {@link mergeManifest}: it reads both sides, applies
 * the merge rules, and reports what it did so the restore can list the notes.
 *
 * @param {string} source - The snapshot's `package.json`.
 * @param {string} target - This machine's `package.json`.
 * @returns {Promise<{ kind: 'written'|'copy', notes: string[] }>} What happened.
 */
async function mergeProfileManifest(source, target) {
  let incoming
  try {
    incoming = JSON.parse(await readFile(source, 'utf8'))
  } catch {
    return { kind: 'copy', notes: [] }
  }
  let local
  try {
    local = JSON.parse(await readFile(target, 'utf8'))
  } catch {
    local = undefined
  }
  const installed = await readInstalledPackages(dirname(target))
  const merged = mergeManifest({ incoming, local, installed })
  await writeFile(target, `${JSON.stringify(merged.manifest, null, 2)}\n`, 'utf8')
  return { kind: 'written', notes: merged.notes }
}

/**
 * Write a snapshot file whose contents contain redacted placeholders, keeping any
 * real local value the placeholder stands for.
 *
 * The two files are compared line by line. Where the snapshot has the placeholder
 * and the local file has a real value on the matching line, the local line wins —
 * that is the whole point of redaction: the secret never left the machine, so the
 * machine's copy is the only copy. Everything else comes from the snapshot, which
 * is what makes a pull still a real restore.
 *
 * If the line structures do not line up (the remote was edited by hand, or the
 * file was restructured), rewriting would be guesswork, so the file is left
 * entirely alone and reported as skipped: a restore that silently guesses which
 * key belongs where is worse than one that declines and says so.
 *
 * @param {string} source - Snapshot file.
 * @param {string} target - Local file it would overwrite.
 * @param {string} incomingText - Already-read snapshot contents.
 * @returns {Promise<'written'|'skipped'|'copy'>} `written` when a merged file was produced, `skipped` when the local file must be kept, `copy` when the caller should copy verbatim.
 */
async function mergeRedacted(source, target, incomingText) {
  let localText
  try {
    localText = await readFile(target, 'utf8')
  } catch {
    // No local file at all: this is a genuinely fresh machine, and the
    // placeholder is the honest content. Copy it so the user knows a key is owed.
    return 'copy'
  }

  // Match by key name rather than by line number. The two files routinely differ
  // in line count — a pull is also how a clobbered or hand-mangled file gets
  // repaired — and refusing to restore in that case would be the restore failing
  // at exactly the moment it is needed.
  const localByKey = new Map()
  for (const line of localText.split('\n')) {
    const parsed = parseCredentialLine(line)
    if (parsed !== undefined) localByKey.set(parsed.key, { line, value: parsed.value })
  }

  let kept = 0
  const merged = incomingText.split('\n').map((line) => {
    if (!line.includes(REDACTION_PLACEHOLDER)) return line
    const parsed = parseCredentialLine(line)
    if (parsed === undefined) return line
    const local = localByKey.get(parsed.key)
    if (local === undefined) return line
    if (local.value === '' || local.value.includes(REDACTION_PLACEHOLDER)) return line
    kept += 1
    // Keep the local line verbatim so its original quoting and spacing survive.
    return local.line
  })
  if (kept === 0) return 'copy'
  await writeFile(target, merged.join('\n'), 'utf8')
  return 'written'
}

/**
 * Split a `key: value` / `key = value` line into its key and value.
 *
 * Deliberately shallow: this runs over YAML, JSON and TOML alike, and a real
 * parser for any of them would be a dependency this plugin does not otherwise
 * need. It only has to recognise the shape of a credential assignment well enough
 * to pair a redacted line with its local counterpart.
 *
 * @param {string} line - One line of a config file.
 * @returns {{ key: string, value: string } | undefined} The key and value, or undefined for a line that is not an assignment.
 */
function parseCredentialLine(line) {
  const match = /^\s*(?:[-*]\s*)?["']?([\w.-]+)["']?\s*[:=]\s*(.*)$/.exec(line)
  if (match === null) return undefined
  const value = match[2].trim().replace(/^["']|["']$/g, '').replace(/\s*#.*$/, '').trim()
  return { key: match[1], value }
}

/**
 * Copy one file, replacing live credential values with a placeholder.
 *
 * The snapshot repository is private, but "private" is a setting somebody can
 * change, and a profile patch routinely holds a real API key under a key named
 * `apiKey`. Redaction is therefore a per-file text transform rather than a
 * pattern applied to every file: only lines that look like a credential
 * assignment are rewritten, so the snapshot stays a faithful description of the
 * *configuration* while carrying no working secret.
 *
 * @param {string} source - File to read.
 * @param {string} destination - File to write.
 * @returns {Promise<{ redacted: number }>} How many values were replaced.
 */
async function copyRedacted(source, destination) {
  const content = await readFile(source, 'utf8')
  let redacted = 0
  const lines = content.split('\n').map((line) => {
    // `apiKey: sk-…`, `token = "…"`, `"accessToken": "eyJ…"` and friends.
    const match = /^(\s*(?:[-*]\s*)?["']?[\w.-]*(?:token|key|secret|password|passwd|credential|auth)[\w.-]*["']?\s*[:=]\s*)(["']?)([^"'\s#]{8,})\2(\s*(?:#.*)?)$/i
      .exec(line)
    if (match === null) return line
    const value = match[3]
    // Leave references and plain configuration words alone: an env-var *name*,
    // a boolean, a path, or a URL is not a secret.
    if (/^[A-Z][A-Z0-9_]*$/.test(value)) return line
    if (/^(true|false|null|~\d+|\d+)$/i.test(value)) return line
    if (/^[./~]/.test(value)) return line
    redacted += 1
    return `${match[1]}${match[2]}<redacted by dsh-settings-sync>${match[2]}${match[4]}`
  })
  await writeFile(destination, lines.join('\n'), 'utf8')
  return { redacted }
}

/** Delete managed files that are not in the wanted set. */
async function prune(workTree, wanted) {
  let removed = 0
  for (const prefix of MANAGED_PREFIXES) {
    const root = join(workTree, prefix)
    for (const path of await listFiles(root)) {
      const snapshotPath = posix.join(prefix, path.split(sep).join('/'))
      if (wanted.has(snapshotPath)) continue
      if (isSecretName(path)) {
        // Never leave a credential in the tree, and never treat its presence as
        // a change worth reporting either.
        await rm(join(root, path), { force: true })
        continue
      }
      await rm(join(root, path), { force: true })
      removed += 1
    }
    await removeEmptyDirectories(root).catch(() => {})
  }
  return removed
}

/** Every file under a directory, as paths relative to it. */
async function listFiles(root, base = root) {
  const out = []
  for (const entry of await readdirSafe(root)) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...await listFiles(absolute, base))
    } else if (entry.isFile()) {
      out.push(relative(base, absolute))
    }
  }
  return out
}

/** Remove now-empty directories bottom-up; best effort, never fatal. */
async function removeEmptyDirectories(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(join(root, entry.name))
  }
  const remaining = await readdir(root).catch(() => ['x'])
  if (remaining.length === 0) await rm(root, { recursive: true, force: true })
}

/**
 * Write the descriptor that tells a future restore what this snapshot is.
 *
 * Deliberately free of timestamps and other run-varying fields. The manifest sits
 * inside the repository, so anything volatile here would make every push a commit
 * even when nothing was edited — and "no changes" would stop being true. The
 * snapshot's *time* is the commit's own time, which git already records.
 */
async function writeManifest(workTree, plan, applied) {
  const manifest = {
    format: SNAPSHOT_FORMAT,
    generator: 'dsh-settings-sync',
    // Recorded so a future restore can tell the user why a key came back as a
    // placeholder instead of a working credential.
    redacted: Number(applied?.redacted ?? 0),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    counts: {
      files: plan.files.length,
      bytes: plan.bytes,
      skills: plan.skills.length,
      plugins: plan.plugins.length,
    },
    skills: plan.skills,
    plugins: plan.plugins,
  }
  await writeFile(join(workTree, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

/** Read a snapshot's manifest, or null when it is absent or unreadable. */
export async function readManifest(workTree) {
  try {
    return JSON.parse(await readFile(join(workTree, MANIFEST_PATH), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Turn git's change list into the UI's diff entries.
 *
 * @param {Array<{ path: string, change: 'added'|'modified'|'removed' }>} changes - Normalized git changes.
 * @returns {{ entries: Array<{ path: string, change: string, kind: string }>, counts: { added: number, modified: number, removed: number, total: number } }} Diff payload.
 */
export function describeChanges(changes) {
  const entries = changes
    .map((change) => ({ path: change.path, change: change.change, kind: classify(change.path) }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const counts = { added: 0, modified: 0, removed: 0, total: entries.length }
  for (const entry of entries) {
    if (entry.change === 'added') counts.added += 1
    else if (entry.change === 'removed') counts.removed += 1
    else counts.modified += 1
  }
  return { entries, counts }
}

/**
 * Copy a restored working tree back onto this machine.
 *
 * Two modes, because "overwrite" and "merge" answer different questions:
 *
 *   - `overwrite` (default) makes the machine match the remote exactly: every
 *     file in the snapshot is written, and every *managed local* file that the
 *     snapshot does not have is deleted. Files this plugin never collects —
 *     dependencies, sessions, anything outside its own roots — are untouched.
 *   - `merge-skills` writes and updates files but never deletes, which is the
 *     right choice when the two machines carry different skill sets and the user
 *     wants the union on both.
 *
 * A restore point of the current state is written first, and its path is
 * returned so the UI can offer an undo.
 *
 * **Redacted values are preserved, never written.** A snapshot taken with
 * `redactSecrets` holds `<redacted by dsh-settings-sync>` where a live credential
 * used to be. Writing that placeholder onto this machine would replace a working
 * API key with a literal string — the restore would look successful while quietly
 * breaking the configuration it was supposed to reproduce. So a file whose
 * snapshot copy contains a placeholder is written only when the local file has no
 * real value at that spot either (a genuinely fresh machine), and the merge keeps
 * every local secret that the placeholder stands for.
 *
 * @param {object} options - Restore request.
 * @param {string} options.workTree - Working tree holding the snapshot to apply.
 * @param {object} options.config - Resolved deployment config.
 * @param {string} options.mode - `overwrite` or `merge-skills`.
 * @param {string} options.backupsDir - Where restore points are written.
 * @returns {Promise<{ files: number, removed: number, backedUpTo: string|null, skipped: string[] }>} Restore outcome.
 */
export async function restoreSnapshot(options) {
  const { workTree, config, mode } = options
  const overwrite = mode !== 'merge-skills'
  const skipped = []
  /** Human-readable notes about merges that were not a plain copy. */
  const notes = []

  // 1. The restore point: everything this plugin would collect right now.
  const current = await collectSnapshot(config)
  const backedUpTo = await writeRestorePoint(options.backupsDir, current)

  // 2. What the snapshot actually contains.
  const incoming = await listSnapshotFiles(workTree)

  // 3. Write it.
  let files = 0
  let preserved = 0
  for (const snapshotPath of incoming) {
    const target = targetOf(snapshotPath, config)
    if (target === undefined) continue
    if (isSecretName(target)) {
      skipped.push(snapshotPath)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    try {
      // `package.json` is the one file that must be merged rather than copied:
      // its dependency specs are half local paths. See `lib/manifest.js`.
      if (snapshotPath === 'profile/package.json') {
        const merged = await mergeProfileManifest(join(workTree, snapshotPath), target)
        if (merged.kind === 'written') {
          files += 1
          notes.push(...merged.notes)
          continue
        }
      }
      const source = join(workTree, snapshotPath)
      const incomingText = await readFile(source, 'utf8').catch(() => undefined)
      if (incomingText !== undefined && incomingText.includes(REDACTION_PLACEHOLDER)) {
        const merged = await mergeRedacted(source, target, incomingText)
        if (merged === 'skipped') {
          skipped.push(`${snapshotPath}（保留本机密钥，未覆盖）`)
          preserved += 1
          continue
        }
        if (merged === 'written') {
          files += 1
          preserved += 1
          continue
        }
      }
      await copyFile(source, target)
      files += 1
    } catch (error) {
      skipped.push(`${snapshotPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 4. Optionally delete managed local files the snapshot does not have.
  let removed = 0
  if (overwrite) {
    const keep = new Set(incoming)
    for (const file of current.files) {
      if (keep.has(file.target)) continue
      await rm(file.source, { force: true })
      removed += 1
    }
  }

  return { files, removed, backedUpTo, skipped, preserved, notes }
}

/**
 * Every file in a snapshot tree, as snapshot-relative POSIX paths.
 *
 * @param {string} workTree - The mirror's working directory.
 * @returns {Promise<string[]>} Sorted snapshot paths.
 */
export async function listSnapshotFiles(workTree) {
  const out = []
  for (const prefix of [...MANAGED_PREFIXES, '']) {
    const root = prefix === '' ? workTree : join(workTree, prefix)
    if (prefix === '') continue
    for (const path of await listFiles(root)) {
      out.push(posix.join(prefix, path.split(sep).join('/')))
    }
  }
  return out.sort()
}

/**
 * Write a restore point: a timestamped copy of the current snapshot.
 *
 * Restore points live outside the repository (under `<stateDir>/backups`) so
 * undoing a bad pull never depends on the remote being reachable.
 *
 * @param {string} backupsDir - Root for restore points.
 * @param {{ files: Array<{source: string, target: string}> }} plan - Current plan to capture.
 * @param {string} [label] - Human label, e.g. `before-pull`.
 * @returns {Promise<string|null>} The restore point directory, or null when there was nothing to save.
 */
export async function writeRestorePoint(backupsDir, plan, label = 'snapshot') {
  if (plan.files.length === 0) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const id = `${stamp}-${label}`
  const root = join(backupsDir, id)
  let written = 0
  for (const file of plan.files) {
    const destination = join(root, file.target)
    try {
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(file.source, destination)
      written += 1
    } catch {
      // Skipping one unreadable file must not lose the rest of the restore point.
    }
  }
  if (written === 0) {
    await rm(root, { recursive: true, force: true })
    return null
  }
  await writeFile(join(root, 'restore-point.json'), `${JSON.stringify({
    id,
    label,
    at: new Date().toISOString(),
    files: written,
    format: SNAPSHOT_FORMAT,
  }, null, 2)}\n`, 'utf8')
  return root
}

/**
 * List restore points, newest first.
 *
 * @param {string} backupsDir - Root for restore points.
 * @returns {Promise<Array<{ id: string, at: number, label: string, files: number }>>} Restore points.
 */
export async function listRestorePoints(backupsDir) {
  const items = []
  for (const entry of await readdirSafe(backupsDir)) {
    if (!entry.isDirectory()) continue
    const descriptor = join(backupsDir, entry.name, 'restore-point.json')
    try {
      const parsed = JSON.parse(await readFile(descriptor, 'utf8'))
      items.push({
        id: String(parsed.id ?? entry.name),
        at: Date.parse(String(parsed.at ?? '')) || 0,
        label: String(parsed.label ?? 'snapshot'),
        files: Number(parsed.files ?? 0),
      })
    } catch {
      continue
    }
  }
  return items.sort((left, right) => right.at - left.at)
}

/**
 * Resolve one restore point id to a directory, refusing anything that escapes.
 *
 * @param {string} backupsDir - Root for restore points.
 * @param {unknown} id - The id the UI sent.
 * @returns {Promise<string|null>} The directory, or null when unknown/unsafe.
 */
export async function resolveRestorePoint(backupsDir, id) {
  if (typeof id !== 'string' || id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) {
    return null
  }
  const root = resolve(backupsDir, id)
  const base = resolve(backupsDir)
  if (!root.startsWith(`${base}${sep}`)) return null
  try {
    const info = await stat(root)
    return info.isDirectory() ? root : null
  } catch {
    return null
  }
}

/**
 * Restore one saved restore point onto this machine.
 *
 * Reuses {@link restoreSnapshot} by pointing it at the restore-point directory,
 * which has the same layout as a snapshot tree.
 *
 * @param {object} options - Restore request.
 * @param {string} options.directory - The restore point directory.
 * @param {object} options.config - Resolved deployment config.
 * @param {string} options.backupsDir - Where the pre-restore restore point goes.
 * @returns {Promise<object>} Restore outcome.
 */
export async function restorePoint(options) {
  return restoreSnapshot({
    workTree: options.directory,
    config: options.config,
    mode: 'overwrite',
    backupsDir: options.backupsDir,
  })
}

/**
 * A short, stable fingerprint of a plan, used to decide whether an automatic
 * push has anything new to say. Hashing the file contents rather than the paths
 * is what makes "nothing changed" trustworthy across a restart.
 *
 * @param {{ files: Array<{ target: string }> }} plan - Collected plan.
 * @param {Map<string, string>} hashes - Precomputed `target -> sha1` map.
 * @returns {string} Hex digest.
 */
export function planDigest(plan, hashes) {
  const hash = createHash('sha1')
  for (const target of plan.files.map((file) => file.target).sort()) {
    hash.update(target)
    hash.update('\0')
    hash.update(hashes.get(target) ?? '')
    hash.update('\n')
  }
  return hash.digest('hex')
}
