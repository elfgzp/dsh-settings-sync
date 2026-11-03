/**
 * The sync engine: one serialized owner of the mirror clone.
 *
 * Every operation that touches the repository goes through this class, and only
 * one of them runs at a time. That single constraint removes the whole class of
 * "two clicks, one half-finished clone" bugs: a second push while the first is
 * still committing waits, an automatic timer that fires during a manual pull is
 * skipped instead of interleaving, and the UI's `busy` flag is the truth rather
 * than a hint.
 *
 * The mirror clone deliberately lives outside the profile and outside the user's
 * own repositories (`<stateDir>/mirror`). Nothing here ever reads or writes the
 * user's working tree, so a sync cannot stage somebody's uncommitted code, and an
 * ordinary `git` command in another terminal is unaffected.
 *
 * @module dsh-settings-sync/engine
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { Git, currentBranch, normalizeBranch, normalizeRemote, normalizeChanges, originUrl, parsePorcelain } from './git.js'
import {
  collectSnapshot,
  describeChanges,
  listRestorePoints,
  listSnapshotFiles,
  materialize,
  readManifest,
  resolveRestorePoint,
  restorePoint,
  restoreSnapshot,
} from './snapshot.js'

/** Raised for a request the user can fix; `code` is what the UI branches on. */
export class SyncError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'SyncError'
    this.code = code
  }
}

/** Short human description of a change set, used in commit subjects and the UI. */
function describeCounts(counts) {
  const parts = []
  if (counts.added > 0) parts.push(`+${counts.added}`)
  if (counts.modified > 0) parts.push(`~${counts.modified}`)
  if (counts.removed > 0) parts.push(`-${counts.removed}`)
  return parts.length === 0 ? '无变化' : parts.join(' ')
}

/**
 * The engine.
 *
 * Constructed once per plugin activation; holds no repository state that is not
 * also on disk, so a Host restart loses nothing.
 */
export class SyncEngine {
  /**
   * @param {object} options - Construction options.
   * @param {{ stateDir: string, profileDir: string, dshHome: string, agentsHome: string, maxFiles: number, maxBytes: number, maxFileBytes: number, gitPath?: string }} options.config - Deployment config.
   * @param {{ readUserConfig: Function, writeUserConfig: Function, readLastRun: Function, writeLastRun: Function, ensure: Function }} options.state - Runtime state store.
   * @param {(...args: unknown[]) => void} [options.log] - Logger for non-fatal failures.
   */
  constructor(options) {
    this.config = options.config
    this.state = options.state
    this.log = options.log ?? (() => {})
    this.git = new Git({ binary: options.config.gitPath })
    this.mirrorDir = join(options.config.stateDir, 'mirror')
    this.backupsDir = join(options.config.stateDir, 'backups')
    this.snapshotsDir = join(options.config.stateDir, 'snapshots')
    /** One operation at a time; see the module doc. */
    this.queue = Promise.resolve()
    /** @type {{ operation: string, startedAt: number } | null} */
    this.busy = null
    this.lastSnapshot = null
  }

  /** Run `work` after every previously queued operation has settled. */
  #serialize(operation, work) {
    const run = this.queue.then(async () => {
      this.busy = { operation, startedAt: Date.now() }
      try {
        return await work()
      } finally {
        this.busy = null
      }
    })
    // Keep the chain alive after a failure: a rejected link would poison it.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Whether the mirror clone exists and is a git repository. */
  async repoExists() {
    try {
      const result = await this.git.run(['rev-parse', '--git-dir'], { cwd: this.mirrorDir })
      return result.code === 0
    } catch {
      return false
    }
  }

