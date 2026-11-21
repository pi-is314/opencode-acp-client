# 我们实现的 opencode v2 接口面

> English: [PROTOCOL.md](PROTOCOL.md)

**权威来源，按可信度排序：**

1. **公开的 OpenAPI 规范** —— <https://opencode.ai/v2/docs/api>，机器可读版本在
   <https://opencode.ai/v2/openapi.json>（OpenAPI 3.1.0）。它描述的**就是
   `/api/*` 平面本身**，也正是 TUI 驱动的那个平面：本仓实现的每条路由都在里面，
   路径与 `operationId` 一致（`server.info`、`session.form.reply`、
   `permission.request.list`、`event.subscribe`、`session.message.list` …）。
   **先查它。**
2. opencode v2 仓库里的 `packages/tui/test/fixture/tui-client.ts` —— 他们自己的 TUI
   测试所接受的最小服务端。它是**下限**：规范里标 experimental 的路由，也仍然
   必须让 fixture 跑得通。
3. TUI 自己的生成客户端（`packages/protocol/src/groups/*.ts`、
   `packages/client/src/effect/generated/client.ts`）—— **与规范不一致时**，
   运行中的 TUI 实际用的拼法。已知一处差异，而且两种拼法我们都提供：规范里
   待答表单列表是 `GET /api/form` 的 `form.list`，而 TUI 客户端用的是
   `GET /api/form/request` 的 `form.request.list`。

> **更正。** 这一节以前写的是"这个接口面没有文档、只有 fixture 可信"，
> 还警告说 SDK 有个 `/session` 平面与 TUI 的 `/api/*` 平面不同。那是错的：
> 这个平面是**公开的**（见第 1 条），下面每条路由都已据此复核过。现在的规则是 ——
> **以规范为准**；而当 **TUI** 与规范不一致时，**两种拼法都提供**（表单列表就是如此）。
>
> 有两处我们**知情保留**的偏差：`session.message.list` 规范里是 `{data, cursor}`，
> 我们多给一个 `location` 兄弟字段（无害 —— 客户端读 `.data`）；以及两种待答表单
> 路径都提供。除此之外与规范不符的，都是 bug。

## 会话身份：两个 id，其中一个不是派生的

TUI 显示的 id 是**桥的**会话 id，ACP agent 有它自己的一套。这不是实现上的偶然 —
客户端用 `POST /api/session` 建会话，扮演 server 的那一方回一个 id 给它。原生 opencode v2
可以直接回自己的 id，因为 server **就是** agent 的宿主；在这里 agent 在我们背后，
所以存在两个身份，必须建立映射。

实际是怎么处理的：

1. **启动方可以指定 id，且它被原样采纳。** 知道 **agent 会话 id** 的启动方可以把它传进来
   （已经知道的启动方会用 `-s` 这么做），`createSession` 按给定值使用（`state.ts`：
   `const id = requestedId ?? this.newId('ses')`）。此时 TUI 显示的就是 agent 自己的 id ——
   不是派生出来的值，而是采纳的。恢复时把同一个 id 传回去，桥把它交给 `session/resume`。
2. **在 TUI 里新建的会话拿到的是桥的 id。** 不从 agent 的 id 派生任何东西：那一刻 agent 还没回答，
   而在客户端已经存下主键之后再改写它，会打断客户端的路由。
3. **agent 的 id 同时作为 `acpSessionId` 报出**（在 `/api/session` 与 `/api/session/:id` 上），
   所以这一对永远可查。
4. **两个 id 都能解析到同一个会话。** `State.get` 会退化匹配 `acpSessionId`，
   所以无论复制了哪个 id，路由或 `--session` 都接受。

## 取消一个回合

`POST /api/session/:id/interrupt`（旧客户端拼法 `/abort` 同样提供，body 一致）回
`200 {"interrupted": boolean}` —— 真的打断了一个正在执行的回合是 `true`，空闲时是无操作回 `false`。
这里回 `204` 正是让真 v2.0.27 TUI 每次取消都记一条 `UnexpectedStatus: 204` 未处理拒绝的原因。

