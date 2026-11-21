# opencode-acp-client

> English: [README.md](README.md)

> **不是 OpenCode 团队构建的，也与他们没有任何关联。** 这是一个社区维护的项目。
> 这里说的 “opencode v2” 指本项目驱动的开源 opencode v2 TUI —— 它由你自己安装、作为独立程序运行，
> 本项目不打包它，也不代表官方背书。

用 **opencode v2 的 TUI** 当界面，去驱动**任意 ACP agent**（一个终端
**[ACP](https://agentclientprotocol.com) 客户端**）。

```
opencode v2 TUI ──HTTP + SSE──▶ opencode-acp-client ──ACP stdio──▶ 任意 ACP agent
   （界面）
                                  （ACP 客户端）
                                                                   dsh --profile acp /
                                                                   opencode acp / qwen --acp /
                                                                   claude-acp / codex-acp …
```

**适合谁用**：喜欢、习惯了 opencode v2 的 TUI 的人 —— 熟悉它的按键、命令面板、会话 tab ——
希望继续用这套界面，同时驱动一个**不是 opencode 自己的** agent。

## 安装

### 第一步：先装 opencode v2

本工具**不自带 TUI**，它驱动的是你自己装的 **opencode v2**（`>=2.0.0`，建议最新版）。
**已经装了就跳过这一步**（用 `opencode --version` 确认是 v2.x）；没装则任选一种：

```bash
curl -fsSL https://opencode.ai/v2/install | bash   # 官方安装脚本
npm install -g @opencode/cli                      # 或者用 npm（包名是 @opencode/cli）
```

装完确认：`opencode --version` 应输出 **v2.x**（v1 不行 —— 它的事件词汇完全不同，本工具会拒绝启动）。

### 第二步：装本工具

需要 **Node ≥ 20**。

```bash
# 方式一：从 npm 装（推荐，装的是构建好的包）
npm install -g opencode-acp-client

# 方式二：直接从源码装（指定 Git 仓库即可；npm 会拉代码并在本地构建好）
npm install -g git+https://github.com/pi-is314/opencode-acp-client.git
```

两种方式装出来的东西完全一样。方式二不经过 npm 源，适合想跟主干代码、或者 npm 装不上的情况；
它会在安装时用 `typescript` 现场编译一次（约十几秒），所以需要能访问 npm 源去取编译器。

装出两个命令名，指向同一入口：**`opencode-acp-client`**（主名）和 **`oc-acp-client`**（短 alias）。

TUI 不在 `PATH` 上时，用 `$OPENCODE_BIN` 指过去；启动时会检查版本并报出来，而不是猜。

## 使用

```bash
npm install -g opencode-acp-client

oc-acp-client -- dsh --profile acp     # 用 dsh 的内置 ACP profile
oc-acp-client -- qwen --acp            # 用 qwen-code
oc-acp-client -- opencode acp          # 用我们的桥把 opencode acp 转成 opencode 自己的 http 协议 :)
```

`--` 后面那条命令就是 agent，说 ACP、走 stdio 的东西都能用。一条命令起 TUI + 适配层；
退出 TUI（或 Ctrl-C）会把 agent 一起停掉，不留残余进程。

除上面几个，还能驱动很多实现了 ACP 的 agent，例如
[gemini-cli](https://github.com/google-gemini/gemini-cli)（`gemini --acp`）、
[Pi](https://github.com/badlogic/pi-mono)（经 [pi-acp](https://github.com/svkozak/pi-acp) 适配）、
[GitHub Copilot](https://github.com/features/copilot)、
[Kimi CLI](https://github.com/MoonshotAI/kimi-cli)、
[Goose](https://block.github.io/goose/)、[Cursor](https://cursor.com/docs/cli/acp)、
[Kiro CLI](https://kiro.dev/docs/cli/acp/)、[Cline](https://cline.bot/)、
[OpenHands](https://docs.openhands.dev/openhands/usage/run-openhands/acp) 等。
**更多 ACP agent 见这个列表**：<https://agentclientprotocol.com/get-started/agents>。

**恢复会话**：

```bash
opencode-acp-client -c                  # 当前目录最近的一条
opencode-acp-client -s ses_xxxxx        # 指定会话
```

`-s` / `-c` **不接受** agent 命令 —— 用哪个 agent 由会话映射表决定，CLI 替你启动它。
id 从哪来？退出 TUI 时打印的 `Continue` 行已被改写成可直接复制的一条命令；也可以：

```bash
python3 scripts/list-sessions.py            # 最新 20 条：id、多久之前、标题、目录
python3 scripts/list-sessions.py my-project # 按标题/目录/id 子串过滤
```

**一个 client 只服务一个 agent。** 这是设计而非缺失：模型/provider 属于 agent，把两个 agent 的
tab 混在一个 TUI 里，正是「新 tab 显示成另一个 agent 的模型」的来源。所以 TUI 的 tab 布局按
agent 隔离（`~/.opencode-acp-client/opencode/<agent-slug>/`），属于其它 agent 的会话会被拒绝
（`404`）。`--` 只用于**新建**会话。

## 实测过的 agent

每行都是一次真跑，不是抄文档。

| Agent | 命令 |
|---|---|
| dsh（内置 ACP profile） | `dsh --profile acp` |
| dsh + [deepseek-harness-acp](https://github.com/openma-ai/deepseek-harness-acp)（openma 的插件） | `dsh --profile <你的 profile>` |
| opencode | `opencode acp` |
| [qwen-code](https://github.com/QwenLM/qwen-code) | `qwen --acp` |
| [claude-acp](https://github.com/agentclientprotocol/claude-agent-acp) | `npx -y @agentclientprotocol/claude-agent-acp` |
| [codex-acp](https://github.com/agentclientprotocol/codex-acp) | `npx -y @agentclientprotocol/codex-acp` |

## 常用参数

| 参数 | 含义 |
|---|---|
| `<directory>` | 工作目录（opencode 的拼写；`--directory` / `-C` 也透传给 TUI）|
| `-s <id>` / `--session <id>` | 恢复指定会话 |
| `-c` / `--continue` | 恢复当前目录最近的会话 |
| `--no-tui` | 只提供 HTTP/SSE 面，不起 TUI |
| `--bridge-port <n>` | 只在这个端口提供服务（隐含 `--no-tui`）|
| `--bridge-log <path>` | 桥日志位置 |
| `$OPENCODE_BIN` | opencode v2 二进制路径 |

**能到 TUI 的参数就这么几个**（语义是 opencode v2 的，不是我们的）：

| 参数 | 怎么到 TUI |
|---|---|
| `--auto` | 原样转发（自动批准未被显式拒绝的权限）|
| `--prompt <text>` | 原样转发（起 TUI 前先填好这句）|
| `--print-logs` | 原样转发 |
| `--log-level <level>` | 原样转发 |
| `-c` / `--continue` | 原样转发 —— 由 TUI 自己去读它记的会话列表 |
| `-s <id>` / `--session <id>` | **桥先解析**：认你看到的 `ses_…`，再以 `--session` 交给 TUI |

`--server` / `--standalone` 由本工具接管（桥就是那个 server），传了会被丢掉而**不是**转发。
其余参数不转给 TUI：`auth`、`plugin`、`upgrade` 这类子命令是**原样直通给 opencode 可执行文件本身**（见下）。

`--help` 先打印 opencode v2 自己的帮助，再追加本工具的参数段。

**子命令**：`models` / `api` / `session` 走桥（答案属于你接的 agent），其余（`auth`、`plugin`、
`upgrade`、`debug`…）原样直通给 opencode。`ps` 列出本工具启动过的桥进程。

## 它写了哪些文件

都在 `~/.opencode-acp-client/` 下。**不写原生 opencode v2 的安装目录**；会话映射表只存
id、目录、标题和创建它的 agent argv —— **不存消息内容，也不存凭证**。

| 路径 | 是什么 |
|---|---|
| `sessions.json` | 会话映射表（可见 id ↔ agent 自己的 id、目录、标题、agent）|
| `opencode/<agent-slug>/` | 该 agent 的 TUI 状态与数据；配置（`tui.json`、插件、主题）与你自己的安装共享 |
| `daemons/<pid>.json` | `ps` 用的注册表，正常退出即删 |

## 恢复出来是什么样

取决于 agent 宣告了哪个能力 —— tab 标题会告诉你是哪一种：

- 有 `loadSession` → 回放历史，看得到原来的对话。
- 只有 `sessionCapabilities.resume`（dsh 官方 `acp` profile 就是这样）→ ACP 的
  `session/resume` **按规范不重放历史**，tab 是空的，但保留真名，并有一条 `◈ Notice`
  说明原因。**上下文是否还在，规范不保证。**
- 两个都没有 → 旧会话接不回来；tab 变成一个**新对话**，标题 `[new conversation] <目录名>`。

## 已实测的平台与版本

**完整门控**（typecheck、单测、52 探针的 OpenAPI 校验、tmux 里的全部真 TUI 模式）在
**macOS** 与 **Debian 12** 上各跑过：两边都是 **v2.0.0、v2.1.0、v2.2.0、v2.3.0**，
macOS 上另有 v2.2.7 等中间版本。Windows 上跑 typecheck 与单测，TUI 未实测（没有 tmux）。
16 个 release 逐个记录在 [docs/COMPAT-OPENCODE.zh.md](docs/COMPAT-OPENCODE.zh.md)。

## 设计准则

1. **每个入站请求都要回答。** agent 问了什么却听不到回音，会永远等下去；不支持的也要明确拒绝，让它能降级。
2. **永不假设能力存在。** ACP 是协商出来的，降级规则见 [docs/ACP-COMPAT.zh.md](docs/ACP-COMPAT.zh.md)。
3. **宁可吵闹的真相，不要安静的猜测。** 缺口要能被发现，而不是静默地什么都不渲染。

## 已知缺口

- 未实现的路由：pty、MCP auth、provider OAuth、worktree 变更、revert/share、大部分 `/tui/*` ——
  它们返回格式正确的空信封，或一条记了日志的 404。真实会话用到的 355 个请求已全覆盖。
- **其它 v2 客户端暂不推荐**：状态根是注入给我们自己拉起的 TUI 子进程的，别的客户端拿不到，
  它的 tab 不按 agent 隔离（见上）。

## 文档

- [docs/ARCHITECTURE.zh.md](docs/ARCHITECTURE.zh.md) —— 进程模型与一个回合的时序
- [docs/PROTOCOL.zh.md](docs/PROTOCOL.zh.md) —— 我们实现的 opencode v2 接口面
- [docs/ACP-MATRIX.zh.md](docs/ACP-MATRIX.zh.md) —— ACP 方法矩阵、事件变体、故意偏离
- [docs/ACP-COMPAT.zh.md](docs/ACP-COMPAT.zh.md) —— 运行时能力降级规则
- [docs/COMPAT-OPENCODE.zh.md](docs/COMPAT-OPENCODE.zh.md) —— 版本策略与逐版本实测记录
- [docs/SESSION-LIFECYCLE.zh.md](docs/SESSION-LIFECYCLE.zh.md) —— 会话、映射表、恢复链路
- [docs/DEVELOPMENT.zh.md](docs/DEVELOPMENT.zh.md) —— 开发笔记与坑
- [AGENTS.zh.md](AGENTS.zh.md) —— 开发本仓的入口

## 许可证

[Apache-2.0](LICENSE)。本项目把 opencode v2 二进制作为独立进程启动、走它公开的 HTTP 接口面，
**不链接任何第三方源码**，所以许可独立成立。
