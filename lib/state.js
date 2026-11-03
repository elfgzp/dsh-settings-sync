/**
 * Runtime settings and last-run state, kept in `<stateDir>/config.json`.
 *
 * One small JSON document owns everything the Settings page can change. Reads
 * are cheap and re-run per request, so a write from the browser half is visible
 * to the very next Host call with no cache to invalidate.
 *
 * The file is written through a temp file and a rename, so a crash mid-write
 * leaves the previous document intact instead of a truncated one.
 *
 * @module dsh-settings-sync/state
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEFAULT_BRANCH,
  DEFAULT_GIT_EMAIL,
  DEFAULT_GIT_NAME,
  PROMPT_VERSION,
  PULL_POLICIES,
  isBranchName,
  isRepoUrl,
} from './config.js'

/** Shipped defaults for the user configuration. */
export function defaultUserConfig() {
  return {
    /** The private snapshot repository. Empty until the user sets it. */
    repoUrl: '',
    /** Branch the snapshot is pushed to and pulled from. */
    branch: DEFAULT_BRANCH,
    /** Push automatically after a local change settles. */
    autoPush: false,
    /**
     * What to do about the remote when DSH starts or a session is created:
     * `never` ignores it, `ask` offers the choice once per start, `always`
     * pulls when the remote is ahead and local is clean.
     */
    pullPolicy: 'ask',
    /** Timer interval for the periodic check; 0 disables it. */
    intervalMs: 0,
    /** Commit identity used inside the mirror clone. */
    gitName: DEFAULT_GIT_NAME,
    gitEmail: DEFAULT_GIT_EMAIL,
    /**
     * Replace live credential values with a placeholder before anything leaves
     * this machine.
     *
     * On by default: a profile patch routinely contains a real API key, and the
     * snapshot repository is only as private as its visibility setting. Turning
     * this off is for a user who wants a byte-faithful backup and understands
     * that it carries working secrets.
     */
    redactSecrets: true,
    /** The prompt version the user has already answered. */
    promptVersion: 0,
    /** When the user last answered the first-run prompt. */
    promptAnsweredAt: 0,
  }
}

/** Normalize anything read off disk into a complete, valid document. */
export function normalizeUserConfig(raw) {
  const base = defaultUserConfig()
  if (raw === null || typeof raw !== 'object') return base
  const repoUrl = typeof raw.repoUrl === 'string' && (raw.repoUrl === '' || isRepoUrl(raw.repoUrl))
    ? raw.repoUrl.trim()
    : base.repoUrl
  return {
    repoUrl,
    branch: isBranchName(raw.branch) ? raw.branch : base.branch,
    autoPush: typeof raw.autoPush === 'boolean' ? raw.autoPush : base.autoPush,
    pullPolicy: PULL_POLICIES.includes(raw.pullPolicy) ? raw.pullPolicy : base.pullPolicy,
    intervalMs: Number.isFinite(raw.intervalMs) ? Math.max(0, Math.trunc(raw.intervalMs)) : base.intervalMs,
    gitName: typeof raw.gitName === 'string' && raw.gitName.trim() !== '' ? raw.gitName.trim() : base.gitName,
    gitEmail: typeof raw.gitEmail === 'string' && raw.gitEmail.trim() !== '' ? raw.gitEmail.trim() : base.gitEmail,
    redactSecrets: typeof raw.redactSecrets === 'boolean' ? raw.redactSecrets : base.redactSecrets,
    promptVersion: Number.isFinite(raw.promptVersion) ? Math.trunc(raw.promptVersion) : base.promptVersion,
    promptAnsweredAt: Number.isFinite(raw.promptAnsweredAt) ? Math.trunc(raw.promptAnsweredAt) : base.promptAnsweredAt,
  }
}

/** Whether the first-run (or post-upgrade) prompt is still owed to the user. */
export function promptPending(userConfig) {
  return userConfig.promptVersion < PROMPT_VERSION
}

/** Outcome of the most recent push or pull, surfaced by the status route. */
function defaultLastRun() {
  return { at: 0, direction: null, commit: null, summary: null, files: 0 }
}

/** Read, normalize, and (on first use) create the state directory. */
export class StateStore {
  /**
   * @param {string} stateDir - `<stateDir>` from the resolved deployment config.
   */
  constructor(stateDir) {
    this.stateDir = stateDir
    this.configFile = join(stateDir, 'config.json')
    this.lastRunFile = join(stateDir, 'last-run.json')
  }

  /** Create the state directory and any parent it needs. */
  async ensure() {
    await mkdir(this.stateDir, { recursive: true })
  }

  /** Read one JSON document, or the fallback when the file is absent or broken. */
  async #read(file, fallback) {
    try {
      const content = await readFile(file, 'utf8')
      const parsed = JSON.parse(content)
      return parsed === null || typeof parsed !== 'object' ? fallback : parsed
    } catch {
      return fallback
    }
  }

  /** Write one JSON document atomically. */
  async #write(file, value) {
    await this.ensure()
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  }

  /** The current user configuration, fully defaulted. */
  async readUserConfig() {
    return normalizeUserConfig(await this.#read(this.configFile, null))
  }

  /**
   * Merge a patch into the user configuration.
   *
   * Only known keys are merged, and `undefined` means "leave alone" so a form
   * that omits a field cannot erase it.
   *
   * @param {object} patch - Subset of the user configuration.
   * @returns {Promise<object>} The saved configuration.
   */
  async writeUserConfig(patch) {
    const current = await this.readUserConfig()
    const next = normalizeUserConfig({ ...current, ...prune(patch) })
    await this.#write(this.configFile, next)
    return next
  }

  /** The last push/pull outcome. */
  async readLastRun() {
    return { ...defaultLastRun(), ...(await this.#read(this.lastRunFile, {})) }
  }

  /** Record the outcome of one sync direction. */
  async writeLastRun(patch) {
    const next = { ...(await this.readLastRun()), ...patch, at: Date.now() }
    await this.#write(this.lastRunFile, next)
    return next
  }
}

/** Drop absent values so a merge cannot overwrite a field with `undefined`. */
function prune(patch) {
  const result = {}
  if (patch === null || typeof patch !== 'object') return result
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = value
  }
  return result
}
