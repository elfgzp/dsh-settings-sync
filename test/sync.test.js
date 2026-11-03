/**
 * End-to-end checks for the Host half, run with `node --test`.
 *
 * These exercise the real code paths against a real `git` binary and a scratch
 * directory standing in for the home directory: a fake profile, fake skills, and
 * a bare repository acting as the remote. Nothing here mocks git, because git is
 * exactly the part most likely to be wrong.
 *
 * Run: `node --test test/*.test.js`
 *
 * @module dsh-settings-sync/test
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'

import { resolveConfig } from '../lib/config.js'
import { SyncEngine } from '../lib/engine.js'
import { Git, normalizeBranch, normalizeRemote, parsePorcelain } from '../lib/git.js'
import { collectSnapshot, listRestorePoints, materialize, restoreSnapshot } from '../lib/snapshot.js'
import { StateStore, normalizeUserConfig, promptPending } from '../lib/state.js'

const run = promisify(execFile)

/** Run one git command in a directory, failing loudly. */
async function git(cwd, ...args) {
  const { stdout } = await run('git', args, { cwd })
  return stdout.trim()
}

/**
 * Build a throwaway world: a home directory with a profile, two skill roots, a
 * per-plugin state directory, a credential that must NOT be synced, and a bare
 * remote repository.
 */
