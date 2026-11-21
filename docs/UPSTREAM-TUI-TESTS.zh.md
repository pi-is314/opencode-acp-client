# opencode 是怎么测它自己的 TUI 的 —— 以及每个版本我们要对照什么

> English: [UPSTREAM-TUI-TESTS.md](UPSTREAM-TUI-TESTS.md)

这份文档的目的是：**官方发新版本时，可以一次过完全部对照** —— 官方测什么、其中哪些真正约束
**本桥**、哪些属于 TUI 自己的责任、以及对应的测试在本仓哪里。

下面的一切都读自**已发布的 tag**（`git show <tag>:<path>`），不是本地 checkout，也不是文档。

## 1. 官方的做法，一屏看完

opencode 主要**不是**靠跑真终端来测 TUI 的。它分三层：

| 层 | 真实的 | 假的 | 证明什么 |
|---|---|---|---|
| 渲染测试 | TUI 组件，用 `testRender` 挂到**内存终端** | API | 屏幕上一个键一个键地真正渲染出什么 |
| store/data 测试 | 真实的 `data` store、session-tabs store、同步逻辑 | `fetch` 与 SSE 流 | 客户端状态机是否正确消费了我们发的事件 |
| CLI/app e2e | 真进程 / 真界面自动化 | mock API server | 端到端接线 |

**中间那一层才是约束服务端的**，也是我们做转换的那一层。

## 2. 官方那套假后端，具体是什么

tag v2.0.28 里，它全部在**一个文件**里：

```text
packages/tui/test/fixture/tui-client.ts
```

里面有四样东西：

1. **`createEventStream()`** —— 假的 `/api/event`。`emit(event)` 把一帧推给所有订阅者；
   `v2()` 返回一个 body 是 `ReadableStream` 的 `Response`，**第一帧永远是**
   `{id:"evt_connected", type:"server.connected", data:{}}`；订阅者接入**之前**发出的事件会被
   **排队并在连接时 flush**；`disconnect()` 关掉所有流。
2. **`createFetch(override, events)`** —— 一个可以直接替换 `globalThis.fetch` 的函数。它拿
   `url.pathname` 去匹配一长串路由并返回字面 JSON；**override 回调先跑**，所以测试可以单独接管
   任意一条路由（官方的重连测试就是这样让 `/api/session/active` 挂住的）。**匹配不到就
   `throw new Error("unexpected request: <path>")`**。
3. **`createApi(fetch)`** —— `OpenCode.make({baseUrl:"http://test", fetch})`，即**真实的生成客户端**
   绑到假传输上。
4. 小夹具：`directory`、`worktree`、`json()`。

其中两个设计决定最值得抄：

- **契约就是请求路径**，不是一个 server 对象。缺一条路由就是**抛错**，所以"没实现"无法静默通过。
- **传输在 `fetch` 边界可换**。换掉 `fetch` 之后，真实 store、真实同步逻辑、真实组件全都还在跑，
  客户端内部**没有任何东西被 mock**。

## 3. 为什么这个文件**不能直接拿来用**

`tui-client.ts` 对本仓是**不可 import** 的，原因都是结构性的，不是风格问题：

| 障碍 | 具体 |
|---|---|
| 假的**种类**不对 | 它替换的是**客户端进程内**的 `fetch`。而我们的被测对象是**服务端**；在客户端侧塞一个 fetch 桩，等于换掉了我们要测的东西，而不是我们能控制的东西。 |
| 构建系统 | 官方是 `bun:test` + `@opentui/solid` 的 `testRender` + Solid JSX。本仓是 Node + Vitest，**没有 Solid 工具链**。 |
| 内部 import | 它 import `@opencode/client`、`@opencode/core/session/message`、`@opencode/schema/event`，以及 `../../../src/context/data` 这类**内部路径** —— 这些都不是已发布的包接口。 |
| 夹具数据不同 | 它的 `directory`/`worktree` 是 `/tmp/opencode/...`，会话 id 形如 `session-stale`，而且
其 `/api/info` 里写着 **`capabilities.persistentPty: true`** —— 与本桥的事实**正好相反**。照抄等于把**agent 的假设**搬进来，而不是我们自己的。 |
| 断言目标不同 | 它断言的是"通过桩到达的 TUI store 状态"。我们必须断言的是**桥在真 socket 上真正写出的字节** —— 这正是本仓测试的全部意义。 |

