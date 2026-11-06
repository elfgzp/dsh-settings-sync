/**
 * The browser half of `dsh-settings-sync`.
 *
 * Two seats are registered:
 *
 *   - `settings.section` (`settings-sync`, order 16) — the whole settings page:
 *     repository, manual push/pull, automatic-sync policy, commit identity,
 *     restore points, and the safety note.
 *   - `shell.overlay` (`settings-sync.first-run`, order 60) — the one-time
 *     "sync your settings?" dialog. It renders `null` unless the Host reports
 *     `prompt.pending`, so it never steals a click on later starts.
 *
 * Every byte of data comes from the Host's `/settings-sync/*` routes. This file
 * never talks to a Git remote and never sees a credential: the browser can only
 * *ask* the Host to act, and the Host's answer is the only truth it renders.
 *
 * SAFETY MODEL — the destructive path is also the reversible one. A pull
 * replaces local configuration with the remote tree, so the Host writes a
 * restore point *before* it touches a single file. That is why the restore-point
 * list sits right below the pull button and the safety note says it twice: a
 * user who pulls by accident has a one-click way back.
 */

window.__ModuleLoader__.load({
  id: 'dsh-settings-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace. The manifest's `locale/*.json` files use the same one. */
    const NS = 'dsh-settings-sync'

    /** Route prefix owned by the Host half (see `index.js`). */
    const PREFIX = '/settings-sync'

    /** Slot ids, kept as constants because the Lead's manifest metadata quotes them. */
    const SECTION_ID = 'settings-sync'
    const OVERLAY_ID = 'settings-sync.first-run'

    /** Public home of the plugin, used by the About line. */
    const REPO_URL = 'https://github.com/elfgzp/dsh-settings-sync'

    /** How long a `/status` snapshot is considered fresh enough to reuse (ms). */
    const STATUS_FRESH_MS = 1500

    /** Deadline for the status snapshot, so a wedged Host can still be retried (ms). */
    const STATUS_TIMEOUT_MS = 20_000

    /** How many diff entries are rendered before the list is truncated. */
    const DIFF_RENDER_LIMIT = 200

    /** How long the first-run dialog shows its result before it closes itself. */
    const PROMPT_RESULT_MS = 1400

    /** Automatic-check intervals offered by the page; `intervalMs` is what the Host stores. */
    const INTERVALS = [
      { ms: 0, key: 'interval.off' },
      { ms: 5 * 60_000, key: 'interval.5m' },
      { ms: 30 * 60_000, key: 'interval.30m' },
      { ms: 60 * 60_000, key: 'interval.1h' },
    ]

    /** Diff entry kinds -> locale keys. Unknown kinds fall back to the raw value. */
    const KIND_KEYS = {
      profile: 'kind.profile',
      skill: 'kind.skill',
      'plugin-state': 'kind.pluginState',
      meta: 'kind.meta',
    }

    /**
     * English and Chinese copy. Both tables must carry the same keys — the
     * fallback chain in `makeT` reads `zh` last, so a missing English key shows
     * Chinese rather than a raw identifier.
     */
    const DICTS = {
      zh: {
        'nav.label': '设置同步',
        'section.repository.title': '同步仓库',
        'section.repository.hint': '所有 DSH 设置都会备份到这个私有 Git 仓库。认证沿用你本机 git 的配置（钥匙串 / SSH），插件不保存任何令牌。',
        'field.repoUrl': '仓库地址',
        'field.repoUrl.placeholder': 'git@github.com:you/dsh-settings.git',
        'field.branch': '分支',
        'field.branch.placeholder': 'main',
        'action.save': '保存',
        'action.saving': '保存中…',
        'action.testGit': '检测 git',
        'action.testing': '检测中…',
        'action.createRepo': '用 gh 建私有仓库',
        'action.creating': '创建中…',
        'action.retry': '重试',
        'action.refresh': '刷新',
        'action.push': '上传到远程',
        'action.pushing': '上传中…',
        'action.pull': '从远程恢复',
        'action.pulling': '恢复中…',
        'action.pullConfirm': '确认覆盖本地？',
        'pull.guardTitle': '这次恢复会删掉本机大部分设置',
        'pull.guardHint': '远端快照里的文件比本机少很多，用远端覆盖会把多出来的本机设置删掉。',
        'action.forcePull': '我了解，强制恢复',
        'action.forcePulling': '强制恢复中…',
        'action.cancel': '取消',
        'action.restore': '恢复',
        'action.restoring': '恢复中…',
        'notice.saved': '已保存。',
        'notice.repoCreated': '私有仓库已创建并保存，可以直接上传了。',
        'notice.pushed': '已上传 {files} 个文件（{commit}）。',
        'notice.pulled': '已恢复 {files} 个文件（{commit}），旧配置备份在 {backup}。',
        'notice.needsRestart': '已恢复 {files} 个文件（{commit}），其中 {count} 个插件是新装的：请重启 DSH 后才会加载。',
        'restart.title': '需要重启 DSH',
        'restart.body': '这次恢复装上了 {count} 个新插件，但当前运行的 DSH 是在启动时按插件列表加载的，不会自动看到它们。',
        'restart.list': '重启后生效：{names}',
        'notice.uninstalled': '已恢复 {files} 个文件（{commit}），但 {count} 个插件没有装上：{names}。',
        'missing.title': '{count} 个插件没有装上',
        'missing.body': '这些插件已经写进 profile 配置，但本机没有对应的包。现在重启 DSH，它们会启动失败并一直不生效。',
        'missing.list': '缺少的插件：{names}',
        'missing.autoInstallOff': '「自动同步」里关掉了自动安装，所以这次没有安装插件。打开「自动安装插件」后再恢复一次即可。',
        'missing.installFailed': '自动安装失败了：{message}',
        'missing.manual': '可以在 profile 目录手动执行 pnpm install 补救：',
        'missing.command': 'cd <profile 目录> && pnpm install',
        'restart.hint': '退出 DSH 再重新打开即可（桌面端 Cmd+Q 后重开）。',
        'notice.recovered': '已恢复到 {label}。',
        'notice.testOk': 'git {version} 可用。',
        'notice.testFailed': 'git 不可用',
        'repo.notConfigured': '还没有设置仓库地址。填一个能 git push 的私有仓库，或者让插件用 gh 建一个。',
        'repo.missing': '本地镜像还没克隆，第一次上传时自动创建。',
        'repo.commitLine': '{hash} · {subject} · {ago}',
        'repo.aheadBehind': '领先 {ahead} / 落后 {behind} 个提交',
        'section.sync.title': '同步',
        'section.sync.hint': '上传会把本机设置写成一次提交推到远程；恢复会用远程覆盖本机配置，覆盖前先写一个恢复点。',
        'summary.files': '{n} 个配置文件',
        'summary.skills': '{n} 个技能',
        'summary.plugins': '{n} 个插件',
        'sync.hostBusy': 'DSH 正在执行 {operation}…',
        'lastRun.none': '还没有同步记录。',
        'lastRun.push': '上次上传',
        'lastRun.pull': '上次恢复',
        'lastRun.restore': '上次从恢复点回滚',
        'lastRun.line': '{direction}：{ago} · {files} 个文件 · {commit}',
        'diff.title': '改动预览',
        'diff.added': '+{n}',
        'diff.modified': '~{n}',
        'diff.removed': '−{n}',
        'diff.inSync': '与上次快照一致',
        'diff.empty': '没有检测到改动。',
        'diff.loading': '正在对比…',
        'diff.failed': '对比失败',
        'diff.more': '还有 {n} 条未显示',
        'kind.profile': '配置',
        'kind.skill': '技能',
        'kind.pluginState': '插件',
        'kind.meta': '索引',
        'section.auto.title': '自动同步',
        'section.auto.hint': 'DSH 在后台按下面的策略自动备份；不确定就先保持关闭。',
        'auto.redact': '推送前抹除密钥',
        'auto.redact.hint': '把 profile 里 apiKey / token 这类真实密钥替换成占位符再上传（推荐）',
        'auto.push': '本地改动后自动上传',
        'auto.push.hint': '设置变化后自动提交并推送，不用手动点。',
        'auto.policy': '启动时的拉取策略',
        'auto.policy.hint': 'never 从不拉取；ask 每次启动问一次；always 远程更新且本地干净时直接拉取。',
        'policy.never': '从不',
        'policy.ask': '每次询问',
        'policy.always': '总是',
        'auto.interval': '定时检查',
        'auto.interval.hint': '按固定间隔检查远程有没有更新。',
        'interval.off': '关闭',
        'interval.5m': '每 5 分钟',
        'interval.30m': '每 30 分钟',
        'interval.1h': '每 1 小时',
        'section.identity.title': '提交身份',
        'section.identity.hint': '只用于这个仓库里的提交，不会改动你的全局 git 配置。',
        'field.gitName': '提交人名',
        'field.gitEmail': '提交邮箱',
        'identity.note': '默认值和你 shell 里 `ghc` 别名设置的一致（Elf / me@elfgzp.cn），换机器时填自己的就行。',
        'section.recoveries.title': '恢复点',
        'section.recoveries.hint': '每次用远程覆盖本机之前，插件都会先把本机现状存成一个恢复点。',
        'recoveries.loading': '正在读取恢复点…',
        'recoveries.empty': '还没有恢复点。',
        'recoveries.failed': '读取恢复点失败',
        'recoveries.item': '{files} 个文件 · {ago}',
        'section.safety.title': '安全说明',
        'safety.credentials': '凭据永远不会进仓库',
        'safety.credentials.body': '令牌、Cookie、密钥、日志和会话记录都在排除列表里；快照只包含设置文件、技能和插件状态。',
        'safety.pull': '恢复会覆盖本机，但先备份',
        'safety.pull.body': '从远程恢复会用仓库内容替换本机配置；替换前一定先写恢复点，随时能退回来。',
        'about.version': '版本 {version}',
        'about.repo': 'GitHub 仓库',
        'time.never': '—',
        'time.justNow': '刚刚',
        'time.minutesAgo': '{n} 分钟前',
        'time.hoursAgo': '{n} 小时前',
        'time.daysAgo': '{n} 天前',
        'state.loading': '正在读取设置同步状态…',
        'state.failed': '读取设置同步状态失败',
        'prompt.title': '要同步 DSH 设置吗？',
        'prompt.body': '这台机器的设置和私有 Git 仓库可以双向对齐：从远程恢复，或者先把本机设置传上去。以后随时可以在「设置 → 设置同步」里改。',
        'prompt.restore': '从远程恢复（覆盖本机）',
        'prompt.push': '上传本机设置到远程',
        'prompt.later': '以后再说',
        'prompt.needRepo': '先设置仓库地址才能恢复',
        'prompt.busy': '处理中…',
        'prompt.done': '完成，之后可以在设置里修改这个选择。',
        'prompt.close': '关闭',
      },
      en: {
        'nav.label': 'Settings Sync',
        'section.repository.title': 'Repository',
        'section.repository.hint': 'Every DSH setting is backed up to this private Git repository. Authentication is whatever your local git already uses (keychain or SSH) — the plugin stores no token.',
        'field.repoUrl': 'Repository URL',
        'field.repoUrl.placeholder': 'git@github.com:you/dsh-settings.git',
        'field.branch': 'Branch',
        'field.branch.placeholder': 'main',
        'action.save': 'Save',
        'action.saving': 'Saving…',
        'action.testGit': 'Test git',
        'action.testing': 'Testing…',
        'action.createRepo': 'Create private repo via gh',
        'action.creating': 'Creating…',
        'action.retry': 'Retry',
        'action.refresh': 'Refresh',
        'action.push': 'Push to remote',
        'action.pushing': 'Pushing…',
        'action.pull': 'Pull from remote',
        'action.pulling': 'Pulling…',
        'action.pullConfirm': 'Overwrite local config?',
        'pull.guardTitle': 'This restore would delete most of your local settings',
        'pull.guardHint': 'The remote snapshot holds far fewer files than this machine, so an overwrite would delete the extras.',
        'action.forcePull': 'Understood, force restore',
        'action.forcePulling': 'Force restoring…',
        'action.cancel': 'Cancel',
        'action.restore': 'Restore',
        'action.restoring': 'Restoring…',
        'notice.saved': 'Saved.',
        'notice.repoCreated': 'Private repository created and saved — ready to push.',
        'notice.pushed': 'Uploaded {files} files ({commit}).',
        'notice.pulled': 'Restored {files} files ({commit}); the previous config was backed up to {backup}.',
        'notice.needsRestart': 'Restored {files} files ({commit}), {count} of them newly installed: restart DSH for them to load.',
        'restart.title': 'Restart DSH required',
        'restart.body': 'This restore installed {count} new plugins, but the running DSH composed its plugin list at startup and will not pick them up on its own.',
        'restart.list': 'Activates after a restart: {names}',
        'notice.uninstalled': 'Restored {files} files ({commit}), but {count} plugins could not be installed: {names}.',
        'missing.title': '{count} plugins could not be installed',
        'missing.body': 'These plugins are written into the profile config, but their packages are not on this machine. If you restart DSH now they fail to load and stay inactive.',
        'missing.list': 'Missing plugins: {names}',
        'missing.autoInstallOff': 'Automatic plugin install is off in "Automatic sync", so nothing was installed. Turn it on and restore again.',
        'missing.installFailed': 'The automatic install failed: {message}',
        'missing.manual': 'You can recover by running pnpm install in the profile directory:',
        'missing.command': 'cd <profile directory> && pnpm install',
        'restart.hint': 'Quit DSH and open it again (Cmd+Q on macOS).',
        'notice.recovered': 'Restored {label}.',
        'notice.testOk': 'git {version} is available.',
        'notice.testFailed': 'git is not usable',
        'repo.notConfigured': 'No repository yet. Point this at a private repo you can push to, or let the plugin create one with gh.',
        'repo.missing': 'The local mirror is not cloned yet; it is created on the first push.',
        'repo.commitLine': '{hash} · {subject} · {ago}',
        'repo.aheadBehind': 'ahead {ahead} / behind {behind} commits',
        'section.sync.title': 'Sync',
        'section.sync.hint': 'Push turns the local settings into one commit on the remote; pull replaces local config with the remote tree, after writing a restore point.',
        'summary.files': '{n} config files',
        'summary.skills': '{n} skills',
        'summary.plugins': '{n} plugins',
        'sync.hostBusy': 'DSH is running {operation}…',
        'lastRun.none': 'No sync has run yet.',
        'lastRun.push': 'Last push',
        'lastRun.pull': 'Last pull',
        'lastRun.restore': 'Last restore-point rollback',
        'lastRun.line': '{direction}: {ago} · {files} files · {commit}',
        'diff.title': 'Pending changes',
        'diff.added': '+{n}',
        'diff.modified': '~{n}',
        'diff.removed': '−{n}',
        'diff.inSync': 'matches the last snapshot',
        'diff.empty': 'Nothing to sync.',
        'diff.loading': 'Comparing…',
        'diff.failed': 'Comparing failed',
        'diff.more': '{n} more not shown',
        'kind.profile': 'config',
        'kind.skill': 'skill',
        'kind.pluginState': 'plugin',
        'kind.meta': 'index',
        'section.auto.title': 'Automatic sync',
        'section.auto.hint': 'DSH syncs in the background with the policy below. Leave it off until you trust the repository.',
        'auto.redact': 'Redact secrets before upload',
        'auto.redact.hint': 'Replace live apiKey / token values with a placeholder before they leave this machine (recommended).',
        'auto.push': 'Upload after local changes',
        'auto.push.hint': 'Commit and push automatically once settings settle; no button needed.',
        'auto.policy': 'Pull policy at startup',
        'auto.policy.hint': 'never ignores the remote; ask offers the choice once per start; always pulls when the remote is ahead and local is clean.',
        'policy.never': 'Never',
        'policy.ask': 'Ask each time',
        'policy.always': 'Always',
        'auto.interval': 'Periodic check',
        'auto.interval.hint': 'Look for remote updates on a fixed interval.',
        'interval.off': 'Off',
        'interval.5m': 'Every 5 min',
        'interval.30m': 'Every 30 min',
        'interval.1h': 'Every hour',
        'section.identity.title': 'Commit identity',
        'section.identity.hint': 'Used only for commits inside this repository; your global git config is never touched.',
        'field.gitName': 'Commit name',
        'field.gitEmail': 'Commit email',
        'identity.note': 'The defaults mirror the `ghc` shell alias (Elf / me@elfgzp.cn); put your own values in when you sync from another machine.',
        'section.recoveries.title': 'Restore points',
        'section.recoveries.hint': 'Before a pull overwrites this machine, the plugin snapshots the current state into a restore point.',
        'recoveries.loading': 'Reading restore points…',
        'recoveries.empty': 'No restore points yet.',
        'recoveries.failed': 'Could not read restore points',
        'recoveries.item': '{files} files · {ago}',
        'section.safety.title': 'Safety',
        'safety.credentials': 'Credentials never reach the repository',
        'safety.credentials.body': 'Tokens, cookies, private keys, logs and session transcripts are all on the exclusion list; a snapshot only carries settings files, skills and plugin state.',
        'safety.pull': 'Pull overwrites locally — after a backup',
        'safety.pull.body': 'Pulling replaces local configuration with the repository content. A restore point is written first, so the previous state is always one click away.',
        'about.version': 'Version {version}',
        'about.repo': 'GitHub repository',
        'time.never': '—',
        'time.justNow': 'just now',
        'time.minutesAgo': '{n} min ago',
        'time.hoursAgo': '{n} h ago',
        'time.daysAgo': '{n} d ago',
        'state.loading': 'Reading settings-sync status…',
        'state.failed': 'Could not read the settings-sync status',
        'prompt.title': 'Sync your DSH settings?',
        'prompt.body': 'This machine‘s settings and the private Git repository can be brought in line in either direction — restore from the remote, or upload what is here first. You can change the choice any time in Settings → Settings Sync.',
        'prompt.restore': 'Restore from remote (overwrite local)',
        'prompt.push': 'Upload local settings to remote',
        'prompt.later': 'Later',
        'prompt.needRepo': 'Set a repository first',
        'prompt.busy': 'Working…',
        'prompt.done': 'Done. You can change this later in Settings.',
        'prompt.close': 'Close',
      },
    }

    /**
     * The plugin stylesheet.
     *
     * Every colour is a host theme token so light and dark mode follow for free.
     * The only literal colours are the three diff chips, which have no token and
     * are tinted from `currentColor` so they still track the theme.
     */
    const PANEL_CSS = `
.dss-root { display: flex; flex-direction: column; color: var(--dsw-alias-label-primary); font-size: 12.5px; line-height: 1.6; }
.dss-notice-bar { position: sticky; top: 0; z-index: 3; margin: 0 0 10px; }
.dss-notice { padding: 8px 10px; font-size: 11.5px; line-height: 1.65; border-radius: 7px; overflow-wrap: anywhere; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); }
.dss-notice[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dss-notice[data-tone="error"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dss-notice[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dss-section { padding: 16px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dss-section:first-child { padding-top: 4px; }
.dss-section:last-child { border-bottom: 0; padding-bottom: 4px; }
.dss-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; min-height: 22px; }
.dss-section-title { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.dss-section-hint { margin: 0 0 12px; font-size: 11.5px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.dss-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.dss-row:last-child { margin-bottom: 0; }
.dss-row-label { flex: 0 0 132px; padding-top: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dss-row-body { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 2px; }
.dss-row-hint { flex-basis: 100%; margin-top: 0; }
.dss-field { flex: 1 1 260px; min-width: 0; }
.dss-field-narrow { flex: 0 1 200px; }
.dss-input, .dss-select { box-sizing: border-box; width: 100%; font: inherit; font-size: 12px; padding: 5px 9px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dss-input::placeholder { color: var(--dsw-alias-label-secondary); }
.dss-input:focus, .dss-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dss-input:disabled, .dss-select:disabled { opacity: .6; }
.dss-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.dss-btn { appearance: none; display: inline-flex; align-items: center; justify-content: center; font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; }
.dss-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dss-btn:disabled { opacity: .5; cursor: default; }
/* brand-primary is a foreground token (near-white in dark mode), so it is used
   as a fill with the label painted in bg-base; that keeps contrast either way. */
.dss-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 500; }
.dss-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); opacity: .88; }
.dss-btn-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dss-btn-ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.dss-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dss-meta { margin-top: 8px; font-size: 11.5px; line-height: 1.7; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dss-meta-inline { margin-top: 0; }
.dss-meta-tight { margin-top: 2px; }
.dss-meta-below { margin-top: 0; margin-bottom: 8px; }
.dss-list-inset { margin-top: 10px; }
.dss-spacer { flex: 1 1 auto; }
.dss-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.dss-error-text { margin-top: 8px; font-size: 11.5px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.dss-empty { padding: 18px 0; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dss-chips { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dss-chip { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
/* The only literal colours in this file: "added"/"removed" have no theme token.
   The fill is mixed from currentColor, so the chip still follows the theme. */
.dss-chip[data-change="added"] { color: #1a7f37; border-color: currentColor; background: color-mix(in srgb, currentColor 12%, transparent); }
.dss-chip[data-change="modified"] { color: #9a6700; border-color: currentColor; background: color-mix(in srgb, currentColor 12%, transparent); }
.dss-chip[data-change="removed"] { color: #cf222e; border-color: currentColor; background: color-mix(in srgb, currentColor 12%, transparent); }
.dss-list { margin-top: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; }
.dss-list-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 0; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.dss-list-head:hover { background: var(--dsw-alias-bg-layer-2); }
.dss-list-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dss-list-body { max-height: 280px; overflow: auto; border-top: 1px solid var(--dsw-alias-border-l1); }
.dss-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 11.5px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dss-item:last-child { border-bottom: 0; }
.dss-item-label { flex: 0 0 auto; color: var(--dsw-alias-label-primary); }
.dss-item-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dss-item-kind { flex: 0 0 auto; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.dss-caret { flex: 0 0 auto; display: inline-block; width: 10px; font-size: 10px; color: var(--dsw-alias-label-secondary); transition: transform .12s ease; }
.dss-caret[data-open="true"] { transform: rotate(90deg); }
.dss-switch { appearance: none; position: relative; flex: 0 0 auto; width: 34px; height: 19px; padding: 0; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); cursor: pointer; transition: background .15s ease, border-color .15s ease; }
.dss-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--dsw-alias-label-secondary); transition: transform .15s ease, background .15s ease; }
.dss-switch[data-on="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dss-switch[data-on="true"]::after { transform: translateX(15px); background: var(--dsw-alias-bg-base); }
.dss-switch:disabled { opacity: .5; cursor: default; }
.dss-missing { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-warn-primary); }
.dss-missing strong { font-size: 12px; font-weight: 600; color: var(--dsw-alias-state-warn-primary); }
.dss-missing p { margin: 0; font-size: 11.5px; line-height: 1.75; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dss-missing-list { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px !important; color: var(--dsw-alias-label-primary) !important; }
.dss-missing-cmd { margin: 2px 0 0; padding: 6px 9px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-primary); overflow-x: auto; }
.dss-restart { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-success-primary); }
.dss-restart strong { font-size: 12px; font-weight: 600; color: var(--dsw-alias-state-success-primary); }
.dss-restart p { margin: 0; font-size: 11.5px; line-height: 1.75; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dss-restart-list { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px !important; color: var(--dsw-alias-label-primary) !important; }
.dss-restart-hint { color: var(--dsw-alias-label-secondary); }
.dss-guard { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-primary); }
.dss-guard strong { font-size: 12px; font-weight: 600; color: var(--dsw-alias-state-error-primary); }
.dss-guard p { margin: 0; font-size: 11.5px; line-height: 1.75; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dss-guard .dss-actions { margin-top: 6px; }
.dss-safety { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-warn-primary); }
.dss-safety p { margin: 0; font-size: 11.5px; line-height: 1.75; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dss-safety strong { display: block; margin-bottom: 2px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-state-warn-primary); }
.dss-about { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dss-about a { color: var(--dsw-alias-label-primary); text-decoration: underline; text-underline-offset: 2px; }
.dss-overlay { position: fixed; inset: 0; z-index: 120; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--dsw-alias-bg-overlay); }
.dss-dialog { box-sizing: border-box; width: 100%; max-width: 560px; display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); box-shadow: 0 24px 64px rgba(0, 0, 0, .32); }
.dss-dialog-head { display: flex; align-items: flex-start; gap: 10px; }
.dss-dialog-head h2 { flex: 1 1 auto; margin: 0; font-size: 15px; font-weight: 600; }
.dss-dialog p { margin: 0; font-size: 12.5px; line-height: 1.75; color: var(--dsw-alias-label-secondary); }
.dss-dialog-actions { display: flex; flex-direction: column; gap: 8px; }
.dss-dialog-reason { font-size: 11px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dss-result { font-size: 11.5px; color: var(--dsw-alias-state-success-primary); overflow-wrap: anywhere; }
.dss-failure { font-size: 11.5px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
`

    /**
     * Inject the stylesheet once and return its disposer.
     *
     * @returns {() => void} Removes the `<style>` element on unload.
     */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const id = 'dsh-settings-sync-style'
      document.getElementById(id)?.remove()
      const style = document.createElement('style')
      style.id = id
      style.dataset.plugin = NS
      style.textContent = PANEL_CSS
      document.head.appendChild(style)
      return () => {
        document.getElementById(id)?.remove()
      }
    }

    /** Resolve the Host origin, with a placeholder for a `null`-origin page. */
    function hostBase() {
      const origin = globalThis.location && globalThis.location.origin
      return origin !== undefined && origin !== null && origin !== 'null' ? origin : 'http://dsh.internal'
    }

    /**
     * Call one Host route.
     *
     * GET parameters are appended as query string values (empty ones dropped so
     * a default stays a default); everything else is posted as JSON. A non-JSON
     * body almost always means the route does not exist in the running Host —
     * i.e. the plugin was updated but DSH was not restarted — so that case gets
     * its own message instead of a bare "bad response".
     *
     * @param {'GET' | 'POST'} method - HTTP method.
     * @param {string} path - Path after `/settings-sync`.
     * @param {object} [options] - Query parameters (GET) or request body (POST).
     * @returns {Promise<any>} The unwrapped payload; every field access is optional upstream.
     * @throws {Error & { code?: string }} When the Host answers with `ok: false` or unparsable JSON.
     */
    async function call(method, path, options) {
      const url = new URL(`${PREFIX}${path}`, hostBase())
      /** @type {RequestInit} */
      const init = { method, headers: { accept: 'application/json' } }
      if (method === 'GET') {
        for (const [key, value] of Object.entries(options ?? {})) {
          if (value === undefined || value === null || value === '') continue
          url.searchParams.set(key, String(value))
        }
      } else {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options ?? {})
      }
      const response = await fetch(url, init)
      let payload
      try {
        payload = await response.json()
      } catch {
        const restartHint = response.status === 404
          ? ' (the Host has no such route — the plugin was probably updated without restarting DSH)'
          : ''
        throw Object.assign(
          new Error(`${method} ${PREFIX}${path} returned ${response.status} and the body was not JSON${restartHint}`),
          { code: response.status === 404 ? 'route-missing' : 'bad-response' },
        )
      }
      if (payload?.ok !== true) {
        throw Object.assign(new Error(payload?.message ?? 'request failed'), { code: payload?.code ?? 'error' })
      }
      return payload
    }

    /**
     * Race a promise against a timeout.
     *
     * A Host that accepts a connection and then never answers would leave the
     * page with no state to render and no error to show. The status store in
     * particular must not be wedged by one hung request: without this, "still
     * loading" would be permanent, because the store would keep joining the
     * same dead promise and its Retry button could never fire.
     *
     * @param {Promise<any>} promise - The work to bound.
     * @param {number} ms - How long to wait before giving up.
     * @param {string} path - Route name, for the message.
     * @returns {Promise<any>} The promise's value.
     * @throws {Error & { code: 'timeout' }} When the deadline passes first.
     */
    function withTimeout(promise, ms, path) {
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          rejectPromise(Object.assign(
            new Error(`${path} did not answer within ${Math.round(ms / 1000)}s`),
            { code: 'timeout' },
          ))
        }, ms)
        promise.then(
          (value) => { clearTimeout(timer); resolvePromise(value) },
          (error) => { clearTimeout(timer); rejectPromise(error) },
        )
      })
    }

    /**
     * Build the translator once per activation.
     *
     * The locale can change while the page is open, so the language is read on
     * every call rather than captured. Missing keys fall back to Chinese, then
     * to the key itself, which makes a forgotten English string obvious in the
     * UI instead of rendering `undefined`.
     *
     * @param {object} ctx - The plugin context, for `ctx.locale`.
     * @returns {(key: string, vars?: Record<string, string|number>) => string} Translator.
     */
    function makeT(ctx) {
      return function t(key, vars) {
        let lang = 'zh'
        try {
          if (ctx?.locale?.getLocale?.()?.id === 'en') lang = 'en'
        } catch {
          // A locale service that throws is not worth a broken page; use Chinese.
        }
        const table = DICTS[lang] ?? DICTS.zh
        const template = table[key] ?? DICTS.zh[key] ?? key
        if (vars === undefined || vars === null) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (
          Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
        ))
      }
    }

    /**
     * Format a byte count the way a settings page should.
     *
     * @param {number|null|undefined} bytes - Size in bytes.
     * @returns {string} Human readable size, or an em dash.
     */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
      if (bytes < 1024) return `${Math.round(bytes)} B`
      const units = ['KB', 'MB', 'GB']
      let value = bytes / 1024
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`
    }

    /**
     * Format an epoch-millisecond timestamp for a meta line.
     *
     * @param {number|null|undefined} ms - Timestamp in milliseconds.
     * @returns {string} `YYYY-MM-DD HH:mm`, or an em dash when absent.
     */
    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * Relative time ("3 min ago"), localized.
     *
     * @param {number|null|undefined} ms - Timestamp in milliseconds.
     * @param {(key: string, vars?: object) => string} t - Translator.
     * @returns {string} Relative time, or an em dash when there is no timestamp.
     */
    function formatAgo(ms, t) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return t('time.never')
      const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (seconds < 45) return t('time.justNow')
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return t('time.minutesAgo', { n: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return t('time.hoursAgo', { n: hours })
      const days = Math.round(hours / 24)
      if (days < 30) return t('time.daysAgo', { n: days })
      return formatTime(ms)
    }

    /**
     * Short form of a commit hash.
     *
     * @param {string|null|undefined} hash - Full hash.
     * @returns {string} Seven characters, or an em dash.
     */
    function shortHash(hash) {
      return typeof hash === 'string' && hash !== '' ? hash.slice(0, 7) : '—'
    }

    /**
     * Localized label for a diff entry kind.
     *
     * @param {string|null|undefined} kind - `profile` | `skill` | `plugin-state` | `meta`.
     * @param {(key: string) => string} t - Translator.
     * @returns {string} Label.
     */
    function kindLabel(kind, t) {
      const key = KIND_KEYS[kind]
      return key === undefined ? String(kind ?? '') : t(key)
    }

    /**
     * One line describing the most recent push or pull.
     *
     * @param {object|null|undefined} lastRun - `status.lastRun`.
     * @param {(key: string, vars?: object) => string} t - Translator.
     * @returns {string} The line.
     */
    function formatLastRun(lastRun, t) {
      const at = lastRun?.at
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return t('lastRun.none')
      const direction = lastRun?.direction === 'push'
        ? t('lastRun.push')
        : lastRun?.direction === 'pull' ? t('lastRun.pull')
          : lastRun?.direction === 'restore' ? t('lastRun.restore') : null
      if (direction === null) return t('lastRun.none')
      return t('lastRun.line', {
        direction,
        ago: formatAgo(at, t),
        files: lastRun?.files ?? 0,
        commit: shortHash(lastRun?.commit),
      })
    }

    /**
     * Project `status.config` onto the editable form fields.
     *
     * @param {object|null|undefined} config - `status.config`.
     * @returns {{ repoUrl: string, branch: string, gitName: string, gitEmail: string }} Form draft.
     */
    function toDraft(config) {
      const source = config ?? {}
      return {
        repoUrl: typeof source.repoUrl === 'string' ? source.repoUrl : '',
        branch: typeof source.branch === 'string' ? source.branch : '',
        gitName: typeof source.gitName === 'string' ? source.gitName : '',
        gitEmail: typeof source.gitEmail === 'string' ? source.gitEmail : '',
      }
    }

    /**
     * One `/status` snapshot shared by the settings section and the overlay.
     *
     * The two slots are separate React trees, so without a shared store they
     * would each fetch `/status` and could disagree — the overlay would keep
     * offering a prompt the settings page already answered. The store also
     * collapses concurrent loads into one request and remembers the last error
     * so a failed fetch reports once instead of on every mount.
     *
     * @returns {object} `{ subscribe, getSnapshot, ensure, refresh, patch }`.
     */
    function createStatusStore() {
      /** @type {{ data: any, error: string|null, loading: boolean, at: number }} */
      let snapshot = { data: null, error: null, loading: true, at: 0 }
      /** @type {Set<() => void>} */
      const listeners = new Set()
      /** @type {Promise<void>|null} */
      let inflight = null
      let warned = false

      /** Replace part of the snapshot and wake every subscriber. */
      function emit(partial) {
        snapshot = { ...snapshot, ...partial }
        for (const listener of listeners) listener()
      }

      /**
       * Load `/status`. `force` bypasses the freshness window; a call that is
       * already in flight is always joined rather than duplicated.
       *
       * @param {boolean} force - Fetch even when the snapshot is fresh.
       * @returns {Promise<void>} Resolves when the snapshot settled.
       */
      async function load(force) {
        if (inflight !== null) return inflight
        // The freshness window only applies to a *successful* snapshot. After a
        // failure the page must be able to retry immediately — otherwise the
        // Retry button would appear to do nothing for a second and a half.
        if (force !== true && snapshot.data !== null && Date.now() - snapshot.at < STATUS_FRESH_MS) return
        emit({ loading: true })
        inflight = (async () => {
          try {
            const payload = await withTimeout(call('GET', '/status'), STATUS_TIMEOUT_MS, 'GET /status')
            emit({ data: payload, error: null, loading: false, at: Date.now() })
          } catch (error) {
            /* The quality bar allows exactly one diagnostic line: a status fetch
               that fails is worth reporting once, because every widget on the
               page depends on it. */
            if (warned === false) {
              warned = true
              console.warn('[dsh-settings-sync] status fetch failed:', error?.message ?? error)
            }
            emit({ error: error?.message ?? String(error), loading: false, at: Date.now() })
          } finally {
            inflight = null
          }
        })()
        return inflight
      }

      return {
        /** Subscribe to snapshot changes; the return value unsubscribes. */
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /** Current snapshot; stable between emits, which is what React requires. */
        getSnapshot() {
          return snapshot
        },
        /** Load if stale — the mount path, so opening two slots costs one request. */
        ensure() {
          return load(false)
        },
        /** Load unconditionally — the path used after a mutation. */
        refresh() {
          return load(true)
        },
        /**
         * Merge fields into the cached snapshot after a successful mutation, so
         * the page reflects the answer without a second round trip. Ignored
         * while nothing is loaded: a partial object must never pose as status.
         */
        patch(partial) {
          if (snapshot.data === null) return
          emit({ data: { ...snapshot.data, ...partial }, error: null })
        },
      }
    }

    /** `useSyncExternalStore` with a one-line fallback for hosts on older React. */
    const useStore = typeof React.useSyncExternalStore === 'function'
      ? React.useSyncExternalStore
      : function useStoreFallback(subscribe, getSnapshot) {
        const [value, setValue] = React.useState(getSnapshot)
        React.useEffect(
          () => subscribe(() => setValue(getSnapshot())),
          [subscribe, getSnapshot],
        )
        return value
      }

    /**
     * Subscribe a component to the shared status snapshot.
     *
     * @param {ReturnType<typeof createStatusStore>} store - Shared store.
     * @returns {{ data: any, error: string|null, loading: boolean }} Snapshot.
     */
    function useStatus(store) {
      const snapshot = useStore(store.subscribe, store.getSnapshot)
      React.useEffect(() => { store.ensure() }, [store])
      return snapshot
    }

    /**
     * The `/diff` preview: one fetch on mount and again after every mutation.
     * Never polled — on a large profile this walks the whole tree on the Host.
     *
     * @returns {{ data: any, error: string|null, loading: boolean, reload: () => Promise<void> }} State.
     */
    function useDiff() {
      const [state, setState] = React.useState({ data: null, error: null, loading: true })
      const reload = React.useCallback(async () => {
        setState((previous) => ({ ...previous, loading: true }))
        try {
          const payload = await call('GET', '/diff')
          setState({ data: payload, error: null, loading: false })
        } catch (error) {
          setState((previous) => ({ ...previous, error: error?.message ?? String(error), loading: false }))
        }
      }, [])
      React.useEffect(() => { reload() }, [reload])
      return { ...state, reload }
    }

    /**
     * The restore-point list. `POST /pull` creates one on every overwrite, so
     * this is refetched after a pull as well as reloaded by hand.
     *
     * @returns {{ items: any[], error: string|null, loading: boolean, reload: () => Promise<void> }} State.
     */
    function useRecoveries() {
      const [state, setState] = React.useState({ items: [], error: null, loading: true })
      const reload = React.useCallback(async () => {
        setState((previous) => ({ ...previous, loading: true }))
        try {
          const payload = await call('GET', '/recoveries')
          setState({ items: Array.isArray(payload?.items) ? payload.items : [], error: null, loading: false })
        } catch (error) {
          setState((previous) => ({ ...previous, error: error?.message ?? String(error), loading: false }))
        }
      }, [])
      React.useEffect(() => { reload() }, [reload])
      return { ...state, reload }
    }

    /**
     * Whether the remote actually carries a snapshot, asked only while the
     * first-run dialog is up.
     *
     * `/status` can say the *local mirror* exists, but not whether the remote
     * has content to restore — that is exactly what `/remote-preview` reports
     * (`exists` plus the `remoteHead` it would restore). The primary action of
     * the dialog depends on this answer, so it is worth one request that is
     * never made at any other time.
     *
     * @param {boolean} enabled - Fetch only when true.
     * @returns {{ data: any, error: string|null, loading: boolean }} Preview state.
     */
    function useRemotePreview(enabled) {
      const [state, setState] = React.useState({ data: null, error: null, loading: false })
      React.useEffect(() => {
        if (enabled !== true) return undefined
        let alive = true
        setState({ data: null, error: null, loading: true })
        call('GET', '/remote-preview')
          .then((payload) => { if (alive) setState({ data: payload, error: null, loading: false }) })
          .catch((error) => {
            if (alive) setState({ data: null, error: error?.message ?? String(error), loading: false })
          })
        return () => { alive = false }
      }, [enabled])
      return state
    }

    /* ------------------------------------------------------------------ */
    /* Shared presentational pieces                                        */
    /* ------------------------------------------------------------------ */

    /**
     * One titled block of the page.
     *
     * @param {object} props - Optional `title` and `hint`, optional `aside` for
     *   the head row, plus children. A section without a title (the About line)
     *   renders no heading at all rather than an empty one.
     * @returns {object} Section element.
     */
    function Section(props) {
      const head = props.title === undefined || props.title === null
        ? null
        : h('div', { className: 'dss-section-head' },
          h('h3', { className: 'dss-section-title' }, props.title),
          props.aside ?? null)
      return h('section', { className: 'dss-section' },
        head,
        props.hint === undefined || props.hint === null
          ? null
          : h('p', { className: 'dss-section-hint' }, props.hint),
        props.children)
    }

    /**
     * A label + control row. The label is not a `<label>` element because the
     * row may hold several controls at once; each input carries its own
     * `aria-label` instead.
     *
     * @param {object} props - `label`, optional `hint` (a second, full-width line
     *   under the controls), and children.
     * @returns {object} Row element.
     */
    function Row(props) {
      const hint = props.hint === undefined || props.hint === null
        ? null
        : h('div', { className: 'dss-meta dss-row-hint' }, props.hint)
      return h('div', { className: 'dss-row' },
        h('span', { className: 'dss-row-label' }, props.label),
        h('div', { className: 'dss-row-body' }, props.children, hint))
    }

    /**
     * A button whose label already carries the busy wording; it only has to be
     * disabled while a request is in flight.
     *
     * @param {object} props - `variant` (`primary` | `danger` | `ghost`), `disabled`, `onClick`, children.
     * @returns {object} Button element.
     */
    function Button(props) {
      const variant = props.variant
      const className = variant === 'primary'
        ? 'dss-btn dss-btn-primary'
        : variant === 'danger' ? 'dss-btn dss-btn-danger'
          : variant === 'ghost' ? 'dss-btn dss-btn-ghost' : 'dss-btn'
      return h('button', {
        type: 'button',
        className,
        title: props.title,
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.children)
    }

    /**
     * The on/off switch used by the automatic-sync section.
     *
     * @param {object} props - `checked`, `onChange(next)`, `disabled`, `label` (accessible name).
     * @returns {object} Switch element.
     */
    function Toggle(props) {
      const on = props.checked === true
      return h('button', {
        type: 'button',
        className: 'dss-switch',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': props.label,
        'data-on': on ? 'true' : 'false',
        disabled: props.disabled === true,
        onClick: () => props.onChange?.(!on),
      })
    }

    /**
     * An inline success/error line. Errors are announced, successes are not.
     *
     * @param {object} props - `notice` (`{ tone, text }` or null).
     * @returns {object|null} Notice element.
     */
    function Notice(props) {
      const notice = props.notice
      if (notice === null || notice === undefined || notice.text === undefined) return null
      const tone = notice.tone ?? 'info'
      return h('div', {
        className: 'dss-notice',
        'data-tone': tone,
        role: tone === 'error' || tone === 'warn' ? 'alert' : undefined,
      }, notice.text)
    }

    /**
     * Collapsible list of pending changes, with the three counts always visible
     * on the head row so the section is useful while collapsed.
     *
     * @param {object} props - `t`, `diff` state, `open`, `onToggle`.
     * @returns {object} List element.
     */
    function DiffList(props) {
      const { t, diff, open, onToggle } = props
      const entries = Array.isArray(diff.data?.entries) ? diff.data.entries : []
      const counts = diff.data?.counts ?? {}
      const total = typeof counts.total === 'number' ? counts.total : entries.length
      const shown = entries.slice(0, DIFF_RENDER_LIMIT)

      const head = h('button', {
        type: 'button',
        className: 'dss-list-head',
        onClick: onToggle,
        'aria-expanded': open === true ? 'true' : 'false',
      },
      h('span', {
        className: 'dss-caret',
        'data-open': open === true ? 'true' : 'false',
        'aria-hidden': 'true',
      }, '\u25B8'),
      h('span', { className: 'dss-list-title' }, t('diff.title')),
      total === 0
        ? h('span', { className: 'dss-meta dss-meta-inline' }, t('diff.inSync'))
        : h('span', { className: 'dss-chips' },
          h('span', { className: 'dss-chip', 'data-change': 'added' }, t('diff.added', { n: counts.added ?? 0 })),
          h('span', { className: 'dss-chip', 'data-change': 'modified' }, t('diff.modified', { n: counts.modified ?? 0 })),
          h('span', { className: 'dss-chip', 'data-change': 'removed' }, t('diff.removed', { n: counts.removed ?? 0 }))))

      let body = null
      if (open === true) {
        if (diff.error !== null) {
          body = h('div', { className: 'dss-empty dss-error-text' }, `${t('diff.failed')}: ${diff.error}`)
        } else if (diff.loading === true && diff.data === null) {
          body = h('div', { className: 'dss-empty' }, t('diff.loading'))
        } else if (entries.length === 0) {
          body = h('div', { className: 'dss-empty' }, t('diff.empty'))
        } else {
          body = h('div', { className: 'dss-list-body' },
            shown.map((entry) => h('div', { className: 'dss-item', key: `${entry.change}:${entry.path}` },
              h('span', { className: 'dss-item-kind' }, kindLabel(entry.kind, t)),
              h('span', { className: 'dss-item-path', title: entry.path }, entry.path),
              h('span', { className: 'dss-chip', 'data-change': entry.change }, entry.change))),
            entries.length > DIFF_RENDER_LIMIT
              ? h('div', { className: 'dss-empty' }, t('diff.more', { n: entries.length - DIFF_RENDER_LIMIT }))
              : null)
        }
      }

      return h('div', { className: 'dss-list' }, head, body)
    }

    /* ------------------------------------------------------------------ */
    /* Page sections                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * Repository URL + branch, plus the git probes. Saving here posts the whole
     * draft, which is why the identity section can share the same handler.
     *
     * @param {object} page - The page bag (see `SettingsPage`).
     * @returns {object|null} Section element.
     */
    function RepositorySection(page) {
      const { t, repo, draft, setDraft, busy, actions } = page
      if (draft === null) return null

      const commit = repo?.lastCommit
      const remoteLine = commit
        ? t('repo.commitLine', {
          hash: shortHash(commit.hash),
          subject: String(commit.subject ?? '').slice(0, 80),
          ago: formatAgo(commit.at, t),
        })
        : repo?.configured === true ? t('repo.missing') : t('repo.notConfigured')
      const tracking = typeof repo?.ahead === 'number' || typeof repo?.behind === 'number'
        ? t('repo.aheadBehind', { ahead: repo?.ahead ?? 0, behind: repo?.behind ?? 0 })
        : null

      return h(Section, { title: t('section.repository.title'), hint: t('section.repository.hint') },
        h(Row, { label: t('field.repoUrl') },
          h('input', {
            className: 'dss-input dss-field',
            type: 'text',
            value: draft.repoUrl,
            placeholder: t('field.repoUrl.placeholder'),
            'aria-label': t('field.repoUrl'),
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => setDraft({ ...draft, repoUrl: event.target.value }),
          })),
        h(Row, { label: t('field.branch') },
          h('input', {
            className: 'dss-input dss-field-narrow',
            type: 'text',
            value: draft.branch,
            placeholder: t('field.branch.placeholder'),
            'aria-label': t('field.branch'),
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => setDraft({ ...draft, branch: event.target.value }),
          })),
        h('div', { className: 'dss-actions' },
          h(Button, { variant: 'primary', disabled: busy !== null, onClick: actions.save },
            busy === 'save' ? t('action.saving') : t('action.save')),
          h(Button, { disabled: busy !== null, onClick: actions.testGit },
            busy === 'test' ? t('action.testing') : t('action.testGit')),
          h(Button, { disabled: busy !== null, onClick: actions.createRepo },
            busy === 'create' ? t('action.creating') : t('action.createRepo'))),
        h('div', { className: 'dss-meta' }, remoteLine),
        tracking === null ? null : h('div', { className: 'dss-meta dss-meta-tight' }, tracking),
        // The Host also puts a message in `repo.error` for the *ordinary*
        // unconfigured case, which `remoteLine` already says in neutral copy.
        // Only a configured repository's error is a real failure worth alarming.
        repo?.configured === true && typeof repo?.error === 'string' && repo.error !== ''
          ? h('div', { className: 'dss-error-text' }, repo.error)
          : null)
    }

    /**
     * Manual push/pull, the snapshot summary, and the diff preview.
     *
     * Pull is the one destructive action in the product, so it arms itself: the
     * first click turns the button into a confirm, and only the second click
     * overwrites local config. A mis-click costs nothing.
     *
     * @param {object} page - The page bag.
     * @returns {object} Section element.
     */
    function SyncSection(page) {
      const { t, data, busy, hostBusy, actions, diff, diffOpen, setDiffOpen, pullArmed, setPullArmed, notice } = page
      const snapshot = data?.snapshot ?? {}
      const lastRun = formatLastRun(data?.lastRun, t)
      const blocked = busy !== null || hostBusy !== null
      // The Host refused an overwrite pull because it would have deleted most of
      // this machine's settings. That is the only failure with a recovery, so the
      // page offers the escape hatch right where the pull button lives.
      const guarded = notice?.code === 'mass-deletion-on-pull'
      // A pull that installed bundles this process never mounted: the config is
      // restored and correct, but the plugins only load after a restart.
      const needsRestart = notice?.code === 'needs-restart'
      const newBundles = Array.isArray(notice?.newBundles) ? notice.newBundles : []
      // The snapshot declares plugins whose packages never landed. Higher
      // priority than the restart advice: a restart would only turn these into
      // startup failures, so the fix has to come first.
      const uninstalled = notice?.code === 'uninstalled-bundles'
        ? (Array.isArray(notice.uninstalledBundles) ? notice.uninstalledBundles : [])
        : []
      const missingMessage = typeof notice?.installMessage === 'string' ? notice.installMessage : null

      return h(Section, { title: t('section.sync.title'), hint: t('section.sync.hint') },
        h('div', { className: 'dss-chips' },
          h('span', { className: 'dss-chip' }, t('summary.files', { n: snapshot.files ?? 0 })),
          h('span', { className: 'dss-chip' }, t('summary.skills', { n: snapshot.skills ?? 0 })),
          h('span', { className: 'dss-chip' }, t('summary.plugins', { n: snapshot.plugins ?? 0 })),
          h('span', { className: 'dss-chip' }, formatBytes(snapshot.bytes))),
        h('div', { className: 'dss-actions' },
          h(Button, { variant: 'primary', disabled: blocked, onClick: actions.push },
            busy === 'push' ? t('action.pushing') : t('action.push')),
          pullArmed === true
            ? h(React.Fragment, null,
              h(Button, {
                variant: 'danger',
                disabled: busy !== null,
                onClick: () => { setPullArmed(false); actions.pull() },
              }, busy === 'pull' ? t('action.pulling') : t('action.pullConfirm')),
              h(Button, { variant: 'ghost', disabled: busy !== null, onClick: () => setPullArmed(false) }, t('action.cancel')))
            : h(Button, { disabled: blocked, onClick: () => setPullArmed(true) }, t('action.pull'))),
        guarded
          ? h('div', { className: 'dss-guard', role: 'alert' },
            h('strong', null, t('pull.guardTitle')),
            h('p', null, t('pull.guardHint')),
            h('p', null, notice.text),
            h('div', { className: 'dss-actions' },
              h(Button, {
                variant: 'danger',
                disabled: busy !== null || hostBusy !== null,
                onClick: () => actions.pull(true),
              }, busy === 'force-pull' ? t('action.forcePulling') : t('action.forcePull'))))
          : null,
        needsRestart
          ? h('div', { className: 'dss-restart', role: 'status' },
            h('strong', null, t('restart.title')),
            h('p', null, t('restart.body', { count: newBundles.length })),
            newBundles.length === 0
              ? null
              : h('p', { className: 'dss-restart-list' }, t('restart.list', { names: newBundles.join(', ') })),
            h('p', { className: 'dss-restart-hint' }, t('restart.hint')))
          : null,
        uninstalled.length > 0
          ? h('div', { className: 'dss-missing', role: 'alert' },
            h('strong', null, t('missing.title', { count: uninstalled.length })),
            h('p', null, t('missing.body')),
            h('p', { className: 'dss-missing-list' }, t('missing.list', { names: uninstalled.join(', ') })),
            notice?.autoInstallOff === true
              ? h('p', null, t('missing.autoInstallOff'))
              : h('p', null, t('missing.installFailed', { message: missingMessage ?? '—' })),
            notice?.autoInstallOff === true
              ? null
              : h(React.Fragment, null,
                h('p', null, t('missing.manual')),
                h('pre', { className: 'dss-missing-cmd' }, t('missing.command'))))
          : null,
        hostBusy === null
          ? null
          : h('div', { className: 'dss-meta' }, t('sync.hostBusy', { operation: hostBusy })),
        h('div', { className: 'dss-meta' }, lastRun),
        h(DiffList, { t, diff, open: diffOpen === true, onToggle: () => setDiffOpen(!diffOpen) }))
    }

    /**
     * Automatic-sync policy. Every control writes immediately — a toggle that
     * needs a second Save click is a toggle users think is broken.
     *
     * @param {object} page - The page bag.
     * @returns {object} Section element.
     */
    function AutomationSection(page) {
      const { t, config, busy, actions } = page
      const disabled = busy !== null
      const interval = String(config?.intervalMs ?? 0)

      return h(Section, { title: t('section.auto.title'), hint: t('section.auto.hint') },
        // Redaction is first and defaults on: it is the setting that decides
        // whether a push is safe to make at all, so it must be read before the
        // toggle that starts pushing.
        h(Row, { label: t('auto.redact'), hint: t('auto.redact.hint') },
          h(Toggle, {
            checked: config?.redactSecrets !== false,
            disabled,
            label: t('auto.redact'),
            onChange: (next) => actions.saveField({ redactSecrets: next }),
          })),
        h(Row, { label: t('auto.push'), hint: t('auto.push.hint') },
          h(Toggle, {
            checked: config?.autoPush === true,
            disabled,
            label: t('auto.push'),
            onChange: (next) => actions.saveField({ autoPush: next }),
          })),
        h(Row, { label: t('auto.policy'), hint: t('auto.policy.hint') },
          h('select', {
            className: 'dss-select dss-field-narrow',
            value: config?.pullPolicy ?? 'ask',
            disabled,
            'aria-label': t('auto.policy'),
            onChange: (event) => actions.saveField({ pullPolicy: event.target.value }),
          },
          h('option', { value: 'never' }, t('policy.never')),
          h('option', { value: 'ask' }, t('policy.ask')),
          h('option', { value: 'always' }, t('policy.always')))),
        h(Row, { label: t('auto.interval'), hint: t('auto.interval.hint') },
          h('select', {
            className: 'dss-select dss-field-narrow',
            value: interval,
            disabled,
            'aria-label': t('auto.interval'),
            onChange: (event) => actions.saveField({ intervalMs: Number(event.target.value) }),
          },
          INTERVALS.map((entry) => h('option', { key: entry.ms, value: String(entry.ms) }, t(entry.key))))))
    }

    /**
     * Commit identity used inside the mirror clone. The draft is shared with the
     * repository section, so either Save button persists both halves — they are
     * one document on the Host.
     *
     * @param {object} page - The page bag.
     * @returns {object|null} Section element.
     */
    function IdentitySection(page) {
      const { t, draft, setDraft, busy, actions } = page
      if (draft === null) return null
      return h(Section, { title: t('section.identity.title'), hint: t('section.identity.hint') },
        h(Row, { label: t('field.gitName') },
          h('input', {
            className: 'dss-input dss-field',
            type: 'text',
            value: draft.gitName,
            'aria-label': t('field.gitName'),
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => setDraft({ ...draft, gitName: event.target.value }),
          })),
        h(Row, { label: t('field.gitEmail') },
          h('input', {
            className: 'dss-input dss-field',
            type: 'email',
            value: draft.gitEmail,
            'aria-label': t('field.gitEmail'),
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => setDraft({ ...draft, gitEmail: event.target.value }),
          })),
        h('div', { className: 'dss-actions' },
          h(Button, { variant: 'primary', disabled: busy !== null, onClick: actions.save },
            busy === 'save' ? t('action.saving') : t('action.save'))),
        h('div', { className: 'dss-meta' }, t('identity.note')))
    }

    /**
     * Saved restore points, newest first as the Host returns them. Each row can
     * put that state back, which is the escape hatch after a bad pull.
     *
     * @param {object} page - The page bag.
     * @returns {object} Section element.
     */
    function RecoveriesSection(page) {
      const { t, data, recoveries, busy, actions } = page
      const items = recoveries.items ?? []
      const stateLine = data?.paths?.stateDir

      let body
      if (recoveries.error !== null) {
        body = h('div', { className: 'dss-error-text' },
          `${t('recoveries.failed')}: ${recoveries.error}`)
      } else if (recoveries.loading === true && items.length === 0) {
        body = h('div', { className: 'dss-empty' }, t('recoveries.loading'))
      } else if (items.length === 0) {
        body = h('div', { className: 'dss-empty' }, t('recoveries.empty'))
      } else {
        body = h('div', { className: 'dss-list dss-list-inset' },
          items.map((item) => h('div', { className: 'dss-item', key: String(item.id) },
            h('span', { className: 'dss-item-label' }, String(item.label ?? item.id ?? '')),
            h('span', { className: 'dss-meta dss-meta-inline' },
              t('recoveries.item', { files: item.files ?? 0, ago: formatAgo(item.at, t) })),
            h('span', { className: 'dss-spacer' }),
            h(Button, {
              disabled: busy !== null,
              onClick: () => actions.recover(item),
            }, busy === `recover:${item.id}` ? t('action.restoring') : t('action.restore')))))
      }

      return h(Section, {
        title: t('section.recoveries.title'),
        hint: t('section.recoveries.hint'),
        aside: h(Button, { variant: 'ghost', onClick: recoveries.reload }, t('action.refresh')),
      },
      stateLine === undefined || stateLine === null
        ? null
        : h('div', { className: 'dss-meta dss-meta-inline dss-meta-below' },
          h('span', { className: 'dss-mono', title: String(stateLine) }, String(stateLine))),
      body)
    }

    /**
     * The two promises the product makes about credentials and about pulling.
     *
     * @param {object} props - `t`.
     * @returns {object} Section element.
     */
    function SafetySection(props) {
      const t = props.t
      return h(Section, { title: t('section.safety.title') },
        h('div', { className: 'dss-safety' },
          h('div', null,
            h('strong', null, t('safety.credentials')),
            h('p', null, t('safety.credentials.body'))),
          h('div', null,
            h('strong', null, t('safety.pull')),
            h('p', null, t('safety.pull.body')))))
    }

    /**
     * Version and the public repository link.
     *
     * @param {object} props - `t`.
     * @returns {object} About line.
     */
    function AboutSection(props) {
      const t = props.t
      return h(Section, null,
        h('div', { className: 'dss-about' },
          h('span', null, t('about.version', { version: props.version ?? '—' })),
          h('span', { 'aria-hidden': 'true' }, '·'),
          h('a', { href: REPO_URL, target: '_blank', rel: 'noreferrer noopener' }, t('about.repo'))))
    }

    /* ------------------------------------------------------------------ */
    /* Actions                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * The page's single in-flight slot and its single message line.
     *
     * Exactly one request may run at a time: two concurrent pushes onto the same
     * mirror would race, and a page where two buttons spin at once cannot say
     * which one failed. Errors land here too, so a failure has exactly one
     * visible home regardless of which button caused it.
     *
     * @returns {{ busy: string|null, notice: object|null,
     *   run: (key: string, action: () => Promise<any>) => Promise<any|null>,
     *   setNotice: (notice: object|null) => void }} The channel.
     */
    function useBusyChannel() {
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      /**
       * Run one request under the channel.
       *
       * @param {string} key - Busy key, also what the buttons read to show their busy label.
       * @param {() => Promise<any>} action - The request, throwing on failure.
       * @returns {Promise<any|null>} The action's payload, or null when it failed.
       */
      const run = React.useCallback(async (key, action) => {
        setBusy(key)
        setNotice(null)
        try {
          return await action()
        } catch (error) {
          // The error's `code` rides along so the page can offer a recovery for
          // the one failure that has one (`mass-deletion-on-pull`); every other
          // failure is just the message.
          setNotice({ tone: 'error', text: error?.message ?? String(error), code: error?.code ?? null })
          return null
        } finally {
          setBusy(null)
        }
      }, [])

      return { busy, notice, run, setNotice }
    }

    /**
     * Every mutating call the page can make.
     *
     * Each action refreshes only the state it can invalidate — a config write
     * does not need the restore-point list, and a recover does not need the
     * remote preview — so a click costs the minimum number of Host round trips.
     *
     * @param {object} deps - `t`, `store`, `diff`, `recoveries`, `draft`, `setDraft`,
     *   and the channel from {@link useBusyChannel}.
     * @returns {{ save: Function, testGit: Function, createRepo: Function,
     *   push: Function, pull: Function, recover: Function, saveField: Function }} Actions.
     */
    function useSettingsActions(deps) {
      const { t, store, diff, recoveries, draft, setDraft, channel } = deps
      const { run, setNotice } = channel

      /** Persist the whole draft (repository URL, branch, identity). */
      const save = React.useCallback(() => run('save', async () => {
        const payload = await call('POST', '/config', draft ?? {})
        if (payload?.config !== undefined) {
          store.patch({ config: payload.config })
          // Re-project from the Host's normalized answer: a trimmed URL or a
          // rejected branch shows up here rather than silently staying wrong.
          setDraft(toDraft(payload.config))
        }
        store.refresh()
        setNotice({ tone: 'ok', text: t('notice.saved') })
      }), [run, draft, store, setDraft, t])

      /** Ask the Host whether its `git` is usable. */
      const testGit = React.useCallback(() => run('test', async () => {
        const payload = await call('POST', '/test')
        setNotice(payload?.okGit === true
          ? { tone: 'ok', text: t('notice.testOk', { version: payload?.version ?? payload?.message ?? '?' }) }
          : { tone: 'error', text: payload?.message ?? t('notice.testFailed') })
      }), [run, t])

      /** Create a private repository with the user's `gh`, then prefill the URL. */
      const createRepo = React.useCallback(() => run('create', async () => {
        const payload = await call('POST', '/create-repo', {})
        const repoUrl = typeof payload?.repoUrl === 'string' ? payload.repoUrl : ''
        // The Host already persisted the new URL, so mirror it into the draft
        // (otherwise the field would still show the old value) and refresh the
        // snapshot rather than leaving the page one save behind.
        if (repoUrl !== '') setDraft((previous) => ({ ...(previous ?? toDraft(null)), repoUrl }))
        store.refresh()
        setNotice({ tone: 'ok', text: t('notice.repoCreated') })
      }), [run, store, setDraft, t])

      /** Push local settings to the remote. */
      const push = React.useCallback(() => run('push', async () => {
        const payload = await call('POST', '/push', {})
        const result = payload?.result ?? {}
        store.refresh()
        diff.reload()
        setNotice({
          tone: 'ok',
          text: t('notice.pushed', { files: result.files ?? 0, commit: shortHash(result.commit) }),
        })
      }), [run, store, diff, t])

      /**
       * Pull the remote over local config. The Host writes the restore point.
       *
       * `force` re-sends the same overwrite pull with the Host's mass-deletion
       * guard switched off. It is only reachable from the guard's own failure,
       * so the user has already read how many files would go.
       *
       * @param {boolean} force - Bypass the Host's mass-deletion guard.
       */
      const pull = React.useCallback((force) => run(force === true ? 'force-pull' : 'pull', async () => {
        const body = force === true ? { mode: 'overwrite', force: true } : { mode: 'overwrite' }
        const payload = await call('POST', '/pull', body)
        const result = payload?.result ?? {}
        store.refresh()
        diff.reload()
        recoveries.reload()
        const newBundles = Array.isArray(result.newBundles) ? result.newBundles : []
        const uninstalled = Array.isArray(result.uninstalledBundles) ? result.uninstalledBundles : []
        // Two different follow-ups ride the same notice channel:
        //
        //   - `needs-restart` — the install worked; the plugins only need a
        //     restart to load. A success with an action.
        //   - `uninstalled-bundles` — the config declares plugins whose packages
        //     never landed. Restarting now would make them fail to load, so this
        //     takes precedence over the restart advice: it is a problem to fix
        //     first, not a step to perform.
        const missing = uninstalled.length > 0
        setNotice({
          tone: missing ? 'warn' : 'ok',
          code: missing ? 'uninstalled-bundles' : result.needsRestart === true ? 'needs-restart' : null,
          text: missing
            ? t('notice.uninstalled', {
              files: result.files ?? 0,
              commit: shortHash(result.commit),
              count: uninstalled.length,
              names: uninstalled.slice(0, 5).join(', '),
            })
            : result.needsRestart === true
              ? t('notice.needsRestart', {
                files: result.files ?? 0,
                commit: shortHash(result.commit),
                count: newBundles.length,
              })
              : t('notice.pulled', {
                files: result.files ?? 0,
                commit: shortHash(result.commit),
                backup: String(result.backedUpTo ?? '—'),
              }),
          newBundles,
          uninstalledBundles: uninstalled,
          installFailed: result.installFailed === true,
          installMessage: typeof result.install?.message === 'string' ? result.install.message : null,
          autoInstallOff: result.install === null,
        })
      }), [run, store, diff, recoveries, t])

      /** Put one restore point back. */
      const recover = React.useCallback((item) => run(`recover:${item?.id}`, async () => {
        await call('POST', '/recover', { id: item?.id })
        store.refresh()
        diff.reload()
        recoveries.reload()
        setNotice({ tone: 'ok', text: t('notice.recovered', { label: String(item?.label ?? item?.id ?? '') }) })
      }), [run, store, diff, recoveries, t])

      /** Write one configuration field (the automatic-sync controls). */
      const saveField = React.useCallback((patch) => run('config', async () => {
        const payload = await call('POST', '/config', patch)
        if (payload?.config !== undefined) store.patch({ config: payload.config })
        store.refresh()
      }), [run, store])

      return { save, testGit, createRepo, push, pull, recover, saveField }
    }

    /* ------------------------------------------------------------------ */
    /* Settings page                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * The `settings.section` body.
     *
     * State lives here because every section reads the same status snapshot and
     * the same form draft; the sections themselves are pure renderers over the
     * `page` bag. `draft` is filled exactly once — when the first status lands —
     * so a background refresh cannot overwrite a half-typed URL.
     *
     * @param {object} props - Slot props plus the injected `t` and `store`.
     * @returns {object} Page element.
     */
    function SettingsPage(props) {
      const t = props.t
      const store = props.store
      const status = useStatus(store)
      const diff = useDiff()
      const recoveries = useRecoveries()
      const [draft, setDraft] = React.useState(null)
      const [diffOpen, setDiffOpen] = React.useState(false)
      const [pullArmed, setPullArmed] = React.useState(false)
      const channel = useBusyChannel()
      const actions = useSettingsActions({ t, store, diff, recoveries, draft, setDraft, channel })

      React.useEffect(() => {
        if (draft !== null || status.data === null) return
        setDraft(toDraft(status.data.config))
      }, [draft, status.data])

      // A stale "overwrite local?" arm would be dangerous if the user walked
      // away from the page and came back to a different status.
      React.useEffect(() => { setPullArmed(false) }, [status.data?.config?.repoUrl])

      if (status.data === null) {
        if (status.error === null) {
          return h('div', { className: 'dss-root' }, h('div', { className: 'dss-empty' }, t('state.loading')))
        }
        return h('div', { className: 'dss-root' },
          h('div', { className: 'dss-error-text', role: 'alert' },
            `${t('state.failed')}: ${status.error}`),
          h('div', { className: 'dss-actions' },
            h(Button, { onClick: store.refresh }, t('action.retry'))))
      }

      const data = status.data
      const page = {
        t,
        data,
        config: data.config ?? {},
        repo: data.repo ?? {},
        draft,
        setDraft,
        busy: channel.busy,
        notice: channel.notice,
        actions,
        diff,
        diffOpen,
        setDiffOpen,
        pullArmed,
        setPullArmed,
        recoveries,
        hostBusy: data?.busy?.operation ?? null,
        // The Host reads this from the package manifest, so the About line cannot
        // drift from the version that is actually installed.
        version: data?.plugin?.version ?? null,
      }

      return h('div', { className: 'dss-root' },
        h('div', { className: 'dss-notice-bar' }, h(Notice, { notice: channel.notice })),
        h(RepositorySection, page),
        h(SyncSection, page),
        h(AutomationSection, page),
        h(IdentitySection, page),
        h(RecoveriesSection, page),
        h(SafetySection, { t }),
        h(AboutSection, { t, version: page.version }))
    }

    /* ------------------------------------------------------------------ */
    /* First-run dialog                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * The dialog's answer channel: busy, failure, and the "done" result.
     *
     * Split out of `FirstRunDialog` because the dialog closes itself from
     * several places (a scrim click, Escape, the close button) and all of them
     * have to agree on whether an answer is already in flight. Recording is
     * optimistic for dismissal — see `dismiss` — so the shared busy flag must
     * not block the user from getting out of the dialog.
     *
     * @param {object} deps - `t` and the shared `store`.
     * @returns {{ busy: string|null, error: string|null, result: string|null,
     *   answer: (action: string) => Promise<void>, dismiss: () => void }} The channel.
     */
    function usePromptAnswer(deps) {
      const { t, store } = deps
      const [busy, setBusy] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [result, setResult] = React.useState(null)

      /** Close locally by clearing the pending flag in the cached snapshot. */
      const dismiss = React.useCallback(() => {
        const current = store.getSnapshot()?.data?.prompt ?? {}
        store.patch({ prompt: { ...current, pending: false } })
      }, [store])

      /** Record one answer; on success the dialog shows its result before closing. */
      const answer = React.useCallback(async (action) => {
        setBusy(action)
        setError(null)
        try {
          await call('POST', '/prompt-answer', { action })
          setResult(t('prompt.done'))
          store.refresh()
        } catch (failure) {
          setError(failure?.message ?? String(failure))
        } finally {
          setBusy(null)
        }
      }, [store, t])

      return { busy, error, result, answer, dismiss }
    }

    /**
     * The modal card itself: a pure renderer so `FirstRunDialog` only owns the
     * fetching and the dismissal rules.
     *
     * @param {object} props - `t`, `busy`, `error`, `result`, `hasRepo`, `hasRemote`,
     *   `onAnswer(action)`, `onLater()`.
     * @returns {object} Overlay element.
     */
    function PromptDialog(props) {
      const { t, busy, error, result, hasRepo, hasRemote, onAnswer, onLater } = props
      const disabled = busy !== null || result !== null
      return h('div', {
        className: 'dss-overlay',
        onClick: (event) => {
          if (event.target === event.currentTarget) onLater()
        },
      },
      h('div', {
        className: 'dss-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('prompt.title'),
      },
      h('div', { className: 'dss-dialog-head' },
        h('h2', null, t('prompt.title')),
        h(Button, {
          variant: 'ghost',
          disabled: disabled === true,
          title: t('prompt.close'),
          onClick: onLater,
        }, '\u00D7')),
      h('p', null, t('prompt.body')),
      h('div', { className: 'dss-dialog-actions' },
        h(Button, {
          variant: hasRemote ? 'primary' : undefined,
          disabled: disabled || !hasRepo,
          onClick: () => onAnswer('restore'),
        }, busy === 'restore' ? t('prompt.busy') : t('prompt.restore')),
        hasRepo ? null : h('div', { className: 'dss-dialog-reason' }, t('prompt.needRepo')),
        h(Button, {
          variant: hasRemote ? undefined : 'primary',
          disabled: disabled || !hasRepo,
          onClick: () => onAnswer('push'),
        }, busy === 'push' ? t('prompt.busy') : t('prompt.push')),
        h(Button, { variant: 'ghost', disabled: disabled === true, onClick: onLater }, t('prompt.later'))),
      result === null ? null : h('div', { className: 'dss-result' }, result),
      error === null ? null : h('div', { className: 'dss-failure', role: 'alert' }, error)))
    }

    /**
     * The `shell.overlay` body: the one-time restore/upload choice.
     *
     * Every exit path counts as an answer: the two action buttons, "Later", the
     * close button, Escape, and a click on the scrim. Closing without choosing
     * records `later`, so the dialog never fights the user who dismissed it —
     * and a *failed* `later` write is swallowed, because the honest outcome is
     * that the dialog simply returns on the next start.
     *
     * "Restore" is the primary action only when the remote actually has a
     * snapshot to restore — asked of `/remote-preview` (`remoteHead`), falling
     * back to the local mirror's `lastCommit` while that request is in flight.
     * Restore is disabled until a repository URL is configured, with that reason
     * written next to it.
     *
     * @param {object} props - Slot props plus the injected `t` and `store`.
     * @returns {object|null} Dialog element, or null when nothing is pending.
     */
    function FirstRunDialog(props) {
      const t = props.t
      const store = props.store
      const status = useStatus(store)
      const { busy, error, result, answer, dismiss } = usePromptAnswer({ t, store })

      const config = status.data?.config ?? {}
      const repo = status.data?.repo ?? {}
      const pending = status.data?.prompt?.pending === true
      const hasRepo = typeof config.repoUrl === 'string' && config.repoUrl.trim() !== ''
      const preview = useRemotePreview(pending === true && hasRepo)
      // Prefer the remote's own answer; fall back to the local mirror's commit
      // only while the preview is still in flight, so the button never flips
      // from "primary" to "secondary" after the user has started reading.
      const hasRemote = preview.data !== null && preview.data !== undefined
        ? preview.data.exists === true && preview.data.remoteHead !== null && preview.data.remoteHead !== undefined
        : repo.exists === true && repo.lastCommit !== null && repo.lastCommit !== undefined

      /** Dismissal is "later": it hides immediately and records in the background. */
      const later = React.useCallback(() => {
        dismiss()
        call('POST', '/prompt-answer', { action: 'later' })
          .then(() => store.refresh())
          // A failed write only means the dialog comes back on the next start,
          // which is the honest outcome — never block the UI on it.
          .catch(() => {})
      }, [dismiss, store])

      // Show the result briefly, then close. The timer is the only reason this
      // tree ever keeps running, so it is cleaned up on unmount.
      React.useEffect(() => {
        if (result === null) return undefined
        const timer = setTimeout(dismiss, PROMPT_RESULT_MS)
        return () => clearTimeout(timer)
      }, [result, dismiss])

      React.useEffect(() => {
        if (pending !== true) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') later()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [pending, later])

      if (pending !== true) return null

      return h(PromptDialog, {
        t,
        busy,
        error,
        result,
        hasRepo,
        hasRemote,
        onAnswer: answer,
        onLater: later,
      })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = makeT(ctx)
        const store = createStatusStore()

        ctx.effect(installStyles, 'settings-sync: stylesheet')
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICTS.zh), 'settings-sync: dictionary (zh)')
        ctx.effect(() => ctx.locale.register(NS, 'en', DICTS.en), 'settings-sync: dictionary (en)')

        // Settings page. `label` is a thunk so the nav entry follows a locale
        // switch without re-registering the slot.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 16,
          label: () => t('nav.label'),
          locale: NS,
        }, (slotProps) => h(SettingsPage, { ...slotProps, t, store })))

        // First-run dialog. The component itself renders null unless the Host
        // still owes an answer, so this registration is inert on later starts.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: OVERLAY_ID,
          order: 60,
          label: () => t('prompt.title'),
          locale: NS,
        }, (slotProps) => h(FirstRunDialog, { ...slotProps, t, store })))
      },
    }
  },
})