  /**
   * The current repository state, as the status route reports it.
   *
   * Every field is independently fallible: an unreadable remote must produce a
   * message rather than break the whole page.
   *
   * @returns {Promise<object>} Repository state.
   */
  async repoState() {
    const user = await this.state.readUserConfig()
    const configured = user.repoUrl !== ''
    const exists = await this.repoExists()
    const empty = {
      configured,
      exists,
      remote: null,
      branch: null,
      clean: null,
      ahead: null,
      behind: null,
      lastCommit: null,
      error: null,
    }
    if (!exists) {
      return { ...empty, error: configured ? null : '还没有配置同步仓库' }
    }

    try {
      const remote = await originUrl(this.git, this.mirrorDir)
      const branch = (await currentBranch(this.git, this.mirrorDir)) ?? user.branch
      const status = await this.git.run(['status', '--porcelain=v1', '-z'], { cwd: this.mirrorDir })
      const changes = status.code === 0 ? normalizeChanges(parsePorcelain(status.stdout)) : []
      const lastCommit = await this.#lastCommit()
      let ahead = null
      let behind = null
      if (remote !== null) {
        const count = await this.git.run(
          ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`],
          { cwd: this.mirrorDir },
        )
        if (count.code === 0) {
          const [left, right] = count.stdout.trim().split(/\s+/).map((part) => Number(part))
          if (Number.isFinite(left) && Number.isFinite(right)) {
            behind = left
            ahead = right
          }
        }
      }
      return {
        configured,
        exists,
        remote,
        branch,
        clean: changes.length === 0,
        ahead,
        behind,
        lastCommit,
        error: null,
      }
    } catch (error) {
      return { ...empty, exists: true, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The mirror's HEAD commit, or null when there is none yet. */
  async #lastCommit() {
    const result = await this.git.run(
      ['log', '-1', '--format=%H%x00%an%x00%aI%x00%s'],
      { cwd: this.mirrorDir },
    )
    if (result.code !== 0) return null
    const [hash, author, at, subject] = result.stdout.trim().split('\0')
    if (hash === undefined || hash === '') return null
    return { hash, author: author ?? '', at: Date.parse(at ?? '') || 0, subject: subject ?? '' }
  }

  /**
   * Ensure the mirror clone exists and points at the configured remote.
   *
   * "Configured remote changed" is handled by re-pointing `origin` rather than by
   * re-cloning: the working tree is a full snapshot, so switching repositories
   * should push that snapshot to the new place, not silently drop it.
   *
   * @param {object} user - The current user configuration.
   * @returns {Promise<void>} Resolves when the mirror is ready to be written.
   * @throws {SyncError} When no usable remote is configured.
   */
  async #ensureRepo(user) {
    const remote = normalizeRemote(user.repoUrl)
    if (remote === undefined) {
      throw new SyncError('no-repo', '还没有配置有效的同步仓库地址，请先在设置里填写')
    }
    const branch = normalizeBranch(user.branch) ?? 'main'
    await mkdir(this.config.stateDir, { recursive: true })

    if (!await this.repoExists()) {
      await this.git.must(['init', '--initial-branch', branch, this.mirrorDir])
      await this.#configureIdentity(user)
      await this.git.must(['remote', 'add', 'origin', remote], { cwd: this.mirrorDir })
      return
    }

    await this.#configureIdentity(user)
    const existing = await originUrl(this.git, this.mirrorDir)
    if (existing !== remote) {
      if (existing !== null) await this.git.must(['remote', 'set-url', 'origin', remote], { cwd: this.mirrorDir })
      else await this.git.must(['remote', 'add', 'origin', remote], { cwd: this.mirrorDir })
    }
  }

  /**
   * Pin the commit identity inside the mirror.
   *
   * Repository-local, never `--global`: a sync commit must not depend on — or
   * change — the identity the user configured for their own work.
   */
  async #configureIdentity(user) {
    await this.git.must(['config', 'user.name', user.gitName], { cwd: this.mirrorDir })
    await this.git.must(['config', 'user.email', user.gitEmail], { cwd: this.mirrorDir })
    // Keep the mirror's own object store tidy across many snapshots.
    await this.git.run(['config', 'gc.auto', '800'], { cwd: this.mirrorDir })
    await this.git.run(['config', 'core.quotepath', 'false'], { cwd: this.mirrorDir })
  }

  /**
   * Collect the current machine and write it into the mirror.
   *
   * @returns {Promise<{ plan: object, applied: object, changes: Array<object>, counts: object }>} The materialized snapshot and its diff against HEAD.
   */
  async #materializeCurrent() {
    const user = await this.state.readUserConfig()
    const plan = await this.lastPlan()
    const applied = await materialize(this.mirrorDir, plan, { redactSecrets: user.redactSecrets !== false })
    const changes = await this.#statusChanges()
    return { plan, applied, changes, counts: describeChanges(changes).counts }
  }

  /**
   * Collect the live plan.
   *
   * Collection walks both skill roots and every per-plugin state directory, so it
   * is the expensive half of a sync; callers that only need the numbers (the
   * status route) use {@link SyncEngine#summary} instead.
   *
   * @returns {Promise<object>} The plan.
   */
  async lastPlan() {
    const plan = await collectSnapshot(this.config)
    this.lastSnapshot = {
      files: plan.files.length,
      bytes: plan.bytes,
      skills: plan.skills.length,
      plugins: plan.plugins.length,
      generatedAt: Date.now(),
      skipped: plan.skipped,
    }
    return plan
  }

  /**
   * Just the snapshot numbers, for the status route.
   *
   * Still a real collection — the counts have to be true — but without writing
   * anything or asking git.
   *
   * @returns {Promise<object>} The compact snapshot summary.
   */
  async summary() {
    return this.#serialize('summary', async () => {
      const plan = await this.lastPlan()
      return this.#snapshotSummary(plan)
    })
  }

  /** Normalized git changes in the mirror's working tree. */
  async #statusChanges() {
    const status = await this.git.must(['status', '--porcelain=v1', '-z'], { cwd: this.mirrorDir })
    return normalizeChanges(parsePorcelain(status.stdout))
  }

  /**
   * The preview the Settings page renders: what a push would change.
   *
   * @returns {Promise<object>} Diff payload plus snapshot summary.
   */
  async diff() {
    return this.#serialize('diff', async () => {
      const user = await this.state.readUserConfig()
      const plan = await this.lastPlan()
      const exists = await this.repoExists()
      if (!exists) {
        // No mirror yet: every collected file is an addition.
        const entries = plan.files
          .map((file) => ({ path: file.target, change: 'added', kind: kindOf(file.target) }))
          .sort((left, right) => left.path.localeCompare(right.path))
        return {
          entries,
          counts: { added: entries.length, modified: 0, removed: 0, total: entries.length },
          snapshot: this.#snapshotSummary(plan),
          remote: null,
        }
      }
      await this.#ensureRepoQuiet(user)
      await this.#materializeCurrent()
      const changes = await this.#statusChanges()
      return {
        ...describeChanges(changes),
        snapshot: this.#snapshotSummary(plan),
        remote: await this.#lastCommit(),
      }
    })
  }

  /** `#ensureRepo` that tolerates an unconfigured remote (the diff still works). */
  async #ensureRepoQuiet(user) {
    try {
      await this.#ensureRepo(user)
    } catch (error) {
      if (error instanceof SyncError && error.code === 'no-repo') return
      throw error
    }
  }

  /** The compact snapshot summary the status and diff payloads share. */
  #snapshotSummary(plan) {
    return {
      files: plan.files.length,
      bytes: plan.bytes,
      skills: plan.skills.length,
      plugins: plan.plugins.length,
      generatedAt: Date.now(),
      skipped: plan.skipped.slice(0, 40),
    }
  }

  /**
   * Push this machine's settings to the remote.
   *
   * @param {object} [options] - Push options.
   * @param {string} [options.message] - Commit subject override.
   * @param {boolean} [options.force] - Push even when nothing changed.
   * @returns {Promise<object>} Push result.
   */
  async push(options = {}) {
    return this.#serialize('push', async () => {
      const user = await this.state.readUserConfig()
      await this.#ensureRepo(user)
      const branch = normalizeBranch(user.branch) ?? 'main'
      const { plan, changes, counts } = await this.#materializeCurrent()

      // A push that deletes files is the one truly dangerous operation here, and
      // it is exactly what a mis-resolved home directory looks like: collect
      // finds nothing, the mirror is pruned to empty, and the remote loses a
      // backup the user was relying on. Refuse the empty case outright, and
      // refuse a mass deletion unless the caller says the machine really changed.
      this.#guardDestructivePush(plan, changes, options)

      let commit = (await this.#lastCommit())?.hash ?? null
      let pushed = false
      if (changes.length > 0) {
        await this.git.must(['add', '--all'], { cwd: this.mirrorDir })
        const summary = typeof options.message === 'string' && options.message.trim() !== ''
          ? options.message.trim().slice(0, 200)
          : `settings: ${describeCounts(counts)} (${plan.files.length} files, ${plan.skills.length} skills)`
        const committed = await this.git.run(['commit', '-m', summary], { cwd: this.mirrorDir })
        if (committed.code !== 0) throw new SyncError('commit-failed', committed.stderr || committed.stdout || '提交失败')
        commit = (await this.#lastCommit())?.hash ?? null
      } else if (options.force !== true) {
        // Nothing new to say. Report success with the existing commit so the UI
        // does not frame "already in sync" as a failure.
        const at = Date.now()
        await this.state.writeLastRun({ direction: 'push', commit, summary: '没有变化', files: 0, at })
        return { commit, pushed: false, files: 0, summary: '没有变化', at }
      }

      const attempt = await this.#pushBranch(branch)
      const pushOk = attempt.code === 0 || /\[up-to-date\]|Everything up-to-date/i.test(attempt.stderr + attempt.stdout)
      if (!pushOk) {
        throw new SyncError('push-failed', summarizeGitError(attempt))
      }
      pushed = true
      const at = Date.now()
      const summary = changes.length > 0 ? describeCounts(counts) : '没有变化'
      await this.state.writeLastRun({ direction: 'push', commit, summary, files: changes.length, at })
      return { commit, pushed, files: changes.length, summary, at }
    })
  }

  /**
   * Refuse a push that would erase the remote's reason to exist.
   *
   * Two cases, both cheap to detect and both unrecoverable if allowed:
   *
   *   - **Nothing collected at all.** Either the DSH home is mis-resolved (an
   *     unusual `DSH_PROFILE_DIR`, a container without the user's home), or the
   *     machine genuinely lost its config. Neither should silently replace a good
   *     snapshot with an empty one.
   *   - **Most of the snapshot disappearing at once.** A handful of deletions is a
   *     real edit; losing more than half of the tracked files in one push is a
   *     sign the roots moved, so it needs an explicit override.
   *
   * @param {object} plan - The collected plan.
   * @param {Array<{ path: string, change: string }>} changes - Git's change list.
   * @param {object} options - Push options; `force` overrides the mass-deletion rule.
   * @throws {SyncError} When the push looks destructive.
   */
  #guardDestructivePush(plan, changes, options) {
    if (plan.files.length === 0) {
      throw new SyncError(
        'nothing-collected',
        `这次没有收集到任何设置文件（profile 目录：${this.config.profileDir}）。为免清空远端备份，已拒绝推送；请确认 DSH 的 profile 路径是否正确。`,
      )
    }
    const removed = changes.filter((change) => change.change === 'removed').length
    if (removed === 0) return
    const tracked = removed + changes.filter((change) => change.change !== 'removed').length
    if (options.force === true || removed <= Math.max(8, tracked * 0.5)) return
    throw new SyncError(
      'mass-deletion',
      `这次推送会从远端删除 ${removed} 个文件（本次共 ${tracked} 个变更）。若确实要这样做，请用「强制推送」。`,
    )
  }

  /** One `git push`, with the credential-helper hint attached to a failure. */
  async #pushBranch(branch) {
    const attempt = await this.git.run(['push', '--set-upstream', 'origin', branch], { cwd: this.mirrorDir })
    if (attempt.code === 0) return attempt
    // A fresh empty remote rejects a non-fast-forward; fetch then retry once.
    if (/rejected|fetch first|non-fast-forward/i.test(attempt.stderr)) {
      await this.git.run(['fetch', 'origin', branch], { cwd: this.mirrorDir })
      const rebase = await this.git.run(['rebase', `origin/${branch}`], { cwd: this.mirrorDir })
      if (rebase.code === 0) {
        return this.git.run(['push', '--set-upstream', 'origin', branch], { cwd: this.mirrorDir })
      }
      await this.git.run(['rebase', '--abort'], { cwd: this.mirrorDir })
    }
    return attempt
  }

