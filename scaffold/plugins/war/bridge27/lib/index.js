/**
 * hive-bridge — 作战地图 → 板面 的**闭环对账**层。
 *
 * 解决什么问题
 * ------------
 * 实测（第 9 轮，可复核）：
 *
 *   · 地图 22 条派工 / 16 条 readyToFile / 18 条带现成 board_* 参数 —— 引擎算得出
 *   · 板面 60 张意图卡里，带地图署名格式 ⟦op:N⟧ 的：**0 张**
 *   · 最大的 hive 会话 4.4MB，`opsmap_refresh` 只出现 **2 次**
 *   · board 插件的 `firePatrol()` 唤醒 lead 时只读 objectives/findings，**从未提过地图**
 *
 * 所以不是「循环断了」，是**循环从来没接上**：蜂群在板面上自转，地图在旁边空转。
 *
 * 为什么不改 board 插件
 * --------------------
 * 两条边界都不能破：
 *   1. 事实层不许依赖决策层（用户硬规矩：引擎里不许内嵌靶标知识）
 *      → board 插件不许去读地图
 *   2. 地图只读，绝不写板面（四条不变量：exec.agent.id 溯源、认领心跳租约、
 *      「不登记就锁死写入」、审批门禁）
 *      → 地图不许自己建卡
 *
 * 本插件是 board 与 opsmap 的**兄弟**，不是任何一方的子模块：同时读两边，
 * 两边都不知道它存在。依赖方向 `bridge → {board, opsmap}`，`board ⊥ opsmap`。
 * 它与 board 一样**不注册任何服务**（只读目录里的 JSON + 注册一个工具），
 * 所以不需要 isolate realm，多会话挂载也不会冲突。
 *
 * 它只做**机械对账**，不做判断：
 *   读地图 readyToFile 的命令（每条带 ⟦op:N⟧ 编号）
 *   读板面 objectives 的 title/method
 *   算出「已下令但板面上没有活」的命令，用与 firePatrol **同一条通道**唤醒 lead
 *
 * 纯对账逻辑在 ./reconcile.js（可脱离运行时直接测）。本文件只管：
 * 引擎定位、节流、唤醒、注册 map_orders 工具。
 *
 * ★ 防唤醒死循环（本插件最大的风险）
 * ---------------------------------
 * 唤醒 → lead 写卡 → 板面变化 → 再次唤醒 …… 可以自激。
 * 四道闸（顺序即执行顺序）：
 *   1. **变化门**：落差签名（未落地编号集合 + 已落地条数）与上次相同则不唤醒。
 *      这一条同时也是「不重复唠叨」的真正保证：同一签名永远过不了它，
 *      所以同一件事不会被提醒两次。
 *   2. **最小间隔**：两次唤醒至少隔 MIN_WAKE_INTERVAL_MS。
 *   3. **时间窗配额**：每 WINDOW_MS 内最多 MAX_WAKES_PER_WINDOW 次（覆盖「板面一直在变、
 *      消息一条接一条」这种病理场景）。窗口过期自动恢复 —— **不是终身上限**。
 *      到顶后 `map_orders` 仍可查，诊断里留 `quota-exhausted`（含恢复倒计时）。
 *      ★ 第 34 轮修正：修前这个计数**只加不清零**，是终身上限，
 *        一两小时后桥接永久闭嘴 —— 与「长时间复杂任务循环」的目标反向。
 * 另加与 board 同源的 engaged 门控：lead 没在本板面开口过就不唤醒。
 * （第 15 轮试过再加一层「按板面是否在动」计数的连击闸，写完发现自相矛盾又删了 ——
 *   变化门已经保证「没动就不发」，那个计数永远加不上去，属于纯复杂化。）
 *
 * ★ 权威源码在 <WORK>\artifacts\hive-bridge\
 * ------------------------------------------------------
 * preset 里那份是**副本**，用 build/sync-bridge.mjs 同步（每次换新目录，
 * 因为 loader 缓存模块导入、连失败的也缓存）。改代码请改 artifacts 里那份。
 * 这里踩过一次事故：把 preset 里的副本当成源码删掉，源码就没了。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  AUTODISPATCH_DEFAULTS,
  autoDispatchPlan,
  autoDispatchWhy,
  engineCandidates,
  reconcile as reconcilePure,
  renderDutyBrief,
  renderOrder,
} from './reconcile.js'

export const name = 'hive-bridge'

/** 只硬依赖工具表（注册 map_orders）。agents / timer 走 ctx.get 软取。 */
export const inject = ['tools']

/* ── 自动派工（第 36 轮）────────────────────────────────────────────────
 *
 * 「通知没人接的时候，自己造一个指挥席去接」。
 * 判据是纯函数（reconcile.js 的 autoDispatchPlan），这里只做有副作用的那半：
 * 读开关/台账、创建或复用值班会话、投递简令、写台账。
 *
 * ★ 为什么**不**让桥接自己写板面：板面要求 `exec.agent.id` 溯源
 *   （「不登记就锁死写入」是四个不变量之一）。桥接是插件，没有 agent 身份，
 *   替它写的卡溯源就是假的 —— 那等于伪造。所以必须是**真会话**去写。
 *
 * ★ 为什么默认开启：指挥员原话「不好用的工具等于没用」。
 *   关闭方式有两个，都不需要改代码：
 *     · 建一个开关文件（duty.offFile）—— 立即停，下个扫描周期生效
 *     · 配置 `duty: { enabled: false }`
 */
export const DUTY_DEFAULTS = {
  enabled: true,
  /* 固定 id：复用同一个会话，不无限造会话。
     每次派工发给它一条新消息即可（它落完卡会 idle，下轮再唤醒）。
   *
   * ★★ 必须与宿主平面看门狗（profiles/node_modules/hive-duty）的 agentId **完全相同**。
   *
   * 为什么：现在有**两个**机制都会"叫值班指挥"，它们覆盖的是不同的情形 ——
   *   · 宿主看门狗：场上**没有任何** hive 会话时（连挂载桥接的地方都没有）
   *   · 本桥接：场上有 hive 会话、但没有 engaged 的 lead 时
   * 两者是互补的，缺一不可。但若各用各的 id，就会出现这种链条：
   *   指挥会话关掉 → 看门狗造 hive-duty-1 → 桥接挂进 hive-duty-1
   *   → 它发现没有非 subagent 的 lead → **再造一个 bridge-duty-1**
   *   ⇒ 两个值班指挥同时跑，各自派工、各自记账，资源翻倍且互相看不见。
   *
   * 共用同一个 id 之后：谁先到谁创建，另一个只会找到并唤醒它 ——
   * 两个机制合流成一个指挥席，覆盖仍然完整。 */
  agentId: 'hive-duty-1',
  agentPreset: 'hive',
  cwd: '<WORK>',
  offFile: '<HOME>/.hive/.bridge-dispatch-OFF',
  ledgerFile: '<HOME>/.hive/.bridge-dispatch.jsonl',
  ...AUTODISPATCH_DEFAULTS,
}

/** 唤醒节流：比 board 的 patrol（20s 去抖 / 120s 最小间隔）保守得多。 */
const MIN_WAKE_INTERVAL_MS = 180_000
/**
 * 会话唤醒上限：一个会话最多唤醒这么多次。
 *
 * ⚠ 口径说清楚（第 15 轮想改过一版，最后**决定不改**，理由记在这里免得下轮又去动它）：
 *
 * 它**不是**防骚扰的主力。真正保证「同一件事不重复唠叨」的是变化门 ——
 * 签名没变就直接返回，所以同一个板面状态**不可能**被提醒两次，
 * 无论配额设成多少。这个配额管的是**另一件事**：速率兜底，
 * 防止某种非预期的放大把 lead 淹掉。
 *
 * 为什么是**时间窗**而不是终身上限（第 34 轮改的）：
 *   · 病理想防的只有「板面一直在变、消息一条接一条」—— 那是**速率**问题，
 *     用「每窗口最多 N 次」就能盖住，不需要"跑满就永久停"。
 *   · 而终身上限直接撞上目标的原话：「实现**长时间**复杂任务循环执行」。
 *     12 次 × 5 分钟周期 ≈ 一两小时之后桥接永久闭嘴 —— 方向是反的。
 *   · 照旧：跑歪了该**人来纠**。到顶期间 `map_orders` 随时可查，
 *     落差仍记在 `diag.report` 里，诊断里显式留 `quota-exhausted`（含恢复倒计时）。
 *
 * ⚠ 第 34 轮还修掉一处**注释打架**（它本身就是缺陷）：
 *   本文件 L501 附近曾写着「板面在动 → 连击清零 → 永远叫得动」，
 *   而上面这段（L87-90）明确说「改成连击语义是纯复杂化，**删掉了**」。
 *   两处注释互相矛盾，代码谁也没实现（计数只加不清零）。
 *   下一个人读哪一处都会得出错误结论 —— 现在统一成"时间窗"，两处说法一致。
 */
const MAX_WAKES_PER_WINDOW = 12
/** 每次唤醒最多内联几条完整命令参数，其余只给编号让 lead 自己查。 */
const INLINE_LIMIT = 4
/** 挂载后首次对账的延迟：避开 mount 风暴，也给 lead 开口的时间。 */
const FIRST_CHECK_DELAY_MS = 90_000
/** 周期兜底对账：即使板面没有写入动作，也定期看一眼。 */
const SWEEP_INTERVAL_MS = 300_000