触发它的手势是**五秒内按两次 Escape**（第一次只是 armed：footer 从 `esc interrupt` 变成
`esc again to interrupt`）。另注意客户端侧是什么结束一个回合的：它的 store 在
`session.execution.succeeded` / `.failed` / `.interrupted` 上把会话从 `running` 翻成 `idle`
—— **不是** `session.idle`，那个它根本不处理。它还会记录是三者中的哪一种，所以选哪个有讲究：

| 回合 | 我们发 |
|---|---|
| 正常结束 | `session.execution.succeeded` |
| 失败 | `session.execution.failed` |
| 用户取消 | `session.execution.interrupted` |

`session.execution.*` 根本不在公开的 OpenAPI 里（规范没有建模执行事件），所以这三个名字以客户端为准。

谁来决定"被取消"：**我们**。`/interrupt` 与 `/abort` 置 `record.interruptRequested`，
由这个标记 —— 而不是 agent 的 `stopReason` —— 选中断结果，因为一个卡在权限请求上的 agent
被取消后仍可能回 `end_turn`。agent 自己报 `stopReason: "cancelled"` 也同样被采纳。

## 事件流 —— `GET /api/event`

```
data: {"id":"evt_connected","type":"server.connected","data":{}}\n\n
```

`server.connected` 这一帧就是握手；客户端把它的缺失视为「服务端未就绪」。
可选的 `Last-Event-ID` 会从环形缓冲里重放。

## 已实现的路由

### 启动 / 身份

| 路由 | 响应 |
|---|---|
| `GET /api/info` | `{location, data:{healthy:true, version, pid}}` —— **没有它客户端拒绝接入** |
| `GET /path` | `{home, state, config, worktree, directory}` |
| `GET /config` | `{}` |
| `GET /config/providers` | `{providers:{}, default:{}}` |
| `GET /provider` | `{all:[], default:{}, connected:[]}` |
| `GET /provider/auth`、`GET /mcp`、`GET /session/status` | `{}` |
| `GET /agent`、`/command`、`/formatter`、`/lsp`、`/experimental/workspace*` | `[]` |
| `GET /experimental/capabilities` | `{backgroundSubagents:false}` |
| `GET /experimental/console` | `{consoleManagedProviders:[], switchableOrgCount:0}` |

### Location / project / vcs

| 路由 | 响应 |
|---|---|
| `GET /api/location` | **裸的** `{directory, project:{id,directory,canonical}}` —— *不是*信封 |
| `GET /api/project/current` | `{id, directory}` |
| `GET /api/project` | `[]` |
| `GET /api/vcs` | `{location, data:{branch:{current, default}}}` |
| `GET /api/worktree`、`/api/worktree/refresh` | 列表 / 204 |

> 客户端会把 `location.directory` 和 `project.canonical` 直接喂给一个路径工具函数。
> 在这里返回数组会让它以
> `The "to" property must be of type string, got undefined` 崩溃。
>
> `workspaceID` **刻意不给**（`src/server.ts` 的 `location` getter 有注释）：客户端按
> `JSON.stringify([directory, workspaceID])` 给 location 级别的目录建 key，而它自己请求时
> 根本不带 workspace（`?location[directory]=...`）。凭空编一个 id 会让目录发布在一个 key 下、
> 查询在另一个 key 下，**每个列表都读成空的**。不返回它，两边都停在 `[directory, null]`。

### 会话

