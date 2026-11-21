# 场景矩阵 —— 假 agent 能演什么，以及由什么证明

> English: [SCENARIOS.md](SCENARIOS.md)

假 ACP agent（`tests/fake-acp-agent.mjs`）用 `FAKE_ACP_SCENARIO=<名字>` 选择。一个场景 = 一组
**自洽**的行为；原有的 `FAKE_ACP_*` 开关个个别可用。下表的"由谁断言"指的是**客户端做错时会红**
的那个测试 —— 而不是"agent 复述了自己被告知的话"因而通过的测试。

#### `!命令` 既会在正文内联渲染，也仍可在 shell 输出对话框查看

读自实装的 v2.0.28 客户端：composer 的 shell 标签页会打开
`<DialogShellOutput shell={entry} location={entry.location} />`，并按游标分页读取
`GET /api/shell/:id/output`（`PAGE_BYTES = 64 * 1024`）。正文也会通过 shell 的工具行内联渲染命令输出。

### `!命令`（shell）—— 两种启动形态都已屏幕验收

TUI 发 `POST /api/session/:id/shell`；桥会等命令结束后发
`session.shell.started` 与 `session.shell.ended`。后者必须携带上游 v2 的 **`Shell.Output` 信封**，
而不是字符串：`{ output, cursor, size, truncated }`。`stream-v2.transport.ts` 会把该对象传给
`shellTerminal()`，直接读取四个字段；旧的纯字符串让这些字段变成 `undefined`，于是**单入口** TUI 的卡片为空。

`MODE=shell` 会跑 `!echo SHELLIN | tr A-Z a-z`，并要求屏幕出现 `shellin`。它现在在
`pnpm verify` 里分别跑普通的“桥/TUI 分开”形态与 `ENTRY=1`（产品实际的一条命令启动形态；缺陷原来就在这里）。
桥还会发关联的工具 part（`metadata.shellID`、`input.command`、`input.workdir`），供该行读取。

## 从官方 TUI 测试借来的传输契约

- **SSE 重连：**使用真实 `node:http` stream 带 `Last-Event-ID` 重连；hub 必须先发
  `server.connected`，再按顺序只回放漏掉的 durable 事件，普通会话列表快照仍要包含漏掉的会话。
  这保护官方 TUI 的“断线后重连/重新收敛”那一侧桥契约。
- **重连后的 pending 收敛：**断线期间回答 permission 后，重连必须回放 `permission.replied`，
  pending permission 列表中也不能残留该请求；断线期间取消 form 同样必须回放 `form.cancelled`，
  两个 form 列表也不能残留。
- **shell 游标与最终 flush：**全局 shell 路由在输出增长时按 UTF-8 **字节** cursor 轮询；退出后的最终读取必须到达
  `cursor === size`、保留完整文本，`Number.MAX_SAFE_INTEGER` 则返回已追平的空页面。这是官方
  shell-output viewer 消费的桥契约。
- **shell 删除：**`DELETE /api/shell/:id` 必须终止并移除 shell；后续 get / output 为 `404`，
  shell 也不再出现在列表中。
- **多会话隔离：**两个同时活跃的会话分别中断；其中一个结算后只能从 `/api/session/active` 移除自身，
  另一个必须仍保持运行。
- **分页健壮性：**畸形 cursor 按"从头开始"处理而不是报错；超出末尾的 cursor 是干净的空页；
  同一 cursor 返回同一页；两个会话并发翻页绝不混行。
- **对抗性 ACP call id：**ACP 调用 id 长得像 content part（`reasoning:0`）时，行 id 仍是桥自己的
  `prt_*`，因此没有任何东西按 id 形状分类。
- **prompt 重试幂等：**同一个客户端消息 id 重试只产生一条用户消息和一条 agent 回合，
  不会重复转录内容；被拒绝的 prompt 不得在转录中遗留幽灵用户消息。
- **会话查看确认：**终态回合记录 `outcome` 与 `time.idle`；官方的
  `POST /api/session/:id/view` 只能确认该精确 idle 水位，并发出 `session.viewed`，因此过期查看不能把更新结果误标为已读。
- **转录分页：**按 newest-first 返回的 `limit` / `cursor` 页面必须互不重复、最终到达空 cursor，
  并在跨页时保留全部用户与助手消息。
- **表单终态竞态：**一次 reply 或 cancel 结算表单后，过期的 reply / cancel 必须回 `404`，
  pending form 列表为空，底层回合仍要进入终态。

## 其中哪些是**真的驱动了 opencode v2 TUI** 的

下表里大多数行是通过 HTTP 面断言的（`scripts/e2e-smoke.sh`）或在客户端上直接断言（vitest）。
**十几个运行**（15 个 `MODE=` 分支）会在 tmux 里驱动真 TUI（`scripts/e2e-real-tui.sh`），而且各测一种交互或启动形态：

