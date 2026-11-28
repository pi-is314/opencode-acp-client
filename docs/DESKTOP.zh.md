# 用 opencode desktop 驱动这个桥

> [English](DESKTOP.md)

opencode desktop 说的是和 TUI 同一套 HTTP/SSE 接口，所以它可以连这个桥，而不是连 opencode 自己的
服务端。**用 desktop 本身的一切 —— 加 server、加项目、打开会话、终端页签、`/agent`、模型选择器 ——
都是 desktop 自己的功能，这里不写。** 这一页只讲属于桥的部分：怎么为 desktop 起一个桥、它在那个角色
下能做什么不能做什么、以及怎么停掉它。

---

## 起一个桥

```bash
oc-acp-client --bridge-port 8765 ~/project -- <agent command>
```

`--bridge-port` 隐含 `--no-tui`，不会画终端界面；桥打印一行 ready 行，带着它正在服务的 URL，
那就是要让 desktop 连的地址。

| 参数 | 为什么拉 desktop 时需要 |
|---|---|
| `--bridge-port <n>` | 定端口；不给的话桥自己挑一个空闲的，地址每次都不一样 |
| `--bridge-host <addr>` | 只在 desktop 跑在**另一台机器**上时需要 —— 见下面的警告 |
| `--bridge-log <file>` | 把请求日志写到能看的地方；这时没有终端可以盯 |

★ **一个桥只驱动一个 agent。** 会话在一条 ACP 连接上复用，而桥的布局是按 agent 分的。两个 agent
就是两个端口上的两个桥，这也正是 desktop 里两个 server 的由来。

★ **`--bridge-host 0.0.0.0` 没有鉴权。** 任何能连到这个端口的东西都能驱动那个 agent：读它的对话，
跑它的工具。除非中间的网络是可信的，否则保持默认的 `127.0.0.1`；desktop 在另一台机器上时，优先用
SSH 隧道。

---

## 桥为 desktop 回答了哪些

TUI 用到的是这套接口里很窄的一部分，desktop 解析得更多，差异就出在这里。下面这些都已实现，每一条
背后都有一段来历 —— 见 `318a5e7` 前后的提交历史：

| 路由 | desktop 拿它做什么 |
|---|---|
| `/api/project` | 建项目树；每一项需要 `worktree`、`sandboxes` 和 `time` |
| `/api/config` | 读配置文档；空数组是合法 JSON，但仍然让新建会话失败 |
| `/api/session` | 列出会话；一个会话需要带 `model` 才能被 desktop 解码 |
| `/api/model` | 填模型选择器 |
| `/api/agent` | 把 ACP 的模式列成 agent |
| `/api/health` 和 `/api/info` | “添加 server”那张卡片两个都探 |

★ **一个渲染得少的客户端，不等于更容易满足的客户端。** TUI 根本不看 `sandboxes`，desktop 不加防护
地读了它然后抛异常。新增一个路由或改动一个字段时，先拿真实的 `opencode serve` 对照一遍，别以为桥
的答案已经齐了。

---

## 怎么停

用 `--bridge-port` 起的桥是谁连上都服务，所以 **desktop 关掉时没有任何东西会告诉它** —— 它会一直
跑着，连同它的 agent，直到你把它停掉。

```bash
oc-acp-client ps            # 当前活着的桥：pid、状态、多久之前、agent、目录、URL
oc-acp-client stop          # 只有它一个活着时停掉；多个时会拒绝并列出来
oc-acp-client stop <pid>    # 停那一个
oc-acp-client stop --all    # 停所有活着的
oc-acp-client ps --prune    # 忘掉那些进程已经不在的记录
```

★ **`stop` 发 SIGTERM 并等它退出。** 桥自己的关闭流程会关掉服务端、注销记录，并**杀掉它起的
agent**。SIGKILL 三件事全跳过，agent 会作为孤儿活下来，占着 workspace 锁 —— 那正是让后来的
`session/load` 报 “Internal error”、而新桥自己的日志看起来一切正常的原因。

★ 进程已经不在的记录（崩溃、`kill -9`、重启）在 `ps` 里显示为 `stale`。它们无害，但会累积 —— 每次
崩溃留一条 —— `ps --prune` 清掉它们。

---

## desktop 的会话在桥里是什么样

没什么特别的：desktop 只是 HTTP 接口的又一个客户端，所以一轮对话的表现和在 TUI 里一样。读桥日志时
有两件事值得知道：

- **desktop 在有选择之后，会在每次 prompt 之前带上自己的 `session.agent`**，所以本该在 TUI 里悄无声息
  的地方，会看到 `[bridge] mode -> …` 这样的行。
- **它订阅 `/api/event`，并在暂停后重连**；连着几行 `GET /api/event` 是一次重连，不是泄漏。

---

## harness

`scripts/e2e-desktop.mjs` 通过 CDP 驱动一个**源码**构建，不在 `pnpm verify` 里 —— 它需要把 opencode
仓库放在旁边，而且它会起一个 Electron 应用。它覆盖的正是这一页不写的那些路径（加 server、打开会话、
工具卡片、agent 选择器、plan 面板），因为那些都是 desktop 自己的；它存在的理由是证明桥答得上来。

```bash
node scripts/e2e-desktop.mjs            # 会话路径
MODE=permission node scripts/e2e-desktop.mjs   # 审批对话框，它会卡住一轮
```

★ 它只跑 **dev** 版 desktop（`ai.opencode.desktop.dev`），安装版永远不会被碰到。
