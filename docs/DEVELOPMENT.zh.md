# 开发笔记

> English: [DEVELOPMENT.md](DEVELOPMENT.md)

这份文档是给**改这个桥的人**看的（而不是只用它的人）：纯服务端模式、怎么看它到底在干什么，
以及那些一定会再遇到的坑。产品本身见 [README.zh.md](../README.zh.md)。

##### 有些路由是**故意继续失败**的

`POST /api/session/:id/{compact,fork,revert/stage}`、`POST /api/session/import`、
`POST /api/worktree` 回的是 204，而客户端生成的代码期望 200 ✓，于是它报 `UnexpectedStatus`
（`worktree.create` 有弹窗，其余是静默）。**看起来该改成 200，但那是错的** ✗ —— 它们失败的根因是
**这个桥里没有这个功能** ✓。回 200 会让 fork 对话框"像是成功了" ✗。一份路由审查把它们列成"返回码不匹配" ✓，
但它们其实是**诚实的失败** ✓ —— 改掉它等于把响亮的缺口换成安静的谎 ✗（见 [AGENTS.zh.md](../AGENTS.zh.md) 铁律 3）。

## 未实现的路由回 **200**，不是 404 —— 这是刻意的

我们没实现的 `/api/*` 路由会回**200 + 形状正确的空信封**，并记 `[bridge] unhandled route:`。
这是**有意**的（`src/server.ts` 里写着理由）：客户端会**无条件读 `.location`**，裸 404 会让它崩，
而**日志才是真正的信号**。所以"这条路由应该改回 404"**并不自动**更安全 —— 那是一次**行为变更**，
要拿真客户端实测才能定。已知唯一别扭的是 `GET /api/fs/read/:path`：客户端按**二进制**读它，
于是把我们的信封**当成文件内容**渲染出来；它能否容忍 404，**尚未验证**。

## agent 是在**会话目录**里运行的

子进程的 `cwd` 是**会话的目录**，不是你的当前目录。所以用**相对路径**写 agent 命令会在那里解析不到、立刻死掉：
`AcpError: agent exited (code=1 signal=null)`，而且**一条 `[acp]` 日志都没有**（因为子进程一行输出都没产生）。
请用绝对路径（`node "$PWD/tests/fake-acp-agent.mjs"`）或 PATH 上的命令（如 `npx -y @agentclientprotocol/claude-agent-acp`）。
本仓为这个坑白花了一轮：看起来像客户端坏了，其实是命令写错了。

## 纯服务端模式（`--bridge-port <n>`，或 `--no-tui`）

`--bridge-port <n>` 在该端口只提供 HTTP/SSE 接口面，不启动 TUI（隐含 `--no-tui`）；
`--no-tui` 不带端口则用随机端口。别的客户端也是接同一个面；
本仓端到端验证过的客户端只有 TUI。

这个接口面是公开的 v2 OpenAPI 面：TUI 是唯一做过端到端验收的客户端。
测试框架需要它，手工调接口时它也是最快的方式：

```bash
node dist/index.js --bridge-port 4096 ~/project -- npx -y @agentclientprotocol/claude-agent-acp
```

它会打印一行带 URL 的 ready 行 —— stdout 上永远是**一个** JSON 对象：

```json
{"type":"ready","url":"http://127.0.0.1:4096","directory":"/home/me/project","agent":"npx"}
```

想要界面就自己起 TUI：

```bash
opencode --server http://127.0.0.1:4096
```

在这个模式里，客户端缺失或只有 v1 只是**告警**而不是失败：TUI 可能是你自己在别处（甚至另一台机器）
起的，所以桥照常服务。而在默认模式（由桥自己启动 TUI、有真人在等）里，一个可用的 v2 客户端是**必需**的。

## 观察一次运行

只要 `OPENCODE_ACP_CLIENT_TRACE` 不为 `0`，每个 HTTP 请求都会被记录
（`[http] METHOD /path`，写请求还带 body）。正是这条 trace 把「客户端什么都没做」
变成了「客户端什么都没发」，也是看下一个缺口最快的方式。配合客户端自己的日志一起用：

