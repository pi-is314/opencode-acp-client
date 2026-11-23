# ACP 兼容性与降级

> English: [ACP-COMPAT.md](ACP-COMPAT.md)

ACP 是一个**协商型**协议：每个 agent 宣告自己的能力，桥只能调用和宣告已经协商到的能力。
本文记录本桥与 ACP、opencode v2 HTTP/TUI 面之间的兼容与降级规则。各 agent 的探测记录、模型数量和
运行笔记属于开发内容，放在 [DEVELOPMENT.zh.md](DEVELOPMENT.zh.md)。

**边界：**[ACP-MATRIX.zh.md](ACP-MATRIX.zh.md) 是细节与规范优先的权威来源：方法清单、全部
`session/update` 变体、故意偏离与 HTTP 映射。本文是较短的运行时指南：协商能力处理、降级规则，以及
opencode v2 TUI 没有对应 ACP 能力的面。

## 准则

> 没有被广告出来的能力，一律视为**不存在**。不做任何乐观尝试，也不留下任何
> 未应答的请求。

有两条失败模式驱动着这条准则：

- **挂死。** 一个未被应答的 agent→客户端 请求会永久阻塞住那个 agent。agent 那一侧
  没有超时。所以我们要**总是**回答，哪怕是拒绝。
- **静默 no-op。** 一个 agent 接受、但并未实现的请求，可能会以空结果 resolve，
  于是 UI 上什么都不显示。这比报错更糟，因为没有任何东西可供排查。

这条准则**双向**成立，也正是它让客户端保持"通用"、而不是绑死某一个 agent 的形状：我们只宣告能兑现的，
而在我们宣告的能力下，agent 合法发来的一切我们都接。

`session/list` 会先检查 `sessionCapabilities.list`，没有就拒绝调用。
见下面的降级表。

## 本客户端宣告了什么

`initialize` 发的是 `clientCapabilities: { elicitation: { form: {} } }` —— 只有一个常量，
即 `src/acp/capabilities.ts` 的 `CLIENT_CAPABILITIES`，由 `tests/capabilities.test.ts` 守卫。

| 宣告了 | 背后的通路 |
|---|---|
| `elicitation.form` | `AcpClient.onRequest('elicitation/create')` → `BridgeServer.awaitElicitation` → TUI 的表单路由 |

| 故意不宣告 | 原因 |
|---|---|
| `elicitation.url` | 没有浏览器面可开，而且规范明确禁止对 url 模式所负责的敏感流程回退到 form |
| `fs.readTextFile` / `fs.writeTextFile` | 未实现；agent 该用它自己的工具，真来调只会拿到明确的 `-32601` |
| `terminal` | 同上；TUI 的 `!` shell 是本地 HTTP 路由，不是 ACP 回调 |
| `session.notices` | opencode v2 没有渲染 notice 的落点，宣告只会产生没人显示的事件 |
| `session.compaction` | 同上：v2 没有压缩面 |
| `session.configOptions.boolean` | 只投影 `category: "model"` 与 `thought_level`；布尔开关无处可放 |

按 ACP，agent **MUST NOT** 请求我们未宣告的模式 —— 而未宣告模式的请求会被回 `-32602`，
不会被悄悄处理掉。

## 能力矩阵

| ACP 能力或方法 | 桥的行为 | opencode v2 结果 |
|---|---|---|
| `initialize` | 协商并记录 agent 能力 | 启动能力状态 |
| `session/new` | 第一次 prompt 时懒创建 agent 侧会话 | 正常会话生命周期 |
| `session/prompt` | 转发已支持的 prompt block；使用独立的 prompt 超时 | 流式回合 |
| `session/update` 的文本、思考、工具变体 | 翻译支持的变体 | 文本、思考、工具行 |
| `session/request_permission` | 排队并回用户决定或 `cancelled` | 权限页脚 |
| `session/load` | 仅在 agent 宣告能力后调用；失败会明确记录并退回新会话 | agent 给出回放数据时恢复上下文 |
| `session/list` | 仅在宣告 `sessionCapabilities.list` 后调用 | 可选的 agent 会话发现/标题查询 |
| `promptCapabilities.image` / `embeddedContext` | 仅在宣告后转发 | 有能力时支持附件/上下文 |
| agent → client 的 `fs/*` / `terminal/*` | 从不宣告；即使收到也回 `-32601` | 不发明 TUI 面 |
| agent → client 的 `elicitation/create`（`form`） | 在符合已宣告 form 能力时支持 | 表单对话框 |
| 未宣告的 elicitation 模式或未知反向请求 | 明确拒绝（`-32602` 或 `-32601`） | agent 不会挂死 |

## 桥怎么降级

| 时机 | 行为 | 位置 |
|---|---|---|
| `initialize` 没返回任何有用信息 | 视为最小 profile，`reported=false` | `effectiveCapabilities` |
| 在能力缺失时调用 `session/load` | 抛 `AcpMethodNotFound`，可捕获 —— 调用方改为新起一个会话 | `AcpClient.loadSession` |
| agent 没宣告 `sessionCapabilities.list` | 在发出之前就拒绝 `session/list`（规范禁止无门控地调用）；标题退回目录名 | `canListSessions` / `AcpClient.listSessions` / `applyBackendTitle` |
| prompt 里含不支持的块 | 发送前丢弃该块 + 记日志 | `filterPromptBlocks` |
| agent 调 `fs/*` 或 `terminal/*` | 明确的 `-32601` error（我们从未广告过它）| `clientCallbackSupport` |
| agent 请求一个我们没宣告的 elicitation 模式 | 在任何 handler 运行**之前**就回 `-32602`；表单队列里什么都不发布 | `AcpClient.onRequest` |
| agent 的 elicitation schema 无法完整渲染 | `-32602`；不画半个表单，也就不会收到一个悄悄不合 schema 的答案 | `formFromElicitation` |
| agent 请求权限但没装 handler | 回 `cancelled`，于是它失败关闭而不是挂死 | `AcpClient.onRequest` |
| agent 问任何其它未知的东西 | 明确的 `-32601` | `AcpClient.onRequest` |
| agent 的工具状态字符串不认识 | 映射为 `running`，绝不给 `completed` | `mapToolStatus` |
| agent 报工具为 `cancelled` / `canceled` | 终止态 `error`，而不是一直转圈 —— ACP 线上没有这个状态，但 agent 会发 | `mapToolStatus` |
| 我们不认识的 `session/update` 类型 | 忽略 + 记日志 | `AcpTranslator.apply` |

