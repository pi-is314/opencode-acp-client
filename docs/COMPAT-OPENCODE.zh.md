# opencode v2 兼容性

> English: [COMPAT-OPENCODE.md](COMPAT-OPENCODE.md)

## 策略

**opencode >= 2.0.0。** 声明在 `package.json`（`opencodeVersion`），由
`src/opencode-bin.ts`（`MIN_MAJOR_VERSION`）执行，由 `tests/version-policy.test.ts`
断言两者一致，并由 `scripts/check-opencode-version.sh` 拿**真实二进制**验收。

门控**只看主版本**，也只该看主版本：v2 至今这个接口面都是**增量**的，而按小版本白名单
会把新版本挡在门外却拿不出实测理由。它真正要拦的是 **v1** —— v1 的事件词汇完全不同，
失败表现是**静默的空界面**，所以"放行一个新的小版本"比"静默空界面"划算得多。

| | |
|---|---|
| 声明范围 | `>=2.0.0` |
| 拒绝 | v1（事件词汇不同）、以及版本号解析不出来的 |
| CLI 用法 | `opencode --server <url>`（v2）。**不是** v1 的 `opencode attach` |
| 致命时机 | 我们自己启动 TUI 时（默认行为）|
| 仅告警 | `--no-tui` 时（见 [DEVELOPMENT.zh.md](DEVELOPMENT.zh.md)）：TUI 可能由别人启动，所以缺失或 v1 只是警告 |

## 已实测版本

