# 附加说明

> [English](DETAILS.md)

README 里第一次读不需要的部分：本工具往磁盘写了什么、恢复出来的会话是什么样、桥遵循的准则、
以及它目前还做不到什么。

---

## 它写了哪些文件

都在 `~/.opencode-acp-client/` 下。**不写原生 opencode v2 的安装目录**；会话映射表只存
id、目录、标题和创建它的 agent argv —— **不存消息内容，也不存凭证**。

| 路径 | 是什么 |
|---|---|
| `sessions.json` | 会话映射表（可见 id ↔ agent 自己的 id、目录、标题、agent）|
| `opencode/<agent-slug>/` | 该 agent 的 TUI 状态与数据；配置（`tui.json`、插件、主题）与你自己的安装共享 |
| `daemons/<pid>.json` | `ps` 用的注册表，正常退出即删 |

---

## 恢复出来是什么样

取决于 agent 宣告了哪个能力 —— tab 标题会告诉你是哪一种：

- 有 `loadSession` → 回放历史，看得到原来的对话。
- 只有 `sessionCapabilities.resume`（dsh 官方 `acp` profile 就是这样）→ ACP 的
  `session/resume` **按规范不重放历史**，tab 是空的，但保留真名，并有一条 `◈ Notice`
  说明原因。**上下文是否还在，规范不保证。**
- 两个都没有 → 旧会话接不回来；tab 变成一个**新对话**，标题 `[new conversation] <目录名>`。

---

## 设计准则

1. **每个入站请求都要回答。** agent 问了什么却听不到回音，会永远等下去；不支持的也要明确拒绝，让它能降级。
2. **永不假设能力存在。** ACP 是协商出来的，降级规则见 [docs/ACP-COMPAT.zh.md](docs/ACP-COMPAT.zh.md)。
3. **宁可吵闹的真相，不要安静的猜测。** 缺口要能被发现，而不是静默地什么都不渲染。

---

## 已知缺口

- 未实现的路由：pty、MCP auth、provider OAuth、worktree 变更、revert/share、大部分 `/tui/*` ——
  它们返回格式正确的空信封，或一条记了日志的 404。真实会话用到的 355 个请求已全覆盖。
- **其它 v2 客户端暂不推荐**：状态根是注入给我们自己拉起的 TUI 子进程的，别的客户端拿不到，
  它的 tab 不按 agent 隔离（见上）。

