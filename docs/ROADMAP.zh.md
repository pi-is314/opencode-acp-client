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

### 1a. 2026-11-24 实测（macOS，OpenCode.app 2.0.32 → 2.4.1）

★ **desktop 连我们的桥是能跑的。** 用 CDP 走通了完整链路：加服务器 → 打开会话 → 发消息 →
回复渲染出来。所以上面第 3 问（"卡在健康探测"）**已经不成立**——`/api/health` + `/api/info` 够用。

★ **怎么驱动它**（这就是自动化的地基）：

```
/Applications/OpenCode.app/Contents/MacOS/OpenCode --remote-debugging-port=9223
```

`--remote-debugging-port` **必须走命令行**：`environment.ts` 只在 `!app.isPackaged` 时读
`OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT`，而发行版是打包的。CDP 目标只有一个：
`oc://renderer/index.html`。加服务器：设置 → 服务器 → 页面右上「添加服务器」→ 菜单里的
「添加服务器」→ 填 URL → 「添加服务器」（**密码可以留空**）。菜单项要点
`pointerdown`+`pointerup`+`click` 三连才开，单独一个 `.click()` 没反应。

★ **「本地服务器」是 desktop 自己的 opencode**，不是我们的桥：它跑
`opencode-cli serve --service`（来自 `~/Library/Application Support/ai.opencode.desktop/cli/`），
那些会话是原生 opencode 的数据。它起不来是**致命的**（窗口变成错误页、app 退出），
**没有"只用外部服务器"的模式**。

★ **隔离为什么还不行，说准一点。** 四个开关里有三个被 `!app.isPackaged` 挡住：

| 开关 | 对打包版的效果 |
|---|---|
| `OPENCODE_DESKTOP_TEST_ROOT` | ✗ `createTestRoot` 打包时直接返回 undefined |
| `OPENCODE_DESKTOP_ISOLATED_SERVER=1` | ✗ 给 `serve` 加 `--port 0` 的就是它；实测 `args=["serve","--service"]` |
| `--user-data-dir` | ✗ 被 `app.setPath("userData", …)` 覆盖 |
| `OPENCODE_TEST_ONBOARDING=1` | ⚠ 只有它活着，它**搬 XDG 根目录**（+`OPENCODE_DB=:memory:`），但**不动端口** |

**端口就是墙。** `defaultPort()`（`packages/cli/src/services/service-config.ts`）对 channel
`latest`（发行版 desktop 走的就是它）返回 `0xc0de` = **49374**，`local` 是 `0xc0df`，其余由
channel 哈希出 10000..60000。所以两个 desktop 不能同时跑，隔离尝试会和用户自己的实例撞车：

    Managed service port 49374 on 127.0.0.1 is already in use by another process.

`opencode service set port <n>` 是官方给的出路——**但它改的是用户的全局服务注册表**，
所以测试里**绝不能调用**（本次调查调用过一次，已改回）。

⟹ **打包版 desktop 无法隔离测试。要测它，就得从源码跑**（`packages/desktop`，
`bun run dev`）：它设 `OPENCODE_CHANNEL=local`（端口 49375）**并且**
`OPENCODE_DESKTOP_ISOLATED_SERVER=1`（随机 `--port 0`），`isPackaged === false`，上面每个开关
都能用。在那套 harness 出现之前，本节一直关心的「每个 agent 的标签页隔离」仍然悬着。

★ **这一轮查出了两个桥的真缺陷，已修**（提交 `e6781f6`）：

1. `GET /api/project` 硬编码返回 `[]`。TUI 从不请求这条路由，所以一直没人发现；任何按项目
   列表搭侧边栏的客户端都会看到"没有项目"。现在按会话目录（加启动目录）去重列出。
2. `location.project.id` 对**原始启动路径**做哈希，而 `projectIdFor()`——其他所有接口用的——
   哈希的是 `realpath()`。macOS 上 `/var/...` 就是 `/private/var/...`，于是同一个工作区一条路由
   给 `proj_d94b…`、另一条给 `proj_f4e4…`；客户端拿 location 的 id 去 `/api/project` 里找，找不到。

★ **仍然不通过的（2026-11-26 实测）**：刚启动的 dev desktop 会请求 `/api/project`、
`/api/location`、`/api/vcs`，也会把新增的服务器画进侧边栏，然后**始终不发 `GET /api/session`**
——所以列不出会话。有一次它确实列出来了，但那台 desktop 已经跑了一段时间；同样的操作在
全新启动的上不做，等 15 秒以上也不变。已排除僵尸服务器条目。`scripts/e2e-desktop.mjs`
（`pnpm e2e:desktop`）就是这套 harness：前 8 项通过、后 2 项失败，**故意不进 `pnpm verify`**。

★ **清理的坑，踩了两次**：`pkill -f "OpenCode.app/Contents/MacOS/OpenCode"` 只杀 app，
**不杀它拉起的 `opencode-cli serve --service` 子进程**。那个孤儿占着 49374，之后每次启动
desktop 都撞端口。任何 desktop 实验之后，
`ps aux | grep "[o]pencode-onboarding"` 必须是空的。

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

## 4. README 精简，加上 logo 和截图

**做什么**：README 是一路长起来的——每条已验证的事实、每个坑、每个版本行都堆在上面。它应该
像一份介绍：这是什么、一张截图、一行命令、三个链接（协议、兼容性、设计规则）。参考性材料在
`docs/` 里已经有归属。

**参考**：[openma-ai/Martty](https://github.com/openma-ai/Martty) 与
[Kagura-0001/lucid](https://github.com/Kagura-0001/lucid)——两者都是 logo、截图、一段短介绍
打头，深度内容留到下面的页面。

**还有 logo**：风格与 opencode 的相近——能在 40px 下认得出来，深浅色背景都成立。仓库根目录的
`logo.png` / `logo.svg` 就是这个标，README 以它打头。

★ **v0.2.0 已发布的部分**（2026-11-26）：仓库根目录的 `logo.png` / `logo.svg`、退出词标补齐的四
个字母，以及作为发布记录的 [CHANGELOG.zh.md](../CHANGELOG.zh.md)。下面的 **README 精简与截图仍然
没做** —— 这一节现在说的就是这两件。

★ **根目录放文件"并不"能做成仓库头像**（2026-11-24 实测：`logo.png` 推上去之后图标并没有变）：
**GitHub 不会从它取仓库头像。** 仓库本身没有独立头像——列表里那个图标是**账号**的头像，组织的图标在
组织设置里，个人账号的就是账号头像；仓库的 Settings 里根本没有这个字段。本页早先写的"仓库页面用的那个
文件就是 README 展示的那个"是错的。

根目录这两个文件真正服务的是：README（用 `<img>` 引用），以及**社交预览 / Open Graph 卡片**——那个要在
Settings → Social preview **单独上传**，尺寸是 **1280x640**，和这里 1:1 的 `logo.png` 不是同一个资产，
目前也还没做。

**约束**：

1. **中英双语**：每处改动同时落在 `README.md` 与 `README.zh.md`；`check-links.py` 负责盯着这一对。
2. **只能搬家，不能丢**。从 README 拿掉的每条事实都必须已经在 `docs/` 里，并且仍然能从入口文档
   够到（`AGENTS.md` §1 就是阅读顺序）。
3. **截图必须是真的**：真实 TUI + 真实 agent，按 `scripts/e2e-real-tui.sh` 抓 pane 的方式截，
   不接受效果图。
4. **开新分支**。这是首页重写，混在别的改动里没法评审。