## 能力缺失在**屏幕上**是什么样子

上面几张表是协议视角；这一张是**用户视角**：agent 不宣告 X 时，什么仍然可用、用户看不到什么。
逐 agent 的实测（含 `initialize` 原始回包）在 [AGENT-CAPABILITIES.zh.md](AGENT-CAPABILITIES.zh.md)。

| agent 不宣告 | 仍然可用 | 用户看不到 | 界面上的说法 |
|---|---|---|---|
| `loadSession`（有 `sessionCapabilities.resume`） | **恢复成功**——同一个会话，agent 侧上下文可能继续 | 之前的对话（ACP 的 `session/resume` 不重放任何东西） | tab 保留**真名**（无标记），**并且**会话区一条 `◈ Notice`：*Resumed without showing history: this agent has no session/load capability* |
| `loadSession` 和 `resume` 都没有 | 仍然可以新建对话 | 任何恢复；tab 变成一个**新对话** | tab `[new conversation] <名字>` + 一条 `◈ Notice` 说明旧会话打不开 |
| 标题面（不推 `session_info_update`，`session/list` 也没有 `title`） | 会话照常 | 对话的真名——退回**第一条 prompt 的派生标题**，再退回目录名 | 普通兜底标题，不加标记 |
| `promptCapabilities.image` / `embeddedContext` | 文本 prompt 照常 | 附件与嵌入上下文（那些块在发送前被丢掉并记日志） | 无提示（块已经不在了） |
| `sessionCapabilities.delete` | 本地删掉 tab、忘掉映射 | agent 侧会话真正被删 | 日志 `agent could not release <id>` |
| `sessionCapabilities.list` | 会话可用；标题只有派生值 | 旧会话的发现与后端标题 | 目录名 / 派生标题 |
| `session/set_config_option` | 会话开始时的模型 | 切模型；路由回 `400` 并点名是这个 agent 不提供 | `400 … this session's agent does not offer …` |

**现成例子 —— dsh 官方 `acp` profile**（`dsh --profile acp`）：
它宣告 `{close, list, resume}`、`promptCapabilities: {image: false, audio: false, embeddedContext: false}`，
**没有 `loadSession`**。所以恢复出来的会话**确实是恢复成功**，但看不到历史（tab 保留真名，Notice 说明原因）；
标题只能来自第一条 prompt（现在会写进映射表）或目录名；图片块被丢掉；删 tab 也不会删掉 agent 侧的会话。
其余常用 agent（`opencode acp` / `claude-agent-acp` / `codex-acp`）都宣告了 `loadSession`，
所以这四类症状对它们不成立。

## opencode v2 里没有落点的能力

有些 ACP 能力在 TUI 里**没有地方可放**。这不是桥的缺口，而桥**也不会为它造一个落点** —— 一个没人渲染的事件，看起来和"功能正常"一模一样，直到你发现屏幕是空的。

| ACP 侧 | opencode v2 | 依据 |
|---|---|---|
| `plan` 更新（agent 的待办）| **没有 todo 面** | opencode v2 TUI 没有 todo 能力 |
| 子 agent | 只以**工具卡片**呈现，从不作为子会话 | ACP 每次 prompt 只携带一条会话，没有子会话可映射；子 agent 活动改以工具行呈现 |
| `lsp` 配置 | 接受但**不运行** | `/docs/migrate-v1` 原文：`V2 accepts and preserves lsp configuration, but it does not run language servers, expose LSP tools, or produce LSP diagnostics.` 这是迁移文档里**唯一**一处明确指出替代方案的地方（改用项目的 lint / typecheck / 编译器命令）。|
| v2 的内建 agent（`build` / `plan` / `general` / `explore`）| **未暴露** | ACP 没有 agent/mode 列表 —— agent 的 `session/new` 只通过 config options 广告模型与推理强度，别的没有。因此 `/api/agent` 只返回一个合成的 primary agent。切换 agent 是空操作，桥**如实回 204**，不假装。|

### 侧栏实际能显示什么

`context`（tokens 与百分比）、以及**当前目录与分支**。v1 侧栏里的其它东西 —— context detail、compact、opencode v2 版本、LSP 状态、todo、MCP server —— 在 v2 里**没有可挂靠的对象**。MCP 尤其没有列表可渲染：ACP 不携带列表（`session/new` 的 servers 是**客户端**输入），客户端不是 MCP 宿主，我们也不提供 MCP server 列表，所以侧栏的 MCP 区域就是空的。

"用 agent 自己的配置参数跑一次来发现 MCP"这条老路是**故意移除**的：它假定了对面是哪个 agent，
而对不认 argv 的 agent 它会一直等到超时 —— 把 ready 行也拖住，看起来像是客户端坏了。
`findExecutable` 拒绝跑其它任何探测，也是同一个理由。