async function buildWorld() {
  const root = await mkdtemp(join(tmpdir(), 'settings-sync-'))
  const home = join(root, 'home')
  const dshHome = join(home, '.dsh')
  const agentsHome = join(home, '.agents')
  const profileDir = join(dshHome, 'profiles', 'desktop')
  const stateDir = join(dshHome, 'settings-sync')

  await mkdir(profileDir, { recursive: true })
  await mkdir(join(dshHome, 'skills', 'demo-skill', 'references'), { recursive: true })
  await mkdir(join(agentsHome, 'skills', 'flat-skill'), { recursive: true })
  await mkdir(join(dshHome, 'gongfeng-mr'), { recursive: true })

  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { 'dsh-example': 'link:/tmp/example' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-example'] } },
  }, null, 2)}\n`)
  await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: web-search\n  config:\n    apiKey: sk-not-a-real-key\n')
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
  // A .bak of a previous edit: never synced.
  await writeFile(join(profileDir, 'cordis.patch.yml.bak-20260101'), 'stale\n')

  await writeFile(join(dshHome, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: A demo.\n---\n\nBody.\n')
  await writeFile(join(dshHome, 'skills', 'demo-skill', 'references', 'detail.md'), '# detail\n')
  await writeFile(join(agentsHome, 'skills', 'flat-skill', 'SKILL.md'), '---\nname: flat-skill\ndescription: Flat.\n---\n')
  // A directory without SKILL.md is not a skill; it is bundle residue.
  await mkdir(join(agentsHome, 'skills', 'not-a-skill'), { recursive: true })
  await writeFile(join(agentsHome, 'skills', 'not-a-skill', 'readme.md'), 'ignore me\n')

  await writeFile(join(dshHome, 'gongfeng-mr', 'settings.json'), '{"defaultProject":"itfs"}\n')
  await writeFile(join(dshHome, 'gongfeng-mr', 'cache.json'), '{"huge":"cache"}\n')
  // Credentials and session data: never synced.
  await writeFile(join(dshHome, '.credentials.yaml'), 'records:\n  - secret\n')
  await writeFile(join(dshHome, 'tencent-intranet-auth.json'), '{"accessToken":"live-token"}\n')
  await mkdir(join(dshHome, 'sessions'), { recursive: true })
  await writeFile(join(dshHome, 'sessions', 'big.json'), '{"history":true}\n')

  const remoteDir = join(root, 'remote.git')
  await run('git', ['init', '--bare', '--initial-branch', 'main', remoteDir])

  const config = resolveConfig({ stateDir }, {
    HOME: home,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
    DSH_PROFILE_DIR: profileDir,
  })
  return { root, home, dshHome, agentsHome, profileDir, stateDir, remoteDir, config }
}

describe('config resolution', () => {
  it('resolves every root from the environment', () => {
    const config = resolveConfig({}, {
      DSH_HOME: '/tmp/x/.dsh',
      DSH_AGENTS_HOME: '/tmp/x/.agents',
      DSH_PROFILE_DIR: '/tmp/x/.dsh/profiles/desktop',
    })
    assert.equal(config.dshHome, '/tmp/x/.dsh')
    assert.equal(config.agentsHome, '/tmp/x/.agents')
    assert.equal(config.profileDir, '/tmp/x/.dsh/profiles/desktop')
    assert.equal(config.stateDir, '/tmp/x/.dsh/settings-sync')
  })

  it('rejects an unusable repository URL', () => {
    assert.equal(normalizeRemote('https://github.com/elfgzp/dsh-settings.git'), 'https://github.com/elfgzp/dsh-settings.git')
    assert.equal(normalizeRemote('git@github.com:elfgzp/dsh-settings.git'), 'git@github.com:elfgzp/dsh-settings.git')
    assert.equal(normalizeRemote('--upload-pack=evil'), undefined)
    assert.equal(normalizeRemote('not a url'), undefined)
  })

  it('rejects an unusable branch name', () => {
    assert.equal(normalizeBranch('main'), 'main')
    assert.equal(normalizeBranch('feature/sync'), 'feature/sync')
    assert.equal(normalizeBranch('-x'), undefined)
    assert.equal(normalizeBranch('a..b'), undefined)
  })

  it('defaults the user configuration and reports a pending prompt', () => {
    const config = normalizeUserConfig({})
    assert.equal(config.branch, 'main')
    assert.equal(config.pullPolicy, 'ask')
    assert.equal(config.gitName, 'Elf')
    assert.equal(config.gitEmail, 'me@elfgzp.cn')
    assert.equal(promptPending(config), true)
    assert.equal(promptPending(normalizeUserConfig({ promptVersion: 1 })), false)
  })
})

describe('git plumbing', () => {
  it('parses porcelain v1 -z output', () => {
    // ` M path` (modified), `?? path` (untracked), ` D path` (deleted).
    const raw = ' M profile/cordis.yml\0?? homes/dsh/gongfeng-mr/settings.json\0 D profile/old.yml\0'
    const parsed = parsePorcelain(raw)
    assert.deepEqual(parsed.map((entry) => entry.path), [
      'profile/cordis.yml',
      'homes/dsh/gongfeng-mr/settings.json',
      'profile/old.yml',
    ])
  })

  it('reports a missing git binary as a probe failure', async () => {
    const git = new Git({ binary: '/nonexistent/git-xyz' })
    const probe = await git.probe()
    assert.equal(probe.ok, false)
    assert.match(probe.message, /找不到 git/)
  })
})

describe('snapshot collection', () => {
  let world
  before(async () => { world = await buildWorld() })
  after(async () => { await rm(world.root, { recursive: true, force: true }) })

  it('collects profile config, skills and plugin state, and nothing else', async () => {
    const plan = await collectSnapshot(world.config)
    const targets = plan.files.map((file) => file.target)

    assert.ok(targets.includes('profile/package.json'))
    assert.ok(targets.includes('profile/cordis.patch.yml'))
    assert.ok(targets.includes('homes/dsh/skills/demo-skill/SKILL.md'))
    assert.ok(targets.includes('homes/dsh/skills/demo-skill/references/detail.md'))
    assert.ok(targets.includes('homes/agents/skills/flat-skill/SKILL.md'))
    assert.ok(targets.includes('homes/dsh/gongfeng-mr/settings.json'))

    // Excluded: backups, caches, credentials, session history, non-skills.
    assert.ok(!targets.some((path) => path.includes('.bak')))
    assert.ok(!targets.some((path) => path.includes('cache.json')))
    assert.ok(!targets.some((path) => path.includes('.credentials')))
    assert.ok(!targets.some((path) => path.includes('tencent-intranet-auth')))
    assert.ok(!targets.some((path) => path.includes('sessions/')))
    assert.ok(!targets.some((path) => path.includes('not-a-skill')))

    // Inventory.
    assert.equal(plan.skills.length, 2)
    assert.ok(plan.plugins.includes('dsh-example'))
    assert.ok(plan.plugins.includes('@deepseek-ai/dsh-base'))
  })
})

describe('push and pull round trip', () => {
  let world
  let state
  let engine

  before(async () => {
    world = await buildWorld()
    state = new StateStore(world.config.stateDir)
    await state.writeUserConfig({
      repoUrl: world.remoteDir,
      branch: 'main',
      gitName: 'Test',
      gitEmail: 'test@example.com',
    })
    engine = new SyncEngine({ config: world.config, state })
  })

  after(async () => { await rm(world.root, { recursive: true, force: true }) })

  it('pushes a first snapshot to the bare remote', async () => {
    const result = await engine.push({})
    assert.equal(result.pushed, true)
    assert.ok(result.files > 0)

    const log = await git(world.remoteDir, 'log', '--oneline', 'main')
    assert.match(log, /settings:/)

    const manifest = JSON.parse(await git(world.remoteDir, 'show', 'main:manifest.json'))
    assert.equal(manifest.format, 1)
    assert.equal(manifest.generator, 'dsh-settings-sync')
    assert.equal(manifest.counts.skills, 2)
  })

  it('reports no changes on a second push', async () => {
    const result = await engine.push({})
    assert.equal(result.pushed, false)
    assert.equal(result.summary, '没有变化')
  })

  it('diffs an edited config as a modification', async () => {
    await writeFile(join(world.profileDir, 'cordis.yml'), '[]\n# edited\n')
    const diff = await engine.diff()
    const entry = diff.entries.find((item) => item.path === 'profile/cordis.yml')
    assert.ok(entry, 'edited file appears in the diff')
    assert.equal(entry.change, 'modified')
    assert.equal(entry.kind, 'profile')
  })

  it('pushes the edit and then restores it from the remote', async () => {
    await engine.push({})
    // Destroy the local edit and add a file the remote does not have.
    await writeFile(join(world.profileDir, 'cordis.yml'), '[]\n')
    await writeFile(join(world.profileDir, 'cordis.patch.yml'), 'clobbered\n')

    const pulled = await engine.pull({ mode: 'overwrite' })
    assert.ok(pulled.files > 0)
    assert.ok(pulled.backedUpTo !== null, 'a restore point was written before overwriting')

    const restored = await readFile(join(world.profileDir, 'cordis.yml'), 'utf8')
    assert.match(restored, /# edited/)
    const patch = await readFile(join(world.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /web-search/)

    const points = await listRestorePoints(join(world.config.stateDir, 'backups'))
    assert.ok(points.length >= 1)
    assert.ok(points.some((point) => point.label === 'snapshot'))
  })

  it('reports the remote preview without touching this machine', async () => {
    const preview = await engine.remotePreview()
    assert.equal(preview.exists, true)
    assert.ok(preview.files.profile.includes('profile/package.json'))
    assert.ok(preview.files.skills.length >= 2)
  })

  it('refuses to pull from an empty remote with an actionable error', async () => {
    await state.writeUserConfig({ branch: 'does-not-exist' })
    await assert.rejects(
      () => engine.pull({}),
      (error) => error.code === 'remote-empty' || error.code === 'fetch-failed',
    )
    await state.writeUserConfig({ branch: 'main' })
  })

  it('survives a restore when the skills roots differ', async () => {
    await rm(join(world.agentsHome, 'skills', 'flat-skill'), { recursive: true, force: true })
    const result = await restoreSnapshot({
      workTree: join(world.config.stateDir, 'mirror'),
      config: world.config,
      mode: 'merge-skills',
      backupsDir: join(world.config.stateDir, 'backups'),
    })
    assert.ok(result.files > 0)
    const restored = await stat(join(world.agentsHome, 'skills', 'flat-skill', 'SKILL.md'))
    assert.ok(restored.isFile())
  })

  it('creates a restore point and can roll back to it', async () => {
    await writeFile(join(world.profileDir, 'cordis.yml'), '[]\n# keep me\n')
    const points = await engine.recoveries()
    assert.ok(points.items.length >= 1)
    const target = points.items[0]
    await writeFile(join(world.profileDir, 'cordis.yml'), '[]\n# lost\n')
    await engine.recover(target.id)
    const after = await readFile(join(world.profileDir, 'cordis.yml'), 'utf8')
    // The newest restore point was written before the previous pull; either way
    // the file exists and is not the clobbered value.
    assert.ok(!after.includes('# lost'))
  })
})

describe('restore point layout', () => {
  it('keeps restore points outside the snapshot tree', async () => {
    const world = await buildWorld()
    try {
      const stateDir = world.config.stateDir
      await mkdir(join(stateDir, 'backups'), { recursive: true })
      const state = new StateStore(stateDir)
      await state.writeUserConfig({ repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com' })
      const engine = new SyncEngine({ config: world.config, state })
      await engine.push({})
      const points = await readdir(join(stateDir, 'backups'))
      assert.ok(Array.isArray(points))
      const mirror = await readdir(join(stateDir, 'mirror'))
      assert.ok(mirror.includes('.git'))
      assert.ok(!mirror.includes('backups'))
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })
})

describe('destructive push guard', () => {
  it('refuses to replace a good snapshot with an empty one', async () => {
    const world = await buildWorld()
    try {
      const state = new StateStore(world.config.stateDir)
      await state.writeUserConfig({ repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com' })
      const engine = new SyncEngine({ config: world.config, state })
      const first = await engine.push({})
      assert.equal(first.pushed, true)

      // A mis-resolved home: same state directory, roots that hold nothing.
      const emptyRoot = join(world.root, 'empty-home')
      await mkdir(emptyRoot, { recursive: true })
      const misresolved = resolveConfig({ stateDir: world.config.stateDir }, {
        HOME: emptyRoot,
        DSH_HOME: join(emptyRoot, '.dsh'),
        DSH_AGENTS_HOME: join(emptyRoot, '.agents'),
        DSH_PROFILE_DIR: join(emptyRoot, '.dsh', 'profiles', 'desktop'),
      })
      const broken = new SyncEngine({ config: misresolved, state })
      await assert.rejects(() => broken.push({}), (error) => error.code === 'nothing-collected')

      // The remote is untouched.
      const listing = await git(world.remoteDir, 'ls-tree', '-r', '--name-only', 'main')
      assert.match(listing, /profile\/package\.json/)
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })
})

describe('secret redaction', () => {
  it('replaces live credential values but keeps the configuration shape', async () => {
    const world = await buildWorld()
    try {
      await writeFile(
        join(world.profileDir, 'cordis.patch.yml'),
        [
          '- id: web-search',
          '  config:',
          '    apiKey: sk-test-fixture-not-a-real-key-0001',
          '- id: llm',
          '  config:',
          '    apiKeyEnv: MINIMAX_CN_API_KEY',
          '    baseUrl: https://api.example.com/v1',
          '    streaming: true',
          '',
        ].join('\n'),
      )
      const state = new StateStore(world.config.stateDir)
      await state.writeUserConfig({
        repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com', redactSecrets: true,
      })
      const engine = new SyncEngine({ config: world.config, state })
      await engine.push({})

      const mirrored = await readFile(
        join(world.config.stateDir, 'mirror', 'profile', 'cordis.patch.yml'),
        'utf8',
      )
      assert.ok(!mirrored.includes('sk-test-fixture-not-a-real-key-0001'), 'the live key is not in the snapshot')
      assert.match(mirrored, /apiKey: <redacted by dsh-settings-sync>/)
      // Non-secrets survive verbatim, so the snapshot still describes the config.
      assert.match(mirrored, /apiKeyEnv: MINIMAX_CN_API_KEY/)
      assert.match(mirrored, /baseUrl: https:\/\/api\.example\.com\/v1/)
      assert.match(mirrored, /streaming: true/)
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })

  it('keeps values verbatim when redaction is off', async () => {
    const world = await buildWorld()
    try {
      await writeFile(join(world.profileDir, 'cordis.patch.yml'), 'apiKey: sk-abcdef1234567890\n')
      const state = new StateStore(world.config.stateDir)
      await state.writeUserConfig({
        repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com', redactSecrets: false,
      })
      const engine = new SyncEngine({ config: world.config, state })
      await engine.push({})
      const mirrored = await readFile(
        join(world.config.stateDir, 'mirror', 'profile', 'cordis.patch.yml'),
        'utf8',
      )
      assert.match(mirrored, /sk-abcdef1234567890/)
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })
})

describe('profile resolution precedence', () => {
  it('prefers the Host-supplied profile facts over the environment', () => {
    const config = resolveConfig({}, { HOME: '/home/x', DSH_PROFILE_DIR: '/env/profile' }, {
      profileDir: '/host/profile',
      dshHome: '/host/.dsh',
    })
    assert.equal(config.profileDir, '/host/profile')
    assert.equal(config.dshHome, '/host/.dsh')
  })

  it('falls back to DSH_PROFILE_DIR when the Host supplies nothing', () => {
    const config = resolveConfig({}, { HOME: '/home/x', DSH_PROFILE_DIR: '/env/profile' })
    assert.equal(config.profileDir, '/env/profile')
  })

  it('never resolves to a bare "default" profile that does not exist', () => {
    // Desktop exports no profile environment at all; the old fallback produced
    // `~/.dsh/profiles/default`, which silently snapshots the wrong tree.
    const config = resolveConfig({}, { HOME: '/home/x' })
    assert.notEqual(config.profileDir, '/home/x/.dsh/profiles/default')
    assert.match(config.profileDir, /profiles\/desktop$/)
  })
})

describe('redaction is one-way', () => {
  it('never writes a placeholder over a live local secret', async () => {
    const world = await buildWorld()
    try {
      const live = 'sk-live-secret-value-1234567890'
      const patchPath = join(world.profileDir, 'cordis.patch.yml')
      await writeFile(patchPath, `- id: web-search\n  config:\n    apiKey: ${live}\n    model: x\n`)

      const state = new StateStore(world.config.stateDir)
      await state.writeUserConfig({ repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com' })
      const engine = new SyncEngine({ config: world.config, state })
      await engine.push({})

      // The remote copy is redacted…
      const mirrored = await readFile(join(state.stateDir, 'mirror', 'profile', 'cordis.patch.yml'), 'utf8')
      assert.ok(!mirrored.includes(live))

      // …so a pull must keep the machine's real value rather than copy it back.
      const pulled = await engine.pull({ mode: 'overwrite' })
      assert.ok(pulled.preserved >= 1, 'the restore reports that it kept a local secret')

      const after = await readFile(patchPath, 'utf8')
      assert.ok(after.includes(live), 'the live key survived the pull')
      assert.ok(!after.includes('<redacted by dsh-settings-sync>'), 'no placeholder was written locally')
      // Non-secret lines still come from the snapshot.
      assert.match(after, /model: x/)
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })

  it('writes the placeholder onto a machine that has no value yet', async () => {
    const world = await buildWorld()
    try {
      await writeFile(
        join(world.profileDir, 'cordis.patch.yml'),
        '- id: web-search\n  config:\n    apiKey: sk-live-secret-value-1234567890\n',
      )
      const state = new StateStore(world.config.stateDir)
      await state.writeUserConfig({ repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com' })
      const engine = new SyncEngine({ config: world.config, state })
      await engine.push({})

      // Simulate a second machine: same state, different profile directory.
      const otherRoot = join(world.root, 'other-home')
      await mkdir(join(otherRoot, '.dsh', 'profiles', 'desktop'), { recursive: true })
      const otherConfig = resolveConfig({ stateDir: world.config.stateDir }, {
        HOME: otherRoot,
        DSH_HOME: join(otherRoot, '.dsh'),
        DSH_AGENTS_HOME: join(otherRoot, '.agents'),
        DSH_PROFILE_DIR: join(otherRoot, '.dsh', 'profiles', 'desktop'),
      })
      const otherEngine = new SyncEngine({ config: otherConfig, state })
      await otherEngine.pull({ mode: 'overwrite' })

      const restored = await readFile(join(otherConfig.profileDir, 'cordis.patch.yml'), 'utf8')
      // A fresh machine gets the placeholder, which tells the user a key is owed.
      assert.match(restored, /<redacted by dsh-settings-sync>/)
      // And the skills came across, proving the pull itself worked.
      assert.ok(await stat(join(otherRoot, '.agents', 'skills', 'flat-skill', 'SKILL.md')).then(() => true))
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })
})

describe('cross-machine profile manifest merge', () => {
  it('keeps local path specs and drops uninstalled bundles', async () => {
    const { mergeManifest } = await import('../lib/manifest.js')
    const incoming = {
      name: 'dsh-profile-desktop',
      dependencies: {
        'dsh-godot-live': 'link:/Users/gzp/Github/dsh-godot-live', // macOS-only path
        'dsh-chrome-use': '0.4.1',                                  // portable
        dshmarket: '^1.73.8',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-chrome-use', 'dsh-godot-live'] } },
    }
    const local = {
      name: 'dsh-profile-web',
      dependencies: {
        'dsh-gongfeng-mr': 'link:/data/home/elfguan/Work/dsh-gongfeng-mr', // Linux-only path
        'dsh-settings-sync': 'github:elfgzp/dsh-settings-sync',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-gongfeng-mr'] } },
    }
    const merged = mergeManifest({
      incoming,
      local,
      installed: ['dsh-gongfeng-mr', 'dsh-settings-sync', 'dsh-chrome-use'],
    })

    // Local paths survive verbatim: they are the specs that resolve here.
    assert.equal(merged.manifest.dependencies['dsh-gongfeng-mr'], 'link:/data/home/elfguan/Work/dsh-gongfeng-mr')
    // The remote's path spec never lands on this machine.
    assert.equal(merged.manifest.dependencies['dsh-godot-live'], undefined)
    // Portable specs come from the snapshot.
    assert.equal(merged.manifest.dependencies['dsh-chrome-use'], '0.4.1')
    // A local-only dependency is kept so it is not silently uninstalled.
    assert.equal(merged.manifest.dependencies['dsh-settings-sync'], 'github:elfgzp/dsh-settings-sync')
    // The local profile name wins.
    assert.equal(merged.manifest.name, 'dsh-profile-web')

    const bundles = merged.manifest.dsh.profile.bundles
    assert.ok(bundles.includes('dsh-chrome-use'))
    assert.ok(bundles.includes('dsh-gongfeng-mr'), 'an installed local bundle is kept')
    assert.ok(!bundles.includes('dsh-godot-live'), 'an uninstalled bundle is skipped')
    assert.ok(merged.notes.some((note) => note.includes('dsh-godot-live')))
  })

  it('drops path specs onto a genuinely fresh machine', async () => {
    const { mergeManifest } = await import('../lib/manifest.js')
    const merged = mergeManifest({
      incoming: {
        dependencies: { a: 'link:/other/machine/a', b: '^1.0.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'a', 'b'] } },
      },
      local: undefined,
      // Nothing installed yet on a fresh machine beyond the in-box bundles.
      installed: [],
    })
    // The path spec is dropped; the portable one is recorded so a later
    // `pnpm install` would fetch it.
    assert.equal(merged.manifest.dependencies.a, undefined)
    assert.equal(merged.manifest.dependencies.b, '^1.0.0')
    // But neither bundle is enabled: `a` is a foreign path and `b` is not on disk
    // yet, and a bundle whose package is missing cannot activate.
    assert.deepEqual(merged.manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
  })

  it('a real pull over a foreign profile never breaks bundle resolution', async () => {
    const world = await buildWorld()
    try {
      // Pretend the snapshot came from another machine: absolute paths that do
      // not exist here, plus a plugin this machine does not have.
      await writeFile(join(world.profileDir, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-desktop',
        dependencies: {
          'dsh-settings-sync': 'link:/Users/gzp/Work/Github/dsh-settings-sync',
          'dsh-chrome-use': '0.4.1',
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-settings-sync', 'dsh-chrome-use'] } },
      }, null, 2)}\n`)
      const state = new StateStore(world.config.stateDir)
      await state.writeUserConfig({ repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com' })
      const engine = new SyncEngine({ config: world.config, state })
      await engine.push({})

      // Local machine has its own plugin and no dsh-chrome-use.
      await mkdir(join(world.profileDir, 'node_modules', 'dsh-gongfeng-mr'), { recursive: true })
      await writeFile(join(world.profileDir, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-web',
        dependencies: { 'dsh-gongfeng-mr': 'link:/data/home/elfguan/Work/dsh-gongfeng-mr' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-gongfeng-mr'] } },
      }, null, 2)}\n`)

      await engine.pull({ mode: 'overwrite' })
      const after = JSON.parse(await readFile(join(world.profileDir, 'package.json'), 'utf8'))

      assert.equal(after.name, 'dsh-profile-web')
      assert.equal(after.dependencies['dsh-gongfeng-mr'], 'link:/data/home/elfguan/Work/dsh-gongfeng-mr')
      // A restore keeps a portable, declared bundle even before pnpm install
      // runs — the caller installs it immediately after the merge.
      assert.ok(after.dependencies['dsh-chrome-use'] === '0.4.1', 'portable dependency was merged')
      assert.ok(after.dsh.profile.bundles.includes('dsh-chrome-use'), 'declared portable bundle was kept for install')
      assert.ok(after.dsh.profile.bundles.includes('dsh-gongfeng-mr'))
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })
})

describe('portable plugin sources (the cross-machine root cause)', () => {
  it('turns a link: git working tree into an installable spec', async () => {
    const { resolveDependencySpec, portableSpecFromRemote, isPathSpec } = await import('../lib/plugins.js')
    assert.equal(isPathSpec('link:/Users/gzp/Work/x'), true)
    assert.equal(isPathSpec('github:elfgzp/x'), false)
    assert.equal(portableSpecFromRemote('https://github.com/elfgzp/dsh-llm-minimax.git'), 'github:elfgzp/dsh-llm-minimax')
    assert.equal(
      portableSpecFromRemote('git@git.woa.com:elfguan/dsh-devops-pipeline.git'),
      'git+ssh://git@git.woa.com/elfguan/dsh-devops-pipeline.git',
    )
    // A directory that is not a git repo stays local.
    const local = await resolveDependencySpec('x', 'link:/nonexistent/path', '/tmp')
    assert.equal(local.portable, false)
    assert.equal(local.source, 'local-only')
  })

  it('materialize rewrites link: sources into git URLs in the snapshot', async () => {
    const world = await buildWorld()
    try {
      // A fake "source repo" with an origin, linked from the profile.
      const pluginDir = join(world.root, 'my-plugin')
      await mkdir(pluginDir, { recursive: true })
      await writeFile(join(pluginDir, 'package.json'), '{"name":"my-plugin","version":"1.0.0"}\n')
      await git(pluginDir, 'init', '-q')
      await git(pluginDir, 'remote', 'add', 'origin', 'https://github.com/elfgzp/my-plugin.git')

      const manifest = JSON.parse(await readFile(join(world.profileDir, 'package.json'), 'utf8'))
      manifest.dependencies['my-plugin'] = `link:${pluginDir}`
      await writeFile(join(world.profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

      const plan = await collectSnapshot(world.config)
      const scratch = join(world.root, 'mirror')
      const applied = await materialize(scratch, plan, { profileDir: world.profileDir })
      assert.ok(applied.portable >= 1, 'at least one spec was made portable')

      const snapshot = JSON.parse(await readFile(join(scratch, 'profile', 'package.json'), 'utf8'))
      assert.ok(!String(snapshot.dependencies['my-plugin']).includes(world.root), 'no absolute source-machine path in the snapshot')
      assert.equal(snapshot.dependencies['my-plugin'], 'github:elfgzp/my-plugin')
      // The real profile file is untouched.
      const real = JSON.parse(await readFile(join(world.profileDir, 'package.json'), 'utf8'))
      assert.equal(real.dependencies['my-plugin'], `link:${pluginDir}`)
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })

  it('the merged manifest keeps portable plugins and filters only the truly local', async () => {
    const { mergeManifest } = await import('../lib/manifest.js')
    const incoming = {
      name: 'dsh-profile-desktop',
      dependencies: {
        'dsh-llm-minimax': 'github:elfgzp/dsh-llm-minimax',
        'dsh-devops-pipeline': 'git+ssh://git@git.woa.com/elfguan/dsh-devops-pipeline.git',
        '@local/dsh-mcp-intranet': 'link:/Users/gzp/.local/share/dsh-bundles/mcp-intranet',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-llm-minimax', 'dsh-devops-pipeline'] } },
    }
    const local = {
      name: 'dsh-profile-web',
      dependencies: { 'dsh-gongfeng-mr': 'link:/data/home/elfguan/Work/dsh-gongfeng-mr' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-gongfeng-mr'] } },
    }
    // The target machine has just installed the portable deps.
    const merged = mergeManifest({
      incoming, local,
      installed: ['dsh-llm-minimax', 'dsh-devops-pipeline', 'dsh-gongfeng-mr'],
    })
    assert.equal(merged.manifest.dependencies['dsh-llm-minimax'], 'github:elfgzp/dsh-llm-minimax')
    assert.equal(merged.manifest.dependencies['dsh-gongfeng-mr'], 'link:/data/home/elfguan/Work/dsh-gongfeng-mr')
    // The no-git local bundle is not expected to resolve here.
    assert.equal(merged.manifest.dependencies['@local/dsh-mcp-intranet'], undefined)
    assert.ok(merged.manifest.dsh.profile.bundles.includes('dsh-llm-minimax'))
    assert.ok(merged.manifest.dsh.profile.bundles.includes('dsh-devops-pipeline'))
    assert.ok(merged.manifest.dsh.profile.bundles.includes('dsh-gongfeng-mr'))
  })
})

describe('automatic plugin install', () => {
  it('finds pnpm next to the running node', async () => {
    const { resolvePnpm } = await import('../lib/install.js')
    const pnpm = resolvePnpm(undefined)
    assert.ok(pnpm !== null, 'a pnpm invocation was found on this machine')
    assert.equal(typeof pnpm.command, 'string')
    // Prefer an absolute path over a bare PATH lookup when possible.
    assert.ok(pnpm.command.length > 0)
  })

  it('honours a DSH-provided packageManager invocation', async () => {
    const { resolvePnpm } = await import('../lib/install.js')
    const pnpm = resolvePnpm({
      packageManager: { command: '/custom/pnpm.mjs', args: ['--config.foo=1'], env: { FOO: 'bar' } },
    })
    assert.equal(pnpm.command, '/custom/pnpm.mjs')
    assert.deepEqual(pnpm.prefixArgs, ['--config.foo=1'])
    assert.equal(pnpm.env.FOO, 'bar')
  })

  it('pull attempts to install declared plugins when autoInstall is on', async () => {
    const world = await buildWorld()
    try {
      // A tiny installable package with no build script, served from a local
      // directory so the test never touches the network. `file:` is a local
      // spec by design (it names a path on one machine), so it is kept in the
      // merged dependencies but not enabled as a bundle — what this test checks
      // is that the install step actually runs and is reported.
      const pluginDir = join(world.root, 'tiny-plugin')
      await mkdir(pluginDir, { recursive: true })
      await writeFile(join(pluginDir, 'package.json'), `${JSON.stringify({
        name: 'tiny-plugin', version: '1.0.0', private: true,
      }, null, 2)}\n`)
      await writeFile(join(world.profileDir, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-test',
        dependencies: { 'tiny-plugin': `file:${pluginDir}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'tiny-plugin'] } },
      }, null, 2)}\n`)
      await writeFile(join(world.profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')

      const state = new StateStore(world.config.stateDir)
      await state.writeUserConfig({ repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com' })
      const engine = new SyncEngine({ config: world.config, state })
      await engine.push({})

      const pulled = await engine.pull({ mode: 'overwrite' })
      assert.ok(pulled.install !== null, 'the pull reports an install attempt')
      assert.equal(typeof pulled.install.ok, 'boolean')
      // A restore point and the merged dependency survive regardless of whether
      // pnpm happens to be available in this sandbox.
      assert.ok(pulled.backedUpTo !== null)
      const after = JSON.parse(await readFile(join(world.profileDir, 'package.json'), 'utf8'))
      assert.equal(after.dependencies['tiny-plugin'], `file:${pluginDir}`)
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })
})

describe('local installs are never replaced by remote URLs', () => {
  it('a local file: spec wins over the remote git URL for the same package', async () => {
    const { mergeManifest } = await import('../lib/manifest.js')
    const merged = mergeManifest({
      incoming: {
        name: 'dsh-profile-desktop',
        dependencies: { 'dsh-llm-tencent-intranet': 'https://cnb.woa.com/fishen/dsh-llm-tencent-intranet' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-llm-tencent-intranet'] } },
      },
      local: {
        name: 'dsh-profile-web',
        dependencies: { 'dsh-llm-tencent-intranet': 'file:/data/home/elfguan/.dsh-plugin-pkgs/x.tgz' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-llm-tencent-intranet'] } },
      },
      installed: ['dsh-llm-tencent-intranet'],
    })
    assert.equal(
      merged.manifest.dependencies['dsh-llm-tencent-intranet'],
      'file:/data/home/elfguan/.dsh-plugin-pkgs/x.tgz',
      'the working local tgz is kept, not the auth-requiring remote URL',
    )
  })

  it('remote portable plugins still fill gaps this machine does not have', async () => {
    const { mergeManifest } = await import('../lib/manifest.js')
    const merged = mergeManifest({
      incoming: {
        dependencies: { 'dsh-llm-minimax': 'github:elfgzp/dsh-llm-minimax' },
        dsh: { profile: { bundles: ['dsh-llm-minimax'] } },
      },
      local: { dependencies: {}, dsh: { profile: { bundles: [] } } },
      installed: [],
    })
    assert.equal(merged.manifest.dependencies['dsh-llm-minimax'], 'github:elfgzp/dsh-llm-minimax')
    assert.ok(merged.manifest.dsh.profile.bundles.includes('dsh-llm-minimax'))
  })
})
