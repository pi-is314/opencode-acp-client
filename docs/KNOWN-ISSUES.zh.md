# 已知问题与限制

> English: [KNOWN-ISSUES.md](KNOWN-ISSUES.md)

> 这一页只留**尚未解决**的问题与**已知限制**。已经修掉的记录不在仓库里。
> 已修的部分连同复现与原因记在本地一份不纳入版本控制的文档里。

## 打字途中，最近一次来回的消息会消失 🟡（观察中，未定位）

**症状**：在输入框里打字的过程中，会话展示区里**已经回复过的那一次来回**（最后一条用户消息
+ 它的回复）突然消失。

**状态**：近几日未再出现，**未定位，也未排除**。不是已修复——没有改动对应它。

**再出现时怎么做**：带着探针跑一次，它可以一刀切开「桥给没给最新那条」：

```bash
OPENCODE_ACP_CLIENT_MESSAGE_PROBE=1 oc-acp-client -- <agent>
```

**已知的相邻事实**（都是独立结论，不是这次的原因）：

- SSE 空闲约 45s 会被 HTTP 栈回收；客户端因此重连并重走整套引导。**这一点已处理**：
  `/api/event` 每 15s 发一个 `: keepalive` 注释帧。
- 客户端的保护面只覆盖「用户行 + 未确认发送」，机制存在但触发者未知。


## 已知限制：重启后，会话历史里没有 `!` 命令 ✗（与原生一致，**不是 bug**）

**报告**（用户实测）：`!ls` 当场能用；关掉程序重开、从 tab / session list 切回旧会话，
**普通对话都在 ✓，但 shell 命令那条不在了** ✗。

### 为什么：`!` 命令**从来没有经过 ACP agent** ✓

三条读自 v2.0.28 实装源码的证据：

1. **官方 TUI 走的是独立的 HTTP 接口**，和对话并行：

   ```ts
   // packages/tui/src/component/prompt/index.tsx:1306
   if (currentMode === "shell") {
     const send = () => client.api.session.shell({ sessionID: target, command: inputText })
   ```

   对话走 `session.prompt`（agent 会记录 ✓），shell 走 `session.shell`（agent 不参与 ✗）。

2. **官方 Shell 服务明确声明不保存会话/消息状态**：

   ```text
   packages/core/src/shell.ts:57-59
     * Each `create` spawns one shell command, captures combined stdout/stderr to a
     * file-backed output by cursor. No session, message, or permission state lives here.
   ```

3. **shell 的三个事件全是 `ephemeral`（不持久）**，而 `session.message.*` 是 `durable`：

   ```ts
   // packages/schema/src/shell.ts:58-61
   const Created = ephemeral({ type: "shell.created", ... })
   const Exited  = ephemeral({ type: "shell.exited",  ... })
   const Deleted = ephemeral({ type: "shell.deleted", ... })
   ```

本桥实现同样如此：`startShell` 里 **ACP 相关调用 0 次** ✓，直接 `child_process.spawn` ✓；
而且 **ACP 根本没有「执行 shell」这个方法** ✗（它的 `terminal/*` 是**反过来**的：
agent 请求客户端跑命令，而本桥**故意不宣告**该能力 ✓，见铁律 1）。

### 结论 ✓

```text
普通对话   → 经过 ACP → agent 有记录 → 重启后 session/load 能回放 ✓
!shell    → 不经过 ACP → 谁都没记录 → 重启后无处可回放 ✗
```

**原生 opencode v2 同样如此** ✓ —— 重启后它的 shell 也不在历史里 ✓。
所以这是**与官方行为一致的已知限制**，不是本仓的缺陷 ✓。


回归证据：`MODE=shell-history` 的真 TUI 断言 ✓（`scripts/e2e-real-tui.sh` ✓，进 `pnpm verify` ✓）。

---

# session 恢复：结论

使用者用 `dsh --profile acp`（dsh 内置的 ACP profile）实测后报三件事：
标题不变、恢复「没成功」、退出回显变成官方 `opencode -s …`。逐条查完，结论如下。


## 未解决 / 待决定（都不是本次改动能单方面决定的）

1. **有些 agent 没有标题面**（`@deepseek-ai/dsh-acp` 全库 `session_info_update` 出现 **0** 次，
   `session/list` 也不带 title）。应对：**确定性兜底标题**（首条输入压成一行、最多 48 字、超了加 `…`；
   `derivedTitle()`）。优先级：agent 标题 > 用户改名 > 兜底标题 > 目录名/标记；`SessionRecord.titleFrom*`
   三个字段记录来源，兜底永远不会覆盖更好的标题。兜底标题**不写映射表**（那是消息文本）。
2. **多 tab 启动会拉起 N 个 agent 进程**（`/message`、`/api/model`、`/api/command` 三条路径都会顺手启动；
   实测 2 tab → 2 次 load）。plain `acp` 下这些 load **拿不到任何历史**，纯浪费，而且单写者后端会互相踩。
   改法（懒加载）依赖 TUI 内部读取次序，风险中高，需要单独一轮验证。
3. **恢复失败时的兜底策略**：现在是「起一个新会话并如实标记」；更严格的做法是**不造新会话**，
   让 tab 空着、下一次输入时才建。两种都诚实，区别是失败代价（agent 存储里多一个空会话）与可用性。