**真正可借鉴的是形状，不是代码**：每个测试进程一个假后端模块、一张显式的路由表、以及
**匹配不到请求就硬失败**。

## 4. 我们这边对应的是什么，叫什么

| 官方概念 | 我们的等价物 | 位置 |
|---|---|---|
| `createEventStream()` —— 假 SSE 服务端 | 真实 `node:http` SSE 客户端，对着**真实的 hub**，支持 `Last-Event-ID` | `tests/server.test.ts`（`subscribe`/`openStream`） |
| `createFetch()` —— 假 HTTP 服务端 | 真实桥跑在**真实临时端口**上，加上真实假 ACP agent 走 stdio | `tests/scenarios.test.ts`（`start()`） |
| 假 ACP **后端** | `tests/fake-acp-agent.mjs` —— 一个**真的 ACP 子进程**，带 `FAKE_ACP_*` 开关 | `tests/fake-acp-agent.mjs` |
| `testRender` 的组件断言 | 真实 `opencode` TUI 跑在 `tmux` 里，**按屏幕内容**断言 | `scripts/e2e-real-tui.sh` |
| `unexpected request:` 硬失败 | 未知路由 → `[bridge] unhandled route:` 日志 + 形状正确的空信封；OpenAPI 探针对错误形状直接失败 | `src/server.ts`、`scripts/check-openapi.py` |

★ 有一处是**刻意的差别**：官方那个桩比我们**更严格** —— 未知路径直接抛错。而本桥必须回答
**形状正确的某个东西**，因为真客户端把 404 当致命错误（[AGENTS.zh.md](../AGENTS.zh.md) 铁律 3）。我们把"吵闹"留在
**日志**与 **OpenAPI 探针**里，而不是留在抛错里；这个取舍登记在 `scripts/check-openapi.py` 的
`ALLOWED` 表里。

## 5. 官方每个新版本：对照流程

官方发布新的 opencode v2 版本时跑这一套。把 `<tag>` 换成新 tag。

1. **读已发布的夹具，不是 checkout。**
   ```bash
   git show <tag>:packages/tui/test/fixture/tui-client.ts
   ```
   与上一个 tag 做 diff。只有三类变化对我们有意义：
   - `createFetch` 表里**新增/删除了一条路由** → 检查本桥是否服务它、`scripts/check-openapi.py`
     是否应该探它；
   - `createEventStream()` 里**新的默认断言**（握手形状）→ 说明客户端连接时开始期待它；
   - 假 `/api/info` 里的 `capabilities` → 说明客户端**以为**服务端有什么。

2. **列出 TUI 测试文件，找新的"行为级"名字。**
   ```bash
   git diff --stat <old-tag> <tag> -- packages/tui/test
   git show <tag>:packages/tui/test/cli/tui/data.test.tsx | grep -n '^test(\|^  test('
   ```
   名字描述**客户端-服务端行为**（重连、重新收敛、pending、分页、顺序、删除）的，是候选契约；
   描述布局、动画、鼠标、主题、组件内部的，**不是**。

3. **把每个候选转成两种形状之一。**
   - *桥契约* → `tests/server.test.ts`（SSE/HTTP 生命周期）或 `tests/scenarios.test.ts`
     （经假 agent 的一个场景）里的一个 Vitest 用例。
   - *屏幕行为* → `scripts/e2e-real-tui.sh` 里的一个 `MODE=` 分支，断言抓到的屏幕，并把屏幕存到
     `.artifacts/`。

4. **扩展假 agent，而不是 mock。** 新契约需要新的 agent 行为时，给
   `tests/fake-acp-agent.mjs` 加 `FAKE_ACP_*` 开关；**测试体里不许 mock ACP**。

5. **登记偏离。** 新版本约束了某个我们**故意**用不同形状回答的东西时，把理由写进
   `scripts/check-openapi.py` 的 `ALLOWED` 表；涉及 ACP 面的，再写进 `docs/ACP-MATRIX.md`。

6. **跑门控，再跑版本钉。**
   ```bash
   pnpm verify
   pnpm verify:version <tag>
   ```

## 6. 映射表（请保持更新）

列的含意：