  /**
   * Pull the remote settings onto this machine.
   *
   * The order matters and is the safety model: fetch, back up the current machine,
   * apply, and only then report. Nothing on this machine is touched before a
   * restore point exists.
   *
   * @param {object} [options] - Pull options.
   * @param {string} [options.mode] - `overwrite` or `merge-skills`.
   * @param {boolean} [options.force] - Apply even when the remote is not ahead.
   * @returns {Promise<object>} Pull result.
   */
  async pull(options = {}) {
    return this.#serialize('pull', async () => {
      const user = await this.state.readUserConfig()
      await this.#ensureRepo(user)
      const branch = normalizeBranch(user.branch) ?? 'main'
      const mode = options.mode === 'merge-skills' ? 'merge-skills' : 'overwrite'

      const fetched = await this.git.run(['fetch', 'origin', branch], { cwd: this.mirrorDir })
      if (fetched.code !== 0) {
        if (/couldn't find remote ref|no such ref/i.test(fetched.stderr + fetched.stdout)) {
          throw new SyncError('remote-empty', `远端还没有 ${branch} 分支，先推送一次本地设置`)
        }
        throw new SyncError('fetch-failed', summarizeGitError(fetched))
      }

      // The remote tree must be what we apply, not the last local commit.
      const checkout = await this.git.run(['checkout', '-f', '-B', branch, `origin/${branch}`], { cwd: this.mirrorDir })
      if (checkout.code !== 0) throw new SyncError('checkout-failed', summarizeGitError(checkout))

      const remoteCommit = await this.#lastCommit()
      const restore = await restoreSnapshot({
        workTree: this.mirrorDir,
        config: this.config,
        mode,
        backupsDir: this.backupsDir,
      })

      const at = Date.now()
      // Say it when a secret was kept: the user needs to know the placeholder in
      // the repository did not overwrite a real value they still have.
      const keptNote = restore.preserved > 0 ? `，保留 ${restore.preserved} 个本机密钥` : ''
      const summary = `恢复 ${restore.files} 个文件${restore.removed > 0 ? `，删除 ${restore.removed} 个` : ''}${keptNote}`
      await this.state.writeLastRun({
        direction: 'pull',
        commit: remoteCommit?.hash ?? null,
        summary,
        files: restore.files,
        at,
      })
      return {
        commit: remoteCommit?.hash ?? null,
        files: restore.files,
        removed: restore.removed,
        preserved: restore.preserved,
        notes: restore.notes,
        backedUpTo: restore.backedUpTo,
        summary,
        skipped: restore.skipped.slice(0, 40),
        at,
      }
    })
  }

  /**
   * What the remote holds, without touching this machine.
   *
   * Used by the first-run prompt: "restore from remote" has to say how much there
   * is before the user commits to it.
   *
   * @returns {Promise<object>} Remote preview.
   */
  async remotePreview() {
    return this.#serialize('remote-preview', async () => {
      const user = await this.state.readUserConfig()
      const remote = normalizeRemote(user.repoUrl)
      if (remote === undefined) {
        return { exists: false, remote: null, entries: [], counts: emptyCounts(), remoteHead: null, files: emptyFiles() }
      }
      const branch = normalizeBranch(user.branch) ?? 'main'
      await mkdir(this.config.stateDir, { recursive: true })

      // Probe without a clone: `ls-remote` answers "is there anything there?".
      const probe = await this.git.run(['ls-remote', '--heads', remote, branch])
      if (probe.code !== 0) {
        return {
          exists: false,
          remote,
          entries: [],
          counts: emptyCounts(),
          remoteHead: null,
          files: emptyFiles(),
          error: summarizeGitError(probe),
        }
      }
      if (probe.stdout.trim() === '') {
        return { exists: false, remote, entries: [], counts: emptyCounts(), remoteHead: null, files: emptyFiles() }
      }

      // Compare against a throwaway clone so the user's mirror is untouched.
      const scratch = join(this.config.stateDir, 'preview')
      await rm(scratch, { recursive: true, force: true })
      const cloned = await this.git.run(
        ['clone', '--depth', '1', '--branch', branch, remote, scratch],
        { timeoutMs: 120_000 },
      )
      if (cloned.code !== 0) {
        return {
          exists: true,
          remote,
          entries: [],
          counts: emptyCounts(),
          remoteHead: null,
          files: emptyFiles(),
          error: summarizeGitError(cloned),
        }
      }
      try {
        const manifest = await readManifest(scratch)
        const listing = await listSnapshotFiles(scratch)
        const head = await this.git.run(
          ['log', '-1', '--format=%H%x00%aI%x00%s'],
          { cwd: scratch },
        )
        const local = await this.lastPlan()
        const localByTarget = new Map(local.files.map((file) => [file.target, file.source]))
        const entries = []
        for (const path of listing) {
          const localSource = localByTarget.get(path)
          if (localSource === undefined) {
            entries.push({ path, change: 'added', kind: kindOf(path) })
            continue
          }
          // A path present on both sides is only "the same" when the bytes match;
          // a differing file is exactly what the user needs to see before
          // choosing to restore.
          const same = await sameContent(localSource, join(scratch, path))
          if (!same) entries.push({ path, change: 'modified', kind: kindOf(path) })
          localByTarget.delete(path)
        }
        for (const path of localByTarget.keys()) entries.push({ path, change: 'removed', kind: kindOf(path) })
        entries.sort((left, right) => left.path.localeCompare(right.path))
        const parts = head.code === 0 ? head.stdout.trim().split('\0') : []
        return {
          exists: true,
          remote,
          entries,
          counts: {
            added: entries.filter((entry) => entry.change === 'added').length,
            modified: entries.filter((entry) => entry.change === 'modified').length,
            removed: entries.filter((entry) => entry.change === 'removed').length,
            total: entries.length,
          },
          remoteHead: parts[0] !== undefined && parts[0] !== ''
            ? { commit: parts[0], at: Date.parse(parts[1] ?? '') || 0, subject: parts[2] ?? '', manifest }
            : null,
          files: groupListing(listing),
        }
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    })
  }

  /** List restore points. */
  async recoveries() {
    return { items: await listRestorePoints(this.backupsDir) }
  }

  /**
   * Restore one saved restore point.
   *
   * @param {unknown} id - The restore point id from the UI.
   * @returns {Promise<object>} Restore outcome.
   */
  async recover(id) {
    return this.#serialize('recover', async () => {
      const directory = await resolveRestorePoint(this.backupsDir, id)
      if (directory === null) throw new SyncError('unknown-recovery', '找不到这个恢复点')
      const result = await restorePoint({ directory, config: this.config, backupsDir: this.backupsDir })
      await this.state.writeLastRun({
        direction: 'restore',
        commit: null,
        summary: `从恢复点恢复 ${result.files} 个文件`,
        files: result.files,
        at: Date.now(),
      })
      return result
    })
  }

  /**
   * Create a private repository with the `gh` CLI and return its URL.
   *
   * `gh` is the only supported creator because it is the only tool that can make
   * a *private* repository without the user pasting a token into this plugin —
   * it already holds their credential.
   *
   * @param {object} [options] - Creation options.
   * @param {string} [options.name] - Repository name.
   * @returns {Promise<{ repoUrl: string, created: boolean }>} The new remote.
   */
  async createRepo(options = {}) {
    const name = typeof options.name === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(options.name.trim())
      ? options.name.trim()
      : 'dsh-settings'
    const ghBinary = process.env.DSH_SETTINGS_SYNC_GH ?? 'gh'
    const result = await runExecutable(ghBinary, [
      'repo', 'create', name,
      '--private',
      '--description', 'DeepSeek Harness settings snapshot (dsh-settings-sync)',
    ])
    if (result.code !== 0) {
      throw new SyncError('gh-failed', summarizeGhError(result))
    }
    const url = await this.#resolveGithubUrl(ghBinary, name, result.stdout)
    if (url === null) throw new SyncError('gh-failed', '仓库创建成功，但没能读到它的地址')
    await this.state.writeUserConfig({ repoUrl: url })
    return { repoUrl: url, created: true }
  }

  /** Find the clone URL of the repository `gh` just created. */
  async #resolveGithubUrl(ghBinary, name, stdout) {
    const direct = /https:\/\/github\.com\/[^\s]+/.exec(stdout)
    if (direct !== null) return direct[0]
    const view = await runExecutable(ghBinary, ['repo', 'view', name, '--json', 'url', '-q', '.url'])
    const fromView = /https:\/\/github\.com\/[^\s]+/.exec(view.stdout)
    return fromView === null ? null : fromView[0]
  }

  /** Git availability and version. */
  async testGit() {
    const probe = await this.git.probe()
    if (!probe.ok) {
      return { okGit: false, version: null, message: probe.message }
    }
    return { okGit: true, version: probe.version, message: `git ${probe.version}` }
  }
}