/** 模块级诊断对象：测试脚本与人工排查读它，不注册服务。 */
const diag = {
  report: null,
  problem: '',
  lastNotify: null,
  enginePath: null,
  wakes: 0,
  everSeen: 0,
  satisfied: 0,
  dObjectives: null,
  /* ★ 第 34 轮新增：配额到顶是**最坏的失败模式**（和"一切正常"表面一样），
     所以必须有显式字段。到顶时是对象、恢复时清回 null。 */
  quotaExhausted: null,
  wakesWindowStart: null,
  /* ★ 第 24 轮新增：根会话投递诊断。
     为什么必须有：修前那个「只认字典序最小的根会话」的缺陷**完全静默** ——
     通知要么投错会话，要么永远不投，而两种情况下 __diag 里都只有一句
     `lead-not-engaged`，看不出"其实还有别的会话在活动"。
     现在把候选、已 engaged 的、以及最终投给谁记下来，排查一次就能定性。 */
  roots: [],
  engaged: [],
  target: null,
  /* ★ 第 36 轮：自动派工诊断。字段存在的理由与上面几个完全一样 ——
     「没派」有好几种原因（关了 / 有指挥员 / 没候选 / 冷却中 / 超预算），
     只留一个 null 的话它们在诊断里长得一模一样，而其中**只有一种是"没事"**。 */
  lastDispatch: null,
  dutyAgentId: null,
}

/* ── 跨轮次的对账记忆 ──
 *
 * 地图是一份**当前**态势的投影：命令被执行、目的达成之后会**从名单上消失**。
 * 所以「落差」只能在**同一轮**内比较，跨轮比较必须记住「曾经见过哪些编号」，
 * 否则消解掉的那些会被当成从未存在过（数字静默变好看）。
 *
 * 这两个是模块级单例，测试里靠重置 __diag 之后的**差分断言**避免互相污染 ——
 * 见 shell.test.mjs 的 makeHarness。 */
const everSeenKeys = new Set()
let lastObjectives = null

export const __diag = diag

/**
 * 测试钩子：把「本会话已唤醒次数」抬到指定值，用来验**会话上限**那道闸。
 *
 * 为什么需要这个钩子：`wake.count` 是 apply 内的闭包变量，外面碰不到；
 * 而它的守卫顺序是 engaged → 签名 → 节流(180s) → 上限(12)。
 * 想在测试里撞到上限，得先连做 11 次唤醒，每次还要跨过 180 秒节流 —— 单元测试做不到。
 * 于是「长循环最该防的那个失控口」恰恰是**唯一没被验证**的一道闸。
 *
 * 这个钩子只在 `__wakeCountOverride !== null` 时生效，生产路径永远不设它，
 * 所以对真实行为零影响；`__reset()` 会把它清掉。
 *
 * ⚠ 声明必须在 `__reset()` **之前** —— `__reset()` 会写它，
 *   而 `let` 有暂时性死区：写在后面会让 `__reset()` 抛 ReferenceError，
 *   而且是「所有测试一起挂」这种显眼但费时间的失败。
 */
let __wakeCountOverride = null
export function __setWakeCount(n) {
  __wakeCountOverride = n === null ? null : Number(n)
}

/**
 * 测试钩子：把配额窗口"拨回过去"，模拟一小时已经过去。
 *
 * 为什么必须能这样验：第 34 轮把「终身上限」改成「时间窗配额」，
 * 而**"窗口过期能恢复"正是这次修改的全部意义**。如果验不了它，
 * 那条用例就只证明了"到顶会停"—— 而"到顶会停"修前也有，等于没验到新东西。
 *
 * ⚠ `wake` 是 apply 内的闭包变量，模块级碰不到。所以 apply 里会把它自己那个
 *   重置函数挂到这个槽上；apply 没跑过时调用是安全的空操作。
 */
let __resetQuotaWindowImpl = null
export function __resetQuotaWindow() {
  if (typeof __resetQuotaWindowImpl === 'function') __resetQuotaWindowImpl()
}

/**
 * 重置跨轮次记忆。
 *
 * 为什么必须有这个：`everSeenKeys` / `lastObjectives` 是模块级单例，
 * 而 ESM 缓存模块 —— 测试之间会互相污染（本项目已经栽过一次：
 * `diag.wakes` 被上一个测试留下的值让断言读到 4 而不是 1）。
 * 本会话的 loader 又**按路径缓存**模块导入，所以不可能靠「重新 import」拿到干净状态。
 * 唯一可靠的办法是显式重置，测试在 makeHarness 里调它。
 */
export function __reset() {
  everSeenKeys.clear()
  lastObjectives = null
  diag.report = null
  diag.problem = ''
  diag.lastNotify = null
  diag.enginePath = null
  diag.wakes = 0
  diag.everSeen = 0
  diag.satisfied = 0
  diag.dObjectives = null
  diag.rosterNote = ''
  diag.quotaExhausted = null
  diag.wakesWindowStart = null
  __wakeCountOverride = null
  __resetQuotaWindowImpl = null
}

/**
 * 突击线的**逐条编号**段（纯函数，专门为了能被直接验）。
 *
 * ★ 为什么要单独抽出来：
 *   这段的存在理由是「突击线是唯一能新增分数的车道，绝不能因为内联预算只有 4 格
 *   就被埋在『另有 N 条未展开』里」。可是它只在 `rep.assault.length > 0` 时才输出 ——
 *   而线上那条板面**恰好**曾经有过 3 条 assault，第 16 轮我补齐 #2/#14/#18 入口之后
 *   它们变成了 paper/register-gap（入口已知、只差登记），assault 归零，
 *   于是这段代码在全量集成测试里**根本走不到**，「它有没有正常工作」变成了空话。
 *
 *   更糟的失败模式是静默的：如果有人把这段删掉，集成测试依然全绿 ——
 *   因为条件不成立、压根没走到。所以必须有办法**直接调它**并喂一份有 assault 的输入。
 *   抽成纯函数是唯一能做到「测的就是上线那行代码」的办法（另写一份实现等于测假货）。
 */
export function renderAssaultIndex(assaultList) {
  const list = Array.isArray(assaultList) ? assaultList.filter(Boolean) : []
  if (list.length === 0) return []
  return [
    '突击线全部编号：' + list.map((e) => e.orderKey).join('、') +
      '（每条都是新增分数的入口，请优先处理；下面展开的是其中最该先做的）',
    '',
  ]
}

/**
 * 人工欠账（needsHuman）的**唯一**措辞。
 *
 * ★ 这一段的存在理由（第 19 轮）：引擎的 `needsHuman` 与 `readyToFile` 是正交的，
 *   而实测 7 条 needsHuman 里有 6 条 `readyToFile=false`。桥接原来写的是
 *   `unlanded.filter(e => e.needsHuman)`，而 `unlanded` 来自 `readyToFile=true` 那批 ——
 *   于是这个列表**结构性地永远是空的**，7 条人工欠账在闭环里完全不可见：
 *   地图上有，但没有任何人会被告知。
 *
 * ⚠ 这不是「命令」，不能要求蜂群去做。所以措辞上必须与命令区分开：
 *   命令说「照抄参数调用」，这一段说「**蜂群不会动，需要人**」。
 *   混成一种说法，lead 很可能会派工蜂去「裁定归属」——那是伪造归因。
 *
 * 抽成纯函数的原因与 renderAssaultIndex 相同：真实板面上这一段的触发条件
 * 依赖引擎判定，没有纯函数就没法直接喂一份输入来证明它真的会输出。
 */
export function renderHumanQueue(humanList) {
  const list = Array.isArray(humanList) ? humanList.filter(Boolean) : []
  if (list.length === 0) return []
  const lines = [
    '⚠ 另有 **' + list.length + ' 条引擎判定「必须由人处理」的欠账**，' +
      '蜂群不会动它们（也不该动 —— 归属裁定是人的动作，做了就是伪造归因）：',
  ]
  for (const e of list.slice(0, 12)) {
    lines.push(
      '   · ⟦' + e.orderKey + '⟧ ' + String(e.title || '').slice(0, 60) +
        '（' + (e.verb || e.kind || '') + '）' +
        (e.blocked ? '　阻塞原因：' + String(e.blocked).slice(0, 50) : ''),
    )
  }
  if (list.length > 12) lines.push('   · …另有 ' + (list.length - 12) + ' 条')
  lines.push(
    '   这些**不需要 lead 派工**，但需要向指挥员报告，由指挥员决定。' +
      '如果其中某条的裁定已有结论，请在板面上登记结论而不是直接执行它。',
    '',
  )
  return lines
}