- **官方** —— `<路径>:<行号> <测试名>`，读自已发布的 tag。`test(` 的行号会随版本移动；用它**找到**那个测试，然后按**名字**匹配。
- **本桥契约** —— 要让那个测试对着**真服务端**也能通过，桥必须做到什么。新版本里出现一条我们做不到的，那就是这次的发现。
- **我们的** —— 在本仓由哪个文件的哪个用例覆盖。`—` 表示**刻意不迁移**。
- **状态** —— `✓` 已覆盖、`~` 部分覆盖、`✗` 已知缺口、`n/a` 与桥无关。

### 6.1 传输、重连、重新收敛

| 官方（tag v2.0.28） | 本桥契约 | 我们的 | 状态 |
|---|---|---|---|
| `fixture/tui-client.ts:15` `createEventStream()` | 第一帧是 `server.connected {id:"evt_connected"}`；订阅者接入前发出的事件排队、连接时 flush | `tests/server.test.ts` —— *serves the handshake the client waits for on /api/event* | ✓ |
| `cli/tui/data.test.tsx:745` *reconnects the event stream and resyncs active data* | `Last-Event-ID` 只按顺序回放漏掉的；重连后的会话快照是最新的 | `tests/server.test.ts` —— *replays missed durable events after reconnecting with Last-Event-ID* | ✓ |
| `cli/tui/data.test.tsx:1269` *distinguishes initial connection from reconnection* | 握手才代表"已连接"；流关闭是重连，不是新会话 | `tests/server.test.ts` —— 同一个用例（第二条流上也断言握手） | ✓ |
| `cli/tui/data.test.tsx:1328` *tracks session status from active sessions and execution events* | 只有 `session.execution.succeeded\|failed\|interrupted` 才结束回合；`/api/session/active` 反映它 | `tests/server.test.ts` —— *reports true while a turn is running…*；`tests/translate.test.ts` —— 执行终态事件 | ~（`active` 已断言；客户端的状态推导归 TUI） |

### 6.2 会话、tab、view

| 官方（tag v2.0.28） | 本桥契约 | 我们的 | 状态 |
|---|---|---|---|
| `context/session-tabs.test.tsx:440` *derives unread state from server session times* | 提供可比较的 `Session.time.idle` 与 `time.viewed`；`outcome` 标出 failed/interrupted | `tests/server.test.ts` —— *records terminal outcome and acknowledges only the observed idle watermark* | ✓ |
| `context/session-tabs.test.tsx:498` *refreshes server session times after terminal events* | 终态事件之后，紧接着的 `GET /api/session/:id` 已经带上新的 `outcome`/`idle` | 同上 | ✓ |
| `context/session-tabs.test.tsx:469` 与 `:517` *acknowledges viewed sessions even when tabs are disabled / only while focused* | `POST /api/session/:id/view {idle}` 与任何 tab 状态无关，都要被接受 | 同上 | ✓ |
| `context/session-tabs.test.tsx:561` *retries a failed view acknowledgement* | 用同一个 watermark 重复 `POST /view` 必须幂等、安全 | 同上（过期/重复确认被断言为无害） | ✓ |
| `context/session-tabs.test.tsx:454` *marks unread failed sessions with error styling* | `outcome: "failed"` 要到达会话对象 | `tests/scenarios.test.ts`（error-turn）+ `tests/server.test.ts`（view 用例断言 outcome） | ~（outcome 已断言；样式归 TUI） |
| `context/session-tabs.test.tsx:609` *distinguishes family questions and permissions…* | permission / form 的生命周期事件（`permission.asked/replied`、`form.created/cancelled`）必须落在**正确的会话**上 | `tests/server.test.ts` —— permission + form 重连用例；`scripts/e2e-real-tui.sh MODE=permission / MODE=form` | ~（**后台 tab 的 `!` 标记本身**归 TUI） |

### 6.3 prompt 与转录

