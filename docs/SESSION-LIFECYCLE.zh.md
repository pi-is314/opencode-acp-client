# Session 生命周期 —— id 的两副面孔、恢复链路与时序雷区

> ★ 这是本仓最容易出 bug 的一块，每个机制都对应一次真实故障。
> English: [SESSION-LIFECYCLE.md](SESSION-LIFECYCLE.md)

## 目录

0. 为什么 session 这么容易出问题
1. id 的两副面孔与映射表（含 1.2 会话属于哪个 agent）
2. 恢复链路（预建记录、空壳复用、`-c`、adoption）
3. `ensureAgent` 的 id 优先级
4. "最新会话"、epilogue 回显、恢复的三种结局、标题来源
5. 时序雷区（每条都对应一次实测故障）
6. 一张恢复时序图
7. 多 tab：预取、懒加载、每个 tab 自己的 agent 与模型目录

## 0. 为什么 session 这么容易出问题

三个结构性原因，理解了它们，后面的机制都是必然：

1. **一个会话有两个 id**。ACP 规定 `session/new` **没有** id 入参——agent 自己铸 id（通常是 UUID）；
   而 opencode v2 的规范要求会话 id 匹配 `^ses_…`。于是**任何人都不许假装它们相同**。
2. **真相分属三个进程**。会话的正文在 agent 手里（我们**不落盘**任何消息）；
   "哪对 id 是同一个会话"只在桥的映射表里；"上次开的是哪个 tab"只在 TUI 的记忆里。
   任何一处脱钩，恢复就是空的。
3. **agent 是单写者**（dsh 实测：同一会话/工作区，第二个进程的 `session/load` 答 "Internal error"）。
   两条链路同时碰一个会话 = 必败，所以**时序**不是细节，是正确性本身。

```
        ┌────────────────┐   可见 id (ses_…)          ┌─────────────┐
        │ opencode v2 TUI │◀──────────────────────────▶│             │
        │ 记住: 开过哪些tab │   HTTP + SSE               │    本桥      │
        └────────────────┘                             │             │
                                                     ┌─│  映射表(唯一  │
        ┌────────────────┐   agent id (UUID)           │ │  的持久状态)  │
        │   ACP agent    │◀───────────────────────────┼─┤             │
        │ 会话正文/标题    │   ACP stdio (JSON-RPC)      │ └─────────────┘
        │ (agent 自己落盘) │                            │
        └────────────────┘                            ▼
                                        ~/.opencode-acp-client/sessions.json
```

## 1. id 的两副面孔与映射表

| | 可见 id（visible id）| agent id |
|---|---|---|
| **谁铸** | 桥（`ses_…`，符合 opencode 规范）| agent（dsh：UUID）|
| **谁用** | TUI 的 tab、HTTP 路由、`--session`/`-s` 的入参 | ACP 的 `session/load`/`session/list`/`session/prompt` |
| **存在哪** | TUI 自己的记忆 + 桥的映射表（作为键）| 桥的映射表（作为值）+ agent 自己的存储 |

映射表是**本仓唯一的持久文件**（`~/.opencode-acp-client/sessions.json`；另有一份每进程的
`daemons/<pid>.json` 注册表，干净退出即删除，供 `oc-acp-client ps` 使用，
可用 `OPENCODE_ACP_CLIENT_SESSION_MAP` 改名/移位）：

```json
"ses_a1b2c3d4e5f6…" : {
  "acpSessionId" : "9f8e7d6c-5b4a-…",      // agent 侧真身
  "directory"    : "/…/my-project",         // 会话属于哪个工作区（/cd 后更新）
  "title"        : "Explain this codebase", // agent 起的标题（可无）
  "agent"        : { "command": "dsh", "args": ["--profile", "acp"] }, // 谁建的（可无；见下）
  "updatedAt"    : 1792135708656
}
```

