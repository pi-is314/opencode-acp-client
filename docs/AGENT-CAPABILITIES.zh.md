# 常用 ACP agent 的能力缺失 → 在本项目里掉什么功能

> English: [AGENT-CAPABILITIES.md](AGENT-CAPABILITIES.md)

> 本文件只记录**实测的 agent 能力**，以及它在本项目（`oc-acp-client`）里造成的**用户可见后果**。
> 通用降级规则见 [ACP-COMPAT.md](ACP-COMPAT.md)；协议方法清单见 [ACP-MATRIX.md](ACP-MATRIX.md)；
> 会话机制（双 id、三条恢复链路）见 [SESSION-LIFECYCLE.zh.md](SESSION-LIFECYCLE.zh.md)。

## 0. 怎么读（证据等级）

| 级别 | 含义 |
|---|---|
| **①** | **本仓实测**：在开发机上直接起该 agent、发 `initialize`，读回 `agentCapabilities` |
| **②** | **发布源码**：读该 agent 发布的源码（本机有 checkout / 解包） |
| **③** | **调研记录**：只有外部调研写过，**本仓没复核** |

没写证据的格子是 **①**。**能力位是协商结果，不是常量**——agent 升级就会变，读完这张表要重新测一次。

## 0.5 认 agent 看 `agentInfo`，不要看 profile 名

dsh 的 ACP 入口是内置 ACP app（`@deepseek-ai/dsh-acp-app`），命令行上是 `dsh --profile acp`。
profile 名可以被改、被删、被指向别的实现。**判据是 `initialize` 回来的 `agentInfo`
（name + version）与 `agentCapabilities`**，不是命令行里的 profile 名。

| agent（身份） | 包 / 来源 | `agentInfo` | 端到端充分度 |
|---|---|---|---|
| dsh 官方 ACP | `@deepseek-ai/dsh-acp-app` | 名称与版本由 agent 自己报，以 `initialize` 回包为准 | ✅ 多次 `e2e:dsh-acp` 全流程 |
| opencode | 官方 `opencode acp` 子命令 | `OpenCode 2.0.32` | 🟡 初始化、TUI 探针、录帧已做；真实模型端到端待补 |
| claude | `@agentclientprotocol/claude-agent-acp` | `0.93.0`（title: Claude Agent） | ⬜ **仅 initialize**，端到端待补（位置保留） |
| codex | `@agentclientprotocol/codex-acp` | `2.2.2`（title: Codex） | ⬜ **仅 initialize**，端到端待补（位置保留） |

## 1. 总表（实测）

| 能力 | dsh 官方 ACP | opencode acp | claude-agent-acp | codex-acp |
|---|---|---|---|---|
| `loadSession`（恢复时**回放历史**） | **✗** | ✓ | ✓（①，E2E 待补） | ✓（①，E2E 待补） |
| `sessionCapabilities.resume` | ✓ | ✓ | ✓ | ✓ |
| `sessionCapabilities.list`（发现旧会话 / 取标题） | ✓ | ✓ | ✓ | ✓ |
| `sessionCapabilities.close` | ✓ | ✓ | ✓ | ✓ |
| `sessionCapabilities.delete` | **✗** | ✓ | ✓ | ✓ |
| `sessionCapabilities.fork` | ✗ | ✓ | ✓ | ✓ |
| `sessionCapabilities.additionalDirectories` | ✗ | ✓ | ✓ | ✓ |
| `promptCapabilities.image` | **✗（显式 false）** | ✓ | ✓ | ✓ |
| `promptCapabilities.embeddedContext` | **✗（显式 false）** | ✓ | ✓ | ✓ |
| `session/set_config_option`（切模型） | ✓ | ✓ | ✓ | ✓ |
| `session_info_update`（agent 主动改标题） | **✗（实测 0 次）** | **✗（② 源码）** | ✓（③） | ✓（③） |
| `session/list` 条目带 `title` | **✗（条目无 title）** | ✓（② `withTimestampedFallback`） | 未确认 | 未确认 |
| 认证方法 | 无（`authMethods: []`） | `opencode auth login` | `auth.logout`（登录走自己的渠道） | `api-key` / `chat-gpt` |

一句话：**dsh 官方 ACP 缺三大件（`loadSession`、图片、标题）**；opencode v2 的能力面最全。
claude / codex 的**初始化**能力已读回，但端到端（真回合、TUI、恢复）尚未充分验证——位置保留。

## 2. 逐个 agent：在本项目里掉什么

### 2.1 dsh 官方 ACP（`@deepseek-ai/dsh-acp-app`）

```bash
oc-acp-client -- dsh --profile acp      # profile 名只是本机示例
```