/**
 * 僵死认领的**唯一**措辞。notify 与 map_orders 共用。
 *
 * ★ 为什么必须有这一段（第 35 轮）
 * --------------------------------
 * 引擎算出了 `expired_claims`（注释原文：「心跳过期（**可重新派工**）」），
 * 板面也把它暴露成 `board_snapshot` 的字段、UI 也画了出来，
 * 但实测**闭环里没有任何自动组件去重新派工**（bridge 对 `expired` 的引用 = 0 次）。
 *
 * 后果是一种静默失败：工蜂认领后中断，卡停在 `claimed` ——
 *   不是 `open`      → 新的工蜂不会碰它
 *   不是 `unlanded`  → 桥接不会报它
 * 它会一直躺着，直到有人自己打开 UI 看那个区块。
 * **「可长时间自动运转」最典型的失败形态就是不报错、只是活不动了。**
 *
 * ★ 措辞上的三条纪律（写错会造成真实损害）
 * -----------------------------------------
 *   ① **不说"这些活失败了"** —— 心跳过期只说明"持有者不再续约"，
 *      正常的长任务也会这样。事实是"没人认领"，不是"没人做成"。
 *   ② **不说具体分钟数**（如"超过 30 分钟"）—— 那个阈值抄自 board 的常量，
 *      两边会漂移。只说"心跳已过期"。
 *   ③ **明确给两条正当出路**：重新派工，或**在卡上记一条 record 说明为什么放弃**。
 *      只给第一条会逼出"为了清干净而硬派工"——那是拿动作冒充进展。
 */
export function renderExpiredClaims(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : []
  if (arr.length === 0) return []
  const lines = [
    '⚠ **' + arr.length + ' 张意图卡被认领后就没有人再续约了**（心跳已过期，板面状态仍是 claimed）。',
    '   它们既不在 `open`（新工蜂不会碰），也不会被判为 `unlanded`（对账不会报）——',
    '   也就是说：**目前没有任何机制会重新派工它们，只有人打开板面 UI 才看得见。**',
    '   注意这**不等于**"这些活失败了"：持有者可能只是会话结束了。事实是**没人认领**。',
  ]
  for (const c of arr.slice(0, 10)) {
    lines.push(
      '   · ' + c.id + '　' + String(c.title || '').slice(0, 58) +
        (c.assetId ? '　(asset ' + c.assetId + ')' : ''),
    )
  }
  if (arr.length > 10) lines.push('   · …另有 ' + (arr.length - 10) + ' 张')
  lines.push(
    '   对每一张二选一，**不要留着不动**：',
    '     (a) 重新派工 —— 用 board_objective_claim 重新认领，或在它下面建一条新的子意图接手；',
    '     (b) 放弃 —— 用 board_objective_record 写一条说明原因的记录，再 board_objective_release。',
    '   ⚠ 不许为了把这行字清掉就随便派工或随便收口：**那是拿动作冒充进展**。',
    '',
  )
  return lines
}

/**
 * 命令去向的**唯一**措辞。notify（唤醒消息）与 map_orders（工具）都走这里。
 *
 * ★ 为什么必须共用一个函数：本会话已经因为「两个面各自拼一遍」栽过 ——
 * 展示次序漂移了三次。这里更危险，因为它是**指标口径**：
 * 两个面各写一套，同一件事就有两个说法，而且以后改一处必漏一处。
 *
 * ⚠ 故意不报百分比。地图是当前态势的投影，命令被执行、目的达成后会从名单上消失
 * （实测：给 ⟦op:12⟧ 建了资产卡后 orders 从 10 掉到 9），
 * 于是 landed/orders 会因为「干得好」而变难看。绝对值不骗人，比例会。
 */
export function commandDestinyLine(rep, satisfied, dObj, recursionLine) {
  const objectivesNow = rep.raw ? rep.raw.objectives : rep.counts.objectives
  /* ★★ 第 29 轮：把 landed 拆开报 —— 否则「已落地 0 条」会读成"什么都没发生"，
     而真相可能是"lead 建了 3 张卡、工蜂一条没干"，也可能是反过来。
     这两个数字回答的是**不同的问题**：
       landedByWorkers   = 命令下达给蜂群后、**蜂群真的执行了**几条  ← 判据 1 要看的
       landedHumanFacing = lead/人 把义务记成卡了（≠ 外部动作完成）← 报备类命令
     ⚠ 总数仍然照报（判据 1 的定义没变），只是后面跟一个可分辨的拆分。
     拆分只在**实际有落地**时出现 —— 全是 0 的时候不啰嗦。
     （上一轮我把这两个字段算出来了却没接到任何地方显示 —— 那就是"通道选错了"，
       §6.16.1 记过同一个错。这次接进唯一出口 commandDestinyLine，两个面一起生效。） */
  const wkr = Array.isArray(rep.landedByWorkers) ? rep.landedByWorkers.length : null
  const hum = Array.isArray(rep.landedHumanFacing) ? rep.landedHumanFacing.length : null
  const ext = Array.isArray(rep.landedExternalPending) ? rep.landedExternalPending.length : null
  const split = (rep.counts.landed > 0 && wkr !== null && hum !== null)
    ? '（其中工蜂执行 ' + wkr + '、lead/人 记卡 ' + hum + (ext !== null ? '，依赖外部动作 ' + ext : '') + '）'
    : ''
  return (
    '已落地（板面有带 ⟦op:N⟧ 的卡）' + rep.counts.landed + ' 条' + split +
    '　' + (
      satisfied === null || satisfied === undefined
        /* 「本轮没有名单」不是「都消解了」。数字缺失时**不许**印 0（那是在编），
           也不许印 null（那是把内部哨兵漏给读者）。必须明说"不计"。 */
        ? '已消解（本轮地图无可派命令，不计 —— 缺失不是证据）'
        : '已消解（不再出现在地图上，' + satisfied + ' 条）'
    ) +
    '　仍待落地 ' + rep.counts.unlanded + ' 条' +
    '　│　板面意图卡 ' + objectivesNow + ' 张' +
    (dObj === null ? '' : '（较上次 ' + (dObj > 0 ? '+' : '') + dObj + '）') +
    (recursionLine ? '　' + recursionLine : '')
  )
}

/**
 * 更新跨轮记忆并算出「已消解」。两个面共用，避免各自维护一份记忆。
 *
 * 为什么需要跨轮记忆：地图是**当前**态势的投影，命令被执行、目的达成后会
 * 从名单上消失。跨轮比较必须记住「曾经见过哪些编号」，
 * 否则消解掉的那些会被当成从未存在过（数字静默变好看）。
 *
 * ★★ 2026-11-06（指挥官语义裁定）：
 *    **「地图本轮没有可派命令」≠「此前见过的命令都消解了」。缺失不是证据。**
 *
 *    判据落在**显式布尔** `rep.empty` 上（reconcile 的两个分支都返回它），
 *    **不许**落在可空 / 可空集 / 可空数组的字段上。这里原来是
 *    `new Set(rep.liveKeys || [])` —— 地图安静一轮 `live` 就是空集，
 *    于是 `satisfied` 把**整段历史**一次算成「已消解」，正是本函数注释
 *    自己说要防的那件事（数字静默变好看）。
 *
 *    ⚠ 补 `liveKeys: []` 或 `null` 都治不了它：`|| []` 会把两者折成同一个空集，
 *      修了等于没修（该方案已被否决）。真正起作用的是"名单未知时不产出结论"。
 *
 *    所以名单未知时：`satisfied` **不产出**（null，口径行写"不计"）、
 *    `everSeenKeys` **不写入**、`dObj` 照给（它来自真实计数的 raw，与名单无关）。
 *    并且拿不到那个布尔时 **fail-closed** —— 宁可"没算"，不许"算成全消解"。
 */
/* 名字带 `__` 前缀：与同模块已有的测试/排查专用约定（`__reset` / `__diag` / `__setWakeCount`）
   保持一致。**不要为可测性发明第二种命名法** —— 生产代码里它仍只被 notify / map_orders 调。 */
export function __trackDestiny(rep) {
  /* fail-closed：`rep.empty` 不是布尔，就当作"名单状态未知"，不产出 satisfied。 */
  const rosterKnown = !!rep && rep.empty === false
  const objectivesNow = rep && rep.raw && typeof rep.raw.objectives === 'number'
    ? rep.raw.objectives
    : (rep && rep.counts && typeof rep.counts.objectives === 'number' ? rep.counts.objectives : null)

  if (!rosterKnown) {
    diag.rosterNote = rep && rep.empty === true
      ? '本轮地图没有可派命令 → 名单为空，satisfied 不产出（缺失不是证据）'
      : 'rep.empty 不是布尔（收到 ' + String(rep && rep.empty) + '）→ 名单状态未知，satisfied 不产出（fail-closed）'
    const dObj = (objectivesNow === null || lastObjectives === null) ? null : objectivesNow - lastObjectives
    if (objectivesNow !== null) lastObjectives = objectivesNow
    diag.everSeen = everSeenKeys.size
    diag.satisfied = null
    diag.dObjectives = dObj
    return { satisfied: null, dObj, objectivesNow }
  }

  diag.rosterNote = ''
  /* 名单已知 ⇒ liveKeys 必须存在。这里**故意不写 `|| []`**：静默兜底正是上一个缺陷的成因，
     契约被破坏时要吵，不要悄悄折成空集。 */
  const live = new Set(rep.liveKeys)
  for (const k of live) everSeenKeys.add(k)
  const satisfied = [...everSeenKeys].filter((k) => !live.has(k)).length
  const dObj = (objectivesNow === null || lastObjectives === null) ? null : objectivesNow - lastObjectives
  if (objectivesNow !== null) lastObjectives = objectivesNow
  diag.everSeen = everSeenKeys.size
  diag.satisfied = satisfied
  diag.dObjectives = dObj
  return { satisfied, dObj, objectivesNow }
}