写入时机：**真实用过才写**——prompt 走完一轮、adoption 命中、discovery 导入 titled 会话。
**没被 prompt 过的空壳永远不进表**。

★ `agent` = 创建它的 agent **argv**（`{command, args}`，不经过 shell）。
ACP 没有「这个会话属于哪个 agent」的概念，`session/resume` 只认 id，所以用另一个 agent 重开时，
旧 tab 的 id 会被塞进当前 agent —— 实测：先用 `opencode acp` 建会话、再用
`oc-acp-client -- dsh -- profile acp` 重开，那个 tab 只能是空的或报错，而屏幕上什么原因都不写。
**现行策略：一个 client 只驱动启动命令指定的那个 agent**；其它 agent 的条目在
采纳/`-s` 时一律拒绝（404），不再 spawn 它自己的 agent（见 §1.2）。

### 1.1 反查规则（`visibleIdFor` 修）

discovery 导入时要为 agent 会话找已有的可见 id：

```text
给定 directory 时：先在「该 directory 的条目」里精确匹配 agent id；
都没有 → 允许「完全没有 directory 的旧格式条目」兜底；
仍然没有 → 造 ses_acp_<uuid去横线> 新别名。
```

★ 修复原因：同一个 agent 会话在两个工作区用过，A 工作区的导入曾抢到 B 工作区写的
别名——那个别名映射的是 B 目录，恢复时在 A 下加载不到任何东西。
**跨目录绝不串**，目录是会话身份的一部分。

### 1.2 会话属于哪个 agent（`agent` 字段）

ACP **没有**「这个会话属于哪个 agent」的概念：`session/resume`/`session/load` 只认 id，
存到哪里、能不能并发，全由 agent 实现决定。于是「用另一个 agent 重开」时，桥本来会把
opencode 的会话 id 塞给 dsh —— 实测表现是一个空 tab，屏幕上**没有任何原因**。

映射表现在多存一个字段：

```json
"agent" : { "command": "opencode", "args": ["acp"] }
```

- **argv，不是 shell 字符串**：spawn 时直接 exec，不经过 shell；
- 与本次启动的 agent **相同** → 正常采纳/恢复（`record.agent` 不设置，沿用启动的 agent）；
- ★ 与本次启动的 agent **不同** → **拒绝（404）**，不 spawn 别的 agent、不把 id 交给它：
  ```text
  [bridge] refusing 'ses_…': it belongs to 'opencode acp', this bridge drives 'dsh --profile acp' — launch the client with that agent instead
  ```
- `-s <其它 agent 的 id>` 在 CLI 入口就报错（`session … belongs to '…'`），不会走到启动；
- ★ **没有该字段的旧条目也拒绝（404）**：身份不明，猜不起。
- TUI 的状态根按 agent 隔离（`~/.opencode-acp-client/opencode/<slug>/`），所以旧 tab 通常
  连出现都不会出现；这一层是给 `-s`、手写映射和残留 tab 的硬边界。

（旧策略是「按会话绑定它自己的 agent、需要时 spawn」。它让 dsh 的启动里出现
opencode 的 tab，并把 opencode 的模型目录带进新 tab 的 composer。）

## 2. 恢复链路（三条，严格区分）

```
--session <id>（显式）            -c / --continue（隐式）             tab 点击/重开（被动）
───────────────────────        ─────────────────────────────      ─────────────────────────
启动时:                          启动时:                              TUI 请求 GET /api/session/<id>:
 1. parseArgs 拿到原文 id          1. 起一个一次性 ACP 连接               1. 桥查内存 → 没有？
 2. resolveSessionId:               2. session/list(本目录)               2. 查映射表 → 有 acpId？
    查映射表 → 命中? 用 agent id       3. 取「本目录最新（titled 优先）」         ├─ 有 → adoption（收养）
    : 未命中? 按 agent-native          4. dispose 该连接                        └─ 无 → 见 §2.3 收养规则
      透传（UUID 直通）               5. 把这对 id 交给预建恢复路径 ★
 3. 预建记录:                       ★ = 与 --session 完全同构！
    键 = 用户输入的原文 id           （历史先于 TUI 加载完成）
    acpSessionId = 翻译结果
 4. ensureSession → eager
    session/load → 177 条回放
    （历史先于 TUI 加载完成）
```

