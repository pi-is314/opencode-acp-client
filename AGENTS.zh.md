# AGENTS —— opencode-acp-client 开发入口（人类与 agent 通用）

> English: [AGENTS.md](AGENTS.md)

> **本文件 = 入口**：这个项目是什么、边界在哪、哪些事实已经核实过、怎么验证。
> **事实以本文件为准**；协议细节见 [docs/PROTOCOL.md](docs/PROTOCOL.md)、
> [docs/ACP-MATRIX.md](docs/ACP-MATRIX.md)、[docs/COMPAT-OPENCODE.md](docs/COMPAT-OPENCODE.md)。

---

## 0. 三十秒定位

| | |
|---|---|
| **是什么** | 一个 **ACP client**，**界面就是 opencode v2 的 TUI** |
| **怎么用** | `opencode-acp-client -- <任意 ACP agent 命令>`：一条命令起 TUI + 适配层（`oc-acp-client` 是短命令 alias） |
| **方向** | 与「把 opencode 当 agent」的项目**反向**：**借 opencode v2 的 TUI 当界面，用它去消费任意 ACP agent** |
| **不绑定任何 agent** | 任何说 ACP、走 stdio 的东西都能用；具体驱动过哪些见 README 的「Connecting an agent」 |
| **协议面** | **对外 = ACP**（产品协议面）；**内部 opencode v2 `/api/*` + SSE = 界面适配层（实现细节）** |
| **对外身份** | community-maintained、与 opencode 官方无关 |

> ★ **本仓库从一次提交开始。** 更早的历史留在一个**本地旧工作目录**里，那一份已冻结
> （`pre-commit` / `pre-push` 钩子拒绝写入），**只作为历史查询**用。

---

## 1. 阅读顺序

