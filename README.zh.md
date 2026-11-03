# 设置同步（dsh-settings-sync）

把 **DeepSeek Harness 的全部设置**通过一个你自己的私有 Git 仓库做备份与恢复——profile 配置、各插件设置、skills、已安装插件、MCP 服务。一台机器推送，另一台机器恢复；覆盖之前一定先留恢复点。

[English](README.md)

---

## 为什么需要它

DSH 的配置散在几个地方，任何一处丢了都很麻烦：

| 内容 | 位置 |
|---|---|
| 插件清单与 profile 的 bundle 列表 | `~/.dsh/profiles/<profile>/package.json` |
| 各插件配置（模型、MCP、面板设置） | `~/.dsh/profiles/<profile>/cordis.patch.yml` |
| Skills | `~/.dsh/skills/`、`~/.agents/skills/` |
| 插件自身状态（标星、默认项目、任务） | `~/.dsh/<插件>/` |

`dsh export` 能导出一份，但之后还得自己搬。这个插件把它变成持续动作：一个私有仓库、两个方向各一个按钮、推之前能先看清楚差异。

## 同步什么

```
manifest.json                 这份快照由什么生成、什么时候
profile/package.json          插件清单与 bundle 列表
profile/cordis.patch.yml      所有插件的配置
profile/cordis.yml            profile 的根入口列表
profile/pnpm-workspace.yaml   工作区与发布年龄设置
homes/dsh/<插件>/*.json       插件自身状态（标星、默认值、任务）
homes/dsh/skills/<名字>/…     $DSH_HOME 下的用户级 skills
homes/agents/skills/<名字>/…  $DSH_AGENTS_HOME 下的共享 skills
```

明确**不同步**的：

- **凭据。** `~/.dsh/.credentials.yaml`、`tencent-intranet-auth.json`、`.env`、
  `*.pem`、`*.token`、`pairing.json`——按文件名和内容双重排除。更进一步，
  即使某个配置文件本身要同步，里面的真实密钥值（例如 `cordis.patch.yml` 里的
  `apiKey:`）也会在上传前被替换成 `<redacted by dsh-settings-sync>`。配置的**结构**
  保留下来，所以恢复后你仍然知道那里该有一把钥匙，只是需要重新填。

  抹除是**单向**的：恢复时绝不会把占位符写到本机已有的真实值上。恢复逻辑按 key 名
  匹配凭据行，保留本机自己的密钥——所以在快照来源的那台机器上恢复，API key 依然可用。
  只有本机还没有值的机器才会拿到占位符，而那正是它该说的话：「这里欠一个 key」。
- **依赖与缓存。** `node_modules`、`pnpm-lock.yaml`、`__pycache__`、
  `.plugin-manager` 日志、附件二进制。
- **会话与历史。** `~/.dsh/sessions`、`~/.dsh/storages`——历史不是设置，而且它是
  DSH home 里体积最大的东西。
- **旧版本备份。** profile 里任何 `.bak` 文件。

实测一台机器——21 个已装插件、66 个 skills、6 个插件状态目录——收集出来是
**263 个文件、1.4 MB**。

## 安装

```bash
git clone https://github.com/elfgzp/dsh-settings-sync.git ~/Work/Github/dsh-settings-sync
```

然后在 DSH 里走 **设置 → 插件 → 安装**，或在终端里：

```
dsh plugin install ~/Work/Github/dsh-settings-sync
```

插件会在 **设置** 里加一个「设置同步」页，并在首次启动时问一个问题：从远端恢复，还是把当前设置推上去。

