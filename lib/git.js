/**
 * The one place that runs `git`.
 *
 * Two decisions shape this module:
 *
 *   1. **Everything runs through `execFile`, never a shell.** Repository URLs,
 *      branch names, and commit messages all end up here, and a shell would turn
 *      a stray quote in a commit message into command execution. Arguments are
 *      passed as an array and each one is validated before it is used.
 *   2. **Failures are values, not exceptions.** Git's own stderr is the most
 *      useful diagnostic the user will get ("Authentication failed", "no such
 *      remote branch"), so every call returns `{ code, stdout, stderr }` and the
 *      caller decides what is fatal. Only a missing `git` binary throws.
 *
 * Authentication is deliberately *not* handled here. Whatever the user's `git`
 * already does — osxkeychain on macOS, an SSH agent, a `credential.helper`, a
 * `url.<base>.insteadOf` rewrite — applies unchanged, so a repository that can
 * be pushed from a terminal can be pushed from this plugin, with no token ever
 * entering a DSH config file.
 *
 * @module dsh-settings-sync/git
 */

import { execFile } from 'node:child_process'

/** Hard cap on one git invocation. A push that takes longer than this is stuck. */
const DEFAULT_TIMEOUT_MS = 120_000

/** How many bytes of output to retain; git can be very chatty on `pull`. */
const MAX_BUFFER = 8 * 1024 * 1024

/** Raised when the git executable itself cannot be run. */
export class GitMissingError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'GitMissingError'
    this.code = 'git-missing'
  }
}

/** Raised when git ran but exited non-zero. */
export class GitFailedError extends Error {
  constructor(args, result, options) {
    const detail = (result.stderr || result.stdout || '').trim()
    super(detail === '' ? `git ${args[0]} 失败（退出码 ${result.code}）` : detail, options)
    this.name = 'GitFailedError'
    this.code = 'git-failed'
    this.args = args
    this.exitCode = result.code
    this.stdout = result.stdout
    this.stderr = result.stderr
  }
}

/**
 * Validate and normalize a repository URL or local path before it reaches git.
 *
 * The allowlist covers exactly the transports git itself documents — plus an
 * absolute local path, which is how a bare repository on a mounted disk or a
 * second local clone is addressed — so a value that gets through is one
 * `git clone` accepts, and a value that does not get through can never start with
 * `-` and be read as an option.
 *
 * @param {unknown} value - Candidate remote.
 * @returns {string|undefined} The trimmed remote, or undefined when unusable.
 */
export function normalizeRemote(value) {
  if (typeof value !== 'string') return undefined
  const remote = value.trim()
  if (remote === '' || remote.startsWith('-')) return undefined
  if (/^(https?|ssh|git|file):\/\/[^\s]+$/i.test(remote)) return remote
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/.test(remote)) return remote
  // An absolute local path: `/srv/backups/settings.git`, `C:\backups\settings.git`.
  if (/^\/[^\s]+$/.test(remote)) return remote
  if (/^[A-Za-z]:[\\/][^\s]*$/.test(remote)) return remote
  return undefined
}

/**
 * Validate a branch name the way git does, minus the exotic cases.
 *
 * @param {unknown} value - Candidate branch.
 * @returns {string|undefined} The branch, or undefined when unusable.
 */
export function normalizeBranch(value) {
  if (typeof value !== 'string') return undefined
  const branch = value.trim()
  if (branch === '' || branch.startsWith('-') || branch.length > 200) return undefined
  if (branch.includes('..') || branch.includes('~') || branch.includes('^') || branch.includes(':')) return undefined
  if (branch.includes(' ') || branch.includes('\\') || branch.endsWith('.') || branch.endsWith('/')) return undefined
  return branch
}

/**
 * A tiny, explicit git client bound to one working directory.
 *
 * No method here retries, and none of them mutate global git configuration: the
 * mirror clone carries its own `.git/config`, so a sync never disturbs the
 * user's other repositories.
 */
export class Git {
  /**
   * @param {object} options - Construction options.
   * @param {string} [options.binary] - Explicit git path; empty means PATH.
   * @param {number} [options.timeoutMs] - Per-invocation timeout.
   */
  constructor(options = {}) {
    this.binary = typeof options.binary === 'string' && options.binary.trim() !== '' ? options.binary.trim() : 'git'
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  }

