/**
 * Resolving a profile's plugin sources into portable install specs.
 *
 * This module exists because of a mistake the first cross-machine test exposed.
 * A profile manifest links local plugin sources by absolute path:
 *
 * ```json
 * "dsh-llm-minimax": "link:/Users/gzp/Documents/.../dsh-llm-minimax"
 * ```
 *
 * The obvious reading — "this is a machine-local path, drop it" — is wrong. Most
 * of those directories are **git working trees** whose `origin` is a shared
 * remote the other machine can clone. Dropping them is why minimax,
 * network-retry, agent-team-playbook and friends silently failed to appear on the
 * target machine even though their configuration had synced perfectly.
 *
 * The correct transformation happens on the **source** machine, where the path
 * still exists: ask git for each link's remote, and store that URL in the
 * snapshot instead of the path. A snapshot then describes *which plugins the user
 * chose* rather than *where they happened to live on one laptop*.
 *
 * Not every link has a remote. `@local/dsh-mcp-intranet`, for example, is a
 * hand-written bundle under `~/.local/share` with no git at all. Those are
 * genuinely machine-local; the snapshot records them as such and the target
 * machine keeps whatever local equivalent it has (or none).
 *
 * @module dsh-settings-sync/plugins
 */

import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Spec prefixes that name a location on one particular machine. */
const LOCAL_SPEC = /^(link:|file:|portal:|workspace:)/

/** Timeout for one `git remote get-url` probe. */
const GIT_TIMEOUT_MS = 8_000

/**
 * Run one git command and return its trimmed stdout, or undefined on any failure.
 *
 * @param {readonly string[]} args - git arguments.
 * @param {string} cwd - Working directory.
 * @returns {Promise<string|undefined>} stdout, or undefined.
 */
function gitOutput(args, cwd) {
  return new Promise((resolvePromise) => {
    execFile('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => {
      if (error !== null && error !== undefined) {
        resolvePromise(undefined)
        return
      }
      const text = String(stdout ?? '').trim()
      resolvePromise(text === '' ? undefined : text)
    })
  })
}

/**
 * Whether a dependency spec names a local path.
 *
 * @param {unknown} spec - The `dependencies` value.
 * @returns {boolean} Whether it is a path spec.
 */
export function isPathSpec(spec) {
  return typeof spec === 'string' && LOCAL_SPEC.test(spec)
}

/**
 * Strip the `link:` / `file:` / `portal:` prefix to get the filesystem path.
 *
 * @param {string} spec - A path spec.
 * @returns {string} The path.
 */
export function pathOf(spec) {
  return spec.replace(/^(link:|file:|portal:|workspace:)/, '')
}

/**
 * Turn a git remote URL into a spec pnpm can install on another machine.
 *
 * Three shapes matter, because pnpm parses them differently and one of them is
 * an easy trap:
 *
 * - `https://github.com/owner/repo(.git)` → `github:owner/repo`. Short, and
 *   pnpm resolves it through the normal GitHub path.
 * - scp-like `git@host:owner/repo.git` → `git+ssh://git@host/owner/repo.git`.
 *   Passing the bare scp form to `pnpm add` makes pnpm read it as a package named
 *   `git` linked to a path; the `git+ssh://` form is unambiguous.
 * - Anything else (an HTTPS URL on another host, an SSH URL) is already a valid
 *   git spec and is kept verbatim.
 *
 * @param {string} url - A `git remote get-url origin` result.
 * @returns {string} A portable install spec.
 */
export function portableSpecFromRemote(url) {
  const trimmed = url.trim()
  const github = /^https?:\/\/github\.com\/(.+?)(?:\.git)?\/?$/i.exec(trimmed)
  if (github !== null) return `github:${github[1]}`
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+):(.+)$/.exec(trimmed)
  if (scp !== null) return `git+ssh://${scp[1]}@${scp[2]}/${scp[3]}`
  if (/^git@/.test(trimmed)) return trimmed
  return trimmed
}

/**
 * Whether a package directory sits inside a git repo but is **not** the repo root.
 *
 * That is the monorepo case, and it is the difference between a working sync and
 * a broken one. `git remote get-url origin`, run inside `packages/foo`, returns
 * the *enclosing* repository — the same answer it gives for `packages/bar` and
 * for the repo root itself. Emitting that URL for both packages tells pnpm to
 * install the same repository twice, and what lands in `node_modules` is the
 * repository root both times: a `private` monorepo manifest with no `dsh.bundle`
 * and none of the subpackage's files. Measured on devcloud, that produced:
 *
 *   - `dsh-workbench-core` → "declares no dsh.bundle" → skipped
 *   - `dsh-itfs-workbench` → "Cannot find package .../dsh-workbench-core/index.js" → import failed
 *
 * @param {string} directory - The package directory (may be a symlink).
 * @returns {Promise<boolean>} True when the package is a repo subdirectory.
 */
async function isMonorepoSubpackage(directory) {
  const topLevel = await gitOutput(['rev-parse', '--show-toplevel'], directory)
  if (topLevel === undefined) return false
  try {
    // Compare real paths: a `link:` target is often a symlink, and comparing the
    // link against the resolved repo root would report a false mismatch.
    const [packageDir, repoRoot] = await Promise.all([realpath(directory), realpath(topLevel)])
    return packageDir !== repoRoot
  } catch {
    // An unresolvable path cannot be proven to be a subdirectory; treating it as
    // the root keeps the previous behaviour instead of inventing a downgrade.
    return false
  }
}