### 2.1 预建记录（`ensureSession`）

桥保证「至少有一个会话」（TUI 的 composer 只在 session 路由上可用）。
预建记录的**键**：

```typescript
createSession(location, name, resumeVisibleSessionId ?? resumeSession)
//                        ↑ 用户输入的 ses_…，绝不是翻译后的 UUID
```

★ 曾经的 bug：键用了翻译后的 agent id → TUI 拿 `ses_…` 来请求时**命不中**预建记录
→ 走 adoption → 第二个 agent 进程 load 同一会话 → 单写者拒绝 → 兜底分支**新建一个会话**
冒充恢复（标题当时写的是 `[not resumed]`）。三连症状：tab 在、标题对、内容空。

### 2.1.1 预建空壳的复用（R7）

预建记录**不是会话**：它只是让 composer 一开始就有 session 路由。以前它带来的代价是
「一次新对话 = 两条记录 + 两个 agent 进程」：

1. `GET /api/session/active` → `ensureSession` 预建空壳；
2. `/api/model` 为了让目录不是占位符，对空壳 `ensureAgent` → **第一个 agent**；
3. 用户按下回车，TUI 自己 `POST /api/session`（带它选的 id）→ 第二条记录，第一个 prompt → **第二个 agent**。

现在 `POST /api/session` **收编**空壳：

- 空壳带 `precreated` 标记；可复用条件：没有消息、不在跑、目录相同（`canonicalPath` 比较）；
- 命中后把它 **rekey** 成客户端选的 id，并把 `agents` / `pendingAgents` / `translators` /
  挂起权限与表单这些按会话 id 索引的表一起搬过去（`rekeySession`）——**预热好的 agent 保留**；
- **映射表也要搬**：空壳在 `/api/model` 预热时已经写下「可见 id → agent id」的配对，若不搬，
  配对就还挂在空壳的 id 上，而退出回显打印的是客户端选的 id → 下一次 `-s` 直接报
  `unknown session id`。实测：正是这个原因。现在 `rekeySession`
  会 `forget(old)` + `remember(new, …)`，一条会话不会有两个可见 id；
- 于是：一条记录、一个 agent、一个可见 id、`/api/model` 已取到的目录继续有效。

★ 自己挖的坑：第一版用 `record !== shell` 判断「是否搬过表」，而 `state.rekey` 是原地改 id、
返回同一个对象 → 条件永远为假，agent 还挂在旧 id 上，第一个 prompt 找不到 agent、又起一个，
并走进 resume 分支把标题写成 `[new conversation] hi`。**比较 id，不要比较对象。**

真 TUI 验证（fake agent）：新对话一轮之后 `/api/session` 只有一条（标题来自第一句话），
日志里 `adopted the pre-created session as …` 一次、没有 `cannot resume`。

### 2.2 `-c` 为什么必须与 `--session` 同构

同一会话、同一桥，两形态实测对比：

```text
--session ses_xxx：eager load 在 TUI 连接前完成 → GET /message 时数据就绪 → 历史秒开
-c（旧实现）      ：TUI 先导航 → GET /message 撞上 8 秒的 dsh 启动 → 响应虽等到了数据，
                    但 TUI 的预取快照早已按空渲染                      → 历史空白
```

所以 `-c` 现在直接查**映射表**：本目录 `updatedAt` 最新的、带 `agent` 的那条就是它，
agent 也一并从条目里取（不需要 `--`），再把它 resolve 成一对 id 交给预建路径——
**加载发生在 TUI 连接之前**。

