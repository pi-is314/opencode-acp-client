# 架构

> English: [ARCHITECTURE.md](ARCHITECTURE.md)

## 进程模型

一个桥进程。它内部是：

```
                 ┌───────────────────────────────── oc-acp-client ──────────────────────────────────┐
opencode v2 客户端 │                                                                         │
   │ HTTP/SSE    │  src/server.ts      路由 + 生命周期                                        │
   ├────────────▶│    │                                                                      │
   │             │    ├── src/sse.ts        SseHub：扇出 + 有界重放环形缓冲                    │
   │             │    ├── src/state.ts      会话 / 消息 / part（内存态）                       │
   │             │    └── src/translate/    ACP session/update → opencode v2 事件              │
   │             │          ▲                                                                 │
   │             │          │                                                                 │
   │             │  src/acp/client.ts   stdio 上的 JSON-RPC、请求关联、超时                     │
   │             │          │                                                                 │
   │             └──────────┼─────────────────────────────────────────────────────────────────┘
   │                        │ ACP stdio
   │                        ▼
   │                    每个 agent 程序一条 ACP 连接（会话在连接上多路复用）
   ```

**每个 agent 程序一条 ACP 连接，会话在连接上多路复用。** 一个 `(command, args)`
一个进程，每个会话是它上面的一次 `session/new`：每个会话仍各有自己的 catalog
（`AcpClient` 按会话 id 记 config）和翻译器，**共享的只有进程**。代价是真实的：
agent 崩溃或退出会带走连接上的所有会话。

**Tab 的预取是按需的，这是有意的。** 原生 opencode v2 的 TUI 会预取所有记住的 tab
（元数据立刻拉，转写各 300ms 后拉一个）——在它那里很便宜，因为只有一个服务进程在读 SQLite。
在这里，一次需要加载的转写读取就是**一个完整的 agent 进程**在跑 `session/load`/`session/resume`，
而带工作区锁的后端（dsh）会直接拒绝第二次加载。所以：可见 tab 要的那次读取照常加载；
**并发**到达的后台 tab 读取用现有内容回答（日志 `[bridge] lazy: … answered without loading`），
等使用者真的切过去（切 tab 会挂载会话、重新读转写）再加载。

## 一个回合，端到端

```
客户端                     桥                              agent
  │ POST /api/session/:id/prompt
  ├─────────────────────────▶
  │                          │ 追加用户消息，为它发 message.*
  │ ◀── 200 占位响应 ────────┤（响应立刻返回；回合在后台继续跑）
  │                          │
  │                          │ spawn agent（懒加载）→ initialize → session/new
  │                          ├───────────────────────────────▶
  │                          │ ◀──────────── sessionId ────────
  │                          │ 发 turn.wait + session.status(busy)
  │                          ├── session/prompt ─────────────▶
  │                          │                                │
  │ ◀── message.part.delta ──┤ ◀── session/update(chunk) ──────┤
  │ ◀── message.part.updated─┤
  │ ◀── permission.asked ────┤ ◀── request_permission ─────────┤
  │ POST …/permission/:id/reply
  ├─────────────────────────▶ ├── result(selected) ──────────▶
  │ ◀── permission.replied ──┤
  │                          │ ◀── prompt resolves(stopReason)─┤
  │ ◀── session.idle ────────┤ 发 turn.idle + session.status(idle)
  │ ◀── turn.idle ───────────┤
```

这里有两件事很容易做错，而我们是刻意这么处理的：

- **HTTP 响应是占位的。** 若把整个回合 await 完再返回，请求会阻塞几分钟、客户端
  必然超时。真正的内容走 `/api/event` 到达。
- **回合结束时关闭所有仍打开的 part。** 一个拿不到 `end` 的 `reasoning` part
  就是一个永远转不停的 spinner —— 在回合被打断、最终消息永远不来的场景里最明显。

## 模块

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 解析命令行；打印 ready 行 |
| `src/server.ts` | 路由、会话动作、prompt/回合 生命周期 |
| `src/sse.ts` | `/api/event`：扇出、`server.connected` 握手、按 `Last-Event-ID` 有界重放 |
| `src/state.ts` | 会话、消息、part |
| `src/contract.ts` | 我们实现的 opencode v2 接口面（观测所得，不是臆造）|
| `src/acp/client.ts` | spawn、JSON-RPC、关联、超时、回调应答 |
| `src/acp/capabilities.ts` | 协商 + 降级 |
| `src/translate/events.ts` | ACP → opencode v2 的映射 |

## 失败策略

| 情形 | 行为 |
|---|---|
| agent 永不回答某个请求 | 按请求超时（默认 120s）→ reject，回合以错误结束 |
| agent 调 `fs/*` 或 `terminal/*` | 明确的 `-32601` error；我们从未广告过这些能力，而沉默会让它挂死 |
| agent 在回合中途死掉 | 挂起请求全部 reject；`turn.idle` 仍会发出，好让 UI 解卡 |
| 未知 HTTP 路由 | `404` + 一行 `[bridge] unhandled route:` 日志 |
| 未知 `session/update` | 忽略 + 记日志 |
| 不支持的 prompt 块（image/audio/…） | 发送前丢弃 + 记日志 |

## 为什么一个 agent 进程服务多个会话，以及为什么懒加载

在第一次 prompt 时才 spawn，能让启动瞬间完成，也意味着一个只列会话的客户端
永远不会为 agent 付出代价。进程按 **agent 程序**共享，而不是按 tab 各起一个：
每个 tab 一个进程会让每开一个新 tab 都付一次冷启动。`abort` 与 cancel 仍按会话
隔离（它们是 ACP 的会话级操作），但**崩溃不是**——进程挂了，连接上的每个会话一起没了。