/**
 * Whether two files hold identical bytes.
 *
 * Used by the remote preview so a file that differs is reported as `modified`
 * rather than silently treated as "already there". A read error counts as a
 * difference, because the safer answer is to show the user the row.
 *
 * @param {string} left - Absolute path on this machine.
 * @param {string} right - Absolute path in the preview clone.
 * @returns {Promise<boolean>} Whether the contents match.
 */
async function sameContent(left, right) {
  try {
    const [a, b] = await Promise.all([readFile(left), readFile(right)])
    return a.equals(b)
  } catch {
    return false
  }
}

/** The empty counts object. */
function emptyCounts() {
  return { added: 0, modified: 0, removed: 0, total: 0 }
}

/** The empty files grouping. */
function emptyFiles() {
  return { profile: [], skills: [], pluginStates: [] }
}

/** Group snapshot paths for the preview UI. */
function groupListing(paths) {
  const files = emptyFiles()
  for (const path of paths) {
    if (path.startsWith('profile/')) files.profile.push(path)
    else if (path.includes('/skills/')) files.skills.push(path)
    else if (path.startsWith('homes/dsh/')) files.pluginStates.push(path)
  }
  return files
}

/** Classify a snapshot path; mirrors `snapshot.classify` without an import cycle. */
function kindOf(path) {
  if (path === 'manifest.json') return 'meta'
  if (path.startsWith('profile/')) return 'profile'
  if (path.includes('/skills/')) return 'skill'
  return 'plugin-state'
}