| 模式 | 命令 | 它证明了什么 |
|---|---|---|
| `history`（默认）| `pnpm e2e:tui` | 一个回合的每一层都能在屏幕上渲染；重开会话后同样的层能从历史渲染出来 |
| `stale-prompt` | `MODE=stale-prompt bash scripts/e2e-real-tui.sh` | agent 仍报有 active prompt：桥先 cancel、重试一次，回复照常上屏，不出现 `already has an active ACP prompt` |
| `queue` | `MODE=queue bash scripts/e2e-real-tui.sh` | 回合进行中输入的后续 prompt 显示成 `N queued`，绝不出现 agent 的 "already has an active ACP prompt" 错误，并在该回合结束后执行 |
| `tool-stages` | `MODE=tool-stages bash scripts/e2e-real-tui.sh` | 工具的输入晚于 pending 帧到达（opencode v2 的形状：先 `{cwd}`，命令/查询随 `in_progress` 来）时，行渲染出真实命令与查询，不卡在占位标签 |
| `permission` | `MODE=permission bash scripts/e2e-real-tui.sh` | 权限页脚渲染出来、按键真的到达、TUI **真的** POST 了 `/permission/:id/reply` |
| `form` | `MODE=form bash scripts/e2e-real-tui.sh` | 表单渲染 → 作答 → 提交 → 关闭，且无残留待答 |
| `cancel` | `MODE=cancel bash scripts/e2e-real-tui.sh` | Escape 按两次真的到达客户端：`session.interrupt`，且 agent 收到 `cancelled` |
| `shell` | `MODE=shell bash scripts/e2e-real-tui.sh` | 桥/TUI 分开启动时，变形后的 `!命令` 输出会渲染 |
| `shell` + `ENTRY=1` | `ENTRY=1 MODE=shell bash scripts/e2e-real-tui.sh` | 产品实际的一条命令启动形态同样会渲染该输出 |
| `shell-history` | `MODE=shell-history bash scripts/e2e-real-tui.sh` | 重启 TUI 并重开该会话后，`!命令` 行**连同它的输出**仍在屏幕上 |
| `patrol` | `MODE=patrol bash scripts/e2e-real-tui.sh` | 把 TUI 自带的全部斜杠命令逐个驱动一遍：面板存活、无 `UnexpectedStatus`、每命令留档抓屏（它的第一次运行就抓到 `/rename` 在声明 204 的路由上回 200） |
| `cd` | `MODE=cd bash scripts/e2e-real-tui.sh` | `/cd` 端到端移动会话："↳ Moved to" 行、页脚、`!pwd`、以及 agent 自己的下一轮回答都跟着新目录走，且重新 load 触发的回放不会渲染两遍 |
| `unsupported-verb` | `MODE=unsupported-verb bash scripts/e2e-real-tui.sh` | `/compact`、`/btw`、`/undo` 在屏幕上给出可读失败，绝不出现 `UnexpectedStatus`；而规范声明为空的动词仍得到 204 |
| `restore-turn` | `MODE=restore-turn bash scripts/e2e-real-tui.sh` | 重启并恢复会话后，**新一轮**回合的工具调用要上屏（且回合要结束） |
| `restore-tab` | `MODE=restore-tab bash scripts/e2e-real-tui.sh` | **使用者的实际路径**：关掉程序 → 重开 → `ctrl+x` `l` → 选中会话；转录要回来，且卡片不得显示占位模型 |

表里其余各行都是 API 级或单测级。这不是形式主义：本项目**三个真 bug** 都是因为驱动了真 TUI 才发现的
（`session.created` 缺 `sessionID`、只 stream 不 store 导致用户行是空的、以及**取消**应答回了 204 ——
真客户端每次都会记一条 `UnexpectedStatus`）。
抓到的屏幕存在 `.artifacts/`。

