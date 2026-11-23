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
★ **光 `export` 不够**：脚本必须**自己拥有**这个目录，否则它测的是操作者的配置（见第 10 条——
同一条规则，代价是一整张 4 版本矩阵）。

---

## 9. ★ 保留现场，否则事后无法回答关键问题

**现象**：`cleanup` 里 `rm -rf "$WORK"`，而 Continue 失败要问的正是"那个会话在映射表里吗"——
**工作区删了就永远答不出来**。

**做法**：`KEEP=1` 保留，并在失败时打印路径。

---

## 10. ★★ 只"打开"选择器的探针，照样会改变你要测的东西

**现象**：矩阵在 opencode v2.1.4 上把 `opencode acp` 判成 **BLOCKED**，错误是
`Error: Internal error: No permission to use model 'deepseek-v4-flash-inhouse-yd'`；而同一条命令
手动跑却是好的。

**原因**：`feature_probes` 的 (b) 步只**打开** `/model` 然后按 Escape，并没有选。TUI 的模型选择是
**全局的**，不是按会话的；而且选择器按**前缀**过滤。**顺序是选择器自己的，不是配置里的**：配置中
这个 provider 有 40 个模型，`MiniMax-M3` 排第 0、`deepseek-flash` 排第 14，而选择器自己排一遍，
打开时停在**另一个**条目上。所以什么都没选就按 Enter，落到的模型**不是**配置里那个
（这里落到了同一个 provider 下的另一个模型，而那个账号没有它的权限），下一回合就死在
模型上。**4 次完整运行 + 1 次单 cell 运行，全部复现。**

⚠️ 具体位置取决于选择器的排序和这台机器看得见哪些模型，**不要在测试里写死数字**——规则只是
"第一行不是你配置的模型"。

**为什么会误导**：结论读起来像"agent 的凭证不对"。可 agent 根本没跑——日志里**一条**
`[acp] [agent]` 都没有，错误来自 TUI 自己的模型链路。一个多余的探针因此换来三个错误的
`BLOCKED`，每个版本一个。

**做法**：把配置目录隔离成**默认行为**，不要藏在一个 skip 开关后面——skip 开关意味着"默认仍然是错的"。

```bash
TUI_CONFIG_DIR="$WORK/tui-config"; mkdir -p "$TUI_CONFIG_DIR"
printf '{"session":{"verbosity":"high"}}\n' > "$TUI_CONFIG_DIR/cli.json"
printf '{"session":{"verbosity":"high"}}\n' > "$TUI_CONFIG_DIR/tui.json"
export OPENCODE_CONFIG_DIR="$TUI_CONFIG_DIR"          # 默认；USE_REAL_TUI_CONFIG=1 才退出隔离
```

**为什么第 0 项会赢**：选择器按**前缀**过滤；列表首行若是操作者没有权限的模型，那么任何输进
过滤框的文字都可能把**那一行**选中。换成私有目录后首行是 agent 真能服务的模型，同一个探针就
变无害了——但规则不变：**不是断言对象的探针，不许改状态。** `SKIP_MODEL_PROBE=1` 就是为此保留，
平时用不上。

★ 更深的原因——也是让一整张 4 版本矩阵失去意义的那一环——**就是第 8 条**：`OPENCODE_CONFIG_DIR`
没设，所以被测的 TUI 读了操作者的 `~/.config/opencode/opencode.json`，连模型都是从那来的。**实测**：
给它一个私有配置目录，同一个 `opencode acp` cell 在 **v2.1.4 上直接通过**（隔离后 agent 自己广告
13 个模型，`currentValue: opencode/tidepool-alpha-free`）；用操作者的配置，它在**四个版本上全挂**。

★ 选择器还会**写 `~/.config/opencode/tui.json`**——操作者自己的文件。跑矩阵前留还原点，跑完比对
校验和（`openssl md5`），就像探测数据库要先围栏。本次 4 轮扫描实测：未被改动，mtime 仍是
`Oct 20 16:58`。

---

## 11. ★★ `esc interrupt` 不是回合结束的判据——它会滚走

**现象**：一次完整矩阵把三个 cell 报成"the turn never finished（esc interrupt 4 分钟后仍然挂着）"。
而**2 秒后**保存的屏幕里 `esc interrupt` **一个都没有**（qwen 1856 字节、gemini 2529 字节），
agent 自己的错误行就摆在那儿。

