# 桥如何提供 web UI

opencode v2.2 起自带一个 **web UI** —— 和 TUI、desktop 同一套界面，只是以普通网页的形式发出来。值得支持，
因为它在人坐的那台机器上什么都不用装：打开一个 URL 就开始和 agent 对话。

桥没法自己提供它。页面是编译产物，打进这个包里就等于把界面钉死在某一个 opencode 版本上 —— 上游每改一次
界面，我们就要发一次版。**所以桥从一个真实的 `opencode serve` 借用 bundle，在自己的 origin 上把它和桥
已经实现的路由一起发出。** 这一页记录为什么是这个形状、代价是什么，以及那些冲突是怎么定的。

---

## 1. 真实 web UI 对它的 origin 有什么要求

对 `opencode serve`（v2.4.1，监听在一个 loopback 端口上）实测：

| 请求 | 应答 | 备注 |
|---|---|---|
| `GET /` | `200 text/html` | 整个应用外壳；**不需要认证** |
| `GET /_assets/*` | `200`，文件名带哈希 | 编译后的 bundle；**不需要认证** |
| `GET /site.webmanifest`、`/favicon.ico`、`/robots.txt` | `200` | 同一类公开资源 |
| `GET /api/*` | 带 `Authorization: Basic …` 时 `200`，**不带时 `401`** | `WWW-Authenticate: Basic realm="Secure Area"` |
| 任何未知路径 | `200 text/html` | SPA 回退 —— `/ws`、`/pty` 返回的是 HTML，不是路由 |

两个事实决定了设计：

★ **前端只认 `location.origin`。** bundle 用它解析服务器地址
（`currentServerUrl: () => location.origin + <前缀>`），CSP 是 `connect-src 'self'`。所以从 `A` 发出的
页面无法指向 `B` 上的 API —— 没有配置项，没有 CORS origin，什么都没有。**页面和 API 必须同一个 origin。**

★ **凭证走 URL 或 header，从不走 cookie。** 服务端接受 `Authorization: Basic <base64(user:pass)>`
**或者** `?auth_token=<同一个 base64>`（`packages/server/src/middleware/authorization.ts`）；
`opencode pair` 生成的链接就是 query 形式，bundle 读到之后会把参数从地址栏抹掉。整个交换里除了页面自己
的 `fetch`（天然同源）之外，没有任何东西绑定 origin。

合起来：**桥必须从自己的 origin 发这个页面，并且必须把它收到的凭证转发出去。** 这就是它做的事。

---

## 2. 形状：再一个代理，默认关闭

```
浏览器 ──GET /──────────▶ 桥 ──普通 GET──────────▶ opencode serve（loopback，私有）
       ──GET /api/*─────▶ 桥  （自己的应答 —— 页面的 API 是我们的）
       ──GET /_assets/*─▶ 桥 ──普通 GET──────────▶ opencode serve
```

- **`/api/*` 永不代理。** 页面是客户端；它的 API 是桥自己的 —— 和 TUI、desktop 用的是同一批路由。代理它们
  等于把 opencode 自己的会话端出去，而不是 agent 的，正好把这个产品的意义倒过来。
- **其余全部从 helper 取**，再从这个 origin 发出。桥自己不做超出 helper `cache-control` 的缓存：文件名是
  内容哈希，所以重新取一次的成本只是每次加载页面每个资源多一次往返，而升级之后也不会把两个版本的产物
  混在一个页面里。
- **默认关闭。** 不带 `--web-proxy <url>` 时，桥的行为和以前一模一样，不发任何页面。跑 TUI 的人不应该
  在自己的端口上多出一个他没要求的浏览器界面。

---

## 3. helper 怎么起，以及为什么桥不代起

`--web-proxy <url>` 指向一个**正在运行**的 `opencode serve`：

```bash
opencode serve --hostname 127.0.0.1 --port 4096 &
oc-acp-client --bridge-port 8765 --web-proxy http://127.0.0.1:4096 . -- qwen --acp
```

★ **桥不负责启动 helper。** 代起意味着要管理第二个进程的生命周期、端口和密码 —— 而桥已经解析的那个
`opencode` 二进制是它跑 TUI 用的，它的 `serve` 未必和某人想用的 bundle 是同一个版本。写成 URL，决定权
留在人手里，失败也只有一种清楚的形态（"那儿没人在听"），而不是两种（"没起来" / "起来了但 bundle 不对"）。

★ **helper 不需要密码，也不会得到密码。** 它只听 loopback，只有本机能连；浏览器永远不直接和它说话。面向
网络的是桥的端口，而它有自己的一套认证（见下）。

---

## 4. 那些冲突是怎么定的

### 4.1 两个 server，一个 origin