4. 全新启动会预建一个空壳会话并 eager 起 agent；TUI 自己**不开**新会话（实测：什么都不输入时，
   全程只有 1 个会话、1 个 agent —— `scripts/e2e-epilogue.sh` 的 `empty` 场景日志），
   但**第一次提交时它会 POST 自己的会话** → 于是变成两个会话、两个 agent，预建那个从此空置。
   （`GET /api/model` 的 pending 路径其实也能拉起目录，预建那步是否还有必要需要单独测。）

---

## ★ 事实一：`session/resume` 之后，模型是否还“记得”这段对话 —— **不保证**

同一个 profile，两种结果都实测到：

```text
（A）run1: "Remember this word: ZEBRA … ACK_ONE" ✓
     run1 第二轮: "哪个词?" → ZEBRA ✓（同一会话内记忆正常 = 对照实验）
     重开 + `-s <id>` → resumed without replay ✓
     run2: "哪个词?" → 「这段对话里没有让我记住的词」            ← 不记得
（B）同样的流程跑在另一个模型上：
     run2: "哪个词?" → ZEBRA ✓                                  ← 记得
```

- 所以「上下文接上了、能接着聊」和「上下文全丢了」**都不能写死**；
- 能写死的只有规范保证的部分：**不重放历史**（客户端屏幕是空的），以及「同一个 session id」；
- 标题保留**真名**（不加标记，屏幕确实没有历史这件事由会话区那条 Notice 说清楚：agent 没有 `session/load`）；
- 桥日志与 `src/acp/client.ts` 的注释已改成「是否记得由 agent 决定，同一 profile 两种都实测过」，
  README / SESSION-LIFECYCLE / ACP-MATRIX / SCENARIOS 同步；
- 验收脚本对两种结果都接受：记得 → ✓，不记得 → 记为与文档一致的注记，不算失败。
  （★ 单一模型的一次回答不足以支撑「一定不记得」这个结论。）


## ★ 事实二：中途换模型 —— **支持**；失败只说明目标 provider 当时不可用

目标是「换模型之后下一轮报 `Connection error`」时，第一反应会指向 agent。
但那次那个 provider 正好全部不可用，而同一时刻其它 provider 是好的。裸 ACP 对照实验：

```text
[跨 provider] deepseek-official/deepseek-v4-flash -> deepseek/deepseek-v4-pro
  set_config_option: OK 4ms   currentValue 已更新
  turn:              OK 2151ms                       ← 跨 provider 切完照样能跑
[跨 provider] provider-a/model-x -> provider-b/model-y
  set_config_option: OK 3ms   currentValue 已更新
  turn:              FAIL 15459ms -> Internal error: turn failed: Connection error.
```

- 所以：**`session/set_config_option` 的请求形状没问题，切换本身也没问题**（同 provider、跨 provider 都可以，
  回合前后都可以）；`Connection error` 是 agent 在如实报告「这个 provider 现在连不上」。
- 同一时段内那个 provider 下的**所有**模型都失败，而其它 provider 的模型正常 —— 与「换模型」无关。
- 我们因此**不需要**为换模型做任何绕行；TUI 每次挂载重发一次「就是当前模型」的选择仍然短路掉
  （那是一次没必要的 agent 调用，省掉是对的，但它不是正确性的前提）。
- 留给使用者的唯一建议：目标 provider 不可用时，换过去的下一个回合会失败；换回来或等 provider 恢复。


## Windows：单测有 9 个失败 ✗（`windows.yml` 已改为手动触发）

**状态**：`.github/workflows/windows.yml` 第一次真正跑（2026-11-21，新仓库）时 **402 个单测挂了 10 个**。
其中 2 个是**真实产品缺陷**，当场修了：

- `findExecutable` 用「含 `/`」判断是不是路径 → Windows 的 `C:\…\node.exe` 不含 `/`，
  被当成**命令名**去 PATH 里找，明明存在的文件返回 `undefined`；
- `matchesDirectory` 只读 `HOME` → Windows 设的是 `USERPROFILE`，`~` 永远不展开。

**剩下 9 个仍是真实缺陷**，不是测试的问题：

| 失败的测试 | 意味着什么 |
|---|---|
| `/cd move` ×2 | 切目录在 Windows 上不生效 |
| `!command` 的 shell ×2 + shell 列表 ×2 | 分页与字节处理在 Windows 上出错 |
| `skill attachment` | 技能附件路径 |
| `workspace` ×2 | 工作目录解析 |

**为什么先把触发改成手动**：每次 push 都红，`main` 就永远是红的，而**永远红的工作流没人看** ——
真出现回归时反而被淹没。改法是逐个修；**修绿的那一次提交里，同时把 `push` / `pull_request` 触发加回来**。

手动跑一次：`gh workflow run windows.yml`。

## TODO (pending fix): dsh's tool cards show `{` instead of a title

Reported from `~/projects/webapp` with `oc-acp-client -- dsh --profile <profile>`
(the agent is the `<profile>` profile, not the plain `--profile acp` one).
The transcript shows `$ {` for shell cards and `" {` for another kind — the title
collapses to the first character of a JSON object.

Hypothesis (to verify, not yet measured): dsh's `tool_call` frame carries no usable
`title`/`name`, and its `rawInput` is an object whose JSON text starts with `{`; our
name fallback chain (`update['name']` -> title -> kind -> 'tool') ends up on a value
that stringifies to `{`, or the TUI's shell row takes `input.command` from an object.
Measure with OPENCODE_ACP_CLIENT_TRACE=1 before changing anything.