| 缺的能力 | 在本项目里的表现 |
|---|---|
| `loadSession` | **恢复成功但没有历史**：`-s` 走 `session/resume`（重连同一会话、不重放），tab **保留真名**（无标记），会话区多一条 `◈ Notice`：**`Resumed without showing history: this agent "<agent command>" has no session/load capability`**。上下文是否还在**不保证**：同一 profile 实测两种都有（换模型后一次记得、一次不记得）。 |
| 标题面 | 不推 `session_info_update`，`session/list` 条目也没有 `title` → 标题只能用**第一条 prompt 派生**（会写进映射表，所以恢复后仍是真名；没有 prompt 时是目录名）。 |
| `promptCapabilities.image` / `embeddedContext` | 带图/带嵌入上下文的 prompt，那些块**被丢掉并记日志**，文本照常发送。 |
| `sessionCapabilities.delete` | TUI 的删除只能删本地（映射表条目 + tab）；**agent 侧会话还在**。桥会在后台尝试一次 `session/delete`，这个 agent 甚至可能不答，超时后记 `agent could not release <id>`。 |
| fork / additionalDirectories | 没有；本桥也不宣告这些，用户看不到。 |

### 2.2 opencode acp

```bash
oc-acp-client -- opencode acp
```

| 能力 | 在本项目里的表现 |
|---|---|
| `loadSession` ✓ | **恢复 = 回放历史**，看得到原来的对话——与 dsh 官方 `acp` 的体验相反。 |
| `session/list` 带 title ✓ | 标题取 list 的 `title`（`applyBackendTitle`），即使 agent 不推 `session_info_update`。 |
| image / embeddedContext ✓ | 附件与嵌入上下文可用。 |
| delete / fork / close ✓ | 删除会真的删到 agent 侧（fork 仍受本桥不调用 unstable 方法的限制）。 |
| usage | **只发 prompt 结果里的 unstable `usage`**，不发 `usage_update`；桥两边都读（见 ACP-MATRIX §4）。 |

坑（agent 侧，不是桥）：`opencode acp` 子命令**自身没有 provider 凭证**，`opencode auth login`
没做过时回合会失败；错误会如实上屏。

### 2.3 claude-agent-acp（位置保留，端到端待补）

```bash
oc-acp-client -- npx -y @agentclientprotocol/claude-agent-acp
```

- 目前只有 **initialize 实测**（`agentInfo 0.93.0`）：`loadSession` / `resume` / `list` / `close` /
  `delete` / `fork` / `additionalDirectories` / `systemPrompt` / `image` / `embeddedContext` /
  `auth.logout` / `mcp http+sse` 都宣告了。
- 标题：调研记录说会推 `session_info_update`（③，本仓未复核）。
- **端到端（真回合、TUI、恢复）未充分验证**：以上结论只说明"它宣告了"，不说明"在本项目里走得通"。
  待补的验收：`AGENT="npx -y @agentclientprotocol/claude-agent-acp" bash scripts/e2e-real-agent.sh`
  与一次真 TUI 回合。

### 2.4 codex-acp（位置保留，端到端待补）

```bash
oc-acp-client -- npx -y @agentclientprotocol/codex-acp
```

- initialize 实测（`agentInfo 2.2.2`）：能力同样齐全（还多一个 `subagents` 变体）；
  `current_mode_update` **故意不发**（改用 `config_option_update`）——本桥两者都处理，无影响。
- 认证：`api-key` 与 `chat-gpt` 两种。
- **端到端未充分验证**（同上）。待补：`AGENT="npx -y @agentclientprotocol/codex-acp" ...`
  加一次真 TUI 回合。

## 3. 通用映射：缺一个能力，用户看到什么

| agent 缺 | 仍然可用 | 现成例子 |
|---|---|---|
| `session/load` | 恢复成功（同一会话，上下文**可能**继续） | dsh 官方 ACP |
| `resume` 也没有 | 会话照常能新建 | 假 agent 夹具 |
| 标题面（`session_info_update` 与 list 的 `title`） | 会话照常 | dsh 官方 ACP |
| `promptCapabilities.image` | 文本 prompt | dsh 官方 ACP |
| `promptCapabilities.embeddedContext` | 文本 prompt | dsh 官方 ACP |
| `sessionCapabilities.delete` | 本地删掉 tab | dsh 官方 ACP |
| `sessionCapabilities.close` | 会话可用 | 未测到 |
| `sessionCapabilities.list` | 会话可用 | 假 agent |
| `session/set_config_option` | 默认模型 | 未测到 |

## 4. 自己复核（一行命令，不改代码）

```bash
# 把 <agent 命令> 换成上表任意一个，读回 agentCapabilities
python3 - <<'PY'
import json, subprocess
cmd = ["dsh", "--profile", "acp"]          # 例：["opencode", "acp"]
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, cwd="/tmp")
p.stdin.write(json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize",
                          "params":{"protocolVersion":1,"clientCapabilities":{}}}) + "\n")
p.stdin.flush()
print(json.dumps(json.loads(p.stdout.readline()), indent=2, ensure_ascii=False))
p.kill()
PY
```

读 `result.agentInfo` 与 `result.agentCapabilities`：`loadSession` / `promptCapabilities` /
`sessionCapabilities`。**先看 `agentInfo` 确认身份**，再下结论——profile 名不可靠。

端到端层面（真终端、真回合、按屏幕断言）用：

```bash
bash scripts/e2e-agent-matrix.sh     # 六个 agent 的完整回合矩阵，agent 自己的凭证问题记为 BLOCKED
```

★ 本桥的日志里 `[acp] initialized: {…}` 那行是**能力矩阵的 ground truth**——排查"某个功能没反应"先看它，
不要靠猜，也不要靠 grep 别的项目的源码。
