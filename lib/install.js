/**
 * Installing declared plugins after a restore.
 *
 * A snapshot carries the user's *choice* of plugins (dependency specs), not the
 * packages themselves. Restoring the config without installing leaves a profile
 * where every plugin is declared but none of them can activate — which is exactly
 * the "half the plugins did not sync" symptom. This module closes that last gap.
 *
 * The hard part is finding `pnpm`. A GUI- or systemd-launched DSH inherits almost
 * none of the login shell's PATH, and `profileContext.packageManager` is `null`
 * on both the macOS desktop and the devcloud CLI launch (measured on each). What
 * the process *does* know reliably is `process.execPath` — the exact node binary
 * running it — and on an nvm install that binary's directory contains `pnpm`.
 * So the search order is:
 *
 *   1. the DSH-provided `packageManager` invocation, when present (best: it
 *      carries the app's own runtime and env);
 *   2. `pnpm` next to `process.execPath` (nvm / standalone node layouts);
 *   3. `pnpm` on PATH (a normal terminal launch);
 *   4. the usual install locations, matching what dsh-market already does.
 *
 * Nothing here runs a shell: every command goes through `execFile` with an
 * argument array, so a dependency spec can never become a command line.
 *
 * @module dsh-settings-sync/install
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Timeout for one `pnpm install`. A cold install of many plugins needs room. */
const INSTALL_TIMEOUT_MS = 300_000

/** Extra places a pnpm executable is commonly installed. */
function fallbackDirs() {
  const home = homedir()
  return [
    process.env.PNPM_HOME,
    join(home, '.local', 'share', 'pnpm'),
    join(home, 'Library', 'pnpm'),
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter((dir) => typeof dir === 'string' && dir !== '')
}

/**
 * Build the pnpm invocation for this Host.
 *
 * @param {{ packageManager?: { command: string, args?: readonly string[], env?: Record<string,string> } }} [profileContext] - The optional DSH-provided invocation.
 * @returns {{ command: string, prefixArgs: string[], env: Record<string,string> } | null} How to run pnpm, or null when it cannot be found.
 */
export function resolvePnpm(profileContext) {
  const provided = profileContext?.packageManager
  if (provided !== undefined && provided !== null && typeof provided.command === 'string' && provided.command !== '') {
    return {
      command: provided.command,
      prefixArgs: Array.isArray(provided.args) ? [...provided.args] : [],
      env: provided.env ?? {},
    }
  }

  const candidates = [
    join(dirname(process.execPath), 'pnpm'),
    join(dirname(process.execPath), 'pnpm.cjs'),
    'pnpm',
    ...fallbackDirs().map((dir) => join(dir, 'pnpm')),
  ]
  for (const command of candidates) {
    // `pnpm` on PATH is resolved by execFile itself; absolute ones are checked.
    if (command === 'pnpm' || existsSync(command)) return { command, prefixArgs: [], env: {} }
  }
  return null
}

/**
 * Run `pnpm install` in a profile directory.
 *
 * Installs whatever the manifest declares; it does not add or remove anything,
 * which keeps the caller in control of *which* plugins were chosen.
 *
 * @param {object} options - Inputs.
 * @param {string} options.profileDir - The profile directory.
 * @param {{ packageManager?: object }} [options.profileContext] - Optional DSH invocation.
 * @returns {Promise<{ ok: boolean, command: string|null, message: string }>} The outcome.
 */
export async function installDeclaredPlugins(options) {
  const pnpm = resolvePnpm(options.profileContext)
  if (pnpm === null) {
    return {
      ok: false,
      command: null,
      message: '找不到 pnpm：请在设置里关闭自动安装后手动运行 dsh plugin --profile <name> install',
    }
  }
  const args = [...pnpm.prefixArgs, 'install']
  return new Promise((resolvePromise) => {
    execFile(pnpm.command, args, {
      cwd: options.profileDir,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        ...pnpm.env,
        // Never let a git credential prompt hang the Host process.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      },
    }, (error, stdout, stderr) => {
      const lines = `${String(stderr ?? '')}\n${String(stdout ?? '')}`
        .split('\n').map((line) => line.trim()).filter((line) => line !== '')
      if (error !== null && error !== undefined) {
        // pnpm prints the actual failure as an `ERR_PNPM_*` line, then appends
        // npm-config noise after it. Taking the last line surfaced that noise
        // instead of the error, so pick the first real diagnostic line.
        const diagnostic = lines.find((line) => /^ERR_PNPM_|error|Error|failed|Failed|401|403|404/i.test(line))
          ?? lines[0]
          ?? error.message
        resolvePromise({
          ok: false,
          command: pnpm.command,
          message: diagnostic.length > 300 ? `${diagnostic.slice(0, 300)}…` : diagnostic,
        })
        return
      }
      resolvePromise({
        ok: true,
        command: pnpm.command,
        message: lines.filter((line) => /Done|Already up|Packages:/i.test(line)).slice(-1)[0] ?? 'pnpm install 完成',
      })
    })
  })
}