| 路由 | 响应 |
|---|---|
| `GET /api/session` | `{location, data:[session], cursor:{}}` |
| `POST /api/session` | `{location, data: session}` + `session.created` 事件 |
| `GET /api/session/active` | `{location, data:{sessionID: "idle"\|"running"}}` —— 是 **map**，且必须带 location |
| `GET /api/session/:id` | `{location, data: session}` —— 会话必须带 `location`、`projectID`、`cost`、`tokens` |
| `PATCH /api/session/:id` | 改名，**204**，+ `session.updated` + `session.renamed`（客户端声明 `successStatus: 204, empty: true`） |
| `POST /api/session/:id/model` | 转发到 ACP 的 `session/set_config_option` |
| `GET /api/session/:id/message` | `{location, data:[message]}` |
| `GET /api/session/:id/message/:mid` | `{location, data:{info, parts}}` |
| `POST /api/session/:id/prompt` | 占位的助手消息；回合在后台流式进行 |
| `POST /api/session/:id/generate` | **503** `ServiceUnavailableError` —— `/btw`；ACP 没有不改变会话的侧问方法 |
| `POST /api/session/:id/compact` | **409** `ConflictError` —— `/compact`；ACP 没有 compaction 方法 |
| `POST /api/session/:id/revert/stage` | **409** —— `/undo`；ACP 没有回滚历史的方法 |
| `DELETE /api/session/:id/revert` | **409** —— `/redo`；同上 |
| `POST /api/session/:id/revert/commit` | **409** —— 提交一次 undo；同上 |
| `POST /api/session/:id/move` | 204 + `session.moved` —— `/cd`。目标目录按官方规则校验（`Directory does not exist` / `Not a directory` → 400），会话用新 `cwd` 重新走 ACP `session/load`（stable 方法本就带 cwd），事件本身就会渲染 "↳ Moved to" 行并更新页脚。**持久**：新目录写入会话映射表，下次启动认领时读回，重启不会撤销切换 |
| `GET /api/experimental/session/:id/export` | `{location, data:{info, messages}}` —— `/copy` 与 `/export`；整份转录作为单个对象 |
| `POST /api/location/reload` | 204 —— `/reload`；桥的配置就是进程参数，没有可重载的东西 |
| `GET /api/skill` | `{location, data:[Skill.Info]}` —— 从配置 skill/skills 目录与工作区 `.opencode/skill(s)` 扫描真实技能，`/skills` 选择器才有内容可列；被附加的技能以 ACP resource link（`file://<SKILL.md>`）转发给 agent，规范要求所有 agent 必须接受 |
| `GET /api/fs/list` | `{location, data:[{path, type}]}` —— 真实条目；TUI 的 `/cd` 补全靠它列目录，答空会让 Enter 永远提交不了 |
| `POST /api/session/:id/background` | **400** —— 后台化阻塞工具；无 ACP 对应面 |
| `POST /api/session/:id/synthetic` | **409** —— 注入编辑器选区；无 ACP 对应面 |
| `POST /api/session/:id/fork` | **400** —— `session/fork` 是 unstable 且实测 agent 均未宣告 |
| `POST /api/experimental/session/:id/wait` | **204** —— 当前回合结束后返回（桥自己的状态） |
| `POST /api/session/:id/abort` | 204；发 `session/cancel`，随后关掉未完成的工具行、把挂起权限回 `cancelled`、把挂起表单按 `cancel` 结掉 |
| `GET /api/session/:id/todo` | `{location, data:[todo]}` |
| `GET /api/session/:id/inbox` | 挂起的 prompt |
| `POST /api/session/:id/inbox/:iid/{steer,queue}` | 204 + `session.inbox.delivery.changed` |
| `DELETE /api/session/:id/inbox/:iid` | 204 + `session.inbox.cancelled` |
| `GET /api/session/:id/diff`、`/terminal` | `{location, data:[]}` |

> `config_option_update` 会被消费。ACP 发的是**完整**配置状态，所以我们是**替换**而不是合并
> （`AcpClient.applyConfigOptions`）；该更新在 `src/server.ts` 的监听器里、**送进翻译层之前**被拦下 ——
> 否则翻译层会把它记成未知更新并丢弃。如果这次变化移动了选中的模型，就用 `session.model.selected`
> 把 TUI 一起挪过去（这是它 store 里唯一读的事件）。`session/set_config_option` 的响应同样带完整状态，
> 现在也会被存下来，因此依赖型变化（跟着模型走的推理档位之类）也能同步。

### 模型 / agent

派生自 ACP 的 `session/new` 配置项 —— agent 把模型放在**一个**选项里
（`category: "model"`），按 provider 分组，每个值是形如 `["provider","model"]` 的
JSON 数组字符串；推理强度则是 `thought_level`。

| 路由 | 响应 |
|---|---|
| `GET /api/agent` | 一个合成的 `primary` agent；**绝不能为空**，否则输入框会静默拒绝提交 |
| `GET /api/model` | `{location, data:[{id, modelID, providerID, name, capabilities, variants}]}` —— `variants` 必填（客户端会解引用 `info.variants.some`）|
| `GET /api/provider` | `{location, data:[{id, name, models}]}` |