| 官方（tag v2.0.28） | 本桥契约 | 我们的 | 状态 |
|---|---|---|---|
| `cli/tui/data.test.tsx:3332` *admits prompts optimistically and reconciles with the durable echo* | 回声要带客户端给的 id（`session.inbox.enqueued`），且存储的用户行保留该 id | `tests/server.test.ts` —— *does not leave an optimistic user row after a rejected prompt*；`tests/scenarios.test.ts` —— prompt 重试 | ✓ |
| `cli/tui/data.test.tsx:3434` *hydrates durable pending prompts into the visible transcript* | 同一个 id 的 prompt 重试要解析到已有行，而不是重复 | `tests/scenarios.test.ts` —— *keeps one user row and one agent turn after a durable retry* | ✓ |
| `cli/tui/data.test.tsx:3548` *rolls back an optimistic prompt the server rejected* | 被拒的 prompt 回 4xx，且**不存**用户行 | `tests/server.test.ts` —— 被拒 prompt 用例 | ✓ |
| `cli/tui/data.test.tsx:855` *completes exploration and keeps live rows when a queued prompt is promoted* | `session.step.started` 先于 text/tool part；排队投递要广播（`inbox.delivered`） | `tests/server.test.ts` —— *streams a reply as deltas…*；`scripts/e2e-smoke.sh` 场景 1 的事件顺序 | ✓ |
| `cli/tui/data.test.tsx:1069` *classifies live tool rows independently of their call ID* | 桥发出的行 id 是它自己的 `prt_*`，**绝不**是 ACP 的 call id —— 所以一个长得像 content part 的 id（`reasoning:0`）不可能被误认 | `tests/scenarios.test.ts` —— *gets the bridge's own row id, so classification never depends on id shape*（用 fixture 的 `FAKE_ACP_ADVERSARIAL_TOOL_ID=1`） | ✓ |
| `cli/tui/session-rows.test.ts:303` *assigns assistant boundaries to the first rendered row instead of the first text row* | 一条 assistant 消息按**发出顺序**携带它的 part | `tests/scenarios.test.ts` —— *keeps the order an agent interleaves thought, text and tools in*（`reasoning,text,tool,reasoning,text`） | ✓ |
| `cli/tui/session-rows.test.ts:317` *assigns stable IDs to tool rows for direct navigation* | tool part id 在 SSE 与重载之间保持稳定 | `tests/message-projection.test.ts`；`tests/acp-replay.test.ts` | ✓ |
| `cli/tui/session-rows.test.ts:428` *groups adjacent reasoning parts until a visible boundary* | 相邻 reasoning 合成一个 part；工具或文本边界要开新 part | `tests/scenarios.test.ts`（interleaved）+ `scripts/e2e-smoke.sh` 场景 16 | ✓ |

### 6.4 历史分页

| 官方（tag v2.0.28） | 本桥契约 | 我们的 | 状态 |
|---|---|---|---|
| `cli/tui/data.test.tsx:1120` *loads older pages until the oldest exploration group is complete…* | `GET /message?limit&cursor` 是 newest-first、各页互不重复、`cursor.next` 最终为 `null` | `tests/scenarios.test.ts` —— *returns newest-first pages without duplicates and reaches a null cursor* | ✓ |
| `cli/tui/session-history.test.ts:4` *loads older history and preserves the visible scroll anchor* | 相同请求的页内容必须稳定 | 同上（页是确定性的） | ✓ |
| `cli/tui/session-history.test.ts:33` *releases the history load after a failed request* | 出过问题的一页不能毒化同一 cursor 的下一次请求；同一 cursor 返回同一页；超出末尾的 cursor 是干净的空页且 `next: null` | `tests/scenarios.test.ts` —— *lets a repeated request for the same cursor succeed after a bad one* | ✓ |
| `cli/tui/session-history.test.ts:55` *does not move a different session after history loads* | cursor 属于某一个会话：两个会话并发翻页不得混行，且各自不重复 | `tests/scenarios.test.ts` —— *keeps two sessions' pagination independent while both are being paged* | ✓ |

### 6.5 permission、form、取消