| opencode v2 | 日期 | 跑了什么 |
|---|---|---|
| **2.0.0 / 2.1.0 / 2.2.7** | 2026-11-13 | 边界矩阵，由 `scripts/compat-matrix.sh` 在 macOS 上端到端跑完：**3 个细胞、0 失败**。它的目的不是重新证明 HTTP（上面每个 release 的行已经做了），而是找出**只在最新版成立**的断言。抓出四处，全是我们的；另有两处属于客户端自己：v2.0.0 对单个 `websearch` 不分组（只有 grep/glob 算探索），以及 v2.0.0 的 `/timeline` **会杀掉 TUI**（v2.2.7 把那个视图挪进了插件）。|
| `v2.3.0` | 2026-11-14 | 路由 139 → 139，schema 498 → 500，**没有任何删除**：`experimental.mcp.event`（我们没实现 MCP）与 `session.step.first-token`，后者在 `packages/tui/src` 和 `packages/app/src` 里**没有消费者** —— 它是服务端计时事件，不发的 不影响屏幕。**两处行为变化让门控翻车，都是客户端自己有意为之**：某个版本**首次启动会弹** *What's new in this release* 对话框（`dialog-highlights.tsx`，Enter 关闭），它占住 composer，所有等输入的等待全部超时；以及 `session.verbosity` 默认变成 `low`，把一串工具调用折叠成一行（`dialog-config.tsx: default: "low"`），工具卡片断言读不到那一行。验收脚本在等待里关掉对话框，并通过 `OPENCODE_CONFIG_DIR` 固定 `session.verbosity: "high"` —— 注意这个版本起的配置文件名是 `cli.json`，`tui.json` 只用于迁移。|| `v2.2.7` | 2026-11-11 | 在 macOS 上用 `--path` 对 v2 安装器装出来的二进制跑完整门控。没有做路由 diff（就这次能观测到的而言，接口面与 2.2.6 一致：桥服务的每个路由都照常应答，`check-openapi.py` 仍是 32 pass / 20 note / 0 fail）。**这次跑出来的问题在我们自己的脚本里**：渲染模式的 `send_prompt` 打完字后固定等 1.6s 再按 Enter，负载下有时落在 composer 还没接管按键之前 —— 回合根本没开始，而失败的样子像翻译层回归（"每一层都缺"、日志里没有 session id，可桥其实已经服务了 session/model/agent/command）。helper 现在先等自己打进去的文字出现在屏幕上。修完，门控整轮通过。 |
| `v2.2.7` | 2026-11-11 | 在 macOS 上用 `--path` 对 v2 安装器装出来的二进制跑完整门控。没有做路由 diff（就这次能观测到的而言，接口面与 2.2.6 一致）。**这次跑出来的问题在我们自己的脚本里**：渲染模式的 `send_prompt` 打完字后固定等 1.6s 再按 Enter，负载下有时落在 composer 还没接管按键之前 —— 回合根本没开始，而失败的样子像翻译层回归。helper 现在先等桥日志里出现新的 `/prompt`。|
| `v2.2.6` | 2026-11-07 | 138 → 139 条路由：只新增一条 experimental 的 `GET /api/experimental/job?sessionID=&kind=`，列出后台工作（`Job.Info = Job.Shell \| Job.Subagent \| Job.Image`）。没有删除。其余都是生成器对 schema 写法的重构——`location`/`types` 查询参数从 `{anyOf: […]}` 变成等价的 `{type: object, properties: …}`；那约 100 个“新增” schema 是 v2 事件终于被建模了（`Event.ID`、`session.*`、`Job.*`），以前只是枚举字符串。**`/api/event` 的 `types` 枚举 96 → 96：一个事件类型都没增删。** 桥消费的 8 个 schema 全部未变，所以不需要改代码。值得知道的一点：TUI 新增了“subagent 会话内的 transcript 跳转”（#60817）——那是它自己原生会话的能力，ACP 这条路走不到 |
| `v2.2.5` | 2026-10-31 | 相对 v2.2.4 路由没有变化（138 条）；只新增了 `Config.Compaction.Percent` 这一个 schema。桥服务的、消费的东西都没有变 |
| `v2.2.4` | 2026-10-31 | 134 → 138 条路由：新增 4 条 experimental 的 `artifacts`（`/api/experimental/artifacts`、`/providers`、`/{artifactID}`、`/{artifactID}/view/*`），配一套可插拔 provider 的制品存储。没有删除任何路由。`/api/event` 的 `types` 枚举多了两项（`artifact.updated`、`persistent-pty.updated`）——桥忽略 `types`，不受影响。它消费的 8 个 schema 全部未变。已端到端验证：**`pnpm verify:version 2.2.3` 通过完整门控**（16 个真 TUI 模式 + epilogue 全绿）|
| `v2.2.2` | 2026-10-30 | 路由仍是 134 条——**没有新增、没有删除**；被“删除”的 schema 名是内联变体重命名（`*_1`/`*_2` → `Native`）。三处放宽我们本来就容忍：`/api/model` 与 `/api/event` 的 `types` 现在也接受 `null`，`/api/shell` 的 `timeout` 加了上限。两个新的**可选**字段值得知道：`Session.Info.time.busy`（最近一次执行的开始时间；执行期间 `idle` 仍是上一次执行的结束）和 `PromptInput.FileAttachment.source`。桥**两者都不发**——`busy` 是可选的，行为由 `session.execution.*` 事件驱动；附件走 `uri`——所以**不需要改代码**，完整门控全绿 |
| `v2.2.1` | 2026-10-29 | 对 v2.2.0 逐字段 diff：HTTP 面**只增不减**——新增 4 条 experimental 的 `schedule` 路由，没有删除任何路由，`session/update` 的变体也没有增删。唯一变化的 schema 是 `Model.Variant.settings` 收窄为新的 `Model.VariantSettings`（多了 `compaction`、`encoding`），它仍是开放的（`additionalProperties: {}`），桥现在发的 `{id}` 形式依旧合规。`fix(tui): show execution failures that happen before any step` 让客户端渲染 `idle` 消息上的 `error`——桥本来就会设这个字段，所以“step 之前就失败”的情况现在会显示一行，而不是什么都不显示。**不需要改代码** |
| `v2.2.0` | 2026-10-27 | 对 v2.1.4 逐字段 diff 了 HTTP 面：新增 7 条路由（`/api/experimental/usage/limits`、`/api/plugin/gui`、`/api/experimental/media/{hash}`、`generate/*` 一族、`fs/watch`），删掉 1 条 experimental 的 voice 路由，16 个 schema 都是加字段式变更。TUI 启动时会请求 usage limits，v2.2 还给模型加了类型（`Model.Type`，默认 `chat`），所以桥用规范声明的 `data: null` 回答 `/api/experimental/usage/limits`、把每个模型标成 `chat`、并支持 `GET /api/model?types=`。随后真 v2.2 TUI 的首次全量运行又抓出两个 HTTP 面看不出来的回归：`!command` 整行不显示（它的事件必须带两代客户端都会剥掉的 `evt_` 前缀），以及任何工具失败都让 TUI 崩溃（工具 part 的 `state.error` 是 `{type, message}` 而不是字符串）。两处都已修好并经过抓屏验证 |
| `v2.1.0` | 2026-10-20 | 新增 **todo 列表**（`experimental.todo` 背后的 `todowrite` 工具）与**长请求**可靠性；启动时会读 `/api/mcp`。v2.1 还修了 ACP `usage_update.used` 的回归：现在报 `state.usage.last` 而不是回合总量。真 TUI 启动超过旧的 60/120s 上限，已抬到 180/240s |
| `v2.0.32` | 2026-10-17 | 客户端本周又自更新一次，门控逮到它两次：一次是真失败（单入口模式超时——v2.0.32 在 composer 渲染前多跑一整轮服务端读取，于是 e2e 等待从 60s 提到 120s），一次是版本门控。完整 `verify` 全绿 157 项；`CLIENT_VERSION_HINT` 在此升位 |
| `v2.0.31` | 2026-10-17 | 门控在它发布的当天自动逮到（TUI 自更新后告警"Server at … has version 2.0.30; this client is 2.0.31"）。对临时 prefix 安装跑完整 `verify`：156 项通过——typecheck、231 单测、53 探针规范一致性、smoke/entry、全部真 TUI 模式。`CLIENT_VERSION_HINT` 在此升位，版本不匹配警告随之消失 |
| `v2.0.30` | 2026-10-16 | 本仓这一周大部分实测所用的版本：表单关闭的 DELETE 修复、CLI 三类参数契约、resume/continue 重构、fs/find 与图片附件——每个真 TUI 探针都在它上面跑。`pnpm verify` 157 项全绿 |
| `v2.0.28` | 2026-10-13 | 门控自己抓到的版本：本机客户端在这次复查途中升到了它，真 TUI 那一步失败，原因是写死的 `sleep 8` 在输入框就绪之前就把 prompt 打进去了；现在这一步改为**等标记**而不是等时长。通过：typecheck、118 单测、43 探针规范检查、smoke 与单入口套件，以及**两个真 TUI 阶段**（实时屏与重载屏的逐层断言；Escape 按两次 → `session.interrupt` → `200`）|
| `v2.0.27` | 2026-10-13 | 对该二进制跑 `pnpm verify`：typecheck、118 个单测、公开规范一致性检查（43 探针）、7 场景 smoke、单入口套件，以及 tmux 里的真 TUI 验收（重载会话能渲染历史；`Escape` 按两次发出 `session.interrupt` 并拿到 `200 {interrupted}`）|
| `v2.0.22` | 2026-10-13 | 同一套门控跑在**比本仓开发所用版本早六个 release** 的版本上（npm 装进临时 prefix；本机那份客户端没被碰）。全部通过：typecheck、118 单测、43 探针规范检查、smoke 与单入口套件，以及**两个真 TUI 阶段** —— 实时屏与重载屏的**逐层**屏幕断言，加上 Escape 按两次 → `session.interrupt` → `200`。这才叫**版本门控**，而不是「针对某一个构建的回归套件」|
| `v2.0.0` | 2026-10-18 | 声明的下限，完整跑过：**macOS** 与 **Linux**（Docker 里的 Alpine/musl）。正是它抓出了 `/pair` 崩溃：v2.0.0 的界面会解引用 `GET /api/server` 的 `urls`，而桥当时没提供该路由；补上之后，两个平台上的完整门控都是绿的 |

