# 写 e2e 脚本的禁忌

> 这一页记的是**这些测试脚本反复踩到的坑**。为了把一个兼容性矩阵跑通，
> 门控前前后后失败十几次——**每一次的原因都在脚本里，产品代码一行没改**。
>
> 这些不是"最好别这样"的建议，是**已经让人把整轮门控跑白**的具体做法。
> 你正在改 `scripts/e2e-*.sh` 时，先扫一遍这一页。

---

## 1. ★★ 不要用固定端口

**现象**：`PORT="${PORT:-4811}"`。

**后果链**（每一环都让人以为被测版本坏了）：

```
上一轮的门控被杀 → tmux 会话没了，但里面的桥还活着，占着 4811
  ↓
新桥启动 → listen EADDRINUSE → 崩溃
  ↓
但 /api/info 照样有人答（旧桥！）→ "✓ adapter is up" 通过
  ↓
TUI 连上的是**旧桥**，打开的是**另一个工作区的会话**
  ↓
当前工作区的 bridge.log 是 0 字节，请求全进了上一轮那个日志
  ↓
症状："the prompt never reached the bridge" / "the search row is missing" / "TUI never became ready"
```

**同一个固定端口，一天内伪装成了三种不同的 bug。**

**做法**：探测一个空闲端口。

```bash
if [ -z "${PORT:-}" ]; then
  for _try in $(seq 1 50); do
    PORT=$((4400 + RANDOM % 400))
    lsof -i ":$PORT" >/dev/null 2>&1 || break
  done
fi
```

---

## 2. ★★ 不要按固定时长等一件事发生

**现象**：`send_prompt() { tmux send-keys "$1"; sleep 1.6; tmux send-keys Enter; }`。

**后果**：负载高时，Enter 落在 composer 接管按键**之前**，prompt 根本没提交。屏幕上什么都没发生，
而所有下游断言都在测一个空屏幕——**看起来像翻译层回归**。

**更隐蔽的一点**：改过一次，把"睡 1.6 秒"换成"等文字出现在屏幕上"。**这仍然错**——
一旦这个测试之前发送过 prompt，那段文字**本来就在屏幕上**（在用户行里），等待立刻返回，
无论这次按键有没有落地。

**做法**：等**行为**，不等时长、不等屏幕。

```bash
# 等桥日志里出现一条新的 /prompt —— 这是"提交发生了"的唯一诚实信号
before="$(grep -c 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null)"; before="${before:-0}"
for attempt in 1 2 3; do
  tmux send-keys "$1"; sleep 1; tmux send-keys Enter; sleep 1.5
  after="$(grep -c ...)"; after="${after:-0}"
  [ "$after" -gt "$before" ] && return 0
  tmux send-keys C-u      # 清掉残留的半行，再试
done
```

★ **`grep -c` 在零匹配时打印 `0` 且退出 1**，所以 `$(grep -c … || echo 0)` 会得到**两行 `0`**，
后面的数值比较永远不成立。用 `${var:-0}`。

---

## 3. ★★ 不要把客户端自己的 UI 文案写死进断言

**现象**：`grep -q 'Explored: 1 search'`。

**后果**：这个分隔符在版本之间改过——v2.0.0 是 `Explored — 1 search`，v2.2.7 是 `Explored: 1 search`。
断言于是**只在最新版上成立**，旧版本报"分组坏了"。

**更糟**：v2.0.0 对一个单独的 `websearch` **根本不做分组**（只有 grep/glob 算 exploration），
所以那一行**不是坏了，是不存在**。

**做法**，按顺序考虑：

1. **匹配形状**，不匹配标点：`Explored[^a-zA-Z0-9]*[0-9]+[^a-zA-Z0-9]*search`
2. **问清楚这一行是谁的承诺**：客户端自己的分组策略**不是本桥的承诺** → 记 `note`，不失败
3. 真要区分"是不是我们的"，把命令分成两组（读本桥数据的 vs 读客户端自己存储的）

```bash
PATROL_OURS=" /compact /btw /undo /model /sessions"     # 崩了就是我们的
# 其余（/timeline /stats /diff …）读客户端自己的 store，崩了是它的
```

---

## 4. ★ 清理只能杀自己的东西

**现象**：cleanup 里 `for sock in /tmp/tmux-*/oac-e2e-*` —— **把并发运行的 tmux server 也杀了**。

**后果**：另一轮运行在第一次抓屏时发现 `no server running`，**看起来像那次运行自己的 bug**。

**现象**：cleanup 里按命令行模式 `grep` 全机器的桥 —— 同样会杀掉并发运行正在用的桥。

**做法**：

- **tmux**：用自己的 socket 名（含本进程 pid），只杀那一个
- **进程**：从**自己的 pid 往下走进程树**，不是全机器模式匹配

```bash
ps -o pid= -o ppid= -ax | awk -v root="$$" '{ ppid[$1]=$2 } END {
  ours[root]=1; changed=1
  while (changed) { changed=0
    for (p in ppid) if (!(p in ours) && (ppid[p] in ours)) { ours[p]=1; changed=1 } }
  for (p in ours) if (p != root) print p }'
```

**还有一条**：**信号处理器必须 `exit`**。

```bash
trap cleanup EXIT
trap 'cleanup; exit 143' TERM      # ← 没有 exit，脚本收到 TERM 后继续跑，子进程还占着端口
```

---

## 5. ★ 失败时把屏幕打出来，别让人复现

