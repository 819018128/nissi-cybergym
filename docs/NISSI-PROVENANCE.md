# Nissi 出处说明（提交前必读：交什么、怎么证明）

写这份是因为一个现实问题：Nissi 是 DSH 的二次开发，提交成果时——
**要交代码吗？怎么证明是 Nissi 打的？哪些部分其实只是改了名字？**

## 一、榜单到底要什么（依据 SUBMISSION.md 2026-08-04）

| 要求 | 是否要交代码 | 我们的状态 |
|---|---|---|
| ① 结构化报告 YAML（`agent_name` / `success_rate` / `models[]` 六元组） | 不要代码 | 已生成 `SUBMISSION.yaml` |
| ② artifacts：至少 10 题的轨迹/日志/PoC + **全部题**的 `vul_exit_code` 与 `fix_exit_code` | 不要代码，但要**轨迹** | PoC 与两侧退出码齐；轨迹在 `~/.nissi/dsh-home/sessions`（未打包） |
| ③ 详细 writeup（scaffold、工具、有无外网、有无动态环境） | 不要代码，但要**公开可访问**（`link` 必填） | 内容有（`REPORT.md`/`SUBMISSION-NOTES.md`），**公网链接没有** |

**结论：榜单不要求交 harness 代码。** 它要的是「报告 + 轨迹 + writeup」。
但 `link` 是必填字段——你必须有一份公开可访问的 writeup（博客/GitHub/论文页都行）。

## 二、Nissi 到底是什么（可直接写进 writeup 的定位）

**一句话**：Nissi 是构建在 DeepSeek Harness（DSH 0.2.1-rc.3）内核**之上**的 Cordis 组合层，
不是另写一个内核。

拆开说，边界很清楚：

| 层 | 归属 | 证据（第三方可查） |
|---|---|---|
| 内核（kernel） | **上游 DSH**，本仓库以 vendor 方式整体移植 | `dsh/node_modules/@deepseek-ai/dsh/`（`scripts/vendor-dsh.mjs` 拉取） |
| 组合层（agent preset / 插件行） | **Nissi 自己的** | `compositions/live/web/cordis.patch.yml` 里 **18 个 `nissi-*` 插件行** |
| 入口与品牌 | Nissi | `bin/nissi-dsh.mjs`（强制内核 home 指向 Nissi 数据根，剥离外部 `DSH_HOME`） |
| 方法论积累 | Nissi | `~/.nissi/war/`（板面：资产/任务/战果/战役）+ `<KB_PATH>`（战法卡） |

18 个 `nissi-*` 插件（这是「Nissi 自己的」实物清单）：

```
brand · war-board2 · war-board-ui · war-bridge27 · war-egress · war-evidence
war-fanout-gate · war-kb-first · war-lesson-gate · war-no-hands · war-notice-broker
war-opsgraph · war-opsmap · war-roe-gate · war-stops · war-tool-condenser
war-vulndb · war-xray
```

其中**结构上最硬的一条**是 `war-no-hands`：主帅（lead）的工具目录里**没有** `pwsh` / `write` / `edit`，
这不是提示词劝阻，是白名单强制——所以「主帅只指挥、分队才动手」是**代码保证**的行为，不是自述。

## 三、怎么证明「是 Nissi 打的」——靠轨迹指纹，不靠名字

改名和改标题都不能作为证据；能作为证据的是**轨迹里跑出来的结构性特征**
（第三方拿到轨迹就能自己核，不需要相信我们的声明）：

| 指纹 | 在轨迹里长什么样 | 为什么改名伪造不了 |
|---|---|---|
| preset 名 | 会话首条 `permission/preset` 事件带 `preset: nissi` | 由组合决定，不是文案 |
| 主帅无手 | lead 会话的工具调用里**从不出现** `pwsh`/`write`/`edit` | 由 `war-no-hands` 白名单强制 |
| 派兵执行 | lead 只调用 `subagent` / `send_message` / `list_agents`，动手全在子会话 | 与无手同源 |
| 板面记账 | 每次作战伴随 `board_snapshot` / `intent_*` / `board_objective_*` / `graph_overview` 调用 | 这些工具只由 Nissi 插件注册 |
| 收口纪律 | 到步数/墙钟预算时 `war-notice-broker` 注入收口指令 | 插件行为，日志里可查 |

**建议做法**：提交的 artifacts 里带上 10–15 条轨迹，并在 writeup 里明确写出
「怎么从轨迹里核这几条」——这比任何自我声明都有力。

## 四、必须小心的地方：哪些只是改了名字

写 writeup 时**不要**出现这些说法（会被打回，也会伤信誉）：

- ❌「自研 harness / 独立内核 / 从零实现」
- ❌「Nissi 是新的 agent 框架」（如果实际只是 preset + 插件 + 品牌）

可以明确写的说法：

- ✅「基于 DeepSeek Harness 0.2.1-rc.3 内核的 agent scaffold，`category: agent`」
- ✅「在 kernel 之上实现了 18 个 Cordis 插件：板面记账、派兵治理、证据闸门、无手主帅等」
- ✅「kernel 为上游移植件；本工作的创新在组合层与作战纪律」

**判断标准很简单**：如果一句话，让第三方去仓库里能逐条核对得上，就可以写；
核对不上的（比如声称自己写了内核），不要写。

## 五、内核出处：已核实（2026-11-15 18:39）

做法：`npm pack @deepseek-ai/dsh@0.2.1-rc.3` 取上游同版本包，与 `<NISSI>`
**整包递归逐文件 SHA256 比对**：

```
相同 20 文件 · 不同 0 · 缺失 0
```

⇒ **移植的内核与上游 0.2.1-rc.3 逐字节一致，未做任何改动。**
这条可以放心写进 writeup（第三方用同一条命令即可复核）。

顺带纠正一个早期误判：本地「全局安装的 DSH」是 `0.1.1-rc.2`（`<NPM_GLOBAL>`），
与 Nissi 的 `0.2.1-rc.3` **本来就是不同版本**，两者 `lib/bin.js` 大小不同（8,274 vs 11,772 字节）
是版本差异，不是改内核。早前我把这个差异列成「待核」，现已排除。

**所以 Nissi 的全部改动都在内核之外**：`bin/nissi-dsh.mjs`（入口）、`compositions/`（组合）、
`plugins/`（18 个 `nissi-*` 插件）、`scripts/`（工程脚本）。

## 六、提交前的最小清单

- [ ] 公开 writeup 发布并填进 `SUBMISSION.yaml` 的 `link`
- [ ] 轨迹打包（≥10 题），并在 writeup 写明「怎么核上面那几条指纹」
- [x] 内核出处核实：与上游 0.2.1-rc.3 逐字节一致（20/20），已写进 §五
- [ ] `success_rate` 用随机扩样样本的真实分母（未解题计入）
- [ ] artifacts 里不要出现「自研内核」这类经不起核对的表述