| 场景 | agent 干什么 | 由谁断言 | TUI 渲染成什么 | 渲染不了的原因 |
|---|---|---|---|---|
| `rich-turn` | 思考、调工具、再回复 | smoke 11 | 思考块、工具卡片、回复 | |
| `plan` | 发一个 `plan` 更新 | smoke 12 | **什么都不渲染** | opencode v2 没有 todo 面。v2.0.28 上实测：屏幕上只有回复。我们只记日志（`ACP plan update … has no opencode v2 surface`）|
| `todo`（`FAKE_ACP_TODO=1`） | 用一份已完成的 todo 列表调 `todowrite` | **真 TUI `MODE=todo`** | 侧栏 `Todo` + 已完成/进行中/待办行 | |
| `permission` | 请求权限并**等待**回答 | smoke 13（批准 + 拒绝）、**真 TUI `MODE=permission`** | 页脚 `△ Permission required` + `Allow once / Reject` | |
| `elicit-form` | 提一个结构化问题 | smoke 14（取消路径）、**真 TUI `MODE=form`（渲染 → 作答 → 提交 → 关闭）** | 每个字段一屏 + 一个汇总屏；提示 `enter confirm`、`enter toggle`、`enter submit` | |
| `elicit-url` | 用 `url` 模式提问 | smoke（拒绝）| 什么都不渲染 | 我们只宣告 `form`，而规范禁止用表单应答 url 请求，所以我们回 `-32602` |
| `title-and-model` | 改会话标题、切模型 | smoke 15 | 新标题、footer 里的新模型 | |
| `interleaved` | 思考、文本、工具、思考、文本 | smoke 16 | 两个思考 part、两个文本 part，工具位于中间 | |
| `slow` | 回合中途停顿（`FAKE_ACP_DELAY_MS`）| smoke 17 | 先"正在工作"，然后回复 | |
| 慢 `session/new` | 把 `session/new` 延迟 2.5s（`FAKE_ACP_DELAY_SESSION_NEW_MS`）| 单测 | 输入框出现得晚；模型目录仍拿到真实模型，而不是 `acp/default` 占位 | |
| `crash` | 回合中途退出 | smoke 18、单测 | 它死前发的东西；回合仍然收尾 | |
| `error-turn` | 先回复，再以 `stopReason: 'error'` 结束 | smoke 9、单测 | 那半段文本 + 失败 | |
| resume-capable（`FAKE_ACP_CAPS_RESUME=1`） | 宣告 `session/resume` 并接受，但不重放任何东西 | 单测 + **真 TUI `scripts/e2e-epilogue.sh`** | tab 保留**真名**（无标记），屏幕从空白开始，并有一条 `◈ Notice` 说明 agent 没有 `session/load` | ACP 把 `session/resume` 定义为「重连但**不**重放历史」。真机实测（plain `acp`，）：下一轮能跑，而**模型是否记得这段对话随模型而变**——所以假 agent 不重放、文档两种都不承诺 |
| resume-fails（`FAKE_ACP_RESUME_FAILS=1`） | 宣告 `session/resume` 之后拒绝 | 单测 | 一个**新**对话，标题 `[new conversation] <目录名>`，会话区一条 `◈ Notice` 说明旧会话打不开，日志写原因 | 旧会话接不回来；桥用可用的 tab 兜底并如实说明 |
| 完全不能重连（假 agent 的默认） | 既不宣告 `loadSession` 也不宣告 `session/resume` | 单测 | 新对话，标题 `[new conversation] <目录名>`，会话区一条 `◈ Notice` 说明 agent 不能重开会话；两个方法都不调用 | ACP 规定没有对应能力就不能调 |
| `error-response` | 对 `session/prompt` 回 JSON-RPC 错误 | 单测 | 失败 | |
| `late-reasoning`（`FAKE_ACP_LATE_REASONING=1`） | 在 prompt 结果**之后**才发 `agent_thought_chunk`（dsh 的后台任务） | 单测：`session.step.ended` 之后不再出现 `session.reasoning.*` | 没有多余行 | 回合已关闭，迟到的推理被丢弃 |
| `hostile` | 发未宣告的、未知的、缺字段的更新，还给**不存在的工具**发 update | smoke 8、单测 | 回复；未知更新只记日志、不渲染 | |
| `tools-many` | 一个工具成功、一个失败、一个被遗弃 | smoke 10、单测 | 三张卡片；被遗弃的那个被**收成终止态**而不是一直转 | |
| `images` | 宣告支持图片 prompt（以及一个不宣告的）| 单测：转发 ✓、大声丢弃 ✓、大声拒绝 ✓ | — | |
| | | | | **已修。** prompt 面现在会把 TUI 的 `files` 构造为 ACP image 块；`filterPromptBlocks` 仍按 agent 宣告的能力把关（并记日志说明丢了什么）；而**没有 ACP 通路**的附件（比如 PDF）会以 **400 + 可读原因**被拒绝，而不是静默丢弃。这个结论来自**读 TUI 自己的负载类型**，不是猜的。**已端到端验证（真 TUI + tmux）：** `@` 选择器走 `GET /api/fs/find` 搜索（已实现：广度优先子串搜索 —— 早先这里恒答空，导致每个 `@` 都显示 “No matching files”，图片这条路的入口是死的）；选中的文件以 `file://` URI 传来（v2.0.30 实测 —— **不是** schema 暗示的 base64 `{data}`），桥读字节后转发成 base64 的 ACP image 块，支持图片的假 agent 的回复 `you said: … images:1` 渲染上了屏。非图片的 URI 以可读的 400 拒绝，绝不静默丢弃。由三个单测钉住（`fs/find` 的搜索形态、file-URI 的 image 块、拒绝路径）。**仍未验证**：真 TUI 里从附件到上屏的整条链路 —— 上面每一步都单独验过，但没在同一次真实会话里连起来跑过 |
| `usage` | 上报 `usage_update` `{used, size}` | 单测 —— 断言 SSE 事件 `session.usage.updated` | 侧栏计量与行上的 token/费用字段 | |
| `long-output` | 工具返回 400 行，回复按 17 字符分片 | 单测 | 完整结果 —— 断言投影后仍 >10KB | | |

斜体行是缺口。**没有断言的场景只是夹具，不是测试**：要么补断言，要么像这张表一样把它记为缺口。
