/**
 * Merging a profile manifest across machines.
 *
 * `package.json` is the one snapshot file that cannot be copied verbatim, because
 * half of it describes *this* machine rather than the user's configuration:
 *
 * ```json
 * "dependencies": {
 *   "dsh-godot-live": "link:/Users/gzp/Github/dsh-godot-live",   // macOS path
 *   "dsh-itfs-workbench": "file:/data/home/elfguan/x.tgz",       // Linux path
 *   "dsh-chrome-use": "0.4.1"                                     // portable
 * }
 * ```
 *
 * Copying the first two onto another machine produces a profile whose every
 * bundle fails to resolve (`cannot resolve profile bundle ...`), which is exactly
 * what happened the first time this was tested across two hosts. Copying nothing
 * loses the user's actual plugin choice.
 *
 * The rule that works is a split by *what the spec means*:
 *
 *   - **Path specs** (`link:`, `file:`, `portal:`, an absolute path) name a
 *     directory on one machine. They are kept local — the remote's value points
 *     somewhere that does not exist here, and overwriting the working local path
 *     with a foreign one is pure damage.
 *   - **Everything else** (`^1.2.3`, `github:user/repo`, a tarball URL) is
 *     portable. The snapshot's value is the user's intent, so it wins.
 *
 * Bundles are then filtered against the merged dependency set, because a bundle
 * whose package is not installed cannot activate and only produces startup noise.
 *
 * @module dsh-settings-sync/manifest
 */

/** Spec prefixes that name a location on one particular machine. */
const LOCAL_SPEC = /^(link:|file:|portal:|\/|[A-Za-z]:[\\/]|\.\.?[\\/])/

/** Bundles every profile needs; never filtered out. */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/**
 * Whether a dependency spec points at one machine's filesystem.
 *
 * @param {unknown} spec - The `dependencies` value.
 * @returns {boolean} Whether the spec is machine-local.
 */
export function isLocalSpec(spec) {
  return typeof spec === 'string' && LOCAL_SPEC.test(spec)
}

/**
 * Whether a dependency spec can be installed on any machine.
 *
 * @param {unknown} spec - The `dependencies` value.
 * @returns {boolean} Whether the spec is portable.
 */
export function isPortableSpec(spec) {
  return typeof spec === 'string' && spec.trim() !== '' && !isLocalSpec(spec)
}

/**
 * Merge a snapshot manifest onto the local one.
 *
 * @param {object} options - Merge inputs.
 * @param {object|undefined} options.incoming - The snapshot's `package.json`.
 * @param {object|undefined} options.local - This machine's `package.json`.
 * @param {Iterable<string>} [options.installed] - Package names actually present in this profile's `node_modules`. This is the only trustworthy answer to "can this bundle activate": a name in the merged `dependencies` is a *request*, and nothing installs it until `pnpm install` runs.
 * @returns {{ manifest: object, notes: string[], droppedBundles: string[], keptLocalDeps: string[] }} The merged manifest plus what changed.
 */
