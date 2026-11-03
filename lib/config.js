/**
 * Where DSH keeps its files, and what this plugin's own configuration means.
 *
 * The plugin has two configuration layers, and they answer different questions:
 *
 *   - The **Loader row** (`cordis.patch.yml` → `config`) is deployment
 *     configuration: where the sync bookkeeping lives and how large a snapshot
 *     may get. It is edited like any other plugin's config.
 *   - The **user configuration** (`<stateDir>/config.json`) is what the Settings
 *     page writes: the repository URL, the branch, the automatic-sync policy.
 *     It lives in a file rather than in the row because it changes at runtime
 *     from the browser half, and rewriting the profile patch from a plugin would
 *     fight the Loader.
 *
 * Both are re-read on every request, so editing either takes effect without a
 * restart.
 *
 * @module dsh-settings-sync/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { normalizeRemote } from './git.js'

/** Branch used when the user never picked one. */
export const DEFAULT_BRANCH = 'main'

/**
 * Default commit identity.
 *
 * These are the values the user's `ghc` shell alias sets (`~/.zshrc`:
 * `git config user.email "me@elfgzp.cn" && git config user.name "Elf"`), so a
 * sync commit looks exactly like a commit they made themselves. They are
 * overridable in Settings for anybody else using the plugin.
 */
export const DEFAULT_GIT_NAME = 'Elf'
export const DEFAULT_GIT_EMAIL = 'me@elfgzp.cn'

/** Bumped when the first-run prompt must be shown again after an upgrade. */
export const PROMPT_VERSION = 1

/** Automatic-pull policies. `ask` is the shipped default: never overwrite silently. */
export const PULL_POLICIES = ['never', 'ask', 'always']

/** Expand the tilde forms a user may type into a path field. */
export function expandHomePath(value) {
  if (typeof value !== 'string' || value === '') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** `$DSH_HOME`, defaulting to `~/.dsh` exactly like the harness does. */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : undefined
  return resolve(expandHomePath(fromEnv ?? join(homedir(), '.dsh')))
}

/**
 * The profile directory this Host is running.
 *
 * Three sources, in descending order of trust, because getting this wrong is not
 * a cosmetic bug — it decides which files a snapshot contains:
 *
 *   1. `facts.profileDir`, read from the `profileContext` service. This is the
 *      only source that is right under DSH Desktop, which passes the profile
 *      directory as an argv path to the desktop host and exports *no* profile
 *      environment variable at all.
 *   2. `DSH_PROFILE_DIR`, which a CLI-launched profile exports.
 *   3. `DSH_PROFILE` plus `$DSH_HOME`, for a shell that set only the name.
 *
 * There is deliberately no "default profile" fallback: a wrong-but-existing path
 * is worse than an obviously empty one, because the latter trips the guard in
 * `SyncEngine#push` instead of silently snapshotting the wrong profile.
 *
 * @param {NodeJS.ProcessEnv} [env] - Environment to read.
 * @param {{ profileDir?: string }} [facts] - Profile facts from the Host service.
 * @returns {string} The absolute profile directory.
 */
export function resolveProfileDir(env = process.env, facts = {}) {
  if (typeof facts.profileDir === 'string' && facts.profileDir.trim() !== '') {
    return resolve(expandHomePath(facts.profileDir.trim()))
  }
  const explicit = typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.trim() !== ''
    ? env.DSH_PROFILE_DIR
    : undefined
  if (explicit !== undefined) return resolve(expandHomePath(explicit))
  const name = typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== '' ? env.DSH_PROFILE : undefined
  if (name === undefined) return join(resolveDshHome(env), 'profiles', 'desktop')
  if (name === '' || name === '.' || name === '..' || name === 'node_modules'
    || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`settings-sync: 非法的 profile 名 ${JSON.stringify(name)}`)
  }
  return join(resolveDshHome(env), 'profiles', name)
}

/** `$DSH_AGENTS_HOME`, defaulting to `~/.agents` — the shared agent config root. */
export function resolveAgentsHome(env = process.env) {
  const fromEnv = typeof env.DSH_AGENTS_HOME === 'string' && env.DSH_AGENTS_HOME.trim() !== ''
    ? env.DSH_AGENTS_HOME
    : undefined
  return resolve(expandHomePath(fromEnv ?? join(homedir(), '.agents')))
}

/** Coerce a positive integer with a floor and a ceiling. */
function positive(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Trim a string setting, treating blanks as absent. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Normalize the Loader row config.
 *
 * @param {object} [raw] - The `config` block of the patch row.
 * @param {NodeJS.ProcessEnv} [env] - Environment to resolve paths against.
 * @param {{ profileDir?: string, dshHome?: string }} [facts] - Authoritative facts from the Host's `profileContext` service, which outrank both the environment and the defaults.
 * @returns {{ stateDir: string, gitPath: string|undefined, maxFiles: number, maxBytes: number, maxFileBytes: number, dshHome: string, profileDir: string, agentsHome: string }} Resolved deployment config.
 */
export function resolveConfig(raw = {}, env = process.env, facts = {}) {
  const dshHome = typeof facts.dshHome === 'string' && facts.dshHome.trim() !== ''
    ? resolve(expandHomePath(facts.dshHome.trim()))
    : resolveDshHome(env)
  const stateDir = resolve(expandHomePath(text(raw?.stateDir) ?? join(dshHome, 'settings-sync')))
  return {
    stateDir,
    gitPath: text(raw?.gitPath),
    maxFiles: positive(raw?.maxFiles, 4000, 1, 100_000),
    maxBytes: positive(raw?.maxBytes, 32 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    maxFileBytes: positive(raw?.maxFileBytes, 2 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    dshHome,
    profileDir: resolveProfileDir(env, facts),
    agentsHome: resolveAgentsHome(env),
  }
}

/**
 * Whether a string is a repository address worth handing to git.
 *
 * Existence is not the same question as usability, so this defers to the one
 * validator git itself is called with. A URL that passes here can safely reach
 * `git`; anything else is rejected before it becomes an argument.
 *
 * @param {unknown} value - Candidate remote.
 * @returns {boolean} Whether git can be given this remote.
 */
export function isRepoUrl(value) {
  return normalizeRemote(value) !== undefined
}

/** Whether a string is a usable git branch name (conservative subset). */
export function isBranchName(value) {
  if (typeof value !== 'string') return false
  return /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith('/') && !value.endsWith('/')
}
