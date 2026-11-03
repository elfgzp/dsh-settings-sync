/**
 * The Loader row schema.
 *
 * Kept in its own module for one concrete reason: it is the only file in this
 * package that imports `@deepseek-ai/schemastery`, which resolves inside a DSH
 * profile but not from a plain checkout. Everything the tests exercise —
 * `lib/config.js`, `lib/paths.js`, `lib/snapshot.js`, `lib/git.js`,
 * `lib/engine.js` — therefore stays free of that dependency and can be run with
 * `node --test` against nothing but Node and git.
 *
 * Schemastery must come from DSH (`@deepseek-ai/schemastery`), not the public
 * `schemastery` package: only DSH's build wraps a `meta.volatile` field in the
 * reference the Loader's volatile-commit path understands. This row has no
 * volatile fields, but keeping the import source consistent with the rest of the
 * ecosystem avoids a trap the next person would hit.
 *
 * @module dsh-settings-sync/schema
 */

import z from '@deepseek-ai/schemastery'

/**
 * Schema of this plugin's Loader row.
 *
 * Declaring it does two things beyond validation: the Settings page renders each
 * field as an editable form (so the state directory and the size caps can be
 * changed without hand-editing YAML), and a bad value is rejected at activation
 * with a readable message instead of surfacing later as a confusing path error.
 *
 * Every field has a default, so an empty `config:` block is valid.
 */
export const Config = z.object({
  stateDir: z.string()
    .description('状态目录：本地镜像克隆、恢复点和同步配置都在这里。留空表示 `$DSH_HOME/settings-sync`。')
    .default(''),
  gitPath: z.string()
    .description('git 可执行文件路径。留空表示使用 PATH 里的 `git`。')
    .default(''),
  maxFiles: z.number().step(1).min(1).max(100000)
    .description('单次快照的文件数上限；超过就拒绝同步并说明是哪个根目录。')
    .default(4000),
  maxBytes: z.number().step(1).min(1024)
    .description('单次快照的总字节上限。')
    .default(33554432),
  maxFileBytes: z.number().step(1).min(1024)
    .description('单个文件的大小上限，超过则跳过（例如附件索引）。')
    .default(2097152),
})
