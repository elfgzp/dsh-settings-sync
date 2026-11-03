/**
 * dsh-settings-sync — Host half.
 *
 * One job: make this machine's DSH settings reproducible on another machine
 * through a private Git repository the user owns. The browser half never touches
 * the filesystem or git; it reads and writes through the routes registered here,
 * all of them behind the connection's trust fence.
 *
 * Why the split matters:
 *
 *   - **Git needs a filesystem and a credential helper**, neither of which a page
 *     has. Doing it in the Host also means the user's existing `git` setup —
 *     keychain, SSH agent, `insteadOf` rewrites — is what authenticates, so this
 *     plugin never stores a token of its own.
 *   - **The trust fence is reusable.** `connection.requestRejection` applies the
 *     Host's own Host/Origin checks and browser-session authentication, so these
 *     routes are not a second, weaker surface.
 *   - **A sync is a background-ish operation.** Serializing it in the Host keeps
 *     the UI honest: one operation, one `busy` flag, no interleaving.
 *
 * Routes, all under `/settings-sync`:
 *
 * | Method | Path              | Purpose                                            |
 * |--------|-------------------|----------------------------------------------------|
 * | GET    | `/status`         | Config, paths, repo state, snapshot summary, prompt |
 * | GET    | `/diff`           | What a push would change                            |
 * | GET    | `/remote-preview` | What the remote holds, without touching this machine |
 * | GET    | `/recoveries`     | Saved restore points                                |
 * | POST   | `/config`         | Save repository, branch and policy settings         |
 * | POST   | `/test`           | Probe git                                          |
 * | POST   | `/create-repo`    | Create a private repository with `gh`               |
 * | POST   | `/push`           | Upload local settings                               |
 * | POST   | `/pull`           | Apply remote settings here                          |
 * | POST   | `/prompt-answer`  | Answer the first-run choice                         |
 * | POST   | `/recover`        | Restore one restore point                           |
 *
 * @module dsh-settings-sync
 */

import { createRequire } from 'node:module'

import { SyncEngine, SyncError } from './lib/engine.js'
import { resolveConfig } from './lib/config.js'
import { Config } from './lib/schema.js'
import { StateStore, promptPending } from './lib/state.js'

/**
 * Cordis 的硬依赖声明。
 *
 * 这一行不是可选的装饰：没有它，Cordis 会在依赖就绪之前就调用 `apply`，于是在
 * 全新启动时 `ctx.get('webServer')` 还是 undefined，插件直接抛错、整条 row 进入
 * failed 状态（重启后的日志里就是「1 entry did not activate」）。声明之后框架会
 * 等到这两个服务发布再激活本插件。
 *
 * 之前这个问题没暴露，是因为开发机上的 DSH 已经运行很久、服务早已就绪，只有
 * 「冷启动」才会命中——换一台干净的机器安装就立刻复现。
 */
export const inject = ['webServer', 'connection']

/** 本插件独占的路由前缀。 */
const PREFIX = '/settings-sync'

/**
 * This package's own version, read from its manifest.
 *
 * The browser half has no way to import `package.json`, and a constant duplicated
 * on both sides drifts the first time the version is bumped. Serving it from the
 * manifest means the About line is always the version that is actually loaded.
 */