页面由桥发出；它的 API 调用落在桥上。helper 的 API 通过桥的 origin 根本不可达，所以"`/api/session` 是谁
答的"只有一个答案。从 helper 那里只取静态字节。

### 4.2 认证

页面假设自己可以认证：真实服务器上每个 `/api/*` 调用都带 Basic 凭证，页面拿到 `401` 就显示登录页。而桥
今天完全没有认证（见 `docs/DESKTOP.md` 的 `--bridge-host`）。**在这个基础上提供一个浏览器 UI，等于把
agent 的执行权交给任何能连上端口的东西** —— 比 desktop 的情况更糟，因为 desktop 至少不是一个人会收藏的 URL。

所以这个功能自带一个密码：

- `--web-password <pass>` 或 `OPENCODE_WEB_PASSWORD`，**只要发页面就必填**。没有它就启动拒绝
  `--web-proxy`，用一句话说明原因 —— 因为没有密码的浏览器 UI 是这个功能唯一不能发出去的组合。
- 对 `/api/*`，除非请求带上了密码，桥回 `401` 加 `WWW-Authenticate: Basic realm="Secure Area"`。密码
  以 Basic 形式给，或 `?auth_token=<base64("opencode:<pass>")>` 的形式给 —— 正是页面和 pair 链接已经在用的
  两种。按 helper 的同一条规则实现，所以一个能对着 `opencode serve` 工作的 bundle 在这里不用改。
- **范围：只到 `/api/*`。** 静态资源保持公开，和真实服务器一样，这样页面能先把登录界面画出来。资源里没有
  任何秘密。

### 4.3 桥自己的客户端

TUI 和 desktop **不带凭证** —— 它们走 loopback，而且是那么验证的。要求它们出示密码会破坏每一个现有部署。

分界画在请求从哪里来，不画在它是哪个客户端：

| 请求来源 | 密码 |
|---|---|
| loopback（`127.0.0.1`、`::1`） | 不要求 |
| 其它任何地方 | 要求 |

★ 这和桥其它部分一直遵守的是同一条规则：`--bridge-host` 默认 `127.0.0.1` 就是因为没有认证；一旦它接受
其它机器，就要求了。同机的 TUI 不用任何配置继续工作，别的机器上的浏览器必须登录。

### 4.4 页面自己的路由 vs 我们的

对未知路径，helper 回 SPA 回退（`200 text/html`）。而桥对未知 `/api/*` 一直是回一个形状正确的空信封
（TUI 期待的 200/204），这条规则不变：**`/api/*` 永远是我们的。** 在 `/api/*` 之外，SPA 回退是对的，
直接透传；桥不认领那些路径。

### 4.5 流式

页面会开一条事件流。它必须是**我们** origin 上的 `/api/event` —— 桥自己的 SSE，已经实现，也正是 TUI 和
desktop 订阅的那一条。没什么要代理的。helper 自己的 SSE 路由永远到不了，这也是 helper 不需要密码的原因：
它只发文件，别的什么都不问它。

★ 依赖它之前已实测：bundle 的 `EventSource` 和 `fetch` 打的是同一个 origin（`location.origin`），没有
第二条隐藏连接需要重定向。

---

## 5. 失败时的行为

| 情况 | 结果 |
|---|---|
| 没设 `--web-proxy` | 没有页面；每条路径的行为和以前一模一样 |
| 设了 `--web-proxy` 但没有密码 | **启动即拒绝**，一句话 |
| helper 连不上 | `GET /` 回 `502` 加一行文字；`/api/*` 不受影响 —— 那个桥上的 TUI 和 desktop 继续工作 |
| helper 对某个资源回 404 | 那个资源就是 `404`；页面显示它自己的破损状态 |
| helper 是另一个 opencode 版本 | 页面能加载并与**我们的** API 对话；bundle 期望而我们不答的那些 `/api/*` 是普通的兼容性问题，不是这个功能的问题 |

★ 第三行是刻意的：**helper 不在不能把桥拖下水。** 用 TUI 的人从没要求过 web UI，而代理是唯一依赖另一个
进程的部分。

---

## 6. 测了什么，用什么测

`scripts/e2e-web.mjs` —— 一个真实的 `opencode serve` 当 helper，桥挡在前面，无头浏览器驱动页面：需要登录
就登录，开会话，发一句话，从屏幕上读到回复。它不在 `pnpm verify` 里（需要 `opencode` 二进制和浏览器），
缺东西时它会明说而不是悄悄通过。

desktop harness 的教训在这里同样适用，也是这里每一条断言都从**屏幕**上取、而不从桥日志取的原因：被应答的
请求不等于渲染出来的页面，而 desktop 那九次失败里有三次正是 harness 在断言自己的假设。
