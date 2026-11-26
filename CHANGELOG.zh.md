# 更新记录

> [English](CHANGELOG.md)

每次发布，最新在最上面。项目自己的规则 —— 哪些已实测、哪些刻意不做 —— 在
[AGENTS.zh.md](AGENTS.zh.md) 与 [docs/](docs/) 里；这个文件只写给想知道「变了什么」的读者。

---

## 未发布

### 修复

- **恢复的会话不再一直转圈。** `session/load` 之后到达的 `usage_update`、`session_info_update`
  原来被当成对话输出，开启了一个永远不会关闭的 turn。现在只有真正的 agent 输出才会开启
  （PR #3，作者 [@poppyer9](https://github.com/poppyer9)）。
- **模型列表在真正就绪时才播报。** `session/load` 还在进行时，`/api/model` 可能仍回
  `acp/default` 占位；现在每一条能产生 catalog 的路径之后都会播报一次。
- **`/api/command` 不再重放目录里每一个记着的会话**来发现 agent 的斜杠命令 —— 只启动一个。
- **重放的历史保留工具结果**：失败与被取消的历史调用渲染成错误，重放的思考带上了时间，
  不再转圈。

---

## v0.2.0

### 本次亮点

#### Windows 上可以用了

1. **启动规则统一到一处**：`.mjs` / `.cmd` / `.bat` 脚本文件、经 `PATHEXT` 解析的裸命令名、
   镜像按原样使用。`agent command not found: node` 就是 `PATHEXT` 那一环缺失；`spawn EFTYPE`
   是把脚本文件直接交给 `spawn` 的结果。
2. **`pnpm verify:win`**：同一套门禁的 Windows 入口 —— 类型检查、单测、e2e smoke、协议往返。
3. **修掉 Windows 上 9 个单测失败、2 个 JSON 转义断言，以及 `--help` 丢掉整段转发旗标**
   （opencode 在 Windows 上回的是 CRLF，而 npm 把它装成 `.cmd`，`execFileSync` 起不来）。

#### 换用官方 ACP SDK

1. **不再手写 wire 协议** —— 改用 `@agentclientprotocol/sdk`。
2. **每一帧都对照官方 schema 校验**（`tests/acp-schema.test.ts`），拼错字段在测试里就失败，
   而不是等到第一个真实 agent。

#### 思考与推理档位接通了

1. **`/thinking` 的 `model.variant` 现在会转发到 agent 的 effort 选项。**
2. **agent 报上来的 effort 选项会出现在选择器里。**
3. ★ 这条值得记下来，因为它花了一天：**dsh 官方 `acp` profile 把这个选项叫
   `reasoning_effort`**，不是 `effort`。

#### 修复了连按 Esc 无法暂停当前 turn 的 bug

连按两下 Esc 过去之后 spinner 还在转。根因是一条带空 `content: []` 的
`session.tool.failed`：v2.3+ 的客户端会重写 tool content，遇到空数组直接抛异常，把它后面的
中断事件一起吞掉了。

#### 会话历史与恢复

1. **恢复的会话保留历史时间戳**（PR #2，作者
   [@poppyer9](https://github.com/poppyer9)）—— 旧会话不再全堆在「Today」。
2. **恢复后模型列表也会刷新**，从卡片到输入框底部全部一致。
3. **不再把 agent 自己的私有会话导入成 `ses_acp_…` 幽灵 tab。**

#### 结束时的词标与 logo 美化

词标补齐了它一直缺的四个字母（`a`、`i`、`l`、`t`），项目也有了 `logo.png` / `logo.svg` ——
由同一张字形表生成（`scripts/make-logo.py`）。

#### 新增 `agy acp` 与 `gemini --acp` 的真实 agent 验证

矩阵从五个 agent 扩到七个。

### 已验证

| 平台 | 门禁 | 真实 agent 矩阵 |
|---|---|---|
| macOS | ✅ | 34 passed / 1 blocked |
| Linux (Debian 12) | ✅ | 30 passed / 5 blocked |
| Windows 11 | ✅ | 30 passed / 5 blocked |

矩阵是 **5 个 TUI 版本 × 7 个 agent**（`opencode acp`、`claude`、`codex`、`qwen`、`dsh`、
`agy`、`gemini`），每个格子跑 3 轮真实对话。

- **`agy acp`** 三个平台全部通过。
- **`gemini --acp`** 的格子全部 BLOCKED，原因在 gemini-cli 自身：网关把 `topK` 上限定在 40，
  而它内建的 `chat-base` 预设硬编码 64；文档给的 `customAliases` 绕过办法**在 CLI 模式有效、
  在 ACP 模式被忽略** —— bundle 只把 alias 的名字收进 `validModels`，从不应用 alias 的配置。
  详见 [docs/AGENT-CAPABILITIES.zh.md](docs/AGENT-CAPABILITIES.zh.md)。

### 升级说明

- **无破坏性变更。** `~/.opencode-acp-client/sessions.json` 的 schema 未变；环境变量仍然只有
  `OPENCODE_BIN` 与 `OPENCODE_ACP_CLIENT_*` —— **没有别名**。

---

## v0.1.0

首个发布版本：用 opencode v2 的 TUI 驱动任意 ACP agent，每个 agent 程序一条 ACP 连接、会话在其上复用。