★ 规则细节（`newestContinueEntry`，纯函数、有单测）：**按目录过滤（realpath）、按 `updatedAt` 取最新、
必须带 `agent`**（没 agent 的旧条目无法启动，跳过）。没有条目 → **直接报错**：
`no session to continue in <dir>; start a new one with -- <agent>`，
不再退回空白的预建会话（原生 `-c` 在空库下会报错 + 落到草稿，我们选择更清楚的一条）。
目录比较走 **realpath**：macOS 上 `/var` 与 `/private/var` 是同一个地方，字面比较会静默什么都找不到。

★ 什么都 continue 不了时（agent 不宣告 `session/list`，或本目录下没有会话），预建记录的标题写成
`[new conversation] <目录>`——客户端自己的 `-c` 会落到它上面，不标的话看起来就是「延续了一个历史莫名消失的会话」。

### 2.3 收养规则（adoption 收紧）

TUI 重开时会请求它记忆中的每个 tab id。桥的应答分三类：

```text
映射表命中                        未命中，但是 UUID 形状             未命中，且不是 UUID
→ 正常收养：翻译出 agent id       → 收养：id 原样当 agent id         → 404 拒收
  走 load，回放历史                 （从 dsh web UI 抄来的场景）           （TUI 丢弃该 tab）
```

★ 404 是**故意的**：旧规则"无差别收养"会把映射丢失的 `ses_…`、甚至垃圾 id
（见 §5 的 dummy）实体化——load 必败后兜底**新建一个空会话**，
顶着真会话的名字出现在 tab 里。宁可 404 被丢弃，也不要假的恢复。

## 3. `ensureAgent` 的 id 优先级（★ 最重要的单行规则）

```typescript
// 正确（当前）：
const wanted =
  record.acpSessionId ??                       // 记录自己的 id 永远赢
  (record.session.id === resumeRecordKey        // 只有预建记录才用进程级 resume id
    ? this.options.resumeSession
    : undefined);

// 曾经写反的（代价：所有 tab 加载同一个会话）：
const wanted = this.options.resumeSession ?? record.acpSessionId;  // ✗
```

反的那种写法让**每个**被 adoption 的 tab 都去 load 进程级的 resume 会话：
- 正确的那个 tab load 到别的会话（内容错位）；
- 同一会话的别名 tab 与预建记录的活 agent 相撞（单写者）→ 恢复失败 ×N
  → **每撞一次就 spawn 一个新空壳**。

## 4. "最新会话"的判定与排序

`-c` 的语义 = TUI 问 `GET /api/session?limit=1&order=desc` 取第一条。桥保证这条是真会话：

```text
排序规则（state.all）：
  1. 有消息的记录 恒排在 空记录 之前      ← 预建的空壳（标题=目录名）永远不该被 -c 选中
  2. 同组内按 time.updated 降序
加载完成的记录 → state.touch           ← 刚恢复的会话成为"最新"
```

★ 曾经的 bug：预建空记录 `updated = now`，排最前 → TUI 的 `-c` 选中它 →
打开一个标题为目录名的空白会话，而真会话作为 tab 秒后才出现。

### 4.1 epilogue 的 Continue 行（按确定性排三级，不猜；再按「能不能恢复」过滤）

★ 候选按 `prompted → intent(--session/-c) → viewed` 排序，但**只会打印下一个进程真能解析的 id**：
`firstResolvableSessionId` 用 `resolveSessionId` 逐个试，`ses_…` 且映射表没有配对的一律跳过
（一个从没走到 agent 的会话仍可能被算作 viewed；打印它等于保证下一次失败）。
agent 原生 UUID 照旧放行（`-s` 允许它，由 agent 自己判断）。

退出时 TUI 打印 `Continue opencode -s <id>`（原生串硬编码在 TUI 二进制里）。
桥在**子进程退出后**用 ANSI 定位改写该行。取哪个 id —— `epilogueSessionId`
（`src/index.ts`，纯函数、有单测）按**确定性**分三级：