```bash
OPENCODE_ACP_CLIENT_TRACE=1 node dist/index.js --no-tui --bridge-port 4096 -C /tmp -- <agent 命令>
opencode --server http://127.0.0.1:4096 --print-logs      # 看 TUI
```

**要看 `[http]` 日志就得用 `--no-tui`**：默认模式下 TUI 占着终端，我们把日志落到
`$TMPDIR` 下的文件（**任何一行杂散输出都会撕裂 TUI 渲染**）。stdout 永远是保留的
（ready 行 / ACP 线）。

| 环境变量 | 作用 |
|---|---|
| `OPENCODE_BIN` | opencode v2 客户端二进制（否则用 `PATH` 上的 `opencode`）|
| `OPENCODE_ACP_CLIENT_TRACE` | 每个 HTTP 请求和每个 ACP 帧（非常吵）|
| `OPENCODE_ACP_CLIENT_DUMP` | 把 `session/new` 的原始响应落盘 —— agent 能力的唯一 ground truth |
| `OPENCODE_ACP_CLIENT_MESSAGE_PROBE` | 「消息消失」那个 bug 的观测器 |
| `OPENCODE_ACP_CLIENT_RECORD_FRAMES` | 把每个入站 ACP 帧写进 `<dir>/<backend>.jsonl`（首行是来源声明）—— 回放语料的原料 |

录一段真实回合到 `tests/fixtures/acp_frames/`：`AGENT="dsh --profile acp" SCENARIO=turn node scripts/record-acp-frames.mjs`；刷新快照：`UPDATE_FRAME_SNAPSHOTS=1 npx vitest run tests/frame-replay.test.ts`。语料格式与来源规则见 `tests/fixtures/acp_frames/README.md`。
| `OPENCODE_ACP_CLIENT_PROMPT_TIMEOUT_MS` | 可选的 prompt 时钟（默认**不启用**；设正数毫秒才启用；控制类请求仍是 120 秒）|
| `OPENCODE_ACP_CLIENT_RUN` | 即使不是入口文件也运行 CLI（测试用）|

调试开关**用完就关**。

## 客户端现在实际的表现

对着 opencode v2 驱动真实模型时，一个完整回合可以闭环。有两个坑值得反复强调，因为它们是**静默**的，
而不是报错的：

- 当 `local.agent.current()`（或选中的模型）为空时，输入框会返回 `false`，
  **既不弹提示也不写日志**。文本留在输入框里、什么都不发 —— 看起来和「服务死了」
  一模一样。`/api/agent`、`/api/model`、`/api/provider` 必须从 agent 的 ACP
  配置项里填上真实内容。
- `session.text.*` 和 `session.tool.*` 只会**编辑**已有行，行不存在时**直接丢弃
  事件**。只有 `session.step.started` 和 `session.tool.input.started` 会创建行，
  所以它们必须最先发出。

一路上攒下的、都值得留着的事实：

- TUI 的每个动作都以 `session` 为前提；`packages/tui/src` 里满是 `!session`
  守卫，输入框只在 `route.data.type === "session"` 时存在。
- `GET /api/session/active` 是一个 **map** `{ "<sessionID>": "idle" | "running" }`，
  不是 `{sessionID}`。客户端靠 `Object.keys(active)` 来填充状态快照。
- 一旦 `/api/session/active` 返回的形状不是那个 map，所有 id 都会变成
  `undefined`，客户端随后就会请求 `GET /api/session/undefined` —— 这正是修掉
  map 形状之前的全部症状。
- 客户端 footer 里那个 `1 plugin failed` 在任何目录都会出现（包括干净的
  `/tmp`），所以它是一个内置插件而非工作区插件。纯属外观问题，与上面无关。

## 提交

本仓库的**每一条提交都必须是 `PI-is314`**：