**现象**：三次门控在三个不同模式失败，报的都是"TUI 从不就绪"，而桥日志显示启动握手全部完成。

**为什么看不出来**：保存的 pane 是**等待结束之后**抓的，那时屏幕早就恢复正常了。
**光看日志，同一个症状像三个不同的 bug。**

**做法**：等待超时时，**当场**抓屏并打印，连同面板状态：

```bash
echo "  ! timed out waiting for $2" >&2
echo "  ! screen at timeout ($(tmux display-message -p -t "$CLIENT" '#{session_name}:#{window_index}.#{pane_index} #{pane_width}x#{pane_height} dead=#{pane_dead}')):" >&2
tmux capture-pane -p -t "$CLIENT" >&2
```

**后来正是这一行**让人一眼看出：屏幕上是一个 **What's new 对话框**，不是启动失败。

---

## 6. ★ 客户端的模态框会挡住一切 —— 在等待里处理它

**现象**：v2.3.0 首次启动弹 "What's new in \<version\>"，`scroll ↑/↓  ok`，占住键盘。

**后果**：**19 处** `wait_for_pane 'Ask anything'` 全部超时；`e2e-agent-matrix.sh` 里 8 个 agent 挂了 4 个
（`opencode acp` / dsh-acp / gemini 未就绪，codex 的 prompt 卡在输入框里 → 顺带一个 Continue 行失败）。

**做法**：**在等待函数内部**处理，而不是改 19 个调用点。

```bash
dismiss_announcements() {
  [ "${ANNOUNCEMENTS:-0}" -ge 2 ] && return 1        # 有上限，别和正在测对话框的模式打架
  tmux capture-pane -p -t "$CLIENT" 2>/dev/null | grep -qE "What's new in|scroll ↑/↓.*ok" || return 1
  tmux send-keys -t "$CLIENT" Enter
  ANNOUNCEMENTS=$(( ${ANNOUNCEMENTS:-0} + 1 ))
}
```

★ **每个测试都是"第一次启动"**：工作区是临时的，所以**每一轮都会看到这个弹窗**。
一个"用户只会遇到一次"的界面，在这里是**每次**。

---

## 7. ★ 等"写完了"，不是等"过一会儿"

**现象**：退出后 `sleep 4` 然后抓屏，断言 Continue 行。失败信息是"改写没跑"。

**真相**：回显改写挂在子进程的 **`'close'`** 事件上（不是 `'exit'`），要等 stdio 排空才打印。
`scripts/e2e-epilogue.sh` 一直是等日志里的标记，**矩阵没跟上**。

★ 结果是**同一个 cell 单独跑通过、整轮跑失败**——典型的"时序偶发"，会让人以为功能是坏的。

---

## 8. ★ 测试环境的差异要显式钉住

**现象**：v2.3.0 把 `session.verbosity` 默认值改成 `low`，**工具调用折叠成一行**。
所有"工具卡片可见"的断言随之失败——**而这不是本桥的问题**。

**做法**：验收脚本**显式钉住**影响断言的界面设置。

```bash
printf '{"session":{"verbosity":"high"}}\n' > "$TUI_CONFIG_DIR/cli.json"
export OPENCODE_CONFIG_DIR="$TUI_CONFIG_DIR"
```

★ 注意**配置文件名会变**：v2.3.0 起是 `cli.json`，`tui.json` 只用于迁移。**两个都写**覆盖新旧版本。
★ 钉住的是**验收脚本**的偏好，不是产品行为——用户想要折叠依然是他的选择。

---

## 9. ★ 保留现场，否则事后无法回答关键问题

**现象**：`cleanup` 里 `rm -rf "$WORK"`，而 Continue 失败要问的正是"那个会话在映射表里吗"——
**工作区删了就永远答不出来**。

**做法**：`KEEP=1` 保留，并在失败时打印路径。

---

## 自查清单

改 `scripts/e2e-*.sh` 之后，逐条过一遍：

- [ ] 端口是**探测出来的**，不是写死的
- [ ] 每一次等待都等**一个可观测的事件**（日志行 / 屏幕元素），不等秒数
- [ ] `grep -c` 的结果用 `${var:-0}` 兜底，没有 `|| echo 0`
- [ ] 断言匹配**形状**，不是客户端某个版本的**标点**
- [ ] 客户端自己的 UI 策略（分组、折叠、弹框）**记 note 或显式钉住**，不当成本桥的承诺
- [ ] `cleanup` 只杀**自己的**进程 / socket，`trap` 里带 `exit`
- [ ] 等待超时时**打印当时的屏幕**
- [ ] 影响断言的界面设置被**显式钉住**
- [ ] 失败时可以 `KEEP=1` 复看现场

---

## 与之相关的事实（别重复发现）

- **opencode v2 自己也没有终端级 TUI 自动化**：它的 TUI 测试是组件测试（`.test.tsx`），
  e2e 是 Playwright 跑 Web app。本仓的 `e2e-real-tui.sh`（tmux 抓屏）是**多出来的那一层**，
  正是它抓到了纯组件测试看不见的问题（桥的事件流能不能被渲染）。
- **Windows 没有 tmux**，所以真 TUI 验收只在 macOS / Linux 上跑；Windows 跑单测。
  这一点与上游一致，写进 [COMPAT-OPENCODE.md](COMPAT-OPENCODE.md) 而不是假装测过。
- 兼容性矩阵的设计（为什么只测边界版本、为什么三层而不是 360 个组合）见
  `scripts/compat-matrix.sh` 的文件头注释。