export function mergeManifest(options) {
  const incoming = isRecord(options.incoming) ? options.incoming : undefined
  const local = isRecord(options.local) ? options.local : undefined
  if (incoming === undefined) {
    return { manifest: local ?? {}, notes: ['远端没有 package.json，保留本机清单'], droppedBundles: [], keptLocalDeps: [] }
  }
  if (local === undefined) {
    // A genuinely fresh machine: take the remote manifest, but drop the path
    // specs that named the other machine's directories, since they cannot work.
    const dependencies = {}
    const dropped = []
    for (const [name, spec] of Object.entries(incoming.dependencies ?? {})) {
      if (isLocalSpec(spec)) dropped.push(name)
      else dependencies[name] = spec
    }
    // On a machine with nothing installed, only the in-box bundles can activate;
    // enabling the rest would log a warning per plugin at startup.
    const installed = options.installed === undefined ? undefined : new Set(options.installed ?? [])
    const bundles = readBundles(incoming).filter((name) => {
      if (!installed) return !dropped.includes(name)
      return installed.has(name) || INBOX_BUNDLES.has(name)
    })
    const manifest = {
      ...incoming,
      dependencies,
      dsh: withBundles(incoming, bundles),
    }
    const notes = dropped.length > 0
      ? [`跳过 ${dropped.length} 个指向其他机器路径的依赖：${dropped.join(', ')}`]
      : []
    return { manifest, notes, droppedBundles: dropped, keptLocalDeps: [] }
  }

  const localDeps = isRecord(local.dependencies) ? local.dependencies : {}
  const incomingDeps = isRecord(incoming.dependencies) ? incoming.dependencies : {}

  const dependencies = {}
  const keptLocalDeps = []
  const notes = []

  // Local path specs win: they are the ones that actually resolve here.
  for (const [name, spec] of Object.entries(localDeps)) {
    if (isLocalSpec(spec)) {
      dependencies[name] = spec
      keptLocalDeps.push(name)
    }
  }
  // Portable specs come from the snapshot; local-only extras are kept so an
  // install the user added on this machine is not silently uninstalled.
  const fromRemote = []
  for (const [name, spec] of Object.entries(incomingDeps)) {
    if (isLocalSpec(spec)) continue
    if (!isPortableSpec(spec)) continue
    dependencies[name] = spec
    fromRemote.push(name)
  }
  const localOnly = Object.keys(localDeps).filter((name) => !(name in dependencies))
  for (const name of localOnly) dependencies[name] = localDeps[name]

  if (keptLocalDeps.length > 0) {
    notes.push(`保留本机路径依赖 ${keptLocalDeps.length} 个`)
  }
  if (fromRemote.length > 0) {
    notes.push(`合并远端依赖 ${fromRemote.length} 个`)
  }
  if (localOnly.length > 0) {
    notes.push(`保留本机独有依赖 ${localOnly.length} 个`)
  }

  // Bundles: the snapshot's choice, minus anything this machine cannot resolve.
  //
  // A bundle is enabled when its package is *installed* OR *declared with a
  // portable spec*. The second half matters at restore time: the merged manifest
  // has just written those git/npm specs, but `pnpm install` has not run yet, so
  // `node_modules` does not contain them. Filtering strictly by installed
  // packages would drop every newly restored plugin from the bundle list — the
  // config would be present, yet DSH would never load it. The caller installs
  // the declared packages right after this merge.
  //
  // Genuinely local path specs that do not resolve here are still excluded: a
  // `link:` pointing at another machine's directory can never activate.
  const incomingBundles = readBundles(incoming)
  const localBundles = readBundles(local)
  const declaredPortable = new Set(
    Object.entries(dependencies)
      .filter(([, spec]) => isPortableSpec(spec))
      .map(([name]) => name),
  )
  const resolvable = new Set([
    ...(options.installed ?? []),
    ...declaredPortable,
    ...INBOX_BUNDLES,
  ])
  const wanted = incomingBundles.length > 0 ? incomingBundles : localBundles
  const bundles = []
  const droppedBundles = []
  for (const name of wanted) {
    if (resolvable.has(name)) bundles.push(name)
    else droppedBundles.push(name)
  }
  // Keep local bundles the user enabled that the snapshot never had.
  for (const name of localBundles) {
    if (bundles.includes(name) || droppedBundles.includes(name)) continue
    if (resolvable.has(name)) bundles.push(name)
  }
  if (droppedBundles.length > 0) {
    notes.push(`跳过 ${droppedBundles.length} 个本机未安装的 bundle：${droppedBundles.join(', ')}`)
  }

  const manifest = { ...incoming, dependencies }
  // The profile's own name is machine-specific (`dsh-profile-web` vs
  // `dsh-profile-desktop`); keeping the local one avoids renaming the directory.
  if (typeof local.name === 'string' && local.name !== '') manifest.name = local.name
  manifest.dsh = withBundles(incoming, bundles)

  return { manifest, notes, droppedBundles, keptLocalDeps }
}

/** Read the `dsh.profile.bundles` array as strings. */
function readBundles(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles.filter((name) => typeof name === 'string') : []
}

/** A copy of `manifest` with a replaced bundle list. */
function withBundles(manifest, bundles) {
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : {}
  const profile = isRecord(dsh.profile) ? dsh.profile : {}
  return { ...dsh, profile: { ...profile, bundles } }
}

/** Whether a value is a plain object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