/**
 * Resolve one dependency spec to a portable install spec.
 *
 * Only a package that **is** its repository's root can be represented by that
 * repository's URL. A monorepo subpackage cannot: pnpm has no working syntax for
 * installing a git repository's subdirectory (measured — `#path:/sub`,
 * `github:owner/repo/sub` and the npm `?path=` form all either install the root
 * or fail outright). Emitting the shared URL anyway is worse than saying nothing,
 * so such a package is reported `local-only` and the merge keeps whatever the
 * target machine already has.
 *
 * @param {string} name - Package name (used only for diagnostics).
 * @param {string} spec - The original spec.
 * @param {string} profileDir - The profile directory, for resolving relative paths.
 * @returns {Promise<{ spec: string, portable: boolean, source: 'unchanged'|'git-remote'|'local-only', reason?: string }>} The resolved spec.
 */
export async function resolveDependencySpec(name, spec, profileDir) {
  if (!isPathSpec(spec)) {
    // A semver range, a github: spec, a tarball URL — already portable.
    return { spec, portable: true, source: 'unchanged' }
  }
  const rawPath = pathOf(spec)
  const absolute = resolve(profileDir, rawPath)
  const remote = await gitOutput(['remote', 'get-url', 'origin'], absolute)
  if (remote === undefined) {
    // A directory with no git remote: genuinely local to this machine.
    return { spec, portable: false, source: 'local-only' }
  }
  if (await isMonorepoSubpackage(absolute)) {
    return { spec, portable: false, source: 'local-only', reason: 'monorepo-subpackage' }
  }
  return {
    spec: portableSpecFromRemote(remote),
    portable: true,
    source: 'git-remote',
  }
}

/**
 * Build a complete `makePortableManifest` result.
 *
 * Every return path must go through here. The shape of this object is part of
 * the module's contract — callers read `.resolved`, `.localOnly` and
 * `.collisions` without checking for their presence — and a hand-written early
 * return that forgets one of them is how a `dependencies`-less manifest crashed
 * an entire push with `undefined is not iterable`. Constructing the whole object
 * in one place makes that class of drift impossible rather than merely fixed.
 *
 * @param {object} manifest - The (possibly rewritten) manifest.
 * @param {{ localOnly?: string[], resolved?: Record<string, string>, collisions?: string[] }} [diagnostics] - Optional diagnostics.
 * @returns {{ manifest: object, localOnly: string[], resolved: Record<string, string>, collisions: string[] }} The result.
 */
function portableOutcome(manifest, diagnostics = {}) {
  return {
    manifest,
    localOnly: Array.isArray(diagnostics.localOnly) ? diagnostics.localOnly : [],
    resolved: diagnostics.resolved !== null && typeof diagnostics.resolved === 'object' ? diagnostics.resolved : {},
    collisions: Array.isArray(diagnostics.collisions) ? diagnostics.collisions : [],
  }
}

/**
 * Rewrite a profile manifest so its dependency specs are portable.
 *
 * The source machine's real `package.json` is never touched: the caller writes
 * the returned object into the snapshot's mirror only. A `link:` pointing at a
 * git working tree becomes the remote's URL, so the target machine can install
 * it; a `link:` with no remote is left as-is and reported as `localOnly` so the
 * merge knows not to expect it to resolve there.
 *
 * @param {object} options - Inputs.
 * @param {object} options.manifest - Parsed `package.json`.
 * @param {string} options.profileDir - The profile directory (resolves relative link paths).
 * @returns {Promise<{ manifest: object, localOnly: string[], resolved: Record<string, string>, collisions: string[] }>} Portable manifest plus diagnostics. `collisions` lists remote URLs claimed by more than one package name; those packages were demoted to `localOnly` instead of being written as a spec that cannot install.
 */
export async function makePortableManifest(options) {
  const manifest = options.manifest
  const dependencies = manifest?.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    // Nothing to rewrite. The shape is still complete: a `package.json` without
    // a `dependencies` object is legal (a fresh profile or a hand-edited one),
    // and the caller must not have to guess whether the diagnostics exist.
    return portableOutcome(manifest)
  }

  const next = { ...dependencies }
  const localOnly = []
  const resolved = {}
  /** @type {Map<string, string[]>} spec → the package names that produced it. */
  const bySpec = new Map()
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') continue
    const outcome = await resolveDependencySpec(name, spec, options.profileDir)
    if (outcome.source === 'git-remote') {
      next[name] = outcome.spec
      resolved[name] = outcome.spec
      const owners = bySpec.get(outcome.spec)
      if (owners === undefined) bySpec.set(outcome.spec, [name])
      else owners.push(name)
    } else if (outcome.source === 'local-only') {
      localOnly.push(name)
    }
  }

  // A spec shared by two different package names is *always* wrong: installing
  // it produces the same directory twice, so at most one of the two can ever be
  // the package its name claims to be. The subdirectory check above already
  // catches the monorepo case, but this is the invariant that has to hold
  // regardless of how a collision arose — a differently-prefixed remote, a
  // rewritten `insteadOf` rule, two checkouts of one repo. Demote every loser
  // to local-only rather than shipping a snapshot that cannot install.
  const collisions = []
  for (const [spec, names] of bySpec) {
    if (names.length < 2) continue
    collisions.push(spec)
    for (const name of names) {
      // Restore the original local spec: `next` had just been given the shared
      // URL, and leaving it there is exactly the snapshot that broke devcloud.
      next[name] = dependencies[name]
      delete resolved[name]
      if (!localOnly.includes(name)) localOnly.push(name)
    }
  }

  return portableOutcome({ ...manifest, dependencies: next }, { localOnly, resolved, collisions })
}