/**
 * 未落地命令的**展示次序**。notify（唤醒消息）与 map_orders（工具）共用这一个，
 * 免得两个面各自排一遍然后漂移。
 *
 * ★ 为什么排序不是小事（第 10 轮实测踩了三次，每次都栽在同一个毛病：排序键选错）
 * ------------------------------------------------------------------------------
 * 内联上限 4 条，所以次序决定 lead 这一轮**看到什么**。
 *   ① 一开始把 `assault` 直接拼在最前 → 三条只有占位地址的突击线把 ⟦op:18⟧
 *      挤出内联，而它是当时唯一地址取到真入口、能一路做到步骤 2 的命令。
 *   ② 改成「地址可信优先」→ rank 1..4 的四条报备把 assault 整个埋掉。
 *   ③ 改成「assault 但地址待解析降到第 2 档」→ 又一次埋掉 assault，
 *      因为线上那三条突击线**恰好都是** derivedAddress=true。
 *
 * 第三次之后想清楚了：**顺序键要跟「稀不稀缺」对齐，不是跟「完不完整」对齐。**
 * 线上 16 条 readyToFile 里只有 3 条 assault —— 它是稀缺的新增分数来源；
 * 而「地址可信的文书线」有 10 条，多得很，晚一轮看到没有任何损失。
 * 所以车道是**主键**，地址完整度只在同车道内做次级键。
 *
 * 分档：
 *   0 突击线 + 地址可信（能一次做完，最理想）
 *   1 突击线 + 地址待解析（仍是唯一新增分数入口，只是要先解析地址）
 *   2 地址可信的可执行项（文书线为主，含把已有成果「变现」的 cash-in-*）
 *   3 其余可执行项
 *   4 需人裁定（lead 自己做不了；排最后但**不隐藏**）
 *
 * 判据说明：`executor` 是提示性的（"lead / 人" 只是说该谁做），
 * **真正的硬门是 `needsHuman`** —— 它来自决策层，表示引擎明确判定
 * 「这不是机器该决定的事」。所以只按 needsHuman 分档，不看 executor 字面值。
 */
export function orderForDisplay(rep) {
  const tier = (e) => {
    if (e.needsHuman) return 4
    if (e.lane === 'assault') return e.derivedAddress ? 1 : 0
    return e.derivedAddress ? 3 : 2
  }
  return [...rep.unlanded].sort((a, b) => {
    const d = tier(a) - tier(b)
    if (d !== 0) return d
    /* ★★ 第 31 轮：同档内**先看这条能不能开分**，再看地图给的 rank。
     *
     * 为什么必须加这一级：内联只有 INLINE_LIMIT=4 格，而实测 rank 1-5 全是
     *   `blocker-report` / `blocker-ledger`（executor='lead / 人'，外部平台动作）
     * —— 于是**前 4 格全被"人做的事"占满，能开分的 cash-in-* 一条都没展开**。
     * 指挥员看到的第一屏是"要么去平台报备、要么建台账"，看不到分在哪。
     *
     * 判据：`score.upper > 0`（有可兑现的上界），并且不是 triage 那类（上界恒 0）。
     * 同档内排序：有分且上界大的在前 → 其余按地图给的 rank。
     *
     * ⚠ 这一级**只在同一 tier 内**生效：tier 的语义（needHuman / 车道 / 地址完整度）
     *   优先级一个都没动。也就是说这**不是**重排地图的决策，只是同一档内先展示更有价值的。 */
    const s = (x) => {
      const sc = x.score
      if (!sc || sc.span === 'triage') return -1
      return typeof sc.upper === 'number' ? sc.upper : -1
    }
    const sa = s(a), sb = s(b)
    if (sa !== sb) return sb - sa
    return (a.rank || 0) - (b.rank || 0)
  })
}