```
PI-is314 <359395502+pi-is314@users.noreply.github.com>
```

`pnpm install` 会跑 `prepare`，把 `core.hooksPath` 指向 `.githooks/`，其中的 `pre-commit`
会拒绝其它邮箱。之所以要这样：`git config user.email` 存在 `.git/config` 里、**不会随 clone
分发**；在全局身份是别的账号的机器上新 clone 一份，就会用那个身份提交，而 git 历史一旦公开就收不回来。

那个地址是 GitHub 给的 **noreply** 形式（`<账号 id>+<账号名>@users.noreply.github.com`）：
既让 GitHub 把提交归到 `pi-is314` 名下，又不把真实邮箱写进公开历史。

```bash
git config user.name  PI-is314
git config user.email 359395502+pi-is314@users.noreply.github.com   # 每个 clone 设一次
```

## 发版

版本号是**三处对齐**的：`package.json` 的 `version`、git 的 **annotated tag**（`v<version>`）、
以及 npm 上发布出去的那个版本。发一次版就是让这三者同时前进：

```bash
# 1. 干净的工作区 + 全绿的门控（见上「测试」）
git status --short          # 应为空
pnpm typecheck && pnpm test

# 2. 升版本：npm 会自己 commit（身份是 PI-is314，钩子会拦别的）并打 annotated tag
npm version patch           # 或 minor / major；产出 v0.1.1 这样的 tag

# 3. 发布。★ 必须显式指定 registry 和 token：
#    本机的默认 registry 是内网源，不加 --registry 会推到那里去
npm publish --registry https://registry.npmjs.org \
  --//registry.npmjs.org/:_authToken="$(tr -d '[:space:]' < ~/.npm.token)"

# 4. 推代码和 tag（--follow-tags 只推 annotated tag）
git push --follow-tags
```

**npm 那边有几点是必须的**：

- token 要在 npmjs 上生成成 **Granular Access Token 且勾选 “Bypass 2FA”**；否则发布一律
  `E403 … Two-factor authentication or granular access token with bypass 2fa enabled`。
  普通 token 能通过 `whoami`，但发布会被拒 —— 两者不是一回事。
- 发布后会先出现一个 `0.0.0-stage` 占位版本（npm 的暂存发布），约 **2 分钟**后自动变成真正的版本。
  这期间 `npm view <pkg> version` 看到占位版本不是故障。
- 预发布版用 `npm publish --tag next`，这样它**不会**抢走 `latest`；
  否则别人一个 `npm install -g <pkg>` 就会装到测试版。

**验证发版成功**（三处都指向同一个版本）：

```bash
npm view opencode-acp-client version --registry https://registry.npmjs.org
git tag -l 'v*' --sort=-v:refname | head -1
node -p "require('./package.json').version"
```

## 从源码运行

`package.json` 里声明了 `bin.opencode-acp-client`，但单纯 `git clone` 下来它**不会**在
`PATH` 上 —— 这个包永远不会成为自己的依赖，所以 `pnpm exec` 也看不到它。三选一：

```bash
# 1. 完全不用安装（永远可用）
node dist/index.js -- npx -y @agentclientprotocol/claude-agent-acp

# 2. 符号链接（需先 pnpm build，它会设好可执行位）
ln -sf "$PWD/dist/index.js" "$(pnpm bin -g)/oc-acp-client"
oc-acp-client -- npx -y @agentclientprotocol/claude-agent-acp

# 3. 包装脚本（不想依赖可执行位时用它）
printf '#!/bin/sh\nexec node %s/dist/index.js "$@"\n' "$PWD" > ~/.local/bin/oc-acp-client
chmod +x ~/.local/bin/oc-acp-client
```

**不要**用 `pnpm link --global .`：它会把本包加为自己的依赖、改写
`package.json`/`pnpm-lock.yaml`，还想 purge 掉 `node_modules`。

撤销 (2)：`rm "$(pnpm bin -g)/oc-acp-client"`。

## 进程纪律