const VERSION = (() => {
  try {
    const require = createRequire(import.meta.url)
    return String(require('./package.json').version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

/**
 * Safe service lookup.
 *
 * Cordis throws on reading an undeclared service property, so every optional
 * dependency goes through `ctx.get`.
 *
 * @param {unknown} ctx - Plugin context.
 * @param {string} name - Service name.
 * @returns {any} The service, or undefined.
 */
function safeGet(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** Write one JSON response with no caching. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Read a request body with a size cap.
 *
 * @param {import('node:http').IncomingMessage} req - Request.
 * @param {number} [limit] - Maximum bytes.
 * @returns {Promise<string>} Body text.
 */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Translate a thrown value into an HTTP status and payload.
 *
 * `SyncError` codes are the user-fixable ones, so they get a 400 and keep their
 * code; everything else is an internal failure and is reported as such without
 * pretending to diagnose itself.
 */
function failure(error) {
  if (error instanceof SyncError) {
    return { status: 400, body: { ok: false, code: error.code, message: error.message } }
  }
  return {
    status: 500,
    body: {
      ok: false,
      code: 'internal-error',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

/**
 * Register the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {object} rawConfig - The Loader row config.
 */
export function apply(ctx, rawConfig) {
  const webServer = safeGet(ctx, 'webServer')
  const connection = safeGet(ctx, 'connection')
  if (webServer === undefined || connection === undefined) {
    throw new Error('dsh-settings-sync: 需要 webServer 与 connection 两个服务（Web composition 才有设置页）')
  }

  /**
   * Authoritative profile facts.
   *
   * Desktop boots the Host with no `DSH_HOME` / `DSH_PROFILE_DIR` in the
   * environment at all — the profile directory is passed as an argv path to the
   * desktop host — so reading only the environment resolves `profiles/default`,
   * which does not exist. `profileContext` is the service that actually knows,
   * and it is what the rest of the Host already uses. The environment remains the
   * fallback for a CLI-launched profile, and defaults are the last resort.
   */
  const profileFacts = (() => {
    const service = safeGet(ctx, 'profileContext')
    if (service === undefined) return {}
    return {
      profileDir: typeof service.dir === 'string' ? service.dir : undefined,
      dshHome: typeof service.home === 'string' ? service.home : undefined,
    }
  })()

  const deployment = resolveConfig(rawConfig, process.env, profileFacts)
  const state = new StateStore(deployment.stateDir)
  const engine = new SyncEngine({
    config: deployment,
    state,
    profileContext: safeGet(ctx, 'profileContext'),
    log: (message, error) => ctx.logger?.warn?.(`settings-sync: ${message}`, error),
  })

  /** The last snapshot summary, so `/status` can answer before any sync runs. */
  let snapshotSummary = null

  /** Reject a request the connection trust fence does not admit. */
  const rejected = (req, res) => {
    const rejection = connection.requestRejection({ headers: req.headers })
    if (rejection === undefined) return false
    sendJson(res, rejection, { ok: false, code: 'unauthorized', message: '请求被连接的信任栅栏拒绝' })
    return true
  }

  /**
   * Register one route with uniform body handling and error translation.
   *
   * @param {string} path - Path under {@link PREFIX}.
   * @param {'GET'|'POST'} method - Allowed method.
   * @param {(input: { url: URL, body: any }) => Promise<object>} handler - Handler.
   * @returns {() => void} Cleanup function.
   */
  const route = (path, method, handler) => ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}${path}`,
    async handler(req, res) {
      if (rejected(req, res)) return
      if (req.method !== method) {
        sendJson(res, 405, { ok: false, code: 'bad-request', message: `需要 ${method}` })
        return
      }

      let body = {}
      if (method === 'POST') {
        const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
        if (essence !== 'application/json') {
          sendJson(res, 415, { ok: false, code: 'bad-request', message: 'content-type 必须是 application/json' })
          return
        }
        try {
          const text = await readBody(req)
          body = text === '' ? {} : JSON.parse(text)
        } catch {
          sendJson(res, 400, { ok: false, code: 'bad-request', message: '请求体必须是 JSON' })
          return
        }
      }

      try {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid')
        const result = await handler({ url, body })
        sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        const { status, body: payload } = failure(error)
        sendJson(res, status, payload)
      }
    },
  }), `settings-sync: ${method} ${path}`)

  // ---------- read ----------

  route('/status', 'GET', async () => {
    const user = await state.readUserConfig()
    const repo = await engine.repoState()
    if (snapshotSummary === null) snapshotSummary = await engine.summary().catch(() => null)
    return {
      config: {
        repoUrl: user.repoUrl,
        branch: user.branch,
        autoPush: user.autoPush,
        pullPolicy: user.pullPolicy,
        intervalMs: user.intervalMs,
        gitName: user.gitName,
        gitEmail: user.gitEmail,
        redactSecrets: user.redactSecrets,
        autoInstall: user.autoInstall,
      },
      paths: {
        stateDir: deployment.stateDir,
        profileDir: deployment.profileDir,
        dshHome: deployment.dshHome,
        agentsHome: deployment.agentsHome,
        mirrorDir: engine.mirrorDir,
      },
      prompt: { pending: promptPending(user), version: user.promptVersion },
      plugin: { name: 'dsh-settings-sync', version: VERSION },
      repo,
      lastRun: await state.readLastRun(),
      snapshot: snapshotSummary ?? { files: 0, bytes: 0, skills: 0, plugins: 0, generatedAt: 0 },
      busy: engine.busy,
    }
  })

  route('/diff', 'GET', async () => {
    const diff = await engine.diff()
    snapshotSummary = diff.snapshot
    return diff
  })

  route('/remote-preview', 'GET', async () => engine.remotePreview())

  route('/recoveries', 'GET', async () => engine.recoveries())

  // ---------- write ----------

  route('/config', 'POST', async ({ body }) => {
    if (body === null || typeof body !== 'object') {
      throw new SyncError('bad-request', '请求体必须是对象')
    }
    // A remote change must not silently point the mirror at the new URL without
    // the user seeing it, so the config write only stores the value; the next
    // push/pull re-points `origin` and reports what it did.
    const config = await state.writeUserConfig({
      repoUrl: typeof body.repoUrl === 'string' ? body.repoUrl : undefined,
      branch: typeof body.branch === 'string' ? body.branch : undefined,
      autoPush: typeof body.autoPush === 'boolean' ? body.autoPush : undefined,
      pullPolicy: typeof body.pullPolicy === 'string' ? body.pullPolicy : undefined,
      intervalMs: typeof body.intervalMs === 'number' ? body.intervalMs : undefined,
      gitName: typeof body.gitName === 'string' ? body.gitName : undefined,
      gitEmail: typeof body.gitEmail === 'string' ? body.gitEmail : undefined,
      redactSecrets: typeof body.redactSecrets === 'boolean' ? body.redactSecrets : undefined,
      autoInstall: typeof body.autoInstall === 'boolean' ? body.autoInstall : undefined,
    })
    return {
      config: {
        repoUrl: config.repoUrl,
        branch: config.branch,
        autoPush: config.autoPush,
        pullPolicy: config.pullPolicy,
        intervalMs: config.intervalMs,
        gitName: config.gitName,
        gitEmail: config.gitEmail,
        redactSecrets: config.redactSecrets,
        autoInstall: config.autoInstall,
      },
    }
  })

  route('/test', 'POST', async () => engine.testGit())

  route('/create-repo', 'POST', async ({ body }) => engine.createRepo({ name: body?.name }))

  route('/push', 'POST', async ({ body }) => {
    const result = await engine.push({ message: body?.message, force: body?.force === true })
    return { result }
  })

  route('/pull', 'POST', async ({ body }) => {
    // Pulling without an explicit mode means "make this machine match", which is
    // the destructive one; the UI asks before it gets here.
    const result = await engine.pull({
      mode: body?.mode === 'merge-skills' ? 'merge-skills' : 'overwrite',
      force: body?.force === true,
    })
    return { result }
  })

  route('/recover', 'POST', async ({ body }) => {
    const result = await engine.recover(body?.id)
    return { result }
  })

  route('/prompt-answer', 'POST', async ({ body }) => {
    const action = body?.action
    if (action !== 'restore' && action !== 'push' && action !== 'later') {
      throw new SyncError('bad-request', 'action 必须是 restore / push / later')
    }
    // Record the answer first: a failed restore must not re-prompt forever after
    // the user has clearly seen and answered the question.
    const saved = await state.writeUserConfig({ promptVersion: 1, promptAnsweredAt: Date.now() })
    let result = null
    if (action === 'restore') result = await engine.pull({ mode: 'overwrite' })
    if (action === 'push') result = await engine.push({})
    return { action, prompt: { pending: promptPending(saved) }, result }
  })

  // ---------- automatic sync ----------

  /**
   * The periodic check.
   *
   * Runs on a timer rather than on a file watcher because the interesting
   * question — "is the remote ahead of me?" — needs the network, and hammering a
   * remote on every keystroke in a config file is not a reasonable default. The
   * interval is a user setting; 0 disables it entirely.
   */
  let timer = null
  let timerMs = -1

  const applyTimer = (intervalMs) => {
    if (timerMs === intervalMs) return
    timerMs = intervalMs
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (intervalMs <= 0) return
    timer = setInterval(() => {
      runAutomaticSync().catch((error) => ctx.logger?.warn?.('settings-sync: 自动同步失败', error))
    }, intervalMs)
    // Do not keep the Host process alive on behalf of this timer.
    timer.unref?.()
  }

  /** One automatic pass: push when configured, and surface a pending pull. */
  const runAutomaticSync = async () => {
    if (engine.busy !== null) return
    const user = await state.readUserConfig()
    if (user.repoUrl === '') return
    if (user.autoPush) {
      await engine.push({})
      return
    }
    // No auto-push: only report, never overwrite. `always` is the one policy the
    // user opted into destructive behaviour explicitly.
    const repo = await engine.repoState()
    if (repo.behind !== null && repo.behind > 0 && repo.clean === true && user.pullPolicy === 'always') {
      await engine.pull({ mode: 'overwrite' })
    }
  }

  // Re-read the interval on every settings change and on activation, so a value
  // edited in Settings takes effect without a restart.
  const refreshTimer = () => {
    state.readUserConfig()
      .then((user) => applyTimer(user.intervalMs))
      .catch(() => {})
  }
  refreshTimer()
  ctx.on('settings/document-updated', refreshTimer)
  ctx.effect(() => () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }, 'settings-sync: clear the automatic sync timer')
}

export { Config, SyncEngine, SyncError, StateStore, resolveConfig }