### Shell（`!`）

| 路由 | 响应 |
|---|---|
| `GET /api/shell` | `{location, data:[ShellInfo]}` |
| `POST /api/shell` | 运行 `{command:{command, cwd?, timeout}}`；`{location, data: ShellInfo}` + `session.shell.started` |
| `GET /api/shell/:id` | 单个 `ShellInfo` |
| `GET /api/shell/:id/output?cursor=N` | `{location, data:{output, cursor, size, truncated}}` —— TUI 靠**轮询**它 |
| `DELETE /api/shell/:id` | 204 + `session.shell.ended` |

### 权限

| 路由 | 响应 |
|---|---|
| `GET /api/permission/request` | `{location, data:[…]}` |
| `GET /api/session/:id/permission` | 同上，限制到单个会话 |
| `POST /api/session/:id/permission/:rid/reply` | 204；接受 TUI 的 `{reply:"once"\|"always"\|"reject"}`。若该请求**已回答、已被 agent 过期、或已被 interrupt 取消**则回 **404** —— 这是**终态回答**，让对话框能恢复，而不是误以为自己回答成功 |

**路由注册顺序有讲究**：这条 reply 路由必须注册在 `/api/session/:id(/.*)` **之前**，
否则后者会把它吞掉、回 204，并让那条 ACP 请求永久挂起。

### 表单（agent 的 `elicitation/create`）

form 模式的 ACP `elicitation/create` 走 TUI 自己的表单面呈现。ACP 请求是
`{sessionId, mode:"form", message, requestedSchema}`，其中 `requestedSchema` 是一份扁平 JSON Schema；
它被映射成 `Form.Info`（`{id, sessionID, title, fields[]}`，id 必须带 `frm_` 前缀、`fields` 不能为空）。
`string`（可选 `enum` → options）、`number`、`integer`、`boolean`，以及字符串枚举的 `array`
（TUI 的 `multiselect`）可以渲染；其余一律回 JSON-RPC `-32602`，而不是画一半。

注意两种信封：location 级的路由带 location，会话级的不带。

| 路由 | 响应 |
|---|---|
| `GET /api/form/request` | `{location, data:[Form.Info]}` —— 全部挂起表单 |
| `GET /api/form` | `{location, data:[Form.Info]}` —— 同一份列表 |
| `GET /api/session/:id/form` | `{data:[Form.Info]}` —— **不是** location 信封 |
| `GET /api/session/:id/form/:formID` | `{data: Form.Info}` |
| `GET /api/session/:id/form/:formID/state` | `{data:{status:"pending"}}` |
| `POST /api/session/:id/form/:formID/reply` | body `{answer:{…}}`，204 |
| `DELETE /api/session/:id/form/:formID` | 204 —— **实装客户端在表单上按 Esc 就是它**（规范声明；带可选 `message` query）。缺了它时落进泛匹配 404：表单关不掉、右下角红字 Error、agent 的 elicitation 永久挂起 |
| `POST /api/session/:id/form/:formID/cancel` | 204 —— 旧拼法，为旧客户端保留 |

未知的、或不属于该会话的 `:formID` 回 404 `{error:"form not found"}`；`answer` 不是对象的 reply 回 400。
和权限 reply 路由一样，这些路由必须注册在泛匹配的会话路由**之前**，否则后者会回 204，
把 agent 的 elicitation 永久挂在那里。

用户填的答案成为 `accept` 的 `content`；关闭对话框成为 `cancel`。这个 UI 里没有 `decline` 的控件，
所以我们从不发它。

### 未实现（404 + 记日志）

pty、`/api/mcp`（MCP server 列表）、mcp connect/auth、provider oauth、
`/session/:id/{revert,unrevert,share,init,summarize,fork,command}`、
大部分 `/tui/*`、`/log`、`/auth/:id`、`/find*`、`/file*`、`/experimental/tool*`。

未知的 `/api/*` **读**请求会回一个格式正确的空信封而不是 404，因为客户端会无条件
解引用响应体上的 `.location`。`[bridge] unhandled route: …` 这行日志仍然是真正的
信号。

### 不消费响应的写请求