- 只用显式 PID / 进程组结束子进程；**绝不** `pkill -f '<名字>'` 按名字批量杀 ——
  会误杀使用者的编辑器/其它会话。现有 `AcpClient.dispose()` 的形状
  （SIGTERM → 3s → SIGKILL）是对的，保持。
- **同时只能有一个「起 TUI」的进程**：随机端口 + 一个 TUI 子进程，别并发跑两个。
- 探测**只用临时 profile / 临时目录**，**别碰**使用者已有的配置；探测**不要**调会真删数据的动词。

## 其它文档在哪

- [ARCHITECTURE.zh.md](ARCHITECTURE.zh.md) —— 进程模型与一个回合的端到端时序
- [PROTOCOL.zh.md](PROTOCOL.zh.md) —— 我们实现的 opencode v2 接口面及其坑
- [../AGENTS.zh.md](../AGENTS.zh.md) —— 开发本仓的入口

## 测试

这些命令能替你验证对这座桥的改动，从最便宜到最完整：

```bash
pnpm verify        # 本仓能自证的一切：typecheck、单测、规范一致性、smoke / entry / 真 TUI
pnpm verify:version 2.0.27   # 同一套门控，跑在指定的 opencode v2 release 上
pnpm test          # 单测 + 假 agent 集成测试
pnpm e2e           # 20 个场景：假 agent + 真实 HTTP（session → prompt → delta、表单、取消）
pnpm e2e:entry     # 单入口：起 TUI、透传退出码、零残留
pnpm e2e:agent     # 真实 ACP agent，协议级：必须 AGENT="<命令>"（本仓不预设任何 agent）；
                   #   默认不发 prompt，所以不花 token
pnpm e2e:tui       # 真 opencode v2 TUI + tmux + 假 agent，驱动一个**完整的回合**
                   #   （思考 + 工具调用 + 回复），并对**屏幕上的内容**断言：用户行、思考块、
                   #   带输入的工具卡片、回复、以及 agent/模型 footer。每次抓到的屏幕都存到
                   #   .artifacts/ —— 这是逐个 release 的证据，而不是一句声称
                   #   MODE=cancel FAKE_ENV='FAKE_ACP_HANG=1' pnpm e2e:tui  发取消手势并报告桥看到了什么
```

### 全绿证明了什么 —— 以及证明不了什么

`pnpm verify` 就是门控，所以在你把一次全绿当成对改动的批准之前，先弄清它到底覆盖了什么。
全绿意味着：类型检查通过；457 个单测通过（ACP 翻译层、HTTP 接口面的形状、
能力门控、版本策略、取消语义、SSE 全流程）；我们实现的**每条**路由都符合 opencode v2 **公开 OpenAPI**
描述的形状（52 个探针；故意不同的地方登记在 `scripts/check-openapi.py` 的 `ALLOWED` 表里，而不是被无视）；
20 场景 smoke 与单入口套件通过；以及 **真** opencode v2 TUI（在 tmux 里驱动）能重开一个会话并把它渲染出来。

全绿**不**意味着 —— 所以别拿它当以下结论的证据：某个真实 agent 的回答是合理的（那要靠
`pnpm e2e:agent` + 你自己的眼睛）；TUI 在你的终端上、或在别的平台上长得对；除被测版本以外的
opencode v2 版本能用（那要靠 `pnpm verify:version`，以及每个 release 都跑一遍它的监听任务）；
或者我们**故意没实现**的功能突然能用（见 [PROTOCOL.zh.md](PROTOCOL.zh.md)）。
**单测看不见渲染出来的屏幕** —— 这正是 e2e 脚本和版本门控存在的原因。

---

## 桥写的**唯一**一个文件