```text
1. prompted  本轮真的输入过的会话      ← 桥自己在 prompt 处理器第一行记的，最硬
2. intent    用户点名要恢复的会话      ← --session <id> / -c 解析出来的一对 id
3. viewed    客户端最后读过/聚焦的会话  ← GET /api/session/:id、POST /view
三级全空（开着、没输入、没点开任何会话）→ 保留原生行，绝不编一个 id

为什么要这三级的顺序（每条都是一次实测）：
  · 只有「输入过」时，恢复后不输入就退出的会话没名字 → 原生行（最先报的 bug）
  · 只有「最后读过的」时，多 tab 启动会把**别的 tab** 当成最后读过 → 名字错位
  · 所以 intent 必须压过 viewed：用户点名的 ≠ 客户端预取顺手读的
行形态：用户敲的命令形态 + -s <id>
        （已有 --session/-s/-c 原位替换；无则在 -- 前插入；
          桥内部参数 --bridge-* 剔除；PATH 解析过的 agent 命令还原为 basename）
读法：只用内存里的访问器（`promptedSessionId` / `viewedSessionId`），
      不在退出时发 HTTP —— 实测那一下会撞上关停，拿回 null。

验收：`bash scripts/e2e-epilogue.sh`（真 TUI + tmux + 按屏幕断言，4 个场景：
恢复后不输入、intent 压过 viewed、只有 viewed、什么都没有）。
```
### 4.2 恢复的三种结局（能力决定，标题如实）

`ensureAgent` 只调 agent **宣告过**的方法——ACP 对这两条都是 MUST NOT：没有
`loadSession` 不能 `session/load`，没有 `sessionCapabilities.resume` 不能 `session/resume`。
于是恢复只有三种结局，而**标题是用户唯一能看到的说明**（客户端会把它持久化进 tab 布局，
所以措辞必须与事实一致——`[not resumed]` 就曾把一个成功的恢复说成失败）：

| agent 宣告 | 我们做什么 | tab 标题 | 屏幕上是什么 |
|---|---|---|---|
| `loadSession` | `session/load`，回放变成 transcript | 不动（agent 给的标题优先） | 历史在 |
| 只有 `resume`（dsh 的 plain `acp` 就是这样） | `session/resume`：重连同一个会话，**不重放历史** | 保留**真名**（无标记） | 空（规范如此），但会话区会多一条 `◈ Notice`：`Resumed without showing history: this agent has no session/load capability`——把「agent 读不了历史」说清楚，而不是让人以为「没有历史」。★ 上下文是否还在**不保证**：同一 profile 实测两种都有（换模型后一次记得、一次不记得）——两种说法都不要写死 |
| 两者都没有 | 两个方法都不调，如实记「无法恢复」，起一个新会话 | `[new conversation] <目录名>` | 空，但明确是**新对话** |

★ 标记是**幂等**的：`markTitle` 先剥掉旧标记（含历史的 `[not resumed]`）再加新的，
所以反复恢复不会叠成 `[new conversation] [new conversation] …`。

★ 映射表的写入规则（`rememberPairing`）：

- **成功**时把「可见 id → agent id」补上。`-c` 合成的 `ses_acp_…`（agent 自己的列表里来）
  只有靠这一步才能在下次 `-s` 时被解析出来——否则回显给你的那行 id 下次会被判成「未知会话」。
- **失败兜底**时只在「本来就没有这条映射」的情况下写入新会话；**已有的映射不动**。
  旧会话在 agent 自己那边完好，下次启动会再试它，而不是永久改指向新会话。

失败时（load / resume 抛错，实测最常见的原因是**另一个进程握着这个会话**——单写者）
本次运行内提示走新会话，标题已经说明了这件事。

### 4.3 标题从哪来（谁赢）