| 官方（tag v2.0.28） | 本桥契约 | 我们的 | 状态 |
|---|---|---|---|
| `cli/tui/data.test.tsx:2317` *adds and dismisses permission requests from live events* | `permission.asked` 带 v2 形状；回答后发 `permission.replied` | `tests/server.test.ts` —— *surfaces a permission request and accepts a reply*；`scripts/e2e-smoke.sh` 场景 2 | ✓ |
| `cli/tui/data.test.tsx:2388` *reconciles active session permissions when the event stream reconnects* | 断线期间结算的 permission 要在重连后回放，且 pending 列表随后为空 | `tests/server.test.ts` —— *replays a permission settlement and leaves no stale pending permission after reconnect* | ✓ |
| `cli/tui/data.test.tsx:2436` *dismisses a permission that expired before its reply* | 对未知/已过期请求的回答要是**明确的终态**（`404`），不是沉默 | `tests/server.test.ts` —— *surfaces a permission request and accepts a reply*（第二次回答断言为 `404`） | ✓ |
| `cli/tui/data.test.tsx:2494` / `:2773` *adds, dismisses, and refreshes form requests / reconciles active session forms on reconnect* | form 生命周期事件、按会话与全局的列表互相一致；断线期间取消要回放 | `tests/server.test.ts` —— *replays a form cancellation…*；`tests/scenarios.test.ts` —— form 终态竞态 + 三个列表一致 | ✓ |
| `cli/tui/form.test.tsx:138` *restores the composer when terminal-form revalidation fails* | 已结算的 form 对过期 reply/cancel 回 404，客户端才能恢复 | `tests/scenarios.test.ts` —— *settles once, rejects stale reply/cancel with 404…* | ✓ |
| `cli/tui/prompt-interrupt-status.test.tsx:7` *armed interrupt status renders visible warning text* | `POST /interrupt` 回 `200 {interrupted:boolean}`；工具收束；发 `execution.interrupted` | `tests/server.test.ts`；`tests/translate.test.ts`；`scripts/e2e-real-tui.sh MODE=cancel` | ✓ |

### 6.6 shell 输出

| 官方（tag v2.0.28） | 本桥契约 | 我们的 | 状态 |
|---|---|---|---|
| `component/dialog-shell-output.test.tsx:213` *large captures open at a bounded tail and clicking a shell opens the viewer* | `/api/shell/:id/output` 按 **UTF-8 字节** cursor + `limit` 分页；追平后返回空页 | `tests/scenarios.test.ts` —— *keeps cursor-paged output readable after the shell exits*、*uses UTF-8 bytes…* | ✓ |
| `component/dialog-shell-output.test.tsx:167` *empty output explains redirection, retries errors, and preserves output after removal* | `DELETE /api/shell/:id` 之后，该 shell 从 get/output/list 全部消失 | `tests/scenarios.test.ts` —— *removes a deleted shell from list and output endpoints* | ✓ |
| `cli/tui/data.test.tsx` 的 shell 行（`rows.ts` 分析） | `!命令` 行是带 `metadata.shellID` 的工具行；shell 对象本身**不带** `output` | `tests/scenarios.test.ts` —— *emits shell events the client can actually correlate…*、*scopes each shell to its session…*；`scripts/e2e-real-tui.sh MODE=shell` 与 `ENTRY=1 MODE=shell` | ✓ |

### 6.7 刻意不迁移

| 官方区域 | 原因 |
|---|---|
| tab 布局、宽度、marquee、鼠标拖拽（`component/session-tabs-mouse.test.tsx`、`context/session-tabs-model.test.ts`） | TUI 自己的渲染；改桥修不了 |
| form 编辑器内部：粘贴、光标、自定义多选（`cli/tui/form.test.tsx:291`+） | 同上 |
| shell viewer 的滚动位置与 follow 行为 | 客户端侧的 viewer；桥只提供字节 |
| 主题、ANSI 颜色、转圈动画 | 同上 |
| compaction、inbox queue、retry（`data.test.tsx:969`、`:1795`、`:1613`+） | 本桥不宣告 `session.compaction`，opencode 的 inbox queue 也没有 ACP 对应物 —— 它们是记录在 `docs/ACP-COMPAT.md` 里的**负面契约** |

### 6.8 官方发新版时怎么用这张表

1. `git diff <旧 tag> <新 tag> -- packages/tui/test` —— 凡涉及上表任一行的，都是候选。
2. 对每个变化的测试，在新 tag 上重读，并与**本桥契约**列对比。
3. 契约变了：要么修桥，要么在这里**加一行**（并补测试）。
4. 表里状态为 `~` 或 `✗` 的，就是待办；关掉一个就把状态改掉。
5. 重跑 `pnpm verify` 与 `pnpm verify:version <tag>`。

## 7. 这份文档自我约束的规则

- 只读**已发布的 tag**，绝不读工作树。
- 只有当**改本桥**能让一个官方测试失败时，它才值得迁移；否则那是 TUI 自己的事，明确列为"不迁移"。
- 任何测试都**不得 mock ACP**：要新行为就扩展 `tests/fake-acp-agent.mjs`。
- 每个迁移过来的契约都要在 `docs/SCENARIOS.md`（及其中文版）里写明它证明了什么。
- 真实屏幕断言只写在 `scripts/e2e-real-tui.sh` 里；桥层的断言只写在 Vitest 里。**两者不要混。**