| # | 文档 | 为什么 |
|---|---|---|
| 1 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 进程模型 + 一个回合的端到端时序（**为什么 HTTP 响应是占位符**、为什么要关掉所有 open part）|
| 2 | [docs/PROTOCOL.md](docs/PROTOCOL.md) | 我们实现的 opencode v2 面 + **v2 事件词汇**（事件名/形状写错 = 静默不渲染）。★ **权威是公开规范**：<https://opencode.ai/v2/openapi.json>（OpenAPI 3.1.0）|
| 3 | [docs/ACP-MATRIX.md](docs/ACP-MATRIX.md) | ★ **能力矩阵**：我们宣告/实现了哪些 ACP 方法（13+11+1）、`session/update` 的 14 个变体、**agent 缺能力时掉什么功能**、以及 opencode v2 那些**无法与 ACP 对齐**的面（依据是 ACP v1.25.0 schema，不是概览页）|
| 3.5 | [docs/ACP-CLIENT-OBLIGATIONS.md](docs/ACP-CLIENT-OBLIGATIONS.md) | ★ **规范里的每条 MUST 一行**：引文 → 本客户端怎么做 → 落在哪个文件。动 ACP 面之前读它，让每条 MUST 都被回答而不是被漏掉 |
| 4 | [docs/COMPAT-OPENCODE.md](docs/COMPAT-OPENCODE.md) | ★ **opencode v2 版本策略**（`>=2.0.0`）、已实测版本、以及「官方发新 release 就自动跑一遍门控」的机制 |
| 5 | [docs/KNOWN-ISSUES.zh.md](docs/KNOWN-ISSUES.zh.md) | **尚未解决**的问题与已知限制（已修的记录不进仓库）|
| 6 | [docs/ACP-COMPAT.md](docs/ACP-COMPAT.md) | 运行时能力降级规则，以及 opencode v2 TUI 没有对应 ACP 能力的面（通用规则；**逐 agent 的实测**见下一条）|
| 6.5 | [docs/AGENT-CAPABILITIES.zh.md](docs/AGENT-CAPABILITIES.zh.md) | ★ **逐 agent 能力实测**：`dsh --profile acp` / `opencode acp` / [claude-acp](https://github.com/agentclientprotocol/claude-agent-acp) / [codex-acp](https://github.com/agentclientprotocol/codex-acp) 的 `initialize` 回包，以及各自在本项目里**掉什么功能**（例如 dsh 官方 acp 没有 `loadSession` → 恢复成功但没有历史，tab 保留真名 + 一条 Notice 说明原因）|
| 7 | [docs/SCENARIOS.md](docs/SCENARIOS.md) | ★ **假 agent 的场景矩阵**：能演哪些场景、各自由哪个测试断言、**屏幕上渲染成什么**、渲染不了的原因（含尚未断言的缺口）|
| 8 | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | ★ **开发笔记**：纯服务端模式（`--no-tui`）、怎么观察一次运行、以及动这个桥之前该知道的坑 |
| 9 | [docs/UPSTREAM-TUI-TESTS.md](docs/UPSTREAM-TUI-TESTS.md) | ★ **官方 TUI 测试 → 本桥契约的映射表 + 逐版本对照流程**（官方发新版先看这里）|
| 10 | [docs/SESSION-LIFECYCLE.zh.md](docs/SESSION-LIFECYCLE.zh.md) | ★ **session 全机制**：双 id 与映射表、三条恢复链路、`-c`/`--session`/adoption、排序与 epilogue、五个时序雷区（每个机制都对应一次实测故障）|
| 11 | [docs/E2E-PITFALLS.zh.md](docs/E2E-PITFALLS.zh.md) | ★★ **写 e2e 脚本的禁忌**：固定端口、按时长等、按 UI 文案断言、cleanup 杀别人、模态框挡路……**每一条都已让人白跑一整轮门控**。改 `scripts/e2e-*.sh` 前先扫一遍 |
| 12 | [docs/ROADMAP.zh.md](docs/ROADMAP.zh.md) | ★ **已知要做、当前不做**的三件事（desktop、ACP v2、常驻桥），以及各自**为什么现在不做**——动手前先读这一页，别从零调研 |
| 13 | [CHANGELOG.zh.md](CHANGELOG.zh.md) | ★ **每个已发布版本变了什么**，一个主题一节。写给用户看的，不是维护者 —— 背后的事实都在上面那些页面里。**打 tag 前要和 `package.json` 一起改**，并且每条都要在 [CHANGELOG.md](CHANGELOG.md) 里有对应。 |
| — | 源码 | `src/index.ts`（CLI/单入口生命周期）→ `src/server.ts`（HTTP/SSE + 会话投影，**最重的一个文件**）→ `src/acp/client.ts`（**ACP 协议实现**）→ `src/translate/events.ts`（翻译层）|

**协议原文**：<https://agentclientprotocol.com/protocol/v1/overview>（**页面加 `.md` 取纯文本**；全站索引见 <https://agentclientprotocol.com/llms.txt>）；
ACP 的稳定 schema：`https://github.com/agentclientprotocol/agent-client-protocol/releases/download/schema-v1.25.0/schema.json`。

---

## 2. 铁律（违反即 bug）

1. **只宣告能兑现的能力。** `initialize` 的 `clientCapabilities` 是 `CLIENT_CAPABILITIES`
   （`src/acp/capabilities.ts`）= **`{ elicitation: { form: {} }, _meta: { terminal_output: true } }`** ——
   只此两项，各有完整通路（表单走 `/api/session/:id/form`；`terminal_output` 走 `toolOutput()`，见铁律 7）；
   `elicitation.url`、`fs/*`、`terminal/*`、`session.notices`、`session.compaction` 都**故意不宣告**
   （各自的原因写在该常量上方）。**加了实现才宣告**；宣告了没实现 = agent 真来调，我们答不上。
   守卫测试：`tests/capabilities.test.ts`。（ACP 原文：`initialize` 里省略的能力一律按 **UNSUPPORTED** 处理。）
2. **每个反向请求都必须有明确回答。** agent → 我们的请求（`session/request_permission`、`fs/*`、`terminal/*`、
   `elicitation/create`）**不接也要回 JSON-RPC error / `cancelled`**；静默 = **agent 永久挂起**（协议侧没有超时）。
   落点：`src/acp/client.ts` 的 `onRequest`。
3. **不静默降级。** 未知 HTTP 路由 → **记 `[bridge] unhandled route:` 并回一个形状正确的空信封**（不是 404 ✗；
   只有未知的**会话 GET 子路由**才 404、未知的**会话 POST 动词**回 204 ✓）；未知 `session/update` → 记日志；
   未宣告的能力不尝试。**宁可吵闹的真相，不要安静的猜测**（README「Design rules」的原话）：
   这是缺口被发现、而不是"渲染成空白"的唯一途径。
4. **UI 适配层的两条硬规则**（[docs/PROTOCOL.md](docs/PROTOCOL.md) 末尾）：`session.text.*` / `session.tool.*`
   只**编辑**行，行不存在就**丢弃**事件 → **`session.step.started` 与 `session.tool.input.started` 必须先发**
   （只有它们创建行）；**回合结束必须关闭所有 open part**，否则转圈永不停止。
5. **路由顺序**：`/api/session/:id/permission/:rid/reply` 必须注册在泛匹配 `/api/session/:id(/.*)`
   **之前**（见 `src/server.ts` 的注释），否则被吞成 204，**权限对话框永久挂起**。
6. **任何 ACP 面的改动，先对规范。** 权威是规范本身 —— 不是我们的习惯 ✓，也不是别的项目的调研 ✓：
   拿出方法清单（`/tmp/acp-v1-methods.md`，或从 release 的 `meta.json` 重新导出 ✓）、stable 的 `schema.json` ✓、
   以及 `docs/ACP-MATRIX.md` ✓。**规范没答案时，停下来提出讨论** ✓ —— 不要自己发明一个方法或负载形状 ✓；
   确实要偏离，就必须写进 `docs/ACP-MATRIX.md`，带上理由与规范出处 ✓（就像 opencode 面在
   `scripts/check-openapi.py` 的 `ALLOWED` 表里登记那样 ✓）。unstable 方法（`schema.unstable.json`：
   `session/fork`、`providers/*`、`nes/*`、`session/set_model`）**存在**，但**只能**在规范给定的 capability
   门控之后使用 ✓ —— 无条件发 `session/set_model` 就是偏离。
   ★ 读源码要读**实装的那个版本**（`git show <tag>:<path>`），而不是本地 checkout 恰好停在哪 ——
   拿另一个版本读到的结论，对着实装的版本往往正好是错的。

7. ★★ **拿不准的 ACP 行为，先对齐 Zed。** Zed 是 ACP 的提出方（`../zed`），
   agent 作者实际上都是**对着 Zed 调通**的，所以 Zed 怎么读、怎么声明，就是事实上的标准。
   具体入口：`crates/agent_servers/src/acp/v1.rs` 的 `client_capabilities_for_agent`
   （它声明什么、`_meta` 里放什么键）与 `crates/agent_ui/src/conversation_view/thread_view.rs`
   （它按什么渲染卡片——例如 `matches!(tool_call.kind(), ToolKind::Execute)` 才画终端卡片）。
   **顺序**：ACP 规范原文 → Zed 的实现 → agent 的实际行为。三者冲突时按这个顺序信，
   并把结论写进 [docs/ACP-MATRIX.md](docs/ACP-MATRIX.md)。
   ★ 已按这条办的例子：`_meta.terminal_output` —— Zed 在 `initialize` 里声明
   `("terminal_output", true)`，agent 据此切换输出方言；我们照做后，
   `!command` 的卡片拿到真实输出，而不是 `{formatted_output, exit_code}` 那段 JSON。

8. ★★ **凡是 TUI 上的行为，自己在 tmux 里跑，不许交给使用者验证。** 本仓已经有
   `scripts/e2e-real-tui.sh`（真 opencode v2 TUI + tmux + 按屏幕断言），它能覆盖的就**必须**由它覆盖；
   它还没覆盖的，就**加一个 `MODE=`**，而不是让使用者手动试。**"我改了代码"不等于"屏幕上会显示"** ——
   这两件事之间隔着渲染路径，只有抓屏能证明。
   ★ 三条已验证的启动坑，照抄正确姿势：
   - **TUI 必须用绝对路径 + 登录 shell 起**：`tmux new-session -d -s rc "cd $W && zsh -lic 'cd $W && $OC --server http://127.0.0.1:$PORT'"`
     （`$OC=/Users/.../.opencode/bin/opencode`）。裸 `opencode` 在 tmux 里可能**没有 PATH，进程直接退出**，
     而 `tmux capture-pane` 会回 `can't find pane` —— 那看起来像"屏幕空白"，其实是**你的启动方式是坏的**。
   - **用 `--session` 打开旧会话做验收要先确认它真的进了会话路由**：早期实测它「可以不起会话」
     （客户端一个业务请求都不发），后来在 `scripts/e2e-epilogue.sh` 里复核出结论——**取决于桥怎么应答**：
     映射表里没有那个 id（或桥回了 404）时 TUI 就停在欢迎屏；给一个**已知的** id，
     bridge 日志里会出现 `GET /api/session/<id>` + `/message`，会话路由是开的。
     ∴ 判据不是「用没用 `--session`」，而是**日志里有没有那条 `/message` 读**（脚本就是这么等的）。
     要打开既有会话又不想赌，用已验证的 **`Ctrl+X` 然后 `L`**（session list）选中；
     或者按 e2e 的既有模式，用 `--server` 起 TUI 再驱动交互。
   - **断言必须落在屏幕上，不能落在 JSON 上**：`/api/session/:id/message` 里有某条数据
     **不代表** TUI 会把它渲染出来（`!命令` 卡片就栽在这里：JSON 有了，历史里却没有卡片）。
     判据是 `tmux capture-pane` 抓到的文本，而不是接口返回体。
   ★ 只有在**真 TUI 里无法复现**（例如需要真实模型额度、或依赖使用者本机私有配置）时，才可以请使用者帮忙，
   并且要在请求里写清：已经试过什么、卡在哪一步、需要看什么。

---

## 3. 架构速览

```
opencode v2 TUI ──HTTP + SSE(/api/*)──▶ 本进程 ──ACP stdio (JSON-RPC)──▶ 每个 agent 程序一条连接（会话多路复用）
             （界面适配层：实现细节）      （翻译层 + 会话投影）        （协议面：对外的真东西）
```

| 文件 | 职责 |
|---|---|
| `src/index.ts` | CLI 解析、单入口生命周期（默认起 TUI，`--no-tui` 退化）、agent 命令预检、opencode v2 二进制解析/版本门控、信号与退出清理、ready 行 |
| `src/server.ts` | 路由、会话动词、prompt/turn 生命周期、会话改名/标题、权限队列 |
| `src/sse.ts` | `/api/event`：fan-out、`server.connected` 握手、`Last-Event-ID` 环形回放、每 15s `: keepalive` |
| `src/state.ts` | sessions / messages / parts（内存） |
| `src/contract.ts` | 我们实现的 opencode v2 面（**观测得来，不是发明的**；推断处标 `INFERRED`）|
| `src/acp/client.ts` | spawn、JSON-RPC 关联与超时、反向请求应答 |
| `src/acp/capabilities.ts` | 协商 + 降级（`effectiveCapabilities` / `filterPromptBlocks` / `clientCallbackSupport`）|
| `src/translate/events.ts` | ACP `session/update` → opencode v2 事件（**本仓最核心的翻译层**）|
| `src/project.ts` | 内部消息 → 规范的 typed `Session.Message.Info`（历史/重载路径靠它）|
| `src/acp-replay.ts` | `session/load` 回放 → 客户端能渲染的 `HistoryEntry[]` |
| `src/opencode-bin.ts` | opencode v2 二进制解析（`$OPENCODE_BIN` → PATH）+ 主版本门控（`MIN_MAJOR_VERSION = 2`）|

**一个 agent 程序一条连接，会话在连接上多路复用，懒启动**（第一次 prompt 才 spawn）：同一 `(command, args)` 的会话共享一条 ACP 连接（各自的 config 目录、翻译器、历史互不串），不同 agent 各自一条；代价是一条连接崩了会带走它上面的所有会话。

---

## 4. 命令与验证

```bash
pnpm install
pnpm build        # tsc -p tsconfig.json && chmod +x dist/index.js   ← 是 tsc，不是 tsdown
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm verify       # ★ 总闸 = typecheck + 单测 + 文档链接 + 规范一致性 + smoke/entry/真 TUI（含取消）
pnpm verify:version 2.0.27  # 同一套门控跑在指定 opencode v2 release 上（npm 装到临时 prefix，
                  #   不碰你的 ~/.opencode；latest-v2 = npm 上最新的 >=2.0.0）
pnpm e2e          # = bash scripts/e2e-smoke.sh  假 agent + 真 HTTP，20 个场景
pnpm e2e:entry    # = bash scripts/e2e-entry.sh  单入口：起 TUI、退出码、零残留
pnpm e2e:todo:win # = node scripts/e2e-todo-windows.mjs  ★ Windows 版的 MODE=todo（那边没有 tmux）
                  #   用 node-pty 代替 tmux，在抓到的画面上断言 v2.1 的 todo 侧栏。
                  #   v2.0 上跳过（与 bash 版一致）；非 Windows 上什么都不做。
pnpm e2e:matrix   # = node scripts/e2e-matrix-real.mjs  ★ TUI 构建 × 真实 agent，每格三轮真实对话；
                  #   判定看 transcript + ACP 错误原文，**不看截屏**。**花 token。**三平台都能跑（不需要 tmux）。
pnpm e2e:conversation # = node scripts/e2e-real-conversation.mjs -- <agent>  单个 agent 三轮，
                  #   手动查某个 agent 时用。**花 token。**
pnpm e2e:protocol # = node scripts/e2e-protocol.mjs  ★ 唯一能在 Windows 上跑的端到端检查
                  #   （不需要 bash、不需要 tmux）：ready 行 → 会话 → 回合 → 真实目录
                  #   （不是 acp/default 占位）→ 模型切换 → 打断的应答形状
pnpm e2e:agent    # = bash scripts/e2e-real-agent.sh  真实 agent（必须 AGENT=<命令>；默认不发 prompt）
pnpm e2e:tui      # = bash scripts/e2e-real-tui.sh    真 opencode v2 TUI（tmux）：按屏幕断言 + 重载历史
                  #   MODE=cancel 那个模式查取消手势（自动把 agent 挂住，并让一个 shell 工具正在跑、其 failed
                  #   在取消之后才到——真实 agent 的样子；真的 Escape 要按两次）
                  #   AGENT=<命令> 换成真 agent（默认用假 agent）；如 AGENT="npx -y @agentclientprotocol/claude-agent-acp"
                  #   MODE=shell-history 验重载后 !命令 卡片是否还在（按屏幕断言）
                  #   MODE=patrol 把 TUI 全部斜杠命令逐个驱动一遍（面板存活 + 无 UnexpectedStatus + 留档）
                  #   MODE=cd 验 /cd 切目录：Moved 行、页脚、!pwd、agent 的下一轮回答都要跟上，
                  #   且重新 load 的回放不重复渲染
                  #   MODE=restore-turn 验「重启恢复后的会话再跑一轮工具调用」是否能上屏
                  #   MODE=restore-tab 验「重启后从 tab / session list 恢复会话」（你实际的使用路径）
                  #   MODE=stale-prompt 验「agent 仍报 active prompt」：桥先 cancel 再重试一次，
                  #   回复正常上屏，不出现 "already has an active ACP prompt" 红字
                  #   MODE=queue 验「回合运行中输入后续 prompt」：显示 N queued（不是 agent 的
                  #   "already has an active ACP prompt" 红字），且原回合结束后真的会执行
                  #   MODE=tool-stages 验「命令/查询在 in_progress 才到」的工具行：显示命令与分组搜索行，
                  #   不显示 "Writing command…" / "Searching web…" 占位标签
                  #   MODE=unsupported-verb 验 /compact、/btw、/undo 这类做不到的动词是否按规范失败（不再报 UnexpectedStatus）
pnpm e2e:epilogue # = bash scripts/e2e-epilogue.sh  退出 TUI 时回显的 Continue 行（真 TUI + tmux，4 个场景）
                  #   恢复后不输入就退出 / intent 压过另一个 tab 的 viewed / 只有 viewed / 什么都没有
pnpm e2e:dsh-acp # = bash scripts/e2e-dsh-acp.sh  ★ 真 agent 全功能验收（默认 `dsh --profile acp`，**花 token**：两三轮小对话）
                  #   起 TUI / 真回合 / 工具卡片 / !命令 / /model / /compact /btw / 回显 / `-s` 恢复（不重放）
                  #   跑完自动归档 dsh 的测试会话；不在总闸里（需要真 agent，见 e2e-real-agent 的同类约定）
```

- **测试现状（本机实测）：29 文件 / 480 passed / ★ 0 skipped。**
  README 的状态表是**手写的**，改动测试时记得同步它。
- ★ **不要引入 skip，也不要用 `fetch` 读 SSE。** vitest 下 `fetch` 会缓冲，读永远不返回；
  **用 `node:http`**（真 socket）。两个连带的事实：① 订阅是异步建立的，先 `openStream` 后立刻动作会丢掉最早的事件
  （现在 `await reader.ready`）；② 一个"事后才订阅"的读法**永远看不到更早的事件**（hub 的环形缓冲不给新订阅者重放）。
  ⟹ **skip 会掩盖 bug，而它们看起来像"环境问题"**。
- **路由形状也有单测**（`tests/routes.test.ts`）：`ServerInfo` 的必需字段、信封 `location` 只能是 `{directory}`、
  会话 `active` 的键与值、typed message、两种健康探测拼法 —— 正是真 TUI 抓到过的那几处。
  穷尽式的**逐 schema** 校验在 `scripts/check-openapi.py`（52 探针，需要 python3+jsonschema+网络），由 `pnpm verify` 跑。
- ⚠️ `scripts/e2e-smoke.sh` 里 `[ -f dist/index.js ] || tsc …`：**dist 已存在就不会重建**，
  而 `dist/` 可能还留着源码里已删掉的陈旧产物 → **跑 e2e 之前先 `pnpm build`**（`pnpm e2e` 不做这件事）。
- ★ **`scripts/e2e-agent-matrix.sh`：真 agent 的端到端矩阵**（[claude-acp](https://github.com/agentclientprotocol/claude-agent-acp)、[codex-acp](https://github.com/agentclientprotocol/codex-acp)、`opencode acp`、`dsh --profile acp`、`qwen --acp`，以及 gemini 的 `--acp`）。
  每个 agent 在**真终端**里跑一次完整回合，断言在**屏幕上**：起来、footer 是**真实模型**、回合走完、
  回复或 agent 自己的错误上屏、退出行是我们的。agent 自己的凭证/配置问题记为 **BLOCKED**（不是我们的失败）——
  如实传递错误本身就是桥的职责。每个 agent 的坑都写在脚本里（codex 的 catalog 拒 `"effort": "max"`；
  `opencode acp` 子命令没有 provider 凭证）。
- **`scripts/e2e-real-agent.sh` 是唯一碰真实 agent 的脚本**：**必须**用 `AGENT=<命令>` 指定要验的 agent
  （本仓不预设任何 agent）；**默认不发 prompt（不花 token）**，`PROMPT=1` 才发一条 → **要花 token，先问使用者**。
  它断言的是"真实模型列表已经到达"，不是"接口有响应"—— `/api/model` 在任何会话到达 ACP 之前会回**占位模型**
  `acp/default`，只数长度会把占位当成成功。
- 测试**不需要真的 opencode v2**：假 agent 在 `tests/fake-acp-agent.mjs`（`FAKE_ACP_*` 开关），
  假 TUI 在 `tests/fake-opencode-tui.mjs`（`FAKE_TUI_EXIT` / `FAKE_TUI_SLEEP_MS`，只回答 `--version` 就够过版本门控）。
  **要新的 agent 行为就扩展它们，别在测试体里 mock。**
- ★ **边界用例写成原始 JSON，不要写成对象字面量**（`tests/raw-updates.test.ts`）。对象字面量
  **表达不了**"字段不存在"，而 ACP 里"缺字段"与"值为 null"**语义不同**（规范只说
  `rawInput`/`rawOutput` 两者等价；其它字段缺省=不变）。Zed 为此建了
  `MaybeUndefined::{Undefined, Null, Value}`（`acp/terminal_updates.rs` 的
  `patch_preserves_omission_and_null`），照它办：把 agent 会发出的那段 JSON 原样贴进测试。
- ★ **每一帧都对着官方 schema 校验**（`tests/acp-schema.test.ts`）。行为单测证明的是"桥按预期动"，
  说不出"发出去的东西合规" —— 一个字段名写错（schema 要 `configId`，我们发 `configOptions`）
  能过掉所有行为断言，到真 agent 那儿才炸；`session/set_model` 就是这么烧掉一天的。
  用的是 ACP 项目自己发布的 schema（`agentclientprotocol/typescript-sdk` 的
  `schema/v1/schema.json`），**vendored 进 `tests/fixtures/acp-schema/`**，测试不联网；
  同目录的 `meta.v1.json` 带完整方法清单，所以"我们只调用存在的方法"也能一起断言。
- 提交前：`pnpm typecheck && pnpm test`；动了 HTTP/ACP 面再跑 `pnpm verify`（或至少 `bash scripts/e2e-smoke.sh`）。
- ★ **门控跑多全，按改动规模定，别机械全跑**：
  - **小改动**（文案、注释、个别断言、脚本小修）：`pnpm typecheck && pnpm test` 即可，**不跑完整 `pnpm verify`**——
    完整门控要十几分钟，为三行改动花这个时间是浪费。**想跑全量先问使用者**。
  - **大改动**（协议面、翻译层、**CLI 解析器**、路由行为、新增 MODE）：**直接跑完整 `pnpm verify`**，不用问。
    CLI 解析器尤其算大改动——它是一切路径的入口，词法分类错一处，e2e 全家都测不到那条分支
    （原生子命令的后续词被认领成目录，而 e2e 全走 `--no-tui`，根本不经过那条分支）。
  - ★ **跑全量时放进子智能体（subagent）后台执行**：
    不要在主会话里前台跑、也不要只用 `&` 挂在本会话——`pnpm verify` 要十几分钟，
    前台会卡住交互。让子智能体跑 `bash scripts/verify.sh > /tmp/verify.log 2>&1`，
    把结果（末尾几十行 + EXIT 码）回报；主会话只读结论。
  - 判断拿不准时，倾向问一句而不是猜。
- **改了 HTTP 面的形状，就跑规范一致性检查**：`pnpm verify` 会跑；单独跑用
  `python3 scripts/check-openapi.py --spec .cache/openapi.json`。它的 `ALLOWED` 表就是"我们故意不一样"的登记册，
  每条都写了原因。当前基线：**32 pass / 20 各自知情的 note / 0 fail**（52 探针）。
  显式登记的例子：信封 `location` 只是 `{directory}`、`parts` 与 typed message 字段并存、
  `/api/form` 与 `/api/form/request` 两种拼法都提供、`/api/health` 与 `/api/info` 都提供（客户端的健康探测端点搬过家）。
- **别让单测依赖本机真装了 opencode v2**：版本门控那条路径用 `OPENCODE_BIN=<path>` 指向假二进制即可
  （`tests/opencode-bin.test.ts` 就是这么做的）。

---

## 5. 已核实的事实与坑

### 5.1 ACP 与 opencode v2 两侧的硬事实

- **`session/update` 有 14 个变体**（ACP v1.25.0 schema）：我们**翻译 9 种**、`plan`/`available_commands_update`/
  `current_mode_update` **只记日志**、`notice`/`compaction_update`/`compaction_summary_chunk` **永远不会到达**
  （我们没有宣告 `session.notices` / `session.compaction`，而 opencode v2 也没有对应显示面）。
- **取消语义**：`POST /api/session/:id/interrupt`（旧的 `/abort` 同样提供）回
  `200 {interrupted: boolean}`；取消时 ① 把未完成工具收成终止态 ② 把挂起权限回 `cancelled`
  ③ 把挂起的表单按 `cancel` 结掉。e2e 场景 7 断言 agent **真的收到**了 `cancelled`。
- **取消的回合发 `session.execution.interrupted`**（不是 `succeeded`），而且**以我们自己的取消意图为准**
  （`record.interruptRequested`：`/abort` 置位、`beginTurn` 清除），**不只看 agent 的 stop reason** ——
  agent 被取消后照样可能回 `end_turn`。
- **`session/set_config_option` 的响应带的是完整配置状态**（所以我们存下来、不做合并），
  `config_option_update` 驱动模型选择器 → `session.model.selected`。
- **ACP 线上没有 `cancelled` 工具状态**（只有 pending / in_progress / completed / failed），但 agent 会发；
  必须按终止态处理，否则**转圈永不停止**。
- ★ **权限对话框在真 TUI 上已验证**：它以**页脚**形式渲染
  （`△ Permission required` + `⚙ Call tool …` + `Allow once  Reject`，底行提示 `⇆ select  enter confirm`），
  按键是 **左右选择、enter 确认、esc 拒绝**；按下之后 TUI 会 `POST /api/session/:id/permission/:rid/reply`，
  对话框消失、`/api/permission/request` 变空 ✓。并发时 tab 上会出现 `!` 注意力标记 ✓。
  ⟹ 页脚在屏幕**底部**：抓屏时不能只截前 20 行，否则看起来像"权限对话框没出现"。
- ★ **transcript 列表是"最新在前"**：`GET /api/session/:id/message` 替客户端做了 reverse（客户端自己会再 reverse 回来），
  所以**直接 flatten 这个列表不是事件发生顺序** ✗ —— 要判断交错顺序，得看**单条 assistant 消息自己的 `content[]`**。
- ★ **prompt 默认不设时钟**：`session/prompt` 可以跑任意长；其它控制类请求仍是
  **120 秒**。历史：先是一个 20+ 工具调用的 review 被 **2 分钟静默**判死，于是加了 30 分钟总超时；
  后来真实长任务又被这 30 分钟**总**超时误杀两次（agent 还在跑，TUI 红字 `timed out waiting for
  session/prompt`，agent 侧 prompt 仍 active，用户得手动“继续”）。ACP 没有服务端 prompt 超时，
  TUI 的 Esc/interrupt 才是用户的停止手段；`OPENCODE_ACP_CLIENT_PROMPT_TIMEOUT_MS` 设为正数可恢复时钟。
  ✓ **已由单测验证**：`tests/prompt-timeout.test.ts`（挂住 agent + `promptTimeoutMs: 400` → 598ms 内以
  `timed out waiting for session/prompt` 拒绝 ✓；反向也断言了 `promptTimeoutMs: 1` **不会**缩短
  `initialize`/`session/new` ✓）。
  ★ **超时参数必须在用它的地方生效**：`request()` 的 `setTimeout` 里要用**传进来的参数**，不是
  `this.timeoutMs`。而**断言要放在行为所在的层**——HTTP 层的探针会被无关原因干扰（回合不收尾 /
  `agent exited`）证明不了它，AcpClient 单测能。
- ★★ **回合被我们判死之后，agent 继续发的 tool call 会渲染成"静态历史"**（**没有转圈**，但结果照常出现）——
  实测时间线（真实会话，`msg_mv6gq6pwd`，超时把消息标成 completed 记作 T，**从 UI 读的 `content[].time` 量出**）：
  **24 次工具调用里有 6 次**起于 T **之后** ✗（最早 T+1.7s，最晚 **T+180s**），前 18 次都在 T 之前 ✓ ——
  也就是说它们是**在回合已经结束之后**到达的 ✓，UI 把新行画进一条已完成的消息里，自然没有进行中样式 ✓。
  ⟹ **"工具没有转圈了"与"任务无声停住"可以是同一个根因**（超时掐断 ✓），排查时先对齐时间线。
- ✓ **tool 的时间在 `content[].time` 里，不在 `state.time`**（`src/project.ts:130`）：
  `{created, ran, completed}` ✓ —— `created`/`ran` 是起点、`completed` 是终点 ✓；内部 part 里才是 `state.time.{start,end}` ✓。
  ⚠️ **这个字段查错曾导致错误的结论** ✗：查 `entry.state.time` 得到 `None` ✓，据此下结论"投影丢了时间" ✗✗ ——
  实际是**查错了字段** ✓。同一份数据换一个字段名就全在 ✓，而且 UI 读的正是 `content[].time` ✓。
  ⟹ **宣布"某字段缺失"之前，先确认自己查的是那个字段**（这条和"改了签名忘了改函数体"是同一类错误 ✓）。
- ★ **失败可能悄无声息，而且不止一条路**：① 回合**已开始**后失败 → 我们给消息设 `error` + `finish:'error'`，
  TUI 才有东西可渲染 ✓；② 失败发生在**回合开始之前**（`ensureAgent`：spawn / `initialize` / `session/new`）→
  那条 `await` 在 prompt 的 try 之外，请求直接失败、**不产生任何带错误的消息** → 界面同样"什么都没说"。
  ★ **② 已有处理**：prompt 路径 catch 它，开一个回合并用错误收尾
  （`session.step.failed` + transcript 里带 `error` 的 assistant 行），HTTP 形状与正常回合一致。
  教训仍然成立：**"请求失败"与"用户看到失败"是两件事**，新增的会抛错的 `await` 都要问一句"它失败时屏幕上有什么"。
- **`/api/model` 在任何会话到达 ACP 之前会回占位模型 `acp/default`**：验证真实 agent 时要断言
  "**非 `acp` 占位 provider** 的模型出现了"。
- **v2 的事件词汇**：转圈结束靠 `session.execution.succeeded|failed|interrupted`，**不是 `session.idle`**
  （客户端的 store 不处理 `session.idle`）。
- **环境变量**：选 bin 用 **`OPENCODE_BIN`**（**没有** `--opencode` 参数）；调试开关 6 个
  `OPENCODE_ACP_CLIENT_*` —— `_TRACE`、`_DUMP`、`_MESSAGE_PROBE`、
  `_PROMPT_TIMEOUT_MS`、`_RUN`、`_RECORD_FRAMES`；**没有旧名别名**。
  ★ **对外主名是 `opencode-acp-client`（包名/文档用），装出两个命令名**（主名 + `oc-acp-client` 短命令 alias）；
  状态目录与环境变量跟包名（`~/.opencode-acp-client/`、`OPENCODE_ACP_CLIENT_*`）**不变**——
  目录里已有使用者的会话映射，改名会直接丢失它们。
  ★ **桥的持久文件只有一张**：**会话 id 映射**（`~/.opencode-acp-client/sessions.json`，
  可用 `OPENCODE_ACP_CLIENT_SESSION_MAP` 改名/移位）—— 只存「客户端看到的 id → agent 自己的 id」、目录、可选 agent 标题，
  以及**创建它的 agent 命令**（`agent: {command, args}`）✓。**一个 client 只驱动启动命令指定的那个 agent**：属于其它 agent 的条目在采纳/`-s` 时**拒绝（404）**，TUI 的状态根也按 agent 隔离（`~/.opencode-acp-client/opencode/<slug>/`），所以别的 agent 的 tab 不会出现、它们的模型也不会混进新 tab 的列表 ✓替代原来的「按会话绑定它自己的 agent」）。
  ★ **没有 `agent` 字段的旧条目一律拒绝（404）**，不再「沿用本次启动的 agent」——那是在猜，
  混用 agent 的映射表里猜错就会把 dsh 的 id 交给 opencode，得到一个空 tab；日志会说明删掉该条目或整张表即可。
  **不存消息内容、不存凭证** ✓。**为什么必须写**：ACP 不允许客户端给新会话命名 ✓（`session/new` 无 id 字段 ✓，
  实测 dsh 也不认 `_meta.sessionId` ✓）→ 客户端记住的 id 与 agent 的 id **必然不同** ✓ → 不记这张表，
  恢复的 tab 只能开一个空的新会话 ✓。详见 `docs/ACP-MATRIX.md` 的那一节 ✓。
  `_TITLE_REQUESTS` 仍已删除（ACP 没有客户端设标题的方法 ✓）。
  ★ **只存「可见 id → agent id」这一种方向**：早期还额外写过「agent id → 它自己」的自映射，
  实测**没有任何读者**会用到它 ✗ —— 客户端请求的 id 永远来自桥展示给它的 `ses_…` 别名 ✓
  （实测 TUI 请求 `ses_ec3718af…` / `ses_acp_…`，从不请求裸 UUID ✓），而唯一的反查
  `visibleIdFor` 要求 `visibleId.startsWith('ses_')` ✓，自映射永远匹配不上 ✓。
  代价是**真实存在**的：自映射曾占真实文件的 **79/153 = 52%** ✓，而 `flush()` 按 `updatedAt`
  排序后截断到 `MAX_ENTRIES = 500` ✓ → 冗余会把有效映射**挤出上限** ✗。已移除 ✓。
  回归检查：`grep -rn -E 'ACP_BRIDGE_|ACPB_|ACP_OPENCODE_BRIDGE_|DSH_BRIDGE_' src tests scripts`（应为空）。

### 5.2 坑（都值钱）

1. ★ **客户端 store 不处理 `session.updated`**：以前发的标题/改名事件**全是静默无效**的 ✗。
   真正生效的是 **`session.renamed`** `{sessionID, title}`。凡是"发了个事件但 UI 没反应"，先去那个 store
   里 grep 事件名，**别猜**。
2. ★ **假 agent 必须区分"回答"与"请求"**：`onMessage` 先判"无 method 有 id = 回给我的响应"，
   否则回调往返根本闭环不了，而测试看起来还是绿的。
   ⟹ **"我们发了事件"与"对端收到了"是两件事，必须分别断言**。
3. **`session.created` 必须带 `sessionID`**：客户端 store 读 `event.data.sessionID`，只带 `{session}` 会让它
   去同步一个叫 `undefined` 的会话（日志里真会出现 `GET /api/session/undefined`）。
4. ★ **读 transcript 要两步**：`GET /api/session/:id/message` 只回**消息头**，**parts 在 `/message/:id`** 里。
   只读列表会得出"模型没回话"的结论（该结论是错的 ✗）。而且客户端重载时**只读列表** ⟹ 列表项必须是
   规范的 typed `Session.Message.Info`（见坑 6）。
5. ★ **只 stream 不 store，历史一定是空的**：prompt 的文本以前只发事件、没存进 state，
   于是历史里那条 user message 没有 part，投影出来 `text: ''`（用户那行空着）。修法：同一处 `state.upsertPart(...)`。
6. ★ **投影层必须按规范**（`src/project.ts`）：`/message` 与 `/message/:id` 回
   `Session.Message.Info`（user 带 `text`、assistant 带 `agent`/`model`/`content[text|reasoning|tool]`），
   历史 id 补 `^msg_` 前缀；`parts`/`role`/`sessionID` 作为**登记在册的超集**保留。
7. ★ **真 TUI 的验收要按屏幕断言，而且只断言"有字"不够**：假 agent 的回复若与 prompt 同串，
   一句 echo 能同时骗过用户行和助手行 ✗ —— 用 `FAKE_ACP_REPLY` 设成不同的串，并要求
   用户行 / 思考块 / **工具卡片+输入** / 回复 / agent·模型 footer **全部**出现。抓到的屏幕存 `.artifacts/`。
8. ★ **表单的"起始页"是竞态的 —— 别数按键，读提示行** ✗：TUI 的表单每字段一屏 + 一个汇总屏，
   提示行分别是 `enter confirm` / `enter toggle` / `enter submit` ✓。**提交 prompt 的那个 Enter 可能落在表单出现之后**
   ✓，把表单顺手推进一格 ✗ → 同一个脚本，这次开局在 `Strategy`、下次开局就在汇总屏 ✓。
   "从假定起点数 Tab"必然时对时错，看起来像"同样设置、结果不同"。修法：**先读提示行把位置归一化**，
   再作答、再走到 `enter submit`（`scripts/e2e-real-tui.sh` 的 `MODE=form`，断言到"TUI 真的 POST 了 reply +
   表单关闭 + 无残留"）。
   ⟹ 与"取消手势"那条同理：**界面交互要按状态驱动，不要按次数驱动** ✓。
9. ★ **取消手势是「Escape 按两次」**（5 秒内；第一次只是 armed，footer 从 `esc interrupt` 变成
   `esc again to interrupt`），发 `POST /api/session/:id/interrupt?resume=true`，期望
   **`200 {interrupted: boolean}`**。回 204 会让真客户端每次取消都记一条
   `unhandled rejection: UnexpectedStatus: 204`。
10. ★ **一个假前提能让测试"证明"出完全错误的结论**：测试取消手势时，如果 agent 没被挂住，
   回合会瞬间结束 → 取消命令是 disabled 的，于是测试"证明"了「Esc 什么都不发」。跑取消类用例前
   先让 agent 真的挂住。
11. **agent 侧坏掉时表现得像客户端 bug**：某个 agent 的插件导入失败时，它可能只把回答写进会话标题、
    **不发 `agent_message_chunk`** —— 界面上就是"模型什么都没说"。遇到"没回话"先用
    `OPENCODE_ACP_CLIENT_TRACE=1` 看桥有没有收到 chunk，**再**怀疑客户端。
12. ★ **改了函数签名，一定回头改函数体**：`request()` 加了 `timeoutMs` 参数 ✓，但 `setTimeout` 里仍写
   `this.timeoutMs` ✗ → 调用方传的超时**被静默忽略** ✓。症状是"修复看起来生效、实际没生效" ✗，
   而**在错误的层做验证会掩盖它**：HTTP 层的两次探针都因无关原因失败（回合不收尾、agent 退出）✗，
   直到直接在 `AcpClient` 上断言才当场暴露 ✓。⟹ **断言要放在行为所在的层**。
13. **不同 agent 的启动速度差很多**（实测有 ~8s 才 `session/new` 完的），`waitForCatalog` 的 12s 是**真的**截止
    （`Promise.race`），别把它改回裸 `await`。
14. ★ **能力门控要放在真正发请求的那一层**：只在调用点判断（"看 `loadSession` 决定走不走"）不够 ——
    解析结果里也得有这项能力（`EffectiveCapabilities` 要解析 `sessionCapabilities.*`），并且
    **在 `AcpClient` 的方法里再门控一次**，这样任何新调用点都不可能绕过。否则对不宣告它的 agent
    照样会发请求（规范 MUST NOT），被拒后还会逃出会话启动路径。守卫测试：`tests/capabilities.test.ts`。
15. ★ **手写客户端的持久化文件必须照抄它的真实形状**：TUI 的 `tabs.json` 真实形状是
    `{global:{…}, cwd:{<目录>:{tabs:[…]}}}`；写成 `{<目录>: {tabs:[…]}}` 会让 TUI 启动即崩
    （`TypeError: undefined is not an object (evaluating 'g.cwd[u.cwd]')`），且看起来像「桥把客户端搞崩了」。
    ∴ 造客户端状态时，**先读一份它自己写的文件**，别照文档里的片段拼。

---

## 6. 进程与环境纪律（血的教训）

- **只用显式 PID / 进程组结束子进程**；✗ **绝不 `pkill -f '<name>'` 按名字批量杀** —— 会误杀使用者的编辑器/其它会话。
  现有 `AcpClient.dispose()` 的形状（SIGTERM → 3s → SIGKILL）是对的，保持。
- **别用 grep 判断一个 ACP 实现的能力**（会被 vendored SDK 污染）—— **实跑 `initialize`** 看它到底宣告什么。
  `OPENCODE_ACP_CLIENT_DUMP=<path>` 能把 `session/new` 的原始响应落盘，`[acp] initialized: {…}` 那行日志是
  能力矩阵的唯一 ground truth。
- 探测**只用临时 profile / 临时目录**，**别碰**使用者已有的配置；探测**不要**调会真删数据的动词。
- ★ **真 agent 测试的会话必须归档**。真实 agent（如 dsh）把会话写进**它自己的存储**
  （dsh 在 `~/.dsh/sessions/<工作区>/<sid>/`），会出现在它的 web UI 里——实测 dsh 宣告的
  `sessionCapabilities` **没有 `delete`**（`session/delete` 发过去甚至挂起不答），ACP 删不掉。
  所以：①能用假 agent 就用假 agent；②确需真 agent 时，**测试结束必须跑**
  `python3 scripts/archive-test-sessions.py`——它把测试会话**移动**（不是删除）到
  `~/.dsh/sessions-archived-bridge-tests-<时间戳>/`，并写 inventory JSON（与使用者自己的
  `sessions-archived-*` 惯例一致）；判定只收**测试工作区**（tmp/e2e 目录）和**今天创建的
  空会话或含测试标记的会话**，真实会话一律不碰。
- ★ **`pnpm add @opencode/cli` 会留下一个空壳，`existsSync` 分辨不出来**。pnpm 12 默认跳过这个包的
  postinstall，而 postinstall 正是把真正约 200 MB 的二进制拷进来的步骤——剩下的是一个 229 字节的壳：
  文件**存在**，只在执行时才失败（Windows 上是 `not a valid Win32 application`）。安装前先在
  `package.json` 同级放一个 `pnpm-workspace.yaml` 写 `allowBuilds: {'@opencode/cli': true}`，
  并且**看体积，不要只看存在**。
- ★ **临时探针结束后必须核对孤儿进程**：
  ```bash
  ps aux | grep -E "dist/index.js|bin/dsh --profile|fake-acp-agent"
  ```
  **`tmux kill-session` 不回收孙进程** —— 桥被杀后，它 spawn 的 agent 会变成
  `ppid=1` 的孤儿继续活着。实测的后端是**单写者**模型（dsh），孤儿占着工作区锁时，
  后来者的 `session/load` 必然失败（"Internal error"），症状是**恢复会话空白**，
  而桥自己的日志看起来一切正常；同样的孤儿还会让"Continue 行没改写"看起来像改写逻辑坏了。
  ⟹ **排查"恢复空白/加载失败"的第一步就是这条命令**；committed 的 e2e 脚本有
  cleanup trap，但**手写探针没有**，所以每次探针后自己核对。
- 调试开关**用完就关**：`OPENCODE_ACP_CLIENT_TRACE` 会把每个 HTTP 请求和每个 ACP 帧都写进日志（很吵）；
  `OPENCODE_ACP_CLIENT_MESSAGE_PROBE` 是「消息消失」那个 bug 的观测器。
- **要看 `[http]` 日志就得用 `--no-tui`**：默认模式下 TUI 占着终端，我们把日志落到 `$TMPDIR` 下的文件
  （**任何一行杂散输出都会撕裂 TUI 渲染**）；纯服务端模式下日志直接走 stderr。stdout 永远是保留的（ready 行 / ACP 线）。
- **同时只能有一个「起 TUI」的进程**：随机端口 + 一个 TUI 子进程，别并发跑两个。
- 别 `pnpm link --global .`：它把这个包变成它自己的依赖，改 `package.json`/lock，并要清 `node_modules`。
  用 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)「从源码运行」里的软链或 wrapper。

---

## 7. 外部面（改了会波及谁）

| 谁 | 依赖什么 | 状态 |
|---|---|---|
| **opencode v2 官方** | 我们实现 opencode v2 的 `/api/*`：**公开的 OpenAPI 3.1.0**（<https://opencode.ai/v2/docs/api>、机器可读 `/v2/openapi.json`）| 视为**契约**；`pnpm verify` 逐路由校验，故意差异登记在 `ALLOWED` 表里。版本策略见 [docs/COMPAT-OPENCODE.md](docs/COMPAT-OPENCODE.md) |
| **opencode v2 客户端** | 用 `--server <url>` 指向本桥 | 界面层；**只验证 TUI**（按屏幕 e2e）。★ 其它客户端暂不推荐：状态根是我们注入给 TUI 子进程的，别的客户端拿不到，tab 不按 agent 隔离 |
| **ACP agent** | 任何说 ACP、走 stdio 的命令 | 不绑定任何实现；已驱动过的清单在 README，降级规则在 [docs/ACP-COMPAT.md](docs/ACP-COMPAT.md) |
| 使用者 PATH 上装的旧 bin 名 | 历史名字 | **已决定不保留兼容别名**（想要兼容就在自己的启动器里加一级回退）|

---

## 8. 已定

**已定（照做，别再问）：**

1. ★ **不保留环境变量的旧名别名**；选 bin 只有 `OPENCODE_BIN`，且**没有** `--opencode` 参数。
2. **bin 名**：对外主名 **`opencode-acp-client`**（包名、文档用）；`oc-acp-client` 只是短命令 alias。发布两项、指向同一入口。
3. **对外身份**：community-maintained、非 opencode v2 官方；方向是"借 opencode v2 的 TUI 去消费任意 ACP agent"。
4. ★ **LICENSE = Apache-2.0**。理由：**不链接任何第三方源码**——
   桥是把 opencode 二进制作为独立进程启动、走它公开的 HTTP 接口面，所以不继承对方许可，
   本许可独立成立。选 Apache 而非 MIT 的实质理由是**专利条款**：面向企业开发者时法务看这一条，
   且与 ACP 生态一致（claude-code-acp / codex-acp / claude-agent-acp 都是 Apache-2.0）。
   版权行写的是**社区形式**（`Copyright 2026 opencode-acp-client contributors`），不署个人或公司。
5. **品牌一致性**：`--help` 保持英文，README 保持双语。
6. **对称产品**（别的 TUI + 同一个桥）是**另一个仓**的事，不在本仓范围内。
7. ★★ **和原生 opencode 一样的 TUI 行为，不是需求，是基线。** 不加桥开关、不注入配置，
   **也不写文档**：跑 `opencode` 的人、跑 `oc-acp-client` 的人看到的东西一样、改法也一样，那这个项目
   就没有要补的。写下来是在宣称一个并不存在的差异，加一个旋钮则会让两边慢慢走散。

   ★ **为什么做得到**：桥只重定向 `XDG_STATE_HOME` 与 `XDG_DATA_HOME`（按 agent 隔离，为了 tabs 和 db），
   **故意不动 `XDG_CONFIG_HOME`**，所以 `cli.json` / `tui.json` 两边是**同一份文件**——改一处两边生效。
   于是 TUI 自己能设的每一项（`/settings`、斜杠命令、keybind）在这里本来就"支持"；动手前的检查只有一个：
   **"原生 opencode 用户是不是本来就有这个？"**，答案是"有"就**什么都别做**。

   ★ 实测的例子：v2.4 把 `session.verbosity` 默认设成 `low`、`session.thinking` 设成 `hide`；
   `/settings` 两项都能翻，改的正是两边共读的那个文件。遇到"我们的工具调用被折叠了"这种反馈，
   回复应该是 opencode 自己的行为，而不是一个补丁。

   ★ 反过来依然成立：**和原生 opencode 不一致**的行为是缺陷（见非商议第 4 条）；
   **opencode 根本无法表达**的东西是缺口，归 [docs/ACP-COMPAT.md](docs/ACP-COMPAT.md)。
   本条只覆盖第一种情形。