`~/.opencode-acp-client/sessions.json`（用 `OPENCODE_ACP_CLIENT_SESSION_MAP` 改名/移位 ✓）；
另外每进程还有一份 `daemons/<pid>.json`（启动写入、干净退出删除，`oc-acp-client ps` 用它列出
存活/僵死的桥，`--prune` 清死记录、`--kill` 显式停活的；用 `OPENCODE_ACP_CLIENT_DAEMONS` 改名）✓
存的是：**会话 id**、它背后的 **agent id**、会话运行时的**目录**，以及可选的 **agent 标题** ✓ —— **不存消息内容、不存凭证** ✓，
最多 500 条 ✓，读写出错**只记日志、绝不致命** ✓ —— 它是优化，不是存储 ✓。

它存在的理由是：**ACP 不允许客户端给新会话命名** ✓。`session/new` 没有 id 字段 ✓
（只有 `{_meta, additionalDirectories, cwd, mcpServers}` ✓），id 由 **agent 生成后返回** ✓；
对 dsh 的实测还确认**连 `_meta.sessionId` 也不被采纳** ✓。而 opencode v2 客户端记住的是**它被展示的那个 id** ✓，
所以没有这张对应表，恢复的 tab 会拿一个 agent 从没听过的 id 去 load ✓ → 失败 ✓ → tab 打开**空白** ✓。
**通用 ACP client 没有这种能力** ✓ —— 它只能接受 agent 给的 id ✓。

★ **只存一个方向**：可见 id → agent id ✓。早期还额外写过「agent id → 它自己」的自映射 ✗，
而**没有任何读者** ✓：客户端只会拿桥展示给它的 `ses_…` 别名来问 ✓
（实测 TUI 请求 `ses_ec3718af…` 与 `ses_acp_…` ✓，从不请求裸 UUID ✓），
唯一的反查也要求键以 `ses_` 开头 ✓。这些条目**不是免费的** ✗：在真实文件里曾占 **79/153 = 52%** ✓，
而文件按时间排序后截断到 `MAX_ENTRIES` ✓ → 死条目会把**有效映射挤出去** ✗。
现在有回归测试断言**没有任何键等于自己的 `acpSessionId`** ✓。

## agent 探测与恢复观察

各 agent 的实测属于开发证据，不属于产品兼容承诺。用 `pnpm e2e:agent` 做**不发模型 prompt** 的协议级探测；
会话到达 ACP 后，它会报告协商到的能力和模型目录。没有测到，不能被写成“需要凭证”或“没有能力”。

恢复时看 `initialize` 的能力日志（`[acp] initialized: {…}`）：只有宣告了 `loadSession` 的 agent 才能收到
`session/load`。即使有这个能力，也不承诺 agent 会重放转录。桥会明确记录不可恢复或恢复失败，然后可见地退回新会话，
而不是静默声称恢复成功。新增 agent 探测或较弱能力场景时，应扩展 `tests/fake-acp-agent.mjs`，不要在测试里 mock ACP client。

## 在 Linux 上跑门控（Docker）

作者本机是 macOS；Linux 用容器跑。镜像里含 Node、pnpm、tmux、zsh、python3 与
`jsonschema`，并在镜像内执行 `pnpm build`：

```bash
docker build -f docker/linux-gate.Dockerfile -t oac-linux-gate .
docker run --rm oac-linux-gate                      # 完整门控
docker run --rm oac-linux-gate bash -c 'pnpm test'  # 单跑一步
```

基础镜像默认 `node:22-alpine`；如果这台机器到不了 Docker Hub，就把可达的基础镜像
和 apk 镜像传进去：

```bash
docker build \
  --build-arg BASE_IMAGE=<内网 Alpine 基础镜像> \
  --build-arg APK_MIRROR=https://mirrors.tuna.tsinghua.edu.cn \
  --build-arg INSTALL_NODE=1 \
  -f docker/linux-gate.Dockerfile -t oac-linux-gate .
```

Linux 这一轮不是走形式：它抓出了四处 macOS 假设——默认 `dsh` 在 PATH 上、链接检查
依赖 `git`、两处回复断言与异步 POST 抢跑、`/cd` 断言写死 `/var/folders/…`。让这个
镜像保持可构建，因为只有它会抓到这类问题。