  /**
   * Run one git command.
   *
   * @param {readonly string[]} args - Arguments, already validated by the caller.
   * @param {object} [options] - Run options.
   * @param {string} [options.cwd] - Working directory; omitted for global calls.
   * @param {NodeJS.ProcessEnv} [options.env] - Extra environment.
   * @param {number} [options.timeoutMs] - Override the instance timeout.
   * @param {AbortSignal} [options.signal] - Cancel the run.
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>} The raw result.
   * @throws {GitMissingError} When git cannot be executed at all.
   */
  run(args, options = {}) {
    if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string')) {
      throw new TypeError('git 参数必须是字符串数组')
    }
    return new Promise((resolvePromise, reject) => {
      execFile(
        this.binary,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? this.timeoutMs,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          signal: options.signal,
          // A blank credential prompt would hang the Host forever. Git must
          // fail fast and let the user fix their credential helper.
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: 'echo',
            ...options.env,
          },
        },
        (error, stdout, stderr) => {
          if (error !== null && error !== undefined) {
            const code = typeof error.code === 'number' ? error.code : -1
            if (code === -1 || error.code === 'ENOENT') {
              reject(new GitMissingError(`找不到 git 可执行文件（${this.binary}），请在设置里填写 git 的绝对路径`, { cause: error }))
              return
            }
            resolvePromise({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? error.message ?? '') })
            return
          }
          resolvePromise({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        },
      )
    })
  }

  /**
   * Run one command and require success.
   *
   * @param {readonly string[]} args - Arguments.
   * @param {object} [options] - Run options, as {@link Git#run}.
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>} The result.
   * @throws {GitFailedError} When git exited non-zero.
   */
  async must(args, options = {}) {
    const result = await this.run(args, options)
    if (result.code !== 0) throw new GitFailedError(args, result)
    return result
  }

  /**
   * The installed git version, or `null` when git is unusable.
   *
   * @returns {Promise<{ ok: boolean, version: string|null, message: string }>} Probe result.
   */
  async probe() {
    try {
      const result = await this.run(['--version'])
      if (result.code !== 0) {
        return { ok: false, version: null, message: (result.stderr || result.stdout).trim() }
      }
      return { ok: true, version: result.stdout.trim().replace(/^git version\s+/i, ''), message: result.stdout.trim() }
    } catch (error) {
      return { ok: false, version: null, message: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * Read the current branch of a repository.
 *
 * @param {Git} git - Client.
 * @param {string} cwd - Repository working directory.
 * @returns {Promise<string|null>} The branch name, or null on a detached HEAD.
 */
export async function currentBranch(git, cwd) {
  const result = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
  if (result.code !== 0) return null
  const branch = result.stdout.trim()
  return branch === 'HEAD' || branch === '' ? null : branch
}

/**
 * Whether a repository has an `origin` remote pointing at the expected URL.
 *
 * @param {Git} git - Client.
 * @param {string} cwd - Repository working directory.
 * @returns {Promise<string|null>} The remote URL, or null when unset.
 */
export async function originUrl(git, cwd) {
  const result = await git.run(['remote', 'get-url', 'origin'], { cwd })
  if (result.code !== 0) return null
  const url = result.stdout.trim()
  return url === '' ? null : url
}

/**
 * Parse `git status --porcelain=v1 -z` into changed paths.
 *
 * The `-z` form separates entries with NUL bytes, which is what makes paths
 * containing spaces or newlines survive intact.
 *
 * @param {string} stdout - Raw output.
 * @returns {Array<{ path: string, code: string }>} Changed paths.
 */
export function parsePorcelain(stdout) {
  const out = []
  for (const entry of stdout.split('\0')) {
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (entry[0] === 'R' || entry[0] === 'C') {
      // Rename/copy: the source path follows as its own NUL-terminated entry.
      out.push({ path, code })
      continue
    }
    out.push({ path, code })
  }
  return out
}

/**
 * Summarize a `git diff --name-status` style list into our three change kinds.
 *
 * @param {Array<{ path: string, code: string }>} entries - Parsed status entries.
 * @returns {Array<{ path: string, change: 'added'|'modified'|'removed' }>} Normalized changes.
 */
export function normalizeChanges(entries) {
  const seen = new Map()
  for (const entry of entries) {
    if (entry.code.includes('D')) seen.set(entry.path, 'removed')
    else if (entry.code.includes('A') || entry.code.includes('?')) seen.set(entry.path, 'added')
    else seen.set(entry.path, 'modified')
  }
  return [...seen].map(([path, change]) => ({ path, change }))
}