`POST /api/session/:id/agent`（ACP 没有 agent 列表，所以对着唯一的 primary agent
老实地回 204）以及其它「接受但未实现」的会话动作，都回 204，以免客户端把它当成
致命协议错误。

## 通过本桥启动的 TUI：哪些功能可用、哪些不可用

TUI 是我们上面这套 HTTP 接口面的客户端，所以它的功能范围就是这套接口面——不是 opencode
自己的 daemon。屏幕级证据来自 `scripts/e2e-real-tui.sh` 的各 `MODE`。

| TUI 功能 | 通过本桥 | 证据 |
|---|---|---|
| 对话、流式文本、思考块、工具卡片 | ✅ | history/replay 模式 |
| 回合进行中输入后续消息 | ✅ 排队（`N queued`），回合结束后执行；ACP 不支持中途注入 | `MODE=queue` |
| 权限对话框 | ✅ | `MODE=permission` |
| 表单 / 澄清（`session/request_elicitation`） | ✅ | `MODE=form` |
| `!命令` shell | ✅ | `MODE=shell` |
| 模型选择器 | ✅ agent 提供 config options 时可用；否则只能看到占位 `acp/default`，不能切换 | `tests/session-catalog.test.ts` |
| 会话列表 / 切换 / 改名 | ✅ | restore 模式、patrol |
| 删除会话 | ✅ 本地删掉；agent 侧只有宣告 `sessionCapabilities.delete` 才会真删 | 转发 `session/delete` |
| Continue / `-c` / `-s` | ✅；只有 agent 支持 `loadSession` 才回放历史 | restore 模式 |
| Diff 查看器 | ✅ 读 `/api/session/:id/diff` | patrol `/diff` |
| 复制 / 导出 | ✅ | patrol `/copy`、`/export` |
| Fork | ❌ 稳定 ACP 没有这个方法；unstable 的 `session/fork` 我们不调用（见 ACP-MATRIX） | `/session/:id/fork` 未实现 |
| Compact / undo / redo / `btw` 侧问 | ❌ 但会给出**可读的拒绝**（声明过的 409/503），绝不出现 `UnexpectedStatus` | `MODE=unsupported-verb` |
| 内置终端 | ❌ `/terminal` 回空信封；这个上下文里 TUI 不提供该面板 | patrol 跳过 `/terminal` |
| MCP 面板 | ❌ 本桥不是 MCP host；`/api/mcp`、connect/auth 路由未实现 | 见 [ACP-COMPAT.zh.md](ACP-COMPAT.zh.md) |
| Share | ❌ opencode v2 已移除会话分享；路由未实现 | PROTOCOL「未实现」清单 |
| Provider / 模型列表 | 📖 **只读**——由 agent 的目录投影而来（`GET /api/provider`、`/api/model`）；TUI **不能创建**、编辑或登录 provider：provider 属于 agent 的配置 | `modelCatalog`；`/api/integration` 固定为空 |
| Provider 登录 / oauth、`find`/`file` 搜索、多数 `/tui/*` | ❌ 未实现；认证归 agent 自己（它自己的 `authMethods`） | 同上 |
| TUI 自动更新 | ❌ 故意禁用（曾因静默升级把桥的版本门控打崩） | `src/index.ts` 的 `isolatedTuiRoots` |
| 任何其它 v2 客户端 | 未实测，而且**暂不推荐**：按 agent 隔离的状态根只注入给我们 spawn 的 TUI，别的客户端拿不到 | README「其它 v2 客户端 —— 还不行」 |

**一个 client 只服务一个 agent——TUI 的 tab 布局也按 agent 隔离。** TUI 的 `tabs.json`
和它自己的 db 都在我们交给它的隔离根下，而根目录现在按 agent 命令命名
（`~/.opencode-acp-client/opencode/<slug>/`）。所以用 `dsh` 启动时**不会**恢复出 opencode
的 tab：TUI 读的是另一个 `tabs.json`，tab bar 根本不需要过滤。桥是硬边界：映射表里属于
**其它 agent** 的历史会话在采纳时被拒绝（404），`-s` 会直接告诉你它属于哪个 agent。
这样模型目录就没有歧义了——就是启动 agent 宣告的那份（焦点启发式与外来模型忽略仍保留，
用于同一 agent 的多个 tab）。