ACP 没有「客户端设标题」的方法，`session_info_update` 是 agent 的方向。于是标题有四个来源，
优先级从高到低：

```text
1. agent         session_info_update / session/list 的 title   ← 最高，一到就覆盖
2. 用户改名      PATCH /api/session/:id、POST /rename          ← 立刻生效，兜底不再动它
3. 兜底标题      第一条输入（压一行、≤48 字、超了加 …）        ← 只算一次，绝不反复重算
4. 默认/标记     目录名、[new conversation]                    ← 什么都没有时的样子（`[no history]`/`[no transcript]` 是历史遗留，仍会被剥掉）
```

`SessionRecord.titleFromAgent / titleFromUser / titleDerived` 三个标记记录来源，
`deriveTitle`（`src/server.ts`）只在三个标记都为假时动手；`derivedTitle` 是纯函数（有单测）。

★ **标题是双向的，映射表存「最后已知的名字」**：兜底标题、agent 的
`session_info_update` / `session/list` 标题、用户改名，**任何一个来源赢，都把当前标题写回映射表**
（`persistTitle`；标记是显示装饰，永不写表）。这样 `-s` 恢复时读回的是
真实名字，而不是目录名——之前只有 agent 标题进表，plain `acp` 根本没有标题面，于是每次恢复都退回 `tau`。
表仍然**不存消息内容**：一个 ≤48 字的标题是身份，不是日志。

★ 为什么必须有兜底：plain `acp` 完全没有标题面（实测 `session_info_update` 出现 0 次），
没有它，这类会话永远停在客户端的「New session」——那正是 owner 最早报的第一条。

## 5. 时序雷区（每条都对应一次实测故障）

```text
雷区 A —— 双 agent 进程撞单写者锁
  eager session/new（预建记录）+ adoption 的 session/load（另一条链路）
  = 两个 dsh 进程在同一工作区 → 后者必败（Internal error）
  ∴ continue-mode 下预建记录保持 lazy，绝不起第二个进程。

雷区 B —— load 撞 agent 未就绪
  discovery/启动最早期，dsh 存储可能未 ready → 同一个 load 稍后重试就成。
  ∴ load 失败先延迟 2s 重试一次，仍败才走兜底（并如实标记会话标题）。

雷区 C —— 残留进程占锁（环境级）
  tmux kill-session / 关窗 曾直接杀死桥（无 SIGHUP 处理）→ agent 孤儿化
  → 之后所有 load 必败，症状像极了桥的 bug。
  ∴ SIGHUP 接入关停流程；排查"恢复空白"先 ps 查孤儿。

雷区 D —— TUI 的 -c 占位符 "dummy"
  TUI 源码：-c 的 initialRoute 硬编码 sessionID:"dummy"，等列表回来才真导航。
  桥若收养它 → 实体化出一个叫 dummy 的空会话。现在 404 拒收（§2.3）。

雷区 E —— discovery 自己制造空壳
  discovery 起 agent 连接拿列表，dsh 在 initialize 时顺手 session/new 一个空壳。
  曾实测：某工作区 41 个会话 37 个是空壳（90%）——历史探针的累积污染。
  ∴ 只导入 titled 会话（dsh 在回合完成后才起标题，空壳无标题天然被排除）；
    测试结束必须跑归档脚本（[AGENTS.zh.md](../AGENTS.zh.md) §6）。
```

## 6. 一张恢复时序图（当前正确版）