export function apply(ctx, config = {}) {
  const hiveRoot = process.env.HIVE_ROOT || config.hiveRoot || '<HOME>/.hive'
  const doctrineRoot = config.doctrineRoot || '<HOME>/.dsh/doctrine'

  /* preset 根 = 本文件位置向上三层。
   *
   * 文件在 <preset>/plugins/<bridgeN>/lib/index.js：
   *   import.meta.dirname = <preset>/plugins/<bridgeN>/lib
   *   ..                 = <preset>/plugins/<bridgeN>
   *   ../..              = <preset>/plugins
   *   ../../..           = <preset>
   *
   * ⚠ 这里一开始用 createRequire(import.meta.url).resolve('./package.json') 定位，
   *   挂载直接失败：`Cannot find module './package.json'`。loader 的模块解析不接受
   *   这种写法。纯 path 运算没有这个问题，也不需要 node:module 的额外依赖。
   *
   * ⚠ 但「向上三层」只对**部署在 preset 里**的那份成立。权威源码在
   *   artifacts/hive-bridge/ 下，从那里跑测试时向上三层得到的是 artifacts —— 找不到地图。
   *   所以 presetRoot 必须可以显式覆盖：HIVE_BRIDGE_PRESET_ROOT 或 config.presetRoot。
   *   这不是为了测试方便而已：部署位置本来就该是可配的，写死路径是隐藏耦合。
   *   只提供这一个覆盖口 —— 地图根默认就是 preset 根下的 plugins/opsmap*，
   *   再开第二个口子会各自漂移，最后谁都不准。 */
  const presetRoot = path.resolve(
    process.env.HIVE_BRIDGE_PRESET_ROOT || config.presetRoot || path.join(import.meta.dirname, '..', '..', '..'),
  )

  let engine = null
  const engineErrors = []
  /* ★ 候选为空时的现场（2026-11-06 定因那一轮加的）。
   *
   * 病根不在文案本身，在**信息量**：原文「没找到任何 opsmap* 插件目录」对两种
   * 完全不同的情况打同一句话 ——
   *   · 目录真的不存在/没装      → 该去查部署
   *   · 目录在、叫 opsmap-1793867164181，但匹配模式没认出它 → 该去改代码
   * 那一轮只能靠读 `engineCandidates` 的源码才把两者分开，多花了一整轮。
   * 所以未命中候选时把现场摊进 detail：扫了哪个 pluginsRoot、看到几个目录名、
   * 其中几个是 opsmap 前缀（以及它们为什么没被选中）。 */
  let engineScanNote = ''

  /** 候选为空的现场说明。只在「一个候选都没有」时算 —— 有候选但导入失败时
   *  engineErrors 已经带着路径与异常原文，那才是更有用的信息。 */
  async function explainEmptyCandidates() {
    const pluginsRoot = path.join(presetRoot, 'plugins')
    let names = []
    try {
      names = await fsp.readdir(pluginsRoot)
    } catch (e) {
      return '扫描目录不可读（可能不存在）：' + pluginsRoot + ' · ' + String((e && e.message) || e)
    }
    const like = names.filter((n) => /^opsmap/i.test(n))
    /* ⚠ 这里是**文案**，不是判据：正则写成字面量只为让人一眼看出该改哪一处。
     *   真正的匹配在 reconcile.js 的 engineCandidates —— 两处不同步就会再次说谎。 */
    return '已扫描 ' + pluginsRoot + '（' + names.length + ' 个目录名）' +
      (like.length
        ? '：opsmap 前缀 ' + like.length + ' 个（' + like.slice(0, 6).join('，') +
          (like.length > 6 ? ' …' : '') + '），但都不匹配 /^opsmap-?(\\d*)$/ 或缺 lib/index.js'
        : '：没有任何 opsmap 前缀目录')
  }

  async function loadEngine() {
    if (engine !== null) return engine
    engineErrors.length = 0
    engineScanNote = ''
    const candidates = engineCandidates(presetRoot, process.env.HIVE_MAP_ENGINE)
    /* 「空候选」是**什么都没试**，不是「试过都失败」—— 这两种情形以前打同一句话。 */
    if (candidates.length === 0) engineScanNote = await explainEmptyCandidates()
    for (const p of candidates) {
      try {
        const mod = await import('file://' + p.replace(/\\/g, '/'))
        if (typeof mod.refresh === 'function') {
          engine = mod
          diag.enginePath = p
          return engine
        }
        engineErrors.push(p + '：没有导出 refresh')
      } catch (e) {
        engineErrors.push(p + '：' + String((e && e.message) || e))
      }
    }
    return null
  }

  async function reconcile() {
    if (engine === null) await loadEngine()
    if (engine === null) {
      return {
        ok: false,
        reason: 'engine-unavailable',
        detail: engineErrors.length
          ? engineErrors.join(' ； ')
          : '没找到任何 opsmap* 插件目录' + (engineScanNote ? '（' + engineScanNote + '）' : ''),
      }
    }
    return reconcilePure({ engine, hiveRoot, doctrineRoot, enginePath: diag.enginePath })
  }

  /* ★★ 第 34 轮：把「会话总量硬顶」改成**时间窗配额**。
   *
   * 修前的实际语义（读代码得出，不是读注释）：`wake.count++` 只加**从不清零**，
   * 所以 `MAX_WAKES_PER_SESSION` 是一个**终身**上限 ——
   * 12 次 × 5 分钟兜底周期 ≈ **一两小时之后桥接就永久闭嘴**。
   *
   * 而目标的原话是「实现**长时间**复杂任务循环执行」。一个驱动长循环的机制，
   * 偏偏在跑了一两小时之后停止驱动 —— 方向是反的。
   *
   * ⚠ 更要命的是**文档自相矛盾**（这也是缺陷的一部分）：
   *   · 头注释 L84-87 明确说「改成『板面没动才算连击』……加了一层语义而行为零变化，
   *     是纯复杂化，又删掉了」—— 即**没有做**连击语义
   *   · 而 L501-503 却写着「板面在动 → 连击清零 → 永远叫得动」
   *   两处注释互相打架，代码谁也没实现。下一个人读哪一处都会得出错误结论。
   *
   * 修法（保住设计意图，只改计数的窗口）：
   *   `WINDOW_MS` 内最多 `MAX_WAKES_PER_WINDOW` 次；窗口过期后重置。
   *   · 病理想防的「板面一直在变、消息一条接一条」照样被限住在 12 次/小时以内
   *   · 长循环可以一直跑下去（这正是目标要的）
   *   · 变化门仍是防重复唠叨的主力，这一点一个字没动
   *
   * 并且**到顶要吵**：「彻底闭嘴」是最坏的失败模式 ——
   * 它和「一切正常」在表面上完全一样。所以到顶时记一个显式诊断字段，
   * 且让下一次真正该发的通知**优先送出一条"配额到顶"的说明**（见 notify）。 */
  const wake = { lastAt: 0, lastSignature: null, count: 0, windowStart: 0, engaged: new Set() }
  /* 时间窗配额：每 WINDOW_MS 最多 MAX_WAKES_PER_WINDOW 次唤醒 */
  const WINDOW_MS = 60 * 60 * 1000
  const MAX_WAKES_PER_WINDOW = 12
  /** 当前窗口内已用配额（窗口过期则重置 —— 这是与修前**唯一**的行为差异）。
   *  ⚠ 两处坑我都踩过，写下来免得重犯：
   *    ① `windowStart` 初值是 0，它是**哨兵**而不是"很久以前"。
   *       第一版直接 `now - 0 >= WINDOW_MS` 判断，于是第一次调用就把窗口
   *       误判成"早已过期"，`resetsInMs` 算出一个巨大负数。
   *    ② 测试钩子 `__wakeCountOverride` 若在**设窗口之前**就 return，
   *       窗口起点永远是 0 → `resetsInMs` 恒为 0（实测就这么红的）。
   *       所以开窗必须与"读计数"分开：先保证窗口已开，再决定返回什么计数。 */
  function ensureWindow(now) {
    if (wake.windowStart === 0 || now - wake.windowStart >= WINDOW_MS) {
      wake.windowStart = now
      wake.count = 0
    }
  }
  function wakesInWindow(now) {
    ensureWindow(now)
    if (__wakeCountOverride !== null) return __wakeCountOverride
    return wake.count
  }
  /** 记一次唤醒。窗口的开/关统一由 ensureWindow 负责。 */
  function noteWake(now) {
    ensureWindow(now)
    wake.count++
    diag.wakes = wake.count
    diag.wakesWindowStart = new Date(wake.windowStart).toISOString()
  }
  /** 距窗口恢复还有多久（至少 0）。 */
  function quotaResetsIn(now) {
    if (wake.windowStart === 0) return 0
    return Math.max(0, wake.windowStart + WINDOW_MS - now)
  }
  /* 把"拨回窗口"的能力挂给模块级钩子（见 __resetQuotaWindow 的注释）。
     ⚠ 也必须在 __reset 里清掉，否则上一个 harness 的闭包会残留到下一条用例。 */
  __resetQuotaWindowImpl = function () {
    wake.windowStart = 0
    wake.count = 0
    /* ⚠ 也必须清掉 `__wakeCountOverride`。
       它是**测试钩子**，用来把"已用配额"抬到上限；而这个函数的语义是
       「时间过去了一个窗口」。窗口过去了，`__setWakeCount(12)` 模拟的
       "本窗口已用满"就不再成立 —— 不清它的话，恢复阶段仍会被挡，
       现象是"超时等待：窗口恢复后的唤醒"（实测踩到）。
       这不是为了让测试通过而放水：留着它模拟的就是一个**自相矛盾的状态**
       （窗口已重置，却还记着"本窗口已用满 12 次"）。 */
    __wakeCountOverride = null
    /* 同理清 lastAt —— 一小时当然跨过了 180 秒最小间隔。 */
    wake.lastAt = 0
    diag.wakes = 0
    diag.quotaExhausted = null
  }

  /**
   * 全部"根"会话（非 subagent），按 id 字典序稳定排序。
   *
   * ★★ 第 24 轮修正 —— 这是一个**真实的静默错投递缺陷**，不是理论风险。
   *
   * 修前：
   *   · findLead() 取 leads[0]（字典序最小）**只取一个**
   *   · guard 里要求 `findLead().id === 调用者 id` 才把调用者塞进 wake.engaged
   *   · notify 又只在 `findLead()` 那一个会话上判 engaged
   *
   * 三条连起来的后果，取决于实际有几个根会话：
   *   只有一个根会话 → 它与 findLead() 是同一个 → 正常。**这就是初始设计假设。**
   *   多个根会话     → 只有字典序最小的那个解锁得了；其余会话用再多工具也解不开
   *                    （guard 里那个相等判断对它们恒为假）。
   *                    更糟的是 notify 会把通知 steer 给字典序最小那个 ——
   *                    而真正在跟指挥员对话的可能不是它。
   *
   * **错投递比不发送更坏**：收件人是错的，谁都不会发现自己漏了消息。
   * 实测本机 `.dsh/sessions` 下有 3 项 —— 多根是现实场景，不是假想。
   *
   * 修法：保留"engaged 门控"这个**设计意图**（人没开口不开第一轮），
   * 但把"哪个会话"的判断改成"**哪个根会话真的用过工具**"：
   *   ① 全体根会话都参与 engaged 记录（guard 不再要求是最小 id 那个）
   *   ② notify 优先投给**已 engaged 的根会话**
   *   ③ 一个都没有 engaged 时退回字典序最小（保持原行为，也保持 no-lead 语义）
   */
  function rootSessions() {
    if (typeof ctx.get !== 'function') return []
    const agents = ctx.get('agents')
    if (!agents || typeof agents.list !== 'function') return []
    let list
    try {
      list = agents.list()
    } catch {
      return []
    }
    if (!Array.isArray(list)) return []
    const roots = list.filter((a) => a && String(a?.session?.header?.origin ?? '') !== 'subagent')
    roots.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    return roots
  }

  /** 兼容原签名：默认返回字典序最小的根会话（无人 engaged 时的行为不变）。 */
  function findLead() {
    const roots = rootSessions()
    for (const r of roots) if (wake.engaged.has(String(r.id))) return r
    return roots[0]
  }
  /** 是否是根会话（guard 用它决定要不要记 engaged）。 */
  function isRoot(id) {
    return rootSessions().some((r) => String(r.id) === String(id))
  }

  /* ── 空闲门：lead 正在跑回合时不注入 ───────────────────────────────────
   *
   * 与 board2 的 patrol 门同源、同一理由（第 37 轮）：`lead.steer()` 进的是
   * next-step inbox，回合中到达会在步骤之间被领取，而 agent loop **没有回合
   * 预算** —— 每领取一次就把当前回合再延长一步。
   *
   * 实测：某个战争会话 53 个回合里有 8 个是「地图周期对账」唤醒开的，
   * 另一个 229 个回合里有 31 个。它们本身是必要的，但不该插在 lead 干活的
   * 时候插进来 —— 那既拖长回合，也让用户自己的消息抢不到回合边界。
   *
   * 判据：宿主 `agent/status` 事件（idle ⇄ running）。拿不到状态时不拦 ——
   * 宁可多发一次，也不要让对账彻底停摆。
   */
  const leadStatus = new Map()
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('agent/status', (payload) => {
        try {
          const id = String(payload?.agent?.id ?? '')
          const status = String(payload?.status ?? '')
          if (id !== '' && status !== '') leadStatus.set(id, status)
        } catch {
          /* 状态跟踪绝不许影响对账 */
        }
      })
    }
  } catch {
    /* ctx.on 不可用则退化为"永远不拦" */
  }

  /** true = lead 正在跑回合，此刻不该注入。 */
  function leadIsBusy(lead) {
    try {
      const direct = lead?.status ?? lead?.state
      if (typeof direct === 'string' && direct !== '') return direct === 'running'
    } catch {
      /* fall through to the tracked map */
    }
    return leadStatus.get(String(lead?.id)) === 'running'
  }

  async function notify(rep, trigger) {
    const lead = findLead()
    /* 投递诊断：每次 notify 都刷新，出问题时一眼看得出"为什么是这个会话"。 */
    try {
      diag.roots = rootSessions().map((r) => String(r.id))
      diag.engaged = [...wake.engaged]
      diag.target = lead === undefined ? null : String(lead.id)
    } catch { /* 诊断本身绝不许影响主流程 */ }
    /* ★★ 第 36 轮：没有落差就是**没有话说**，静默。
     *
     * 实测缺陷：未落地命令为 0 时，这条通知仍然会发出去，正文是
     *   「作战地图已下令 19 条，**还有 0 条命令没有任何蜂群能认领的活**。」
     * —— 一句自相矛盾的假警报，还会消耗一次唤醒配额。
     *
     * 为什么必须放在**最前面**（早于 lead/engaged 门控）：
     *   「没什么可说」比「收件人不在」更根本 —— 前者不该发，
     *   后者发不出。顺序反了会让诊断把"无事"报成"门控挡住"。
     *
     * 注意不是只看 unlanded：僵死认领（心跳过期、没人续约）即使
     * 全部命令都已落地也仍然值得说一声，所以两件都空才闭嘴。 */
    const expiredN = Array.isArray(rep.expiredClaims) ? rep.expiredClaims.length : 0
    if (Number(rep.counts && rep.counts.unlanded) === 0 && expiredN === 0) {
      return { sent: false, why: 'nothing-to-say', unlanded: 0, expired: 0 }
    }

    if (lead === undefined) return { sent: false, why: 'no-lead' }
    if (!wake.engaged.has(String(lead.id))) return { sent: false, why: 'lead-not-engaged' }
    /* ★ 空闲门：lead 正在跑回合时不注入。
       放在这四道门控之后、节流之前 —— 因为它回答的是「现在能不能说」，
       而不是「该不该说」：落差没变、配额没用完，只是此刻时机不对。
       不更新 wake.lastAt / lastSignature，所以下一轮 sweep 会重试。 */
    if (leadIsBusy(lead)) return { sent: false, why: 'lead-busy' }

    const now = Date.now()
    /* ── 顺序很重要，每一步都在回答一个不同的问题 ──
       ① 签名没变     → 「没有新东西可说」，直接闭嘴（**不消耗配额**）
       ② 最小间隔     → 「刚说过，缓缓」
       ③ 窗口配额到顶 → 「这一小时说够了，等窗口过去」
       ④ 没有 lead / 人没开口 → 门控
       顺序不能乱：①② 都是"不该说"，放前面才不会白白吃掉配额。 */
    if (rep.signature === wake.lastSignature) return { sent: false, why: 'signature-unchanged' }
    if (now - wake.lastAt < MIN_WAKE_INTERVAL_MS) return { sent: false, why: 'throttled' }
    /* ★★ 第 34 轮：这里的语义修正见文件头 MAX_WAKES_PER_WINDOW 的注释。
     *
     * 修前（读代码得出的**实际**语义，不是注释说的）：`wake.count++` 只加不清零，
     * 所以那是个**终身**上限 —— 一两小时后桥接永久闭嘴，与「长时间循环」反着来。
     * 而这一段的注释还写着「板面在动 → 连击清零 → 永远叫得动」，与文件头那段
     * （明确说连击语义"删掉了"）互相矛盾，代码谁也没实现。
     *
     * 现在统一成**时间窗**：
     *   · 病理想防的「消息一条接一条」照样被限在每窗口 12 次以内
     *   · 长循环可以一直跑下去
     *   · 到顶**不静默**：记 diag.quotaExhausted（含恢复倒计时）
     * 配额只在"签名变了、节流也过了、正准备开口"这一处消耗 —— ①② 两条
     * "不该说"的分支不许吃配额，否则配额会以"没开口"的速度消失。 */
    /* ★★ 第 34 轮：配额改成**时间窗**（见上面 WINDOW_MS 的注释）。
       修前这里是终身上限 —— 一两小时后永久闭嘴，与「长时间循环」反着来。
       到顶时不再只是静默返回：记一个显式诊断字段，并在下一次签名变化时
       优先送出一条说明（否则"停止驱动"与"一切正常"在表面上无法区分）。 */
    const wakesSoFar = wakesInWindow(now)
    if (wakesSoFar >= MAX_WAKES_PER_WINDOW) {
      diag.quotaExhausted = {
        at: new Date(now).toISOString(),
        used: wakesSoFar,
        windowMs: WINDOW_MS,
        resetsInMs: quotaResetsIn(now),
        note: '本窗口（' + Math.round(WINDOW_MS / 60000) + ' 分钟）唤醒配额已用尽，'
          + '期间不再打扰；窗口过后自动恢复。到顶**不是**"没有可做的事" —— '
          + 'map_orders 随时可查，落差也仍然记在 diag.report 里。',
      }
      return { sent: false, why: 'quota-exhausted', resetsInMs: quotaResetsIn(now) }
    }
    diag.quotaExhausted = null

    /* 池子与次序：抽到 orderForDisplay，与 map_orders 共用同一套判据。 */
    const pool = orderForDisplay(rep)
    const inline = pool.slice(0, INLINE_LIMIT)
    const rest = pool.slice(INLINE_LIMIT)

    const lines = [
      '[地图对账·' + trigger + '] 作战地图已下令 ' + rep.counts.orders + ' 条，' +
        /* ★ 第 36 轮：这句话必须随落差有无而变。
           修前无条件拼出「还有 N 条命令没有任何蜂群能认领的活」，N=0 时
           正文变成「**还有 0 条命令没有任何蜂群能认领的活**」——
           一句自相矛盾的假警报。而这条通知在"只剩僵死认领"时仍会发出，
           于是那句 0 会跟着真话一起送到指挥员眼前。 */
        (Number(rep.counts.unlanded) > 0
          ? '**还有 ' + rep.counts.unlanded + ' 条命令没有任何蜂群能认领的活**。'
          : '**命令全部有活认领**（本轮只报僵死认领，见下）。'),
      '',
      '突击线（唯一新增分数来源）未落地 ' + rep.assault.length + ' 条，需人裁定 ' +
        rep.needsHuman.length + ' 条，可机械执行 ' + rep.executable.length + ' 条。',
      '',
    ]

    /* 突击线**逐条列编号**，不靠内联展开。
     *
     * 为什么单独做这件事：内联只有 INLINE_LIMIT 格，而突击线恰好可能占满它 ——
     * 第 4 格永远轮不到第 4 条突击线。结果「唯一能新增分数的车道」会有一部分
     * 藏在「另有 N 条未展开」里。编号列表只有几个字符，把它显式列出来，
     * 无论内联预算多少，lead 都不可能漏掉突击线。
     * （具体措辞与「为什么抽成纯函数」见 renderAssaultIndex。） */
    for (const l of renderAssaultIndex(rep.assault)) lines.push(l)
  /* 人工欠账：与命令分开报，措辞也分开（见 renderHumanQueue 的注释）。
     这一段**不进签名**，所以它不会制造额外唤醒；它只是让每次唤醒都带上
     「还有多少事在等人」这个信息 —— 否则这些事会一直静默挂着。
     ★ 注意用 rep.needsHuman：第 19 轮修之前那个字段永远是空数组。 */
  for (const l of renderHumanQueue(rep.needsHuman)) lines.push(l)

    /* ★★ 第 35 轮：僵死认领。
       与人工欠账并列，但说的是**另一件事**：那些是"人不做就没人做"，
       这些是"该有人做、但持有者早就没续约了，而没有任何机制会重新派工"。
       两条都不进命令落差的分子分母 —— 落差的口径一个字没改。 */
    for (const l of renderExpiredClaims(rep.expiredClaims)) lines.push(l)

    /* ★ 命令去向：把「没干」和「干完了」分开
     *
     * 为什么必须分开（第 11 轮实测发现的指标缺陷）：
     * 地图是一份**当前**态势的投影，不是历史。落地一条命令会让它**从名单上消失** ——
     * 实测：给 ⟦op:12⟧ 建了它要的资产卡之后，orders 从 10 掉到 9，
     * 而且连带 ⟦op:13⟧⟦op:16⟧ 也一起没了（新入口改变了后续态势）。
     *
     * 于是「落地率 = landed/orders」这个指标**自己会骗人**：
     * 它只数仍在名单上的命令里有多少已落地。一条命令被执行、目的达成、
     * 于是离开名单 —— 数字里完全看不到。执行得越好，消失越多，比例反而越难看，
     * 而 0% 既可能是「lead 没动」也可能是「命令全都执行完消失了」。
     * 这两种情况的处置完全相反，标量指标分不清。
     *
     * 所以报三个数：
     *   · 已落地（有锚点）   —— 证据：板面有带编号的卡
     *   · 已消解（名单上没有）—— 说明：命令不再需要，可能是它的目的已达成，也可能是态势变了
     *   · 仍待落地
     * 并且报 Δ 意图卡（净增）—— 这是**最能说明循环在不在转**的一个数，
     * 因为它是绝对值、不受「名单在变」影响。 */
    const { satisfied, dObj } = __trackDestiny(rep)
    lines.push('命令去向：' + commandDestinyLine(rep, satisfied, dObj, ''), '')
    /* 只有「确实什么都没动」时才提示。dObj 为 null 是第一轮（还没有基线可比），
       此时不该说「没净增」—— 那是拿不存在的基线当 0 用。 */
    if (rep.counts.landed === 0 && dObj !== null && dObj <= 0) {
      lines.push(
        '⚠ 注意：既没有带锚点的卡，意图卡也没净增 —— 也就是说**上一轮对账之后板面没有因为这份清单动过**。' +
          '如果这不是因为你在别处干活，那就是落差还挂在那里。',
        '',
      )
    }

    /* D3 观察项：成果有没有衍生出下一步。这一条**不参与**上面的命令落差 ——
       它回答的是另一个问题：循环有没有在长。分开报，避免两个概念混成一个数。

       ★★ 第 31 轮补：这里原来只报「未衍生 N 条」，**没报链深**，
       而 map_orders 那一面报了「链深 2 层」。于是 lead 看到的两个面口径不一致 ——
       通知说"有 46 条没衍生"，工具说"链深 2 层"，读的人无法把它们连起来。
       实测依据：引擎的 recursion 里 maxDepth=2、deepest='find-x8uxay'，
       这些字段一直是可用的，只是这一面没用。

       为什么链深比条数更能说明问题：条数只说明"有多少没衍生"，
       链深说明"**衍生到底有没有真的发生**"。链深 1 = 一层都没往下长；
       链深 ≥2 才叫"循环在长"。这正是判据 4 修订后的口径（见 §4 判据 4）。 */
    const R = rep.recursion
    if (R && R.findings > 0 && R.childlessVerified > 0) {
      const depthNote = (typeof R.maxDepth === 'number')
        ? ('目前链深 ' + R.maxDepth + ' 层' + (R.deepest ? '（最深 ' + R.deepest + '）' : '') +
           (R.maxDepth <= 1 ? ' —— **一层都没往下长**' : ' —— 链条确实在往下长'))
        : '链深：**引擎未提供**（这是保底，不是「0 层」）'
      lines.push(
        '另有一项观察：板面 ' + R.findings + ' 条成果里，**' + R.childless + ' 条没有衍生出任何后续意图**' +
          '（其中已确认 verified 的 ' + R.childlessVerified + ' 条）。' + depthNote + '。' +
          '成果不是终点而是源头：一条已确认的成果如果打开了新地面，应当用 parent_finding_id ' +
          '衍生出子意图，链条才往下长。请对其中已确认的那些做一次判断 —— ' +
          '该衍生的衍生，不该衍生的说明理由即可（profile 类矩阵本来就不衍生，不算欠账）。',
      )
      lines.push('')
    }

    lines.push(
      '以下是**已经算好的 board 调用参数**。地图是参谋部，只出参数不写板面；落地必须由你执行，' +
        '因为板面要求 exec.agent.id 溯源。请照抄参数调用，不要重新规划、不要改写 title/method —— ' +
        '标题里的 ⟦op:N⟧ 是对账锚点，删掉它这条命令就会被永远判为未落地：',
      '',
    )
    inline.forEach((e, i) => {
      lines.push(renderOrder(e, i))
      lines.push('')
    })
    if (rest.length) {
      lines.push(
        '另有 ' + rest.length + ' 条未展开（编号：' + rest.map((e) => e.orderKey).join('、') +
          '）。要完整表就跑一次 opsmap_refresh，或看作战地图页签。',
      )
      lines.push('')
    }
    lines.push(
      '✋ 这是**建议不是授权**：若某条不该落地（例如资产归属待裁定），把它记进对应意图卡的 record ' +
        '说明原因即可，**不要为了消掉落差而建一张空卡**。落地后不需要回复本条消息，对账会自动复核。',
    )

    try {
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm/message')
      lead.steer(
        createUserMessage({
          content: [{ type: 'text', text: lines.join('\n') }],
          source: { kind: 'plugin:hive-bridge', form: 'notice', summary: '地图对账' },
        }),
      )
    } catch (e) {
      return { sent: false, why: 'steer-failed', detail: String((e && e.message) || e) }
    }

    wake.lastAt = now
    wake.lastSignature = rep.signature
    /* ★ 第 34 轮：计数统一走 noteWake（它负责"窗口过期就开新窗"）。
       修前这里是裸的 `wake.count++` —— 只加不清零，于是成了一个**终身**上限。 */
    noteWake(now)
    return { sent: true }
  }

  /* ── 自动派工：通知没人接的时候，造一个指挥席去接 ─────────────────────
   *
   * 判据在 reconcile.js 的 autoDispatchPlan（纯函数，被正反例钉死）。
   * 这里只做有副作用的那半：读开关/台账 → 创建或复用值班会话 → 投递简令 → 记账。
   *
   * ★ 投递口径与 notify 完全一致（同一个 createUserMessage + form:'notice'），
   *   所以两条路径产生的注入在会话日志里长得一样，可以用同一个扫描器统计。
   *   区别只在收件人：notify 给**人**，autoDispatch 给**自己造的值班指挥**。
   */

  const dutyCfg = Object.assign({}, DUTY_DEFAULTS, (config && config.duty) || {})

  /** 读开关文件与派工台账。台账是 append-only JSONL，一行一次派工。 */
  async function readDutyState(now) {
    const st = { off: false, recent: [], lastDispatchAt: 0, now }
    try {
      await fsp.stat(String(dutyCfg.offFile))
      st.off = true
    } catch { /* 文件不存在 = 没关。这是**唯一**被当作"没关"的情形 */ }
    try {
      const txt = await fsp.readFile(String(dutyCfg.ledgerFile), 'utf8')
      for (const line of String(txt).split('\n')) {
        const s = line.trim()
        if (!s) continue
        try {
          const r = JSON.parse(s)
          if (r && Number.isFinite(Number(r.at))) st.recent.push(Number(r.at))
        } catch { /* 坏行跳过：台账坏一行不许拖垮整条链，但也不静默——见下面计数 */ }
      }
      st.recent.sort((a, b) => a - b)
      st.lastDispatchAt = st.recent.length ? st.recent[st.recent.length - 1] : 0
    } catch { /* 台账不存在 = 从没派过 */ }
    return st
  }

  async function appendDutyLedger(rec) {
    try {
      await fsp.appendFile(String(dutyCfg.ledgerFile), JSON.stringify(rec) + '\n', 'utf8')
    } catch (e) {
      /* 台账写不进去**不能**静默：它是预算的依据，写不进去就意味着预算失效，
         自动派工会失去唯一的上限。记进 diag.problem，让人看得见。 */
      diag.problem = '派工台账写入失败（预算将失效）：' + String((e && e.message) || e)
    }
  }

  async function autoDispatch(rep, trigger) {
    const now = Date.now()
    const stamp = new Date(now).toISOString()
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents === undefined || typeof agents.create !== 'function') {
      diag.lastDispatch = { at: stamp, trigger, ok: false, why: 'no-agents-service' }
      return
    }

    let st
    try {
      st = await readDutyState(now)
    } catch (e) {
      diag.lastDispatch = { at: stamp, trigger, ok: false, why: 'state-read-failed', detail: String((e && e.message) || e) }
      return
    }
    /* 有指挥员在场上就**不抢它的活** —— 与 notify 的门控同源。
       两处用同一判据（findLead + wake.engaged），所以不会出现
       "notify 说没人接、autoDispatch 说有人接"这种自相矛盾。 */
    try {
      const l = findLead()
      st.leadEngaged = l !== undefined && wake.engaged.has(String(l.id))
    } catch { st.leadEngaged = false }

    const plan = autoDispatchPlan(rep, st, dutyCfg)
    if (!plan.go) {
      diag.lastDispatch = { at: stamp, trigger, ok: false, why: plan.why, note: autoDispatchWhy(plan) }
      return
    }

    const agentId = String(dutyCfg.agentId)
    /* ⚠ 用**假值**判断，不是 `=== undefined`。
       契约说 agents.get() 查不到时返回 undefined，但实现也可能给 null ——
       判 `=== undefined` 时 null 会穿过去，紧接着 `ag.steer` 抛 TypeError，
       整条 sweep 被 catch 吞成一句 diag.problem，
       表现为"自动派工装上了但永远不动作"（第 38 轮在看门狗里实测到同一形态）。 */
    let ag = agents.get(agentId)
    let created = false
    if (!ag) {
      try {
        const handle = await agents.create({
          sessionId: agentId,
          meta: {
            agentPreset: String(dutyCfg.agentPreset),
            cwd: String(dutyCfg.cwd),
            origin: 'subagent',
          },
        })
        ag = (handle && handle.agent) || agents.get(agentId)
        created = true
      } catch (e) {
        diag.lastDispatch = { at: stamp, trigger, ok: false, why: 'create-failed', detail: String((e && e.message) || e) }
        return
      }
    }
    if (!ag || typeof ag.steer !== 'function') {
      diag.lastDispatch = {
        at: stamp, trigger, ok: false, why: 'create-failed',
        detail: 'agents.create 未报错，但注册表里要么查不到 ' + agentId + '，要么它没有 steer 方法',
      }
      return
    }

    const brief = renderDutyBrief(plan, rep, trigger)
    try {
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm/message')
      ag.steer(createUserMessage({
        content: [{ type: 'text', text: brief }],
        source: { kind: 'plugin:hive-bridge', form: 'notice', summary: '值班指挥席·派工' },
      }))
    } catch (e) {
      diag.lastDispatch = { at: stamp, trigger, ok: false, why: 'steer-failed', detail: String((e && e.message) || e) }
      return
    }

    await appendDutyLedger({
      at: now, trigger, agentId, created,
      orders: plan.orders.map((e) => e.orderKey),
      total: plan.total, withheld: plan.withheld,
    })
    diag.dutyAgentId = agentId
    diag.lastDispatch = {
      at: stamp, trigger, ok: true, agentId, created,
      orders: plan.orders.map((e) => e.orderKey), withheld: plan.withheld,
    }
  }

  async function sweep(trigger) {
    try {
      const rep = await reconcile()
      if (!rep.ok) {
        diag.problem = rep.reason + '：' + rep.detail
        diag.lastNotify = { at: new Date().toISOString(), trigger, sent: false, why: rep.reason }
        return
      }
      diag.problem = ''
      diag.report = rep
      if (rep.empty) {
        diag.lastNotify = { at: new Date().toISOString(), trigger, sent: false, why: 'no-orders' }
        return
      }
      const r = await notify(rep, trigger)
      /* ★ 无论 notify 走哪条分支都要记录结果 —— 早先只在「真的发了」之后记录，
         于是「被 engaged 门控挡住」这类分支在诊断里完全看不见，
         测试与人工排查都会误判成「什么都没发生」。 */
      diag.lastNotify = { at: new Date().toISOString(), trigger, ...r }

      /* ★★ 第 36 轮：通知没送到**人**手上时，自己造一个指挥席去接。
       *
       * 只在这两种 why 触发，因为它们精确地表示「收件人不在场」：
       *   no-lead            场上连根会话都没有
       *   lead-not-engaged   有根会话，但没人开口过（最常发生的那种）
       *
       * 其它 why **一律不触发**，这一点是刻意的：
       *   signature-unchanged / throttled / quota-exhausted 表示「不该说」，
       *   不是「没人接」。把它们混进来会让自动派工在该闭嘴的时候反而动起来，
       *   而那正是失控循环的入口。
       *
       * 自动派工自己还有两道闸（冷却 20 分钟、每窗口 3 次）与一个人工开关，
       * 见 reconcile.js 的 autoDispatchPlan。 */
      if (!r.sent && (r.why === 'no-lead' || r.why === 'lead-not-engaged')) {
        if (dutyCfg.enabled === true) await autoDispatch(rep, trigger)
        else diag.lastDispatch = { at: new Date().toISOString(), trigger, ok: false, why: 'disabled' }
      }
    } catch (e) {
      diag.problem = 'sweep-failed：' + String((e && e.message) || e)
    }
  }

  /* ── 手动对账工具：lead 可随时问「地图的命令落地情况」 ──
   *
   * ⚠ 本地插件注册工具必须走 `ctx.tools.register(defineTool({...}))`，
   *   而且 **`output: { schema, render }` 是必填的** —— 少了它挂载直接失败：
   *     tool "map_orders" must declare output { schema, render, presentationMeta? }
   *   （board 插件的 register 助手就是同一个形状，见 board/lib/index.js:572） */
  ctx.tools.register(
    defineTool({
      name: 'map_orders',
      description:
        '对账作战地图的命令与板面的活：给出「地图已下令，但板面上没有任何蜂群能认领的活」的命令' +
        '及其已经算好的 board_* 调用参数。地图是参谋部只出参数，落地必须由 lead ' +
        '执行（板面要求 exec.agent.id 溯源）。巡检消息提示「还有 N 条命令没有活」时用它拿完整参数。' +
        '注：不报「落地率百分比」—— 命令被执行后会从地图上消失，比例会骗人，所以只报绝对数。',
      parameters: {
        full: {
          type: 'boolean',
          description: 'true 则展开全部未落地命令的完整参数（默认只展开前 ' + INLINE_LIMIT + ' 条）。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const rep = await reconcile()
        if (!rep.ok) return 'ERROR: 对账失败（' + rep.reason + '）：' + rep.detail
        if (rep.empty) return '地图当前没有 readyToFile 的命令（没有可下达的活）。'

        /* 执行率回流（M4）：这条只有桥接能算 —— 地图不许读板面（事实层不依赖决策层），
           所以「地图的命令落地了没有」这个反馈只能由同时看得见两边的桥接来产生。
           
           ⚠ 这里**故意不报「落地率」百分比**。原先报的是 landed/orders，
           而地图是当前态势的投影：命令被执行、目的达成后会**从名单上消失**，
           于是分母缩水、分子留不住 —— 执行得越好比例反而越难看。
           实测例：给 ⟦op:12⟧ 建了它要的资产卡后 orders 从 10 掉到 9。
           绝对值（已落地 N 条 / 意图卡 M 张）不会骗人，比例会。 */
        /* ★ 第 17 轮：这里原来是 `rep.recursion || {findings:0, childless:0, ...}`。
           而引擎**从来没有输出过 recursion 这个键**，所以它不是「保底」，
           而是**永远走保底** —— 这一行从上线起就一直打印
           「成果 0 条（衍生过 0，未衍生 0，其中 verified 0）」。
           那是一个**看起来像数据**的常量：比空白更坏，因为它会让人以为
           「板面真的没有成果」。引擎现已补上该键（opsmap-engine/18）。

           保底本身也不是错的（引擎版本旧时仍要出话），但**必须让人看得出来
           它是保底**，否则又一次静默。所以保底时显式写「（引擎未提供）」。 */
        const R = rep.recursion
        const recursionLine = R
          ? ('成果 ' + R.findings + ' 条（衍生过 ' + R.usedAsParent + '，未衍生 ' + R.childless +
             '，其中 verified ' + R.childlessVerified + '；链深 ' + R.maxDepth + ' 层）')
          : '成果数：**引擎未提供**（payload 里没有 recursion 键 —— 这是保底，不是「0 条成果」）'
        const { satisfied, dObj } = __trackDestiny(rep)
        const head = commandDestinyLine(rep, satisfied, dObj, recursionLine)

        if (rep.unlanded.length === 0) {
          /* ★ 第 35 轮：**早退也必须带僵死认领**。
             「命令全部已落地」恰恰是最容易掩盖问题的一句话 ——
             活建了卡不等于活做完了，而一张被弃在半路的卡正是卡在这里。
             这与本文件里记过的另一处缺陷同类：**早退把统计整个跳过了**。 */
          const tail = renderExpiredClaims(rep.expiredClaims)
          return ['✓ 地图的命令全部已落地。' + head, ...(tail.length ? ['', ...tail] : [])].join('\n')
        }

        const out = [
          head,
          '未落地 ' + rep.counts.unlanded + ' 条（突击线 ' + rep.assault.length + '、可机械执行 ' +
            rep.executable.length + '、需人 ' + rep.needsHuman.length + '）',
          '',
        ]
        for (const l of renderExpiredClaims(rep.expiredClaims)) out.push(l)
        const pool = orderForDisplay(rep)
        const show = args && args.full ? pool : pool.slice(0, INLINE_LIMIT)
        show.forEach((e, i) => {
          out.push(renderOrder(e, i))
          out.push('')
        })
        if (!args || !args.full) {
          const restPool = pool.length - show.length
          if (restPool > 0) {
            out.push('（这个池里另有 ' + restPool + ' 条未展开；用 map_orders full=true 看全部）')
          }
        }
        return out.join('\n')
      },
    }),
  )

  /* 记录「lead 开口」：与 board 的 engaged 门控对齐。
   *
   * ⚠ ToolGuard 是**同步**的：registry 调 guard(exec) 后立刻读返回值，所以它绝不能
   *   await、也绝不能碰文件系统（board 的注释写得很清楚）。这里只往 Set 里塞一个 id。
   * ⚠ 用 ctx.effect 包住，卸载时 guard 才会被摘掉。 */
  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        try {
          const id = exec?.agent?.id
          if (id === undefined) return undefined
          /* ★★ 第 24 轮修正：原来是 `findLead().id === id` 才记录 ——
             那等于"只有字典序最小的那个根会话能解锁"。多根会话时，
             其余会话用再多工具也不会被记进 engaged，于是永远收不到巡检。
             现在改成"**任何根会话**用过工具都记"：门控的设计意图是
             '人没开口不开第一轮'，而不是'只认某一个特定会话'。 */
          if (isRoot(id)) wake.engaged.add(String(id))
        } catch {
          /* guard 里绝不允许抛：抛了会挡住用户的真实工具调用 */
        }
        return undefined
      }),
    'tools.guard(hive:bridge-engaged)',
  )

  /* 周期兜底 + 首检。timer 是 Cordis 的可 dispose 助手，随 fiber 卸载而清除。 */
  const timer = ctx.get('timer')
  if (timer && typeof timer.timeout === 'function') {
    ctx.effect(
      () => timer.timeout(() => void sweep('首次对账'), FIRST_CHECK_DELAY_MS),
      'hive-bridge:first-check',
    )
  }
  if (timer && typeof timer.interval === 'function') {
    ctx.effect(() => timer.interval(() => void sweep('周期对账'), SWEEP_INTERVAL_MS), 'hive-bridge:sweep')
  }

  /* 卸载时放开引擎引用，避免 reload 后仍持有旧模块。 */
  ctx.effect(
    () => () => {
      engine = null
      diag.report = null
    },
    'hive-bridge:release-engine',
  )
}

export default { name, apply, inject }