**provider 从哪来——以及为什么没有“新增 provider”按钮。** TUI 的 provider/模型列表是
**agent 目录的投影**（`GET /api/provider` 返回 `modelCatalog.providers`；`/api/integration`
固定为空）。provider/auth、oauth 和 `/auth/*` 路由都没有实现，模型选择器只能选 agent
宣告的模型。**不要指望在这个 TUI 里创建、编辑或登录 provider**——那等于让 TUI 管理 agent
的凭证，本桥不做这件事。要加 provider 就去 agent 侧加（opencode v2：`opencode auth login` 或
`~/.config/opencode/opencode.json`；dsh：profile 的 provider 配置；claude/codex：它们自己的
认证），重启后选择器就会出现。逐 agent 细节见 [AGENT-CAPABILITIES.zh.md](AGENT-CAPABILITIES.zh.md)。

## 我们发出的事件名

opencode v2 与 v1 的词汇完全不同。TUI **完全无视** v1 的 `message.part.*`，
所以两边都发：v1 让冒烟测试保持诚实，v2 才是真正渲染的东西。

| 事件 | 载荷 |
|---|---|
| `server.connected` | `{}` |
| `session.created` / `session.updated` | `{session}` |
| `session.renamed` | `{sessionID, title}` —— TUI 的 store 唯一会读的改名帧 |
| `session.model.selected` | `{sessionID, model:{providerID, modelID}, previous?}` —— **agent** 自己换模型时也发 |
| `session.idle` / `session.status` | `{sessionID}` / `{sessionID, status}` |
| `session.usage.updated` | `{sessionID, cost, tokens}` |
| `session.step.started` | `{sessionID, assistantMessageID, agent, model}` —— **唯一创建助手消息行的事件** |
| `session.execution.started` / `.succeeded` / `.failed` | `{sessionID}` |
| `session.text.started` / `.delta` / `.ended` | `{sessionID, assistantMessageID[, delta\|text]}` |
| `session.reasoning.started` / `.delta` / `.ended` | 同上 |
| `session.tool.input.started` | `{sessionID, assistantMessageID, id, name}` —— **创建工具行** |
| `session.tool.input.delta` / `.ended` | `{…, delta}` / `{…, text}` |
| `session.tool.called` / `.success` / `.failed` | `{…, id, executed, …}` |
| `session.shell.started` / `.ended` | `{sessionID, shell[, output]}` |
| `session.inbox.enqueued` | `{sessionID, inboxID, item}` |
| `session.inbox.delivered` / `.cancelled` | `{sessionID, inboxID}` |
| `session.inbox.delivery.changed` | `{sessionID, inboxID, delivery}` |
| `message.updated`（v1）| `{sessionID, messageID, role?, completed?}` |
| `message.part.updated`（v1）| `{sessionID, messageID, part, time}` |
| `todo.updated` | **已移除** —— opencode v2 没有 todo 落点，见 [ACP-COMPAT.zh.md](ACP-COMPAT.zh.md) |
| `permission.asked` | `{id, sessionID, action, resources}` |
| `permission.replied` | `{sessionID, requestID}` |
| `form.created` | `{form}` —— 一个 `Form.Info`；表单界面靠它出现 |
| `form.replied` | `{id, sessionID, answer}` |
| `form.cancelled` | `{id, sessionID}` |
| `turn.wait` / `turn.idle` | `{sessionID}` |

> **`session.updated` 会发，但 TUI 无视它。** 对照客户端的 store（`packages/client/src/solid/data.ts`）
> 核实过：它有 `session.renamed` 的 case，**没有** `session.updated` 的。所以改名 —— TUI 的
> `PATCH /api/session/:id`，或 agent 的 `session_info_update` —— 只有经 `session.renamed`
> 才能到侧栏，因此两个都发。一个没人处理的事件，在日志里看起来和"功能正常"一模一样。

客户端会**静默**执行的两条规则（未变）：

1. `session.text.*` 和 `session.tool.*` 只**编辑**已有行，行不存在时直接丢弃事件。
   只有 `session.step.started` 和 `session.tool.input.started` 会创建行，所以它们
   必须最先发出。
2. 每个事件都要带 `created`；客户端会用它给行打上 `time.created`。