/**
 * Turn a git failure into one sentence a user can act on.
 *
 * The passthrough cases matter more than the mappings: git's own words about
 * authentication and non-fast-forward are already the clearest explanation there
 * is, so they are kept verbatim under a short prefix.
 */
export function summarizeGitError(result) {
  const raw = `${result.stderr}\n${result.stdout}`.trim()
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i.test(raw)) {
    return `git 认证失败：请先在终端里对这个仓库执行一次 git push，确认凭据可用。（${firstLine(raw)}）`
  }
  if (/Repository not found|not found/i.test(raw)) {
    return `仓库不存在或没有权限：确认地址拼写，并确认你的 git 账号能访问它。（${firstLine(raw)}）`
  }
  if (/Could not resolve host|Connection refused|Failed to connect|timed out/i.test(raw)) {
    return `连不上远端：检查网络或代理设置。（${firstLine(raw)}）`
  }
  if (/rejected|non-fast-forward|fetch first/i.test(raw)) {
    return `远端有本地没有的提交，先「从远端恢复」再推送。（${firstLine(raw)}）`
  }
  if (/Please tell me who you are|empty ident/i.test(raw)) {
    return '还没配置提交身份：在设置里填写提交人姓名与邮箱。'
  }
  return firstLine(raw) || 'git 命令失败'
}