```
oc-acp-client --session ses_AAA -- dsh
   │
   ├─ resolveSessionId(ses_AAA)      查映射表 → agent id 91b0…
   ├─ BridgeServer(resumeSession=91b0…, resumeVisibleSessionId=ses_AAA)
   ├─ listen
   ├─ ensureSession                预建记录，键=ses_AAA
   │     └─ ensureAgent → session/load(91b0…) → 回放 177 条 → record.history 就绪
   ├─ waitForCatalog               模型目录到达
   ├─ launch TUI (--server … --session ses_AAA)
   │     TUI: GET /api/session/ses_AAA      → 命中预建记录（键匹配！）✓
   │     TUI: GET /…/ses_AAA/message        → 回放好的历史，立即渲染 ✓
   └─ 用户 Ctrl-C → SIGHUP/SIGINT → server.close → agent dispose → 零孤儿
```

## 7. 多 tab：预取、懒加载、每个 tab 自己的 agent 与模型目录

### 7.1 原生 opencode v2 怎么做，我们为什么不照抄

原生 TUI 在连上之后**错峰全量预取**：元数据立刻并行拉所有记住的 tab；`TAB_PREFETCH_DELAY`
（300ms）之后，对**除当前 tab 之外**的每个 tab 依次拉 message / pending / permission / form
（`packages/tui/src/context/session-tabs.tsx`）。它便宜，是因为**一个服务进程 + SQLite**：
一次 sync 就是一次数据库读。

我们这里一次「需要加载的转写读取」= **一个完整的 agent 进程**做 `session/load`/`session/resume`，
而带工作区/会话锁的后端（dsh）会直接拒绝第二次持有。所以照抄全量预取 = N 个 agent 进程。

### 7.2 懒加载：同一时刻只加载一个转写

`/message` 的读路径有一条闸：**同一时刻只允许一个转写加载**。

- 可见 tab 的 mount 读先到（客户端源码注释：可见会话的 mount sync 先占连接槽）→ 它拿到加载；
- 并发到达的后台 tab 读 → 用现有内容回答，并记
  `[bridge] lazy: ses_… answered without loading (ses_… is loading its transcript)`；
- 用户切过去时，客户端会 mount 该会话、重新读转写 → 这时闸空了，才真正加载。

这样做不是「兼容性缺口」而是**资源策略**：ACP 只要求「一个会话同一时刻一个持有者」，
没要求客户端读一次就起一个进程。真 TUI 验证（fake agent）：多 tab 重开时，
只有一个转写被加载，后台 tab 在切过去之后再加载。

### 7.3 每个 tab 自己的 agent（见 §1.2）

一个桥可以同时服务多个 agent：tab 的绑定来自映射表，spawn 时用它的 argv。每个 tab 仍是
**懒启动**：只有它真的需要 agent 时才 spawn。

### 7.4 模型目录按「前台的 tab」取

`GET /api/model` 只带 `location[directory]`，没有 session id；但目录必须来自**当前 tab 的 agent**：
两个 tab 分别绑 dsh 和 opencode 时，把 dsh 的模型列在 opencode 的 tab 上，选什么都会被 agent 拒绝。

桥于是记录**聚焦会话**（`noteFocus`）：

- 每次会话级请求（读转写、prompt、换模型、改名）都算一次「看这个会话」；
- 但**同一秒内的多次不同会话**视为启动预取（可见 tab 先到、预取 300ms 后到），**不改变聚焦**；
- 人类切 tab 一定落在静默间隔之后，于是会更新聚焦（`FOCUS_GAP_MS = 1000`）。

`/api/model` 用聚焦会话的 agent 生成目录；没有聚焦（刚启动/新客户端）时退回「所有活着的 agent」。
换模型时再**按该会话自己的目录校验**：不属于这个 agent 的模型直接回 400
（`the agent refused the model switch: …` / `… is not offered by this session's agent`），
而不是让 agent 回一句没人看得懂的 `Internal error`。

★ 已知限制：聚焦是启发式（客户端不给会话 id）。刚启动就立刻打开选择器时，可能仍是「并集」；
人类切 tab 后一定正确。真 TUI 验证（fake agent）：两个 tab 分别只有 model-1 / model-2 时，
切到哪个 tab，`/api/model` 就只列那一个；跨 tab 选模型得到 400。