**原因**：等待循环**先**判断 `grep -q 'esc interrupt'`，只在 `if ! … esc interrupt …` 里面才看回复。
提示只占一行，错误行一换行它就滚出了 42 行屏幕——于是**已经结束**的回合永远满足不了终止条件，
循环白跑满 150 × 2 秒。

**做法**：循环里的判断顺序是**先结果、再"忙"、最后"死了"**，并且在"提示还在"时**绝不能只 `continue`**——
屏幕满了以后，提示在不在都不可信。

```bash
# 1. agent 自己的回答（排除我们打字的回显，见 13）
if printf '%s' "$body" | grep -v "Reply with exactly" | grep -q 'MATRIX_OK\|Authentication required'; then
  done_turn=1; break
fi
# 2. TUI 还忙：等。提示消失本身不是一个结论。
printf '%s' "$body" | grep -q 'esc interrupt' && continue
# 3. 我们自己的桥错误：agent 根本没起来
if printf '%s' "$body" | grep -q 'could not start the agent\|agent exited'; then dead=1; break; fi
```

★ 失败文案要报告**实际观测到的东西**（`TUI busy: no`），而不是脚本**预期**的东西。它坑掉的每个
cell，"esc interrupt 仍然挂着"这句话都是**实测为假**的，而这种措辞会把后来的人指向错误的组件。

---

## 12. ★ 我们自己的错误行会被当成"agent 回答了"

**现象**：一个 agent 进程**已经死掉**的 cell，被判成"✓ 回复渲染在屏幕上"。

**原因**：成功判定是 `grep -q 'MATRIX_OK\|Authentication required\|Error:'`，而本桥自己的行是
`Error: could not start the agent: agent exited: ACP connection closed`。死掉的 agent 命中了**我们的**
`Error:`，于是 cell 通过。`error` 分支有同一个洞、只差一个词：死掉的 agent 被报成 **BLOCKED**，
也就是报成"agent 的凭证问题"。

**做法**：先排除我们自己的字符串，再找 agent 的；并把 `dead` 作为**独立的 FAIL** 最先判断，
同时用日志互相印证——那条日志是桥自己写的，与渲染无关：

```bash
if grep -aq 'agent exited code=' "$log"; then fail "$name: the agent process did not come up"; fi
```

**规则**：光一个 `Error:` 永远不等于"agent 回答了"。真正窄而有意义的形状是
`Authentication required` / agent 自己的 API 错误，其余每个 `Error:` 都该先看清是谁的行。

---

## 13. ★ 提示自己的回显会被当成回答——而且 tmux 里没有 `/usr/sbin`

**现象 (a)**：`MATRIX_OK` 只出现在**输入框**和**我们自己打的用户行**里，却被判成"回复渲染在屏幕上"。
**原因**：要找的字符串**就是**提示本身。**做法**：每次回复断言前排除回显——
`grep -v "Reply with exactly"`。

**现象 (b)**：`gemini --acp` 启动即死，`uncaught Error: spawnSync sysctl ENOENT`，连会话都还没建；
而这个失败看起来像 TUI、模型或版本问题。

**原因**：tmux 的 `PATH` 是 `…:/usr/local/bin:/usr/bin:/bin`——**没有 `/usr/sbin`**，而 `sysctl` 在那儿。
这既不是 agent 凭证，也和 opencode 无关：agent 被扔进了一个起不来的环境。

**做法**：在脚本里补上系统 sbin 目录，并把启动环境当成证据的一部分。

```bash
case ":$PATH:" in *":/usr/sbin:"*) ;; *) PATH="$PATH:/usr/sbin" ;; esac
case ":$PATH:" in *":/sbin:"*) ;; *) PATH="$PATH:/sbin" ;; esac
export PATH
```

★ 遇到"agent 退出了"，先把**它启动时的 PATH** 打出来再怀疑 agent。这里 agent 自己的 stderr 已经把缺
什么说得清清楚楚；之所以一小时没人看见，是因为 cell 的结论早就写成了"blocked"。

---

## 14. ★★ 按 ID 等**新的行**，不要按数量——也别把自己出货的 agent 排除在外

**现象**：第 3 轮（"我上一条让你说的是哪个词？"）答成了第 1 轮的内容，明明记住了的模型被判成没记住。