/** The first non-empty line, clipped to a readable length. */
function firstLine(text) {
  const line = String(text).split('\n').map((part) => part.trim()).find((part) => part !== '') ?? ''
  return line.length > 300 ? `${line.slice(0, 300)}…` : line
}

/** Turn a `gh` failure into one sentence a user can act on. */
export function summarizeGhError(result) {
  const raw = `${result.stderr}\n${result.stdout}`.trim()
  if (result.code === -1 || /ENOENT/.test(raw)) {
    return '没有找到 gh 命令：请先安装 GitHub CLI（brew install gh）并执行 gh auth login。'
  }
  if (/not logged into|authentication required|gh auth login/i.test(raw)) {
    return 'gh 还没登录：先在终端执行 gh auth login。'
  }
  if (/already exists/i.test(raw)) {
    return '同名仓库已经存在：换一个名字，或直接把这个仓库地址填进来。'
  }
  return firstLine(raw) || 'gh 命令失败'
}

/**
 * Run one executable and capture its output.
 *
 * Separate from the {@link Git} wrapper because `gh` is not git: it has different
 * authentication, different exit conventions, and no working directory of ours.
 */
export function runExecutable(binary, args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile(binary, args, {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      ...options,
    }, (error, stdout, stderr) => {
      if (error !== null && error !== undefined) {
        const code = typeof error.code === 'number' ? error.code : -1
        resolvePromise({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? error.message ?? '') })
        return
      }
      resolvePromise({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}