依赖：`PATH` 里的 `git`（也可以在插件配置里填绝对路径）；只有想用「一键建私有仓库」时才需要
[GitHub CLI](https://cli.github.com/) 并执行过 `gh auth login`。

## 使用

1. **填仓库。** 粘贴一个空的私有仓库地址
   （`git@github.com:you/dsh-settings.git` 和
   `https://github.com/you/dsh-settings.git` 都行），或者点「创建私有仓库」让 `gh` 帮你建。
2. **推送**，把这台机器的设置上传。
3. 另一台机器装上插件、填同一个地址、**恢复**。

差异面板会先告诉你这次推送会改什么——`+新增`、`~修改`、`-删除`——再动手。

### 自动同步

| 设置 | 含义 |
|---|---|
| **推送前抹除密钥** | 上传前把真实密钥替换成占位符。默认开启。 |
| **自动推送** | 按检查间隔在设置变化后自动推送。 |
| **远端策略** | `never` 忽略远端；`ask` 每次给选择（默认）；`always` 远端更新且本地干净时直接恢复。 |
| **检查间隔** | 关闭 / 5 分钟 / 30 分钟 / 1 小时。 |

### 安全模型

- **没有恢复点就绝不覆盖。** 恢复会把当前状态完整复制到
  `<stateDir>/backups/<时间戳>-snapshot/`，并在完成后报告路径。设置页里能列出所有恢复点，
  一键回滚。
- **一个文件都没收集到的推送会被拒绝。** `HOME` 解析错误看起来就像「用户把设置全删了」，
  而用一个空快照替换掉好备份是不可逆的。同一道闸也会拒绝一次性删掉大部分文件的推送，
  除非你显式强制。
- **快照就是一个真正的 Git 仓库**，在 `<stateDir>/mirror`。历史本身就是备份：
  在里面 `git log` 能看到每一次同步，`git show <commit>:profile/cordis.patch.yml`
  能取出任意一个历史版本。这也是为什么这个插件不需要自己发明一套撤销格式。

默认全部落在 `$DSH_HOME/settings-sync`：

```
config.json   仓库、分支、策略、提交身份
mirror/       本地克隆，它的历史就是快照历史
backups/      恢复点
last-run.json 最近一次推送或恢复的结果
```

## 开发

```bash
pnpm test    # 或：node --test test/*.test.js
pnpm check   # 对每个模块跑 node --check
```

测试用真实的 `git` 二进制和一个临时 home 目录跑真实代码路径：伪造的 profile、两个 skill 根、
一个插件状态目录、一份绝不能被同步的凭据，以及一个裸仓库充当远端。没有任何一处 mock 掉 git——
因为 git 恰好是最容易出错的部分。

## 设计说明

**镜像是一个克隆，不是一个数据库。** 把快照保持成普通仓库，意味着整套撤销机制就是
「checkout 一个更早的提交」，差异就是 `git status`，用户随时能在终端里自己查看或修复，
不需要这个插件帮忙。

**推送与恢复是串行的。** 一次只跑一个操作、一个忙碌标志。第二次点击会排队而不是交错执行，
定时器在恢复中途触发也会被跳过。

**认证用的是你自己的那套。** 插件不存任何令牌：它跑的就是你跑的 `git`，所以 osxkeychain、
SSH agent、`credential.helper` 原样生效。推论也如实相告——如果终端里 `git push` 推不上去，
这里也推不上去，而且报错会直接这么说。

**浏览器半边不持有要紧状态。** 它只负责渲染和调用；文件系统、仓库、恢复点都在 Host 侧。

## 目录

| 路径 | 作用 |
|---|---|
| `index.js` | Host 入口：路由、自动同步定时器 |
| `lib/config.js` | 路径解析与部署配置 |
| `lib/state.js` | 用户配置与最近一次运行状态 |
| `lib/paths.js` | 什么算设置；密钥与缓存排除规则 |
| `lib/snapshot.js` | 收集、落盘、差异、恢复、恢复点 |
| `lib/git.js` | 唯一执行 `git` 的地方 |
| `lib/engine.js` | 串行同步引擎：推送、恢复、预览、回滚 |
| `client.js` | 设置页与首次启动对话框 |

## 许可

MIT