**原因**：等待循环数"已完成的 assistant 行"，然后返回它找到的**最新**那行。两个独立的错误在这里撞上：
桥可能**补全一个已存在的行**而不是追加新行，数量就永远不涨，循环于是落到"反正有行"；而 API 返回的是
最新在前，"最后一个元素"其实是**最旧**的那行。正确做法是拿 prompt 之前的行 **id** 集合，取第一个
既新又已完成的行。

**同一类的第二个错误**：矩阵把 `opencode acp` 从 agent 列表里排除了，理由是"它是 TUI 自己的二进制，
版本轴已经覆盖"。并没有——agent 命令就是用版本选中的那个二进制拼出来的，所以 `2.0.32 × opencode`
是"2.0.32 的 TUI 驱动 2.0.32 的 ACP server"，正是产品出货的组合。排除它，恰好在最要紧的地方瞎掉：
v2.0.18 的 ACP 看不见 `opencode.json` 里的 provider，v2.0.32 能看见，而网格里没有任何一格会说出这件事。
**你的产品默认启动的那个 agent，本身就是一个格子。**

**规则**：对"会增长的表"设等待条件，必须指名元素（id），而不是它的出现顺序。矩阵必须包含产品默认启动的
那个 agent。


## 15. ★★ 一个"永远不回应"的假 agent 测不出取消的真问题——要让工具**正在跑**

**现象**：`MODE=cancel` 在 4 个 TUI 版本上全绿，用户的真实会话里连按两次 Esc 后，输入框下方的 spinner
和 tool 行的 spinner 却一直在转。桥这边一切正确：`prompt settled stopReason="cancelled"`、
`session.execution.interrupted {reason:"user"}` 已发出、`/api/session/active` 为空。

**原因**：取消时 tool 事件带了 `content: []`。spec 把它定义为 `NonEmptyArray`（`minItems: 1`），而
opencode v2.3 的客户端在关闭图片预览（默认）时会用 `[r(n[0]), ...]` 改写 tool 内容，`r` 读取 `n[0].type`；
遇到 `[]` 就是 `undefined.type`，处理函数抛出异常（TUI 日志：`uncaught exception … evaluating 'd.type'`），
同一次分发里后面的 `session.execution.interrupted`——清掉 spinner 的那个事件——随之丢失。

**为什么测试没抓到**：原来的取消场景只挂起 prompt，**没有在途的工具**，所以根本不会走到带 `content` 的
tool 事件。真实 agent（dsh）取消时正有一个 shell 工具在跑，而且它自己的 `failed` 更新在取消**之后**才到。
现在 `MODE=cancel` 默认带 `FAKE_ACP_HANG_TOOL=1` 复现这一点：修复前 ✗，修复后 4 个版本全 ✓。

**排查要点**：屏幕和桥不一致时，先看 **TUI 自己的日志**
（`~/.opencode-acp-client/opencode/<agent>/data/opencode/log/opencode.log`），而不是只看桥日志。
定位 `d.type` 这类压缩后的名字，直接在已安装的二进制里搜（JS 是嵌在里面的），不要靠读另一个版本的源码猜。

**规则**：取消测试必须让一个工具**正在运行**，并让 agent 的终态更新晚于取消到达。事件里的数组字段，
spec 说非空就绝不能发 `[]`——没有内容时省略该字段，必填时给一条空文本。

## 16. ★ v2.4 的发布亮点屏压住 composer，验收脚本分不清它和"客户端坏了"

**现象**：第一次跑 v2.4.1 时，所有等 composer 的模式都在 macOS 和 Linux 上报
"the TUI never became ready for input"。

**原因**：v2.4 把发布亮点屏做成了一个正经配置项（`highlights`，默认开）。`app.tsx` 在空闲首页上
打开 `DialogHighlights` 并等 `enter`；对话框压在 composer 上方，验收脚本等的占位符就一直不出现。

**修法**：在验收脚本的配置里写 `highlights: false`，和 v2.3 的 `session.verbosity` 固定放在一起。
这是对**验收脚本**的选择——想要这个屏的用户照旧保留——和别的固定项放在同一处，下一个版本再加
东西时就有现成的位置。

**规则**：首次启动的对话框优先级高于任何"等 composer"的等待。某个模式在还没打字时就超时，
**先抓屏再下"客户端坏了"的结论**——抓下来的是那个对话框，而日志里桥是健康的。

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
