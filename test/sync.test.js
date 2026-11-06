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
import { activeBundles, mergeManifest, missingBundles } from '../lib/manifest.js'
import { collectSnapshot, hostProvidedBundles, listRestorePoints, materialize, restoreSnapshot } from '../lib/snapshot.js'
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

describe('destructive pull guard', () => {
  /**
   * Build a world where the remote holds a *small* snapshot and this machine has
   * a *large* one — the exact shape that used to silently wipe a main machine
   * after a push from a fresh laptop.
   *
   * The far side is produced by a second, deliberately sparse profile: it pushes
   * first, so the remote really is "the other machine's settings" rather than a
   * hand-made tree, and the guard is exercised against a genuine remote branch.
   *
   * @returns {Promise<{world: object, engine: any, sparseFiles: string[], fullFiles: string[], remoteTree: string}>} Fixture.
   */
  async function buildLopsidedWorld() {
    const world = await buildWorld()
    const state = new StateStore(world.config.stateDir)
    await state.writeUserConfig({ repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com' })

    // --- the sparse machine pushes first ---
    const sparseRoot = await mkdtemp(join(tmpdir(), 'settings-sync-sparse-'))
    const sparseDshHome = join(sparseRoot, '.dsh')
    const sparseAgents = join(sparseRoot, '.agents')
    const sparseProfile = join(sparseDshHome, 'profiles', 'desktop')
    await mkdir(sparseProfile, { recursive: true })
    await mkdir(join(sparseAgents, 'skills'), { recursive: true })
    await writeFile(join(sparseProfile, 'cordis.yml'), '[]\n')
    const sparseConfig = resolveConfig({ stateDir: world.config.stateDir }, {
      HOME: sparseRoot,
      DSH_HOME: sparseDshHome,
      DSH_AGENTS_HOME: sparseAgents,
      DSH_PROFILE_DIR: sparseProfile,
    })

    // --- this machine: many extra settings the other machine does not have ---
    // The guard's floor is max(8, 50%), so a fixture with a handful of files could
    // never trip it. These are ordinary managed files: per-plugin state under
    // `~/.dsh/gongfeng-mr/` and extra skills under the shared agents root.
    const extras = []
    for (let index = 0; index < 14; index += 1) {
      const name = `extra-${String(index).padStart(2, '0')}.json`
      await writeFile(join(world.dshHome, 'gongfeng-mr', name), `${JSON.stringify({ index })}\n`)
      extras.push(`homes/dsh/gongfeng-mr/${name}`)
    }
    for (let index = 0; index < 6; index += 1) {
      const name = `local-skill-${String(index).padStart(2, '0')}`
      await mkdir(join(world.agentsHome, 'skills', name), { recursive: true })
      await writeFile(
        join(world.agentsHome, 'skills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Local only.\n---\n`,
      )
      extras.push(`homes/agents/skills/${name}/SKILL.md`)
    }

    try {
      const sparseEngine = new SyncEngine({ config: sparseConfig, state })
      const pushed = await sparseEngine.push({})
      assert.equal(pushed.pushed, true)

      // Snapshot paths the remote carries. `manifest.json` lives at the tree root
      // and is not a managed path (it has no prefix), so `listSnapshotFiles` —
      // and therefore the guard — never sees it. Filter the same way here.
      const remoteTree = await git(world.remoteDir, 'ls-tree', '-r', '--name-only', 'main')
      const sparseFiles = remoteTree
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && line !== 'manifest.json')

      // --- this machine has everything from buildWorld() plus the extras ---
      const engine = new SyncEngine({ config: world.config, state })
      const plan = await engine.lastPlan()
      const fullFiles = plan.files.map((file) => file.target)

      return { world, engine, sparseFiles, fullFiles, remoteTree, extras, sparseRoot }
    } catch (error) {
      await rm(sparseRoot, { recursive: true, force: true })
      await rm(world.root, { recursive: true, force: true })
      throw error
    }
  }

  it('refuses an overwrite pull that would delete most local files, and deletes nothing', async () => {
    const fixture = await buildLopsidedWorld()
    const { world, engine, sparseFiles, fullFiles } = fixture
    try {
      assert.ok(sparseFiles.length > 0, 'the sparse machine really pushed something')
      assert.ok(
        fullFiles.length > sparseFiles.length,
        `fixture must be lopsided (local ${fullFiles.length} vs remote ${sparseFiles.length})`,
      )

      // Prediction: every local target the remote does not carry would be deleted.
      const incoming = new Set(sparseFiles)
      const wouldDelete = fullFiles.filter((target) => !incoming.has(target))
      assert.ok(
        wouldDelete.length > Math.max(8, fullFiles.length * 0.5),
        `fixture must trip the threshold (${wouldDelete.length} of ${fullFiles.length})`,
      )

      // Capture every local file's bytes BEFORE the refused pull: `source` is the
      // absolute path on this machine, `target` is the snapshot-relative one.
      const localBefore = new Map()
      for (const file of (await engine.lastPlan()).files) {
        localBefore.set(file.target, { source: file.source, bytes: await readFile(file.source) })
      }
      assert.ok(localBefore.size > 0, 'captured local file contents')

      await assert.rejects(
        () => engine.pull({ mode: 'overwrite' }),
        (error) => {
          assert.equal(error.code, 'mass-deletion-on-pull')
          assert.equal(error.name, 'SyncError')
          // The message must quantify the damage and name the escape hatch.
          assert.match(error.message, /删除本机 \d+ 个设置文件/)
          assert.match(error.message, /强制恢复/)
          return true
        },
      )

      // KEY ASSERTION: a refused pull deletes nothing and rewrites nothing.
      for (const [target, { source, bytes }] of localBefore) {
        await assert.doesNotReject(
          () => stat(source),
          `local file was deleted by a refused pull: ${target}`,
        )
        const after = await readFile(source)
        assert.deepEqual(after, bytes, `local file changed by a refused pull: ${target}`)
      }

      // The remote is untouched too: a refused pull never pushes.
      const remoteAfter = await git(world.remoteDir, 'ls-tree', '-r', '--name-only', 'main')
      assert.equal(remoteAfter, fixture.remoteTree)
    } finally {
      await rm(world.root, { recursive: true, force: true })
      await rm(fixture.sparseRoot, { recursive: true, force: true })
    }
  })

  it('applies the same overwrite pull when force is set, deleting the extra files', async () => {
    const fixture = await buildLopsidedWorld()
    const { world, engine, sparseFiles, fullFiles } = fixture
    try {
      const incoming = new Set(sparseFiles)
      const expectedDeletions = fullFiles.filter((target) => !incoming.has(target))
      assert.ok(expectedDeletions.length > 0)

      const result = await engine.pull({ mode: 'overwrite', force: true })
      assert.ok(result.files > 0, 'the remote files were written')
      assert.equal(
        result.removed,
        expectedDeletions.length,
        'force mode deleted exactly the files the guard predicted',
      )
      assert.ok(result.backedUpTo !== null, 'a restore point was still written before overwriting')

      // The files the remote carried are the ones that survived.
      const remaining = (await engine.lastPlan()).files.map((file) => file.target)
      for (const path of sparseFiles) {
        assert.ok(remaining.includes(path), `remote file was not restored: ${path}`)
      }
      assert.ok(
        remaining.length < fullFiles.length,
        'force mode really shrank the local tree',
      )
    } finally {
      await rm(world.root, { recursive: true, force: true })
      await rm(fixture.sparseRoot, { recursive: true, force: true })
    }
  })

  it('never deletes in merge-skills mode, so the guard does not apply', async () => {
    const fixture = await buildLopsidedWorld()
    const { world, engine, sparseFiles, fullFiles } = fixture
    try {
      const incoming = new Set(sparseFiles)
      const localOnly = fullFiles.filter((target) => !incoming.has(target))
      assert.ok(localOnly.length > 0, 'the fixture has local-only files')

      // No force, and the same lopsided shape the overwrite guard rejects.
      const result = await engine.pull({ mode: 'merge-skills' })
      assert.equal(result.removed, 0, 'merge-skills must never delete')

      const remaining = (await engine.lastPlan()).files.map((file) => file.target)
      for (const path of localOnly) {
        assert.ok(remaining.includes(path), `merge-skills deleted a local-only file: ${path}`)
      }
      // And the remote's files landed too: it is a union, not a no-op.
      for (const path of sparseFiles) {
        assert.ok(remaining.includes(path), `merge-skills did not write ${path}`)
      }
    } finally {
      await rm(world.root, { recursive: true, force: true })
      await rm(fixture.sparseRoot, { recursive: true, force: true })
    }
  })

  it('does not trip on an ordinary pull with a couple of deletions', async () => {
    const world = await buildWorld()
    try {
      const state = new StateStore(world.config.stateDir)
      await state.writeUserConfig({ repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com' })
      const engine = new SyncEngine({ config: world.config, state })
      await engine.push({})

      // Add two local-only files: well under the max(8, 50%) floor.
      await writeFile(join(world.dshHome, 'gongfeng-mr', 'extra-a.json'), '{"a":1}\n')
      await writeFile(join(world.dshHome, 'gongfeng-mr', 'extra-b.json'), '{"b":2}\n')

      const result = await engine.pull({ mode: 'overwrite' })
      assert.equal(result.removed, 2, 'a small, deliberate deletion still goes through')
      assert.ok(result.files > 0)
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

describe('non-directory path specs never reach git', () => {
  /** Build a scratch dir with a real tarball-shaped file in it. */
  async function buildScratch() {
    const root = await mkdtemp(join(tmpdir(), 'tgz-'))
    const profileDir = join(root, 'profile')
    await mkdir(profileDir, { recursive: true })
    const tarball = join(root, 'plugin-1.0.0.tgz')
    await writeFile(tarball, 'not really a tarball, but a regular file\n')
    const repoDir = join(root, 'repo')
    await mkdir(repoDir, { recursive: true })
    await writeFile(join(repoDir, 'package.json'), '{"name":"repo-pkg","version":"1.0.0"}\n')
    await git(repoDir, 'init', '-q')
    await git(repoDir, 'remote', 'add', 'origin', 'https://github.com/elfgzp/repo-pkg.git')
    return { root, profileDir, tarball, repoDir }
  }

  it('treats a file: tarball as local-only instead of spawning git in it', async () => {
    // The devcloud crash: `file:` names a packed artifact, not a working tree.
    // `execFile` with that file as `cwd` throws ENOTDIR **synchronously**, so the
    // child-process error callback never runs and the throw escapes the helper.
    const scratch = await buildScratch()
    try {
      const { resolveDependencySpec } = await import('../lib/plugins.js')
      const outcome = await resolveDependencySpec('dsh-x', `file:${scratch.tarball}`, scratch.profileDir)
      assert.equal(outcome.portable, false)
      assert.equal(outcome.source, 'local-only')
      // The original spec is preserved verbatim: it still installs here.
      assert.equal(outcome.spec, `file:${scratch.tarball}`)
    } finally {
      await rm(scratch.root, { recursive: true, force: true })
    }
  })

  it('treats a tarball spec as local-only through makePortableManifest', async () => {
    const scratch = await buildScratch()
    try {
      const { makePortableManifest } = await import('../lib/plugins.js')
      const result = await makePortableManifest({
        profileDir: scratch.profileDir,
        manifest: { name: 'p', dependencies: { 'dsh-x': `file:${scratch.tarball}` } },
      })
      assert.deepEqual(result.localOnly, ['dsh-x'])
      assert.deepEqual(result.resolved, {}, 'a tarball is never reported as resolved to a URL')
      // Untouched in the snapshot: the machine that has the file can still build.
      assert.equal(result.manifest.dependencies['dsh-x'], `file:${scratch.tarball}`)
    } finally {
      await rm(scratch.root, { recursive: true, force: true })
    }
  })

  it('treats a path that does not exist as local-only without throwing', async () => {
    const scratch = await buildScratch()
    try {
      const { resolveDependencySpec } = await import('../lib/plugins.js')
      for (const spec of [
        'file:/nonexistent/nope-1.0.0.tgz',
        'link:/nonexistent/directory',
      ]) {
        const outcome = await resolveDependencySpec('dsh-x', spec, scratch.profileDir)
        assert.equal(outcome.portable, false, spec)
        assert.equal(outcome.source, 'local-only', spec)
      }
    } finally {
      await rm(scratch.root, { recursive: true, force: true })
    }
  })

  it('still turns a link: directory with a git remote into an installable URL', async () => {
    // The regression guard: the tarball fix must not disable portability.
    const scratch = await buildScratch()
    try {
      const { resolveDependencySpec, makePortableManifest } = await import('../lib/plugins.js')
      const outcome = await resolveDependencySpec('dsh-repo', `link:${scratch.repoDir}`, scratch.profileDir)
      assert.equal(outcome.portable, true)
      assert.equal(outcome.source, 'git-remote')
      assert.equal(outcome.spec, 'github:elfgzp/repo-pkg')

      // Both kinds side by side in one manifest: each is handled on its own.
      const result = await makePortableManifest({
        profileDir: scratch.profileDir,
        manifest: {
          name: 'p',
          dependencies: {
            'dsh-repo': `link:${scratch.repoDir}`,
            'dsh-x': `file:${scratch.tarball}`,
          },
        },
      })
      assert.deepEqual(result.resolved, { 'dsh-repo': 'github:elfgzp/repo-pkg' })
      assert.deepEqual(result.localOnly, ['dsh-x'])
    } finally {
      await rm(scratch.root, { recursive: true, force: true })
    }
  })
})

describe('portable manifest result shape', () => {
  /**
   * Every `makePortableManifest` return value must carry the same diagnostics.
   *
   * The shape is a contract: `materialize` reads `.resolved` and spreads
   * `.collisions` without checking. An early return that omitted `collisions`
   * turned a legal `package.json` (one with no `dependencies` key) into
   * `TypeError: undefined is not iterable`, which took down the whole push.
   *
   * @param {object} result - A `makePortableManifest` result.
   */
  function assertCompleteShape(result) {
    assert.ok(Array.isArray(result.localOnly), 'localOnly is always an array')
    assert.ok(Array.isArray(result.collisions), 'collisions is always an array')
    assert.ok(result.resolved !== null && typeof result.resolved === 'object', 'resolved is always an object')
    assert.ok(!Array.isArray(result.resolved), 'resolved is a record, not a list')
    assert.ok(result.manifest !== null && typeof result.manifest === 'object', 'manifest is always an object')
    // The exact failure that was reported: spreading undefined.
    assert.doesNotThrow(() => { const sink = []; sink.push(...result.collisions) },
      'collisions is spreadable')
  }

  it('returns a complete shape for a manifest with no dependencies key', async () => {
    const { makePortableManifest } = await import('../lib/plugins.js')
    const result = await makePortableManifest({
      // A fresh or hand-edited profile legitimately has no `dependencies`.
      manifest: { name: 'edgecase-profile', dsh: { profile: { bundles: [] } } },
      profileDir: '/tmp/does-not-need-to-exist',
    })
    assertCompleteShape(result)
    assert.deepEqual(Object.keys(result).sort(), ['collisions', 'localOnly', 'manifest', 'resolved'])
  })

  it('returns a complete shape for null and array dependencies', async () => {
    const { makePortableManifest } = await import('../lib/plugins.js')
    for (const dependencies of [null, [], ['not-an-object'], 'a string', 42]) {
      const result = await makePortableManifest({
        manifest: { name: 'p', dependencies },
        profileDir: '/tmp/x',
      })
      assertCompleteShape(result, JSON.stringify(dependencies))
      assert.deepEqual(result.localOnly, [])
      assert.deepEqual(result.collisions, [])
    }
  })

  it('returns a complete shape on the normal path too', async () => {
    const { makePortableManifest } = await import('../lib/plugins.js')
    const result = await makePortableManifest({
      manifest: { name: 'p', dependencies: { 'dsh-x': 'github:elfgzp/dsh-x' } },
      profileDir: '/tmp/x',
    })
    assertCompleteShape(result)
  })

  it('materialize survives a profile package.json without dependencies', async () => {
    // End-to-end for the reported crash: this used to throw inside `materialize`
    // while writing the snapshot, so a push never completed.
    const root = await mkdtemp(join(tmpdir(), 'nodeps-'))
    try {
      const profileDir = join(root, 'profile')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
        name: 'edgecase-profile',
        dsh: { profile: { bundles: [] } },
      }, null, 2)}\n`)

      const plan = {
        files: [{ source: join(profileDir, 'package.json'), target: 'profile/package.json' }],
        skills: [],
        plugins: [],
        bytes: 0,
        skipped: [],
        dshHomeEntries: [],
      }
      const applied = await materialize(join(root, 'mirror'), plan, { profileDir })
      assert.equal(applied.written, 1)
      assert.ok(Array.isArray(applied.collisions), 'materialize always reports a collisions array')
      assert.deepEqual(applied.collisions, [])
      // The mirror copy exists and is still valid JSON.
      const written = JSON.parse(await readFile(join(root, 'mirror', 'profile', 'package.json'), 'utf8'))
      assert.equal(written.name, 'edgecase-profile')
    } finally {
      await rm(root, { recursive: true, force: true })
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

  it('refuses to turn monorepo subpackages into one shared git URL', async () => {
    // The devcloud startup failure, reproduced: a repo whose root is a private
    // monorepo and whose `packages/*` are the real plugin bundles. Every one of
    // them reports the *same* `git remote get-url origin`, so emitting that URL
    // per package installs the repo root twice — a manifest with no `dsh.bundle`
    // and none of the subpackage files.
    const root = await mkdtemp(join(tmpdir(), 'mono-'))
    try {
      const repoDir = join(root, 'mono-repo')
      for (const name of ['pkg-a', 'pkg-b']) {
        await mkdir(join(repoDir, 'packages', name), { recursive: true })
        await writeFile(join(repoDir, 'packages', name, 'package.json'), `${JSON.stringify({
          name,
          version: '1.0.0',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }, null, 2)}\n`)
      }
      await writeFile(join(repoDir, 'package.json'), `${JSON.stringify({
        name: 'my-monorepo', version: '1.0.0', private: true,
      }, null, 2)}\n`)
      await git(repoDir, 'init', '-q')
      await git(repoDir, 'remote', 'add', 'origin', 'https://github.com/elfgzp/dsh-itfs-workbench.git')

      // A normal standalone repo package: this one MUST still become portable.
      const standalone = join(root, 'standalone')
      await mkdir(standalone, { recursive: true })
      await writeFile(join(standalone, 'package.json'), `${JSON.stringify({
        name: 'standalone-plugin', version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }, null, 2)}\n`)
      await git(standalone, 'init', '-q')
      await git(standalone, 'remote', 'add', 'origin', 'https://github.com/elfgzp/standalone.git')

      const { makePortableManifest } = await import('../lib/plugins.js')
      const outcome = await makePortableManifest({
        profileDir: root,
        manifest: {
          name: 'dsh-profile-test',
          dependencies: {
            'pkg-a': `link:${join(repoDir, 'packages', 'pkg-a')}`,
            'pkg-b': `link:${join(repoDir, 'packages', 'pkg-b')}`,
            'standalone-plugin': `link:${standalone}`,
          },
        },
      })

      // The invariant this whole fix exists for: no two package names may end up
      // pointing at the same install spec.
      const specs = Object.values(outcome.manifest.dependencies)
      const portableSpecs = specs.filter((spec) => !String(spec).startsWith('link:'))
      assert.equal(
        new Set(portableSpecs).size,
        portableSpecs.length,
        `two packages share one spec: ${JSON.stringify(portableSpecs)}`,
      )

      // The subpackages keep their local link (installable only where they live).
      assert.ok(String(outcome.manifest.dependencies['pkg-a']).startsWith('link:'))
      assert.ok(String(outcome.manifest.dependencies['pkg-b']).startsWith('link:'))
      assert.deepEqual(outcome.localOnly.sort(), ['pkg-a', 'pkg-b'])

      // The standalone package is still made portable — the fix must not disable
      // the feature it is repairing.
      assert.equal(outcome.manifest.dependencies['standalone-plugin'], 'github:elfgzp/standalone')
      assert.deepEqual(outcome.resolved, { 'standalone-plugin': 'github:elfgzp/standalone' })
      // Two subpackages of one repo never reach the collision stage, because the
      // subdirectory check already demoted them.
      assert.deepEqual(outcome.collisions, [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('demotes every loser when two distinct packages really do share one URL', async () => {
    // Belt and braces: if two *separate* repos resolve to the same spec (a
    // rewritten remote, a fork, a rewrite rule), shipping that spec twice is
    // still an uninstallable snapshot, so both are demoted and reported.
    const root = await mkdtemp(join(tmpdir(), 'shared-'))
    try {
      const dirs = []
      for (const name of ['alpha', 'beta']) {
        const dir = join(root, name)
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0' })}\n`)
        await git(dir, 'init', '-q')
        await git(dir, 'remote', 'add', 'origin', 'https://github.com/elfgzp/one-repo.git')
        dirs.push(dir)
      }

      const { makePortableManifest } = await import('../lib/plugins.js')
      const outcome = await makePortableManifest({
        profileDir: root,
        manifest: {
          name: 'p',
          dependencies: { alpha: `link:${dirs[0]}`, beta: `link:${dirs[1]}` },
        },
      })

      assert.deepEqual(outcome.collisions, ['github:elfgzp/one-repo'])
      assert.deepEqual(outcome.resolved, {}, 'neither loser is reported as resolved')
      assert.deepEqual(outcome.localOnly.sort(), ['alpha', 'beta'])
      // The original link specs are restored, not left as the shared URL.
      assert.equal(outcome.manifest.dependencies.alpha, `link:${dirs[0]}`)
      assert.equal(outcome.manifest.dependencies.beta, `link:${dirs[1]}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

  it('keeps bundles the Host ships itself even when the profile installs nothing', async () => {
    const { mergeManifest } = await import('../lib/manifest.js')
    const merged = mergeManifest({
      incoming: {
        dependencies: { 'dsh-llm-minimax': 'github:elfgzp/dsh-llm-minimax' },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-forge-bundle', 'dsh-llm-minimax'],
          },
        },
      },
      local: { dependencies: {}, dsh: { profile: { bundles: [] } } },
      installed: [],
      // What `hostProvidedBundles` finds inside the desktop app's archive: a
      // package that is loadable but never appears in the profile's node_modules.
      hostResolvable: ['@deepseek-ai/dsh-experimental-forge-bundle'],
    })
    assert.ok(
      merged.manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-forge-bundle'),
      'a bundle the Host provides is not silently dropped',
    )
    assert.ok(merged.manifest.dsh.profile.bundles.includes('dsh-llm-minimax'))
    assert.deepEqual(merged.droppedBundles, [])
  })
})

describe('host-provided bundle probing', () => {
  it('returns nothing for an empty candidate list without touching the filesystem', async () => {
    assert.deepEqual(await hostProvidedBundles([]), [])
  })

  it('never claims a name the Host cannot resolve', async () => {
    // A name no installation carries. The point of this assertion is the failure
    // mode that caused the devcloud false alarm: an empty answer is benign, a
    // *wrong* answer is not, so an unresolvable name must stay out of the list.
    const resolved = await hostProvidedBundles([
      'dsh-definitely-not-a-real-package-xyzzy',
      '@deepseek-ai/also-not-real-xyzzy',
    ])
    assert.deepEqual(resolved, [])
  })

  it('probes the CLI runtime layout through DSH_RUNTIME_DIR', async () => {
    // Reproduce a CLI host in a scratch directory: `<root>/node_modules/<pkg>`
    // is exactly the layout `~/.dsh-runtime` uses, and Node resolves it the same
    // way. This is the anchor that was missing and produced 22 false positives
    // on a fresh devcloud profile (the desktop app.asar anchor returned []).
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-'))
    const previous = process.env.DSH_RUNTIME_DIR
    try {
      const pkgDir = join(root, 'node_modules', 'host-shipped-bundle')
      await mkdir(pkgDir, { recursive: true })
      await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify({
        name: 'host-shipped-bundle',
        version: '1.0.0',
        main: 'index.js',
      }, null, 2)}\n`)
      await writeFile(join(pkgDir, 'index.js'), 'export const name = "host-shipped-bundle"\n')

      process.env.DSH_RUNTIME_DIR = root
      const resolved = await hostProvidedBundles(['host-shipped-bundle', 'profile-only-bundle'])
      assert.deepEqual(resolved, ['host-shipped-bundle'],
        'a package in the Host runtime is provided; one only the profile could install is not')
    } finally {
      if (previous === undefined) delete process.env.DSH_RUNTIME_DIR
      else process.env.DSH_RUNTIME_DIR = previous
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('automatic plugin install', () => {
  it('resolves before installing so a fetch failure cannot empty the profile', async () => {
    const { installDeclaredPlugins } = await import('../lib/install.js')
    const calls = []
    const result = await installDeclaredPlugins({
      profileDir: '/tmp/profile',
      profileContext: { packageManager: { command: 'pnpm', args: [] } },
      runPnpm: async (args) => {
        calls.push(args)
        return { ok: false, message: '[ERR_PNPM_FETCH_401] GET https://cnb.woa.com/x: Unauthorized - 401' }
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.phase, 'resolve')
    assert.equal(calls.length, 1, 'the real install never started')
    assert.ok(calls[0].includes('--lockfile-only'))
    assert.match(result.message, /401/)
  })

  it('installs only after the resolution preflight succeeds', async () => {
    const { installDeclaredPlugins } = await import('../lib/install.js')
    const calls = []
    const result = await installDeclaredPlugins({
      profileDir: '/tmp/profile',
      profileContext: { packageManager: { command: 'pnpm', args: [] } },
      runPnpm: async (args) => {
        calls.push(args)
        return { ok: true, message: 'Done' }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.phase, 'install')
    assert.equal(calls.length, 2)
    assert.ok(calls[0].includes('--lockfile-only'))
    assert.deepEqual(calls[1], ['install'])
  })

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

describe('uninstalled bundles after a pull', () => {
  /**
   * Give the world a profile that declares one portable plugin bundle, and make
   * sure it is NOT present in `node_modules` — the "restored config, missing
   * package" shape this feature exists for.
   *
   * @param {object} world - A `buildWorld()` result.
   * @returns {Promise<object>} The engine and the bundle name.
   */
  async function declareUninstalledBundle(world) {
    const name = 'ghost-plugin'
    await writeFile(join(world.profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-test',
      dependencies: { [name]: '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', name] } },
    }, null, 2)}\n`)
    const state = new StateStore(world.config.stateDir)
    await state.writeUserConfig({ repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com' })
    const engine = new SyncEngine({ config: world.config, state })
    await engine.push({})
    await rm(join(world.profileDir, 'node_modules'), { recursive: true, force: true })
    return { engine, state }
  }

  it('reports bundles the snapshot declares but this machine never installed', async () => {
    const world = await buildWorld()
    try {
      const { engine, state } = await declareUninstalledBundle(world)
      // autoInstall off: the restore writes package.json, installs nothing.
      await state.writeUserConfig({ autoInstall: false })
      const pulled = await engine.pull({ mode: 'overwrite' })

      assert.deepEqual(pulled.uninstalledBundles, ['ghost-plugin'],
        'the declared-but-absent bundle is reported')
      // The inbox bundles resolve from the dsh installation, so they must never
      // appear here even though node_modules has none of them.
      assert.ok(!pulled.uninstalledBundles.includes('@deepseek-ai/dsh-base'),
        'in-box bundles are not "uninstalled"')
      assert.equal(pulled.installFailed, false, 'user-disabled install is not a failure')
      assert.match(pulled.summary, /1 个插件未安装（重启后会失效）：ghost-plugin/)
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })

  it('reports them when the install itself failed, and carries the reason', async () => {
    const world = await buildWorld()
    try {
      const { state } = await declareUninstalledBundle(world)
      // A packageManager stand-in that always fails, like a 401 from a private
      // registry. No network: /bin/sh exits 1 with a diagnostic on stderr.
      const failing = new SyncEngine({
        config: world.config,
        state,
        profileContext: {
          packageManager: { command: '/bin/sh', args: ['-c', 'echo "ERR_PNPM_FETCH_401 Unauthorized" >&2; exit 1'], env: {} },
        },
      })
      const pulled = await failing.pull({ mode: 'overwrite' })

      assert.deepEqual(pulled.uninstalledBundles, ['ghost-plugin'])
      assert.equal(pulled.installFailed, true, 'a non-zero install is a failure')
      assert.equal(pulled.install.ok, false)
      assert.match(pulled.install.message, /401/)
      assert.match(pulled.summary, /插件安装失败/)
      assert.match(pulled.summary, /插件未安装/)
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })

  it('says nothing when every declared bundle really is installed', async () => {
    const world = await buildWorld()
    try {
      const { engine, state } = await declareUninstalledBundle(world)
      // Put the package on disk, which is the state a successful install leaves.
      const pkgDir = join(world.profileDir, 'node_modules', 'ghost-plugin')
      await mkdir(pkgDir, { recursive: true })
      await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify({ name: 'ghost-plugin', version: '1.0.0' })}\n`)
      // autoInstall off so nothing can remove it again during the pull.
      await state.writeUserConfig({ autoInstall: false })

      const pulled = await engine.pull({ mode: 'overwrite' })
      assert.deepEqual(pulled.uninstalledBundles, [], 'a fully installed profile reports nothing')
      assert.ok(!pulled.summary.includes('未安装'), `no false alarm in summary: ${pulled.summary}`)
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })

  it('missingBundles ignores bundles that were never profile dependencies', () => {
    const inboxOnly = {
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }
    assert.deepEqual(missingBundles(inboxOnly, []), [],
      'in-box bundles resolve from the dsh installation')

    const withDep = {
      dependencies: { 'ghost-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'ghost-plugin'] } },
    }
    assert.deepEqual(missingBundles(withDep, []), ['ghost-plugin'])
    assert.deepEqual(missingBundles(withDep, ['ghost-plugin']), [])
    // Degenerate inputs.
    assert.deepEqual(missingBundles(undefined, []), [])
    assert.deepEqual(missingBundles({ dsh: { profile: { bundles: [] } } }, []), [])
  })

  it('missingBundles excludes packages the Host itself resolves', () => {
    // The exact shape a clean-machine restore produced: the *far* machine's
    // package.json lists a Host-shipped bundle as a dependency, so it passes the
    // "is a dependency" guard while being absent from node_modules. Restarting
    // would have worked fine; reporting it told the user 21 plugins were broken.
    const freshMachine = {
      dependencies: {
        '@deepseek-ai/dsh-experimental-agent-team-profile': '0.2.2-rc.1',
        'dsh-agent-team-playbook': '^1.2.0',
      },
      dsh: { profile: { bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-experimental-agent-team-profile',
        'dsh-agent-team-playbook',
      ] } },
    }
    // Without the Host's answer both look missing...
    assert.deepEqual(
      missingBundles(freshMachine, []),
      ['@deepseek-ai/dsh-experimental-agent-team-profile', 'dsh-agent-team-playbook'],
    )
    // ...with it, only the genuinely uninstallable one remains.
    assert.deepEqual(
      missingBundles(freshMachine, [], ['@deepseek-ai/dsh-experimental-agent-team-profile']),
      ['dsh-agent-team-playbook'],
    )
    // Installed wins over everything, and the Host list cannot resurrect a name
    // the profile does not declare at all.
    assert.deepEqual(missingBundles(freshMachine, ['dsh-agent-team-playbook'], []), [
      '@deepseek-ai/dsh-experimental-agent-team-profile',
    ])
    assert.deepEqual(missingBundles(freshMachine, [], ['something-else']), [
      '@deepseek-ai/dsh-experimental-agent-team-profile',
      'dsh-agent-team-playbook',
    ])
  })

  it('missingBundles keeps working with the old two-argument call', () => {
    // Backward compatibility: `hostResolvable` is optional and defaults to empty,
    // so callers written before it existed behave exactly as they did.
    const manifest = {
      dependencies: { 'dsh-alpha': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-alpha'] } },
    }
    assert.deepEqual(missingBundles(manifest, []), ['dsh-alpha'])
    assert.deepEqual(missingBundles(manifest, []), missingBundles(manifest, [], []))
    assert.deepEqual(missingBundles(manifest, [], ['dsh-alpha']), [])
  })
})

describe('needsRestart detection after a pull', () => {
  /** A fake `pnpm` that "installs" nothing but exits 0, so no network is touched. */
  const NOOP_PM = { command: '/bin/true', args: [], env: {} }

  it('reports needsRestart when a restored bundle becomes loadable', async () => {
    const world = await buildWorld()
    try {
      const state = new StateStore(world.config.stateDir)
      await state.writeUserConfig({ repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com' })

      // The snapshot declares a plugin that is NOT in node_modules on this
      // machine — the "restored config, missing package" case, which is exactly
      // the one that used to leave a plugin silently unloaded.
      await writeFile(join(world.profileDir, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-test',
        dependencies: { 'fresh-plugin': '^1.0.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'fresh-plugin'] } },
      }, null, 2)}\n`)
      const engine = new SyncEngine({ config: world.config, state })
      await engine.push({})
      await rm(join(world.profileDir, 'node_modules'), { recursive: true, force: true })

      // A stand-in for pnpm that only creates the package directory in
      // node_modules — no network, no registry, and deterministic offline.
      // This is what makes "the install made it loadable" observable.
      const fakePm = join(world.root, 'fake-pnpm.mjs')
      await writeFile(fakePm, [
        "import { mkdir, writeFile } from 'node:fs/promises'",
        "import { join } from 'node:path'",
        "const dir = join(process.cwd(), 'node_modules', 'fresh-plugin')",
        "await mkdir(dir, { recursive: true })",
        "await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fresh-plugin', version: '1.0.0' }))",
        "console.log('Done in 1ms')",
        '',
      ].join('\n'))

      const installing = new SyncEngine({
        config: world.config,
        state,
        profileContext: { packageManager: { command: process.execPath, args: [fakePm], env: {} } },
      })

      const pulled = await installing.pull({ mode: 'overwrite' })
      assert.equal(pulled.needsRestart, true, 'a newly loadable bundle requires a restart')
      assert.deepEqual(pulled.newBundles, ['fresh-plugin'])
      // The user-facing summary must say it, not just the boolean.
      assert.match(pulled.summary, /需要重启/)
      assert.match(pulled.summary, /插件已安装/)
    } finally {
      await rm(world.root, { recursive: true, force: true })
    }
  })

  it('activeBundles is the intersection of declared and installed', () => {
    const manifest = {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-alpha', 'dsh-beta'] } },
    }
    // Everything installed.
    assert.deepEqual(activeBundles(manifest, ['@deepseek-ai/dsh-base', 'dsh-alpha', 'dsh-beta', 'unrelated']),
      ['@deepseek-ai/dsh-base', 'dsh-alpha', 'dsh-beta'])
    // dsh-beta declared but absent from node_modules: the launcher cannot compose it.
    assert.deepEqual(activeBundles(manifest, ['@deepseek-ai/dsh-base', 'dsh-alpha']),
      ['@deepseek-ai/dsh-base', 'dsh-alpha'])
    // A machine with nothing installed loads nothing from the profile layer.
    assert.deepEqual(activeBundles(manifest, []), [])
    // Degenerate inputs never throw.
    assert.deepEqual(activeBundles(undefined, ['x']), [])
    assert.deepEqual(activeBundles({ dsh: { profile: {} } }, ['x']), [])
    assert.deepEqual(activeBundles({ dsh: { profile: { bundles: 'not-an-array' } } }, ['x']), [])
  })

  it('a bundle present before and after is not a new one', () => {
    // Mirrors the pull-side diff: only names absent from the "before" set count.
    const before = activeBundles({ dsh: { profile: { bundles: ['a', 'b'] } } }, ['a', 'b'])
    const after = activeBundles({ dsh: { profile: { bundles: ['a', 'b', 'c'] } } }, ['a', 'b', 'c'])
    const known = new Set(before)
    assert.deepEqual(after.filter((name) => !known.has(name)), ['c'])
  })

  it('a pull that installs nothing new reports needsRestart false', async () => {
    const world = await buildWorld()
    try {
      const state = new StateStore(world.config.stateDir)
      await state.writeUserConfig({ repoUrl: world.remoteDir, gitName: 'T', gitEmail: 't@e.com' })
      // No packages installed at all, and no bundle becomes loadable.
      await rm(join(world.profileDir, 'node_modules'), { recursive: true, force: true })

      const engine = new SyncEngine({ config: world.config, state, profileContext: { packageManager: NOOP_PM } })
      await engine.push({})
      const pulled = await engine.pull({ mode: 'overwrite' })
      assert.equal(pulled.needsRestart, false)
      assert.deepEqual(pulled.newBundles, [])
      // The summary must not claim a restart that is not needed.
      assert.ok(!pulled.summary.includes('需要重启'), `unexpected restart note: ${pulled.summary}`)
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