一行绿 = **整套门控**在该二进制上通过，而不只是"原则上支持这个版本"。加一行就是下面
这条命令的产物。

**平台。** 完整门控——typecheck、单测、52 探针的 OpenAPI 校验、以及 tmux 里的全部真 TUI
模式——已在 **macOS**（darwin-x64）与 **Debian 12**（glibc，x86_64）上跑过：

| 版本 | macOS | Debian 12 |
|---|---|---|
| v2.0.0 | ✓ | ✓ |
| v2.1.0 | ✓ | ✓ |
| v2.2.0 | ✓ | ✓ |
| v2.3.0 | ✓ | ✓ |

macOS 上还跑过若干中间版本（v2.2.7 等），逐条记在上面的版本表里。更早的一次 Linux 运行
用的是 Docker 里的 **Alpine/musl**（v2.0.0）；上表是 glibc。Debian 上的单测还通过了
**PowerShell 7.4**（`pwsh`）的启动方式。Windows 在 `windows-latest` 上跑 typecheck
与单测，TUI 未实测（见 [Windows](#windows) 一节）。

## 怎么验一个版本

```bash
# 用你已有的，不安装任何东西
bash scripts/check-opencode-version.sh --path ~/.opencode/bin/opencode

# 指定 release：装在**临时 HOME** 下（你的 ~/.opencode 不会被碰），再对其跑整套门控
bash scripts/check-opencode-version.sh 2.0.27

# >= 2.0.0 的最新 release
bash scripts/check-opencode-version.sh latest-v2
```

`pnpm verify:version` 等价。脚本会在**跑任何东西之前**先确认该二进制的主版本达标 ——
这样"下载解析错了"不可能悄悄变成一次用错对象的绿色通过。

这套门控**包含真 TUI**：`scripts/e2e-real-tui.sh` 在 tmux 里驱动它，对着假 agent 跑一个**完整
回合**（思考、带输入输出的工具调用、回复），并且断言的是**屏幕上的内容** —— 用户行、思考块、
工具卡片、回复、agent/模型 footer —— 而不是"我们发了什么"。每次抓到的屏幕写进 `.artifacts/`，
所以某个版本的渲染结果可以**被人查看**（也可以和下一个版本 diff），而不是只能被相信。
这正是单测做不到的部分，也是"新 release 由它的屏幕来判定"的原因。

## 监听官方 release

`.github/workflows/opencode-release.yml` 每天跑（也支持 `repository_dispatch` 与
`workflow_dispatch`）：解析出最新 release tag → 精确安装那个版本 → 通过上面的脚本跑
`pnpm verify`。失败会**开一个 issue** —— 坏掉的是 opencode v2 的 release，不是这次提交。

workflow 的 `repository_dispatch` 分支从 `client_payload.version` 取版本，所以一个
relay 可以把精确的 tag 交给它。上游 release **不能**直接触发本仓（`release` 事件只在
release 所属的仓库里触发），所以 relay 的形态是：轮询 release 的 **atom feed**，再发
dispatch —— 或者在能跑 TUI 的机器上**本地跑门控**：

```bash
# 每 30 分钟检查；有新 v2 tag 就 dispatch 给 CI（需要 gh + token）
bash scripts/watch-opencode-releases.sh --interval 1800 --dispatch --notify

# cron/launchd 用的一次性模式；--run 改成在本地跑完整门控
bash scripts/watch-opencode-releases.sh --once --run
bash scripts/watch-opencode-releases.sh --once --dry-run   # 只打印会发生什么
```

watcher 读 atom feed（没有 API 配额，也就没有"被限流后永远绿"的失败模式），忽略
pre-release 与 `2.x` 以外的 tag，把「已见」tag 存在 `~/.opencode-acp-client/` 下，并且
**门控失败时不会推进它**，所以下一轮会重试。锁保证两个 watcher（或 watcher 与手动
门控）不会在同一台机器上同时驱动两个 TUI。macOS 的 `launchd` / `cron` 跑 `--once`
即可；日志在 `~/.opencode-acp-client/opencode-release-watch.log`。

```cron
# 每小时一次足够；完整门控会下载约 200 MB
17 * * * * cd /path/to/opencode-acp-client && bash scripts/watch-opencode-releases.sh --once --dispatch --notify >> /tmp/opencode-watch.log 2>&1
```

版本来源是 **npm registry**（`@opencode/cli`）—— 这正是 v2 自己发布的渠道，无需
token、没有配额；releases atom feed 作为兜底。有三个坑值得记下来，每个都吃掉了我一轮调试：

- GitHub **API 会限流**未认证的主机，而被限流的监听者看到的是"没有新 release"，
  于是**永远绿**。
- `https://opencode.ai/install`（不带 `/v2/`）是 **v1 的安装脚本**：它按 v1 线解析
  `latest`，而 v1 的 release 资源在 v2 上并不存在 —— 它的报错是 `unzip` 失败，
  而不是明确的"你走错渠道了"。v2 的渠道是 `https://opencode.ai/v2/install`；
  而 `npm install -g @opencode/cli@<version>` 是最省事的一种。
- 两个安装脚本都把 `INSTALL_DIR` 硬编码成 `$HOME/.opencode/bin`，所以"天真地装一下"
  会**覆盖开发者自己的二进制**。本脚本改成装进一个临时 npm prefix。

CI 需要：node、pnpm、`tmux` 与 `zsh`（真 TUI 验收在登录 shell 里驱动 TUI）、`python3` + `jsonschema`（规范检查）。
`scripts/e2e-real-agent.sh` **故意不在门控里** —— 它需要装好真实 ACP agent，属于偶发
检查而不是门控。

## 这个门控**不**覆盖什么

- **其它平台**：CI 跑在 Linux 上；TUI 的渲染与终端/平台相关，Windows/macOS 各有各的毛病。
- **CLI 面的变动**：如果 opencode v2 哪天挪走 `/api/*` 或改了"怎么把 TUI 指到 server"，
  只有在真 TUI 那一步才会被抓到 —— 单测按设计用的是假客户端。
- **agent**：这里的"兼容"说的是**客户端**。某个 ACP agent 表现如何是另一个问题，见
  [ACP-COMPAT.zh.md](ACP-COMPAT.zh.md)。

## Windows

单测在 `windows-latest` 上跑（`.github/workflows/windows.yml`，用的是 **PowerShell** ——
GitHub 在 Windows runner 上的默认 shell）。真 TUI 验收跑不了：它需要 tmux 和 POSIX
登录 shell，所以 Windows 的 TUI 行为**未实测**。

已经实现并有测试覆盖的 Windows 行为：

- 结束 agent 用 `taskkill /PID <pid> /T`（Windows 没有可发信号的进程组）；
  `windowsKillArgs` 固定参数，进程树测试在 Windows 上也会跑；
- 不启用 `detached`（Windows 上 detached 会弹出一个新控制台窗口）。

**`.cmd` shim 在 Windows 上不算程序。** npm 装出来的 `opencode` 是 `opencode.cmd`，而不带
shell 的 `execFile`/`spawn` 起不了它——即使命令就在 `PATH` 上，也只会回 `ENOENT`（走伪终端
时是 `EINVAL`）。所以那里每一处启动二进制的地方都改走 `cmd.exe /d /s /c`：版本探测
（`runVersion`）、`printHelp()`，以及 ACP 客户端自己的 agent 启动（`launchSpec`）。
覆盖这几处的 fixture 是真的 `.cmd` shim，因此 Windows 路径是被测试**真跑到的**，不是跳过
——实测：Windows 上 432 通过 / 0 跳过。

### v2.0.32 之前，`opencode acp` 不认 `provider`

写在 `opencode.json` 里的 provider，在**每个** v2 版本的 TUI 和 `opencode models` 里都能看到，
但 `opencode acp` 的模型列表在 `v2.0.18` 上只从内置 provider 解析：`session/new` 只给出 2 个
选项（全是内置 provider），没有配置里那个，`session/set_config_option` 也以
`model not found` 拒绝。同一台机器、同一份配置，五个二进制实测：

| 二进制 | `configOptions.model` |
|---|---|
| v2.0.18 | 2 个选项，**0** 个来自配置的 provider |
| v2.0.32 / v2.1.4 / v2.2.7 / v2.3.2 | 53 个选项，**40** 个来自配置的 provider |

所以把 agent 指向自定义 provider，需要 `v2.0.32` 或更新。这里修不了——模型解析发生在
`opencode` 的 ACP 子命令内部，在桥被告知任何东西之前。

### 已验证的矩阵

`node scripts/e2e-matrix-real.mjs` 把它能找到的每个 TUI 构建 × 每个 agent 组合起来，每格跑**三轮真实对话**，
走的是 TUI 用的那套 HTTP 面。判定依据是 transcript 加 agent 自己的错误原文，**不是截屏**——agent 的真实错误
藏在 ACP payload 里，屏幕上只显示 `Error: Internal error`。

2026-11-22 的结果，全部指向同一个 OpenAI 兼容端点，每一格都是**必须回忆起上一轮**的真实对话：

| 平台 | 构建 | 结果 |
|---|---|---|
| macOS | 2.0.32 / 2.1.4 / 2.2.7 / 2.3.2 | **20/20** |
| Linux | 2.0.32 / 2.1.4 / 2.2.7 / 2.3.2 | **20/20** |
| Windows | 2.0.32 / 2.1.4 / 2.2.7 / 2.3.2 | **20/20** |

每一行都是 4 个构建 × 5 个 agent（`opencode acp`、claude-agent-acp、codex-acp、qwen、
`dsh --profile acp`）。

`opencode acp` 是按构建逐行测的，因为 agent 命令**就是那个构建的二进制**——见 E2E-PITFALLS #14。
没有任何一格被记成 BLOCKED：某台机器上缺的 agent 要**装上**，而不是记成"跑不了"。Windows 第一次跑
时记的 "dsh blocked（未安装）"，是测试脚本把自己的缺口描述成了 agent 的问题——见下面的 `dsh` 说明。

### 换一个平台才发现的两次

**`dsh` 把 provider 写死在 bundle 里。** `dsh --profile acp` 从 profile 读 LLM 路由，但
`@deepseek-ai/dsh-acp` 这个 bundle 自己指定了 provider，所以只声明了 provider 的 profile 仍然会得到
`no API key for provider route "deepseek-official"`——它要用的是那个路由，不是配置里的。覆盖必须点名 bundle：

```yaml
- id: acp
  name: "@deepseek-ai/dsh-acp"
  config:
    provider: my-llm         # llm-pi-ai 下声明的 provider id
    model: "deepseek-flash"
```

**`pnpm` 会留下一个空的 `opencode.exe`。** pnpm 12 默认跳过 `@opencode/cli` 的 postinstall，而那个
postinstall 正是把真正的 200 MB 二进制拷进来的步骤——留下的是一个 229 字节的壳。文件**存在**，所以
`existsSync` 会通过，问题只在真正运行它时才暴露。安装前先允许构建：

```yaml
# 放在 package.json 同级的 pnpm-workspace.yaml
allowBuilds:
  '@opencode/cli': true
```
