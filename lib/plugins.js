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
 * Resolve one dependency spec to a portable install spec.
 *
 * @param {string} name - Package name (used only for diagnostics).
 * @param {string} spec - The original spec.
 * @param {string} profileDir - The profile directory, for resolving relative paths.
 * @returns {Promise<{ spec: string, portable: boolean, source: 'unchanged'|'git-remote'|'local-only' }>} The resolved spec.
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
  return {
    spec: portableSpecFromRemote(remote),
    portable: true,
    source: 'git-remote',
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
 * @returns {Promise<{ manifest: object, localOnly: string[], resolved: Record<string, string> }>} Portable manifest plus diagnostics.
 */
export async function makePortableManifest(options) {
  const manifest = options.manifest
  const dependencies = manifest?.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return { manifest, localOnly: [], resolved: {} }
  }

  const next = { ...dependencies }
  const localOnly = []
  const resolved = {}
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') continue
    const outcome = await resolveDependencySpec(name, spec, options.profileDir)
    if (outcome.source === 'git-remote') {
      next[name] = outcome.spec
      resolved[name] = outcome.spec
    } else if (outcome.source === 'local-only') {
      localOnly.push(name)
    }
  }
  return { manifest: { ...manifest, dependencies: next }, localOnly, resolved }
}
