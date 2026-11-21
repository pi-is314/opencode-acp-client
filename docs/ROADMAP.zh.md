# Roadmap — 已知要做、但**当前版本不做**的三件事

> English: [ROADMAP.md](ROADMAP.md)

> 这一页的用途：把「我们知道自己欠什么」写下来，并且写清**为什么现在不做**。
> 每一条都带「现在是什么状态」和「动手前要重新确认的事实」——避免下次动手时再从零调研。
>
> 状态：全部 **未开始**。

---

## 1. 验证并补全 opencode desktop 的用法

**现在是什么状态：文档里**不推荐**任何非 TUI 的客户端**，`--bridge-port` 的说明也不再提 desktop。

原因是**具体的、已核实的**，不是"没试过"：

| 事实 | 依据 |
|---|---|
| 桥会按 agent 隔离 TUI 的状态根 | `XDG_STATE_HOME` / `XDG_DATA_HOME` / `OPENCODE_DB` 设在我们 spawn 的子进程上（`src/index.ts` 的 `tuiEnv`） |
| **别的客户端拿不到这些** | 客户端的存储根是**它自己启动时**决定的，HTTP 服务端改不了 |
| 后果 | 第二个客户端接同一个桥，它的 tab **不按 agent 分开**——正是隔离要防的混用 |

★ 这次隔离是**修 bug 修出来的**（两个 agent 的 tab 混在一起、模型选择器答错），
所以不是"可选优化"，是对的行为。

**动手前要先答的问题：**

1. desktop 认不认某个**经 HTTP 告知**的状态目录？（如果它自己从 Settings 读，也许能引导用户改）
2. desktop 消费的接口面比 TUI 宽（`/api/fs/list`、provider、integration 等路由），**哪些必须实现**？
3. 它的「Add server」卡在**健康探测**上（`/api/health` 与 `/api/info` 两个拼法都提供就是为此），
   v2 之后探测端点是否又搬过家？
4. 一旦能隔离，**`--bridge-port` 与 README 里那段「还不行」要一起改回来**
   （`git log --grep "stop recommending other v2 clients"` 能找到那一次提交）。

**验收方式**：与 TUI 同标准——**按屏幕**断言，不是"接口有响应"（见 AGENTS.md 铁律 8）。
desktop 的行为如果只能人工看，就要在文档里明确写「未自动化」，而不是含糊说"可行"。

---

## 2. 实现 ACP v2

**现在是什么状态**：只实现 **ACP v1（stable，schema v1.25.0）**。
`docs/ACP-MATRIX.md` 逐条登记了我们宣告/实现了哪些 v1 方法。

**v2 已经发布**：

- 文档：<https://agentclientprotocol.com/protocol/v2/overview.md>（页面加 `.md` 取纯文本）
- **有一页专门的迁移指南**：<https://agentclientprotocol.com/protocol/v2/migration.md>
- schema release 的命名与 v1 不同：`schema-v2.0.0` 这个 URL **是 404**，
  动手时先按 `meta.json` 或 `llms.txt` 找到 v2 schema 的**真实**发布位置。

★ **已知的变化**（从 v2 overview 读到的，动手前以 migration 页为准）：

- `initialize` 之后多了**认证流程**（`auth/login`），走 Agent 的 method 或"启动并重连"的终端方式；
- 会话建立是 `session/new` **或 `session/resume`**（v1 里 `resume` 是 capability 门控的，
  v2 把它摆到了主流程上）；
- 新增/独立成页的有 **Session Delete**、**Slash Commands**、**Errors**。

**动手前要先答的问题：**

1. **我们宣告的是 v1，v2 是否要求同时支持两者？** 规范里有没有协商（version negotiation）？
2. v2 是否**移除**了我们依赖的东西？（v1 的 14 个 `session/update` 变体在 v2 里对应什么）
3. **opencode v2 的面（`/api/*`）不需要动**——它只是界面适配层，与 ACP 版本无关。
   所以这次改动的边界很清楚：**只动 `src/acp/**` 和翻译层**，但翻译层是"最核心的一个文件"。
4. v1 的 `docs/ACP-MATRIX.md` 是**逐条实测**得来的；v2 要重做一遍同样的实测，不要照抄结论。

**风险**：翻译层是单点，改它等于动所有渲染路径。按 AGENTS.md 铁律 6，**先对规范、再动手**；
按铁律 8，**每个变化都要在真 TUI 里按屏幕验收**。

---

## 3. 实现常驻桥进程

**现在是什么状态**：**桥随 TUI 生、随 TUI 死**。默认模式下一个进程同时管桥和 TUI；
`--no-tui` 可以让桥单独跑，但**它是前台的**，常驻要靠用户自己 `&`。

**已经查清 opencode 怎么做**（源码 `packages/client/src/service-contender.ts`）：

| 机制 | opencode 的做法 |
|---|---|
| 独立进程 | `spawn(..., { detached: true })` + `child.unref()`，与父进程彻底脱钩 |
| 找到它 | 一个**注册文件**（XDG state 目录）：`{ id, version, url, pid, password }` |
| **更新怎么办** | `Service.ensure()` 比较注册文件里的 `version` 与本进程的版本，**不一致就杀掉重启** |
| 安全停止 | `StopOptions.pty: "clear" \| "handoff"`——持久终端可以交接，不是硬杀 |

**为什么现在不做**（不是"没想到"，是**代价明确**）：

1. **更新语义更复杂**：opencode 只需比它自己的版本；我们要比**两个**——
   桥的版本 **和**它 spawn 的 agent 命令。agent 换了怎么办？
2. **一个常驻桥只驱动一个 agent**（架构决定：一条 ACP 连接对应一个 agent 程序）。
   换 agent 就得换桥 ⇒ 注册文件不能只有一份，或者要按 agent 分文件。
3. **配置与目录固定**：桥绑在一个目录 + 一个 agent 上，所有连它的客户端都得接受这一点。
4. **安全**：agent 能跑任意命令，常驻等于"一直在跑"，退出策略必须明确（空闲超时？手动 stop？）。
5. **停不下来就是灾难**：需要 `service start/stop/restart/status` 一整套子命令。

**一个顺带的相关事实**：
**桥退出时 agent 子进程一起退出**，所以任何"关掉 TUI 之后还要继续跑"的 agent 能力
（定时任务、后台 subagent、长任务）都不会继续。这不是 bug，是当前架构的边界。

**动手前要先答的问题：**

1. 注册文件里放什么？至少要有**桥版本**和**agent 命令的指纹**。
2. `ensure` 的规则：版本/agent 不一致时是**杀掉重启**还是**并存**？
3. TUI 怎么连上一个既有的桥？需要 `--attach <url>` 之类的入口（当前**没有**）。
4. 空闲多久退出？谁来回收崩溃留下的注册文件？

---

## 记录之外

这三件事**互不依赖**，可以按需要单独做。若以后有了更多待办，加在这一页而不是散落在各文档里
——`KNOWN-ISSUES.zh.md` 记的是**已经发生、还没修好**的问题，这一页记的是**还没开始**的功能。
