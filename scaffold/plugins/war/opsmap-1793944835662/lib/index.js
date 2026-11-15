/**
 * 作战地图 —— 宿主半边（本地插件版）
 *
 * 这个文件是**手写**的；`opsmap-engine.js` 才是从权威源码生成的，不要手改那个。
 *
 * 职责：读板面+军法+目标+靶标清单，跑完整条判决链，注册一个模型可调用的工具
 *      `opsmap_refresh`，返回一句话摘要。完整地图（约 370KB payload）是给人看的，
 *      由浏览器半边渲染进会话的「作战地图」页签。
 *
 * ★ payload 的键集（2026-10-23 更正）
 *
 *   原文写的是：「payload 的结构必须与权威源码 `artifacts/opsmap/v14.host.js`
 *   的 load-board 逐键一致（… 共 16 键）。验证器 `verify_opsmap_preset.mjs`
 *   会逐键比对，少一个键就会红。」
 *
 *   ⚠ **这三句现在都是错的，实测**：
 *     · `artifacts/opsmap/v14.host.js` —— 查遍 ~/.dsh **不存在** ✗
 *     · `verify_opsmap_preset.mjs` —— 查遍 ~/.dsh **不存在** ✗（那份安全网从来没有过）
 *     · 「共 16 键」—— 真实 payload 是 **20 键**（多出 goal / recursion / kb / cop，
 *       都是后续几轮加上去的）
 *
 *   所以：**那 16 个键是一份失去出处的旧契约**。它没有被删，而是当成回归护栏留着 ——
 *   `probe-inline-size.mjs` 会断言这 16 个键一个不少（少一个就红），其余 4 个只报不判。
 *   换句话说：**护栏现在是真存在的**，只不过不是原注释指的那个东西。
 *
 *   旧句留在上面而不是删掉，是因为「按那句话去找会找不到」这件事本身值得记住。
 *
 * ⚠ 不能用 `harness.defineTool` / `harness.handle`：`harness` 是**动态 Cordis 插件专用**
 *   的宿主内建，本地插件里没有。挂载时会报 `harness is not defined`。
 *   本地插件取服务走 `inject: [...]` + `ctx.<service>`，注册工具走 `ctx.tools.register`。
 *
 * ⚠ 本文件出过一次事故：用 PowerShell 的 Set-Content 改它，把 UTF-8 中文写成了乱码
 *   （GBK 读入 → UTF-8 写出），而编辑工具又因为内容已变无法匹配替换，只得整份重写。
 *   教训：**改含中文的源码一律走编辑工具或 Node，不要用 PowerShell 读写文本。**
 */
import fsSync, { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  BOARD_DIRS,
  CHARTER_ROOT,
  DOCTRINE_ROOT,
  HIVE_ROOT,
  TARGETS_FILE,
  buildDispatch,
  buildExclusions,
  buildLedger,
  buildModel,
  buildSchwerpunkt,
  buildSwarmView,
  computeMetrics,
  computeRecursion,
  criteriaStatus,
  evaluateIntel,
  listBoard,
  loadCharter,
  loadDoctrine,
  loadKbCards,
  loadTargets,
  matchKbCards,
  translateBoardTermsToVulns,
  matchUnits,
} from './opsmap-engine.js'

export const name = 'opsmap'

/** 硬依赖工具表：注册不了工具就没有存在意义。 */
export const inject = ['tools']

/** 默认根路径；组合里可用 config 覆盖（hive 与 opsmap 两个 preset 都挂了 config.hiveRoot）。 */
const DEFAULTS = {
  hiveRoot: HIVE_ROOT,
  doctrineRoot: DOCTRINE_ROOT,
  charterRoot: CHARTER_ROOT,
  targetsFile: TARGETS_FILE,
  /* 观测口：每次刷新后把结论摘要写到这里，供**看门狗**读取。
     为什么需要它：地图是**拉取式**的 —— 没人调 opsmap_refresh 就不存在地图，
     而指挥官要的是「随时能看到」。地图自己做不到心跳，但看门狗可以
     发现「地图多久没刷新了」以及「地图建议 vs 实际可见」的落差。
     没有这个文件，那两件事谁都不知道。
     ⚠ 写的是**观测文件**，不是板面 —— 与「地图只读、不写板面」不冲突。 */
  statusPath: '<HOME>/.dsh/opsmap.status.json',
  /* 完整卡片（未裁剪）按**目标**分文件落盘，供浏览器页签经 HTTP 读取。
   *
   * ★ 这是「数据不再走对话通道」的落点。
   *   原来页签读的是对话里那份工具结果，而它对**两个**机制都脆弱：
   *     · DSH 的溢出策略（内联超过 maxInlineBytes 就截成头+尾）—— 已修
   *     · 工具结果的裁剪/压缩（结果被压掉后页签会显示"还没有刷新过"）
   *   而且裁剪是必须的：44KB 的卡片每轮都进上下文，代价太大。
   *   于是**两个通道各取所需**：对话里放裁过的（给模型读 digest），
   *   磁盘上放完整的（给页签渲染）。页签从此只依赖磁盘，与对话通道无关。
   *
   * ★★ 为什么是**一个目标一份文件**，不是一份全局文件
   *
   *   地图按「调用方会话绑定的目标」跑判决链，而页签是**每个会话都挂**的
   *   （客户端壳在 profile 层，全局可见）。若卡片只存一份，就会出现：
   *     war 会话刷出**任务宪章**的图 → 一个 cordis 会话打开页签，看到的也是这张图
   *     —— 而它的锚点说的是**系统宪章**。
   *   那正是我花力气消除的"锚点说 A、地图报 B"，换个地方又长出来。
   *   ⇒ 一份文件 = 一个目标。页签按自己的会话绑定去取对应那份。
   *   （文件名用 goal id；取不到 id 时落 `_default.json`，绝不静默丢数据。） */
  cardDir: '<HOME>/.dsh/opsmap-cards',
  /* 心跳：每隔这么久自动刷新**所有目标**的地图并落盘。
   *
   * ★ 补的是初衷里明说的「如果需要心跳机制……那就进行设计并开发」。
   *   在此之前我只做了"上报"（mapStale 报出地图多久没刷新），没做"自动刷新" ——
   *   于是「指挥官随时能看到战场局势」实际是「有人问的时候才看得到」。
   *
   * 默认 0 = **关闭**（opt-in）。理由：这是个会自己动起来的定时器，
   * 该由部署方显式决定要不要开，而不是插件自己拍。war/hive 的组合里显式开启。
   *
   * 为什么刷**所有目标**：页签按会话绑定取对应那份，所以每个可能有会话绑上去的
   * 目标都该有新鲜的那一份 —— 否则那个会话会看到"还没为这个目标刷新过"。
   * 目标清单来自 goals.json，通常只有一两个，代价很小。 */
  heartbeatMs: 0,
}

/** 目标 id → 卡片文件名（净化成安全文件名；空则退回 _default）。
 *
 *  ⚠ **导出是为了可测，也是为了让"跨文件契约"能被断言** ——
 *    profile 壳（profiles/node_modules/opsmap/lib/empty-host.js）里有**同名同逻辑**的一份，
 *    它用同样的规则拼路径去读。两处不一致就会出现"地图写到 A 文件、页签去读 B 文件"，
 *    症状是页签一直显示"还没为这个目标刷新过"（看起来像没刷新，其实是文件名不一致）。
 *    sync-to-hive.mjs 会逐字符比对两份实现，不一致就报错。 */
export function cardFileFor(goalId) {
  const s = String(goalId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return (s || '_default') + '.json'
}

/**
 * 确保某个目录存在。
 *
 * ★ 为什么必须有这一步（静态复核抓到的真 bug）
 *
 *   DSH 的 `fs.writeText` 契约是「原子地创建或替换 UTF-8 文本」—— **它不建父目录**，
 *   而且整个 fs 服务**没有 mkdir 方法**（只有 resolve/stat/readText/listDir/writeText/editText）。
 *   而卡片目录 `~/.dsh/opsmap-cards/` 在干净机器上**并不存在**。
 *   后果：每一张卡片都写失败 —— 而写入又是 try/catch 全吞的（"观测写不出去
 *   不能影响出图"），于是**整条磁盘优先链静默断掉**，页签一直显示"还没刷新过"，
 *   没有任何地方报错。
 *
 *   这是我上一轮把"写不出去不能影响出图"当纪律写进注释时，
 *   顺手把"目录不存在"这个真错误也吞掉了。**纪律不该吞掉真错误。**
 *   所以：目录先建（这里），写入失败再单独记账（见 noteWriteFailure）。
 */
function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch (e) {
    noteWriteFailure('mkdir ' + dir, e)
    return false
  }
}

/**
 * 观测写入失败的记账。
 *
 * 「写不出去不能影响出图」是纪律，但**静默**不是 —— 两者容易混为一谈。
 * 纪律说的是"不让它中断主流程"，不是"不让它被看见"。
 * 所以：失败计数 + 首次/变化时打一条 console.error（宿主日志里可见）。
 * 去重是为了心跳每十分钟一次时不刷屏。
 */
const writeFailures = { count: 0, lastMessage: null }
function noteWriteFailure(what, e) {
  writeFailures.count++
  const msg = what + ' → ' + String((e && e.message) || e)
  if (msg !== writeFailures.lastMessage) {
    writeFailures.lastMessage = msg
    try {
      console.error('[opsmap] 观测写入失败（累计 ' + writeFailures.count + ' 次）：' + msg)
    } catch {
      /* 连日志都打不出去就算了，计数仍然在 */
    }
  }
}

/** 把观测写入的失败情况并入摘要 —— 让"写不出去"这件事在能看见的地方可见。 */
export function publishHealth() {
  return { failures: writeFailures.count, lastError: writeFailures.lastMessage }
}

/**
 * 写一个**观测文件**。
 *
 * ★★ 为什么用 node:fs 而不是 DSH 的 fs 服务（实测踩过，代价很大）
 *
 *   原来这三处用的是 `ctx.fs.resolve()` + `ctx.fs.writeText()`，**全部静默失败**，
 *   一个文件都没落盘。根因在 `dsh-fs-sandbox`：
 *
 *       checkedTarget(target, sandboxPolicy) {
 *         const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
 *         ...
 *         if (mode === 'read-only') throw new FsError('cannot write ...: file access denied ...')
 *
 *   省略策略时它去解析「当前」策略；而插件在 apply()／定时器／工具回调里调用时
 *   **没有工具执行上下文**，解析到的是默认值 ⇒ 抛 FS_SANDBOX_DENIED。
 *
 *   部署自带的 fs 工具之所以能写，是因为它们**显式传**了
 *   `ctx.fs.writeText(target, content, intent, exec.signal, sandboxPolicy)` ——
 *   那个 sandboxPolicy 来自工具执行上下文，插件没有。
 *
 *   ⇒ 本部署既有的四个观测口（charter-pin / charter-duty / route-health /
 *     agent-route-sync）**全部用 node:fs 的 writeFileSync，零处用 fs 服务**。
 *     这条约定是实测出来的，不是偏好 —— 我照它办。
 *
 *   ⚠ 我**不会**靠"显式传一个放宽的策略"绕过围栏。那正是让插件放宽自己 confinement，
 *     等于废掉 confinement。观测文件是插件自己的记账，走 node:fs；被沙箱围栏的
 *     用户数据才该走 fs 服务。
 */
/* ══ 发布者登记表（2026-10-23 加）══════════════════════════════════════
 *
 * 为什么要它：实测存在**两个板面根**（war 预设读 ~/.war，hive 预设读 ~/.hive），
 * 而两者写**同一批卡片/状态文件** ⇒ 页签与摘要的读数会在两个世界之间来回翻
 * （32/36 健康 vs 13/36 零覆盖 19）。
 *
 * 谁对谁错要人来定（哪块板面是正典）。但"**此刻有不止一个发布者**"这件事
 * 本身不该是谜 —— 它现在会被记下来，任何读者都能一眼看到：
 *     有 2 个发布者在写同一批观测文件 —— 读到的数字取决于谁最后写。
 *
 * ⚠ 两个预设实例**在同一个进程里**，所以板面根必须**逐次传递**，
 *   不能存模块级变量（会被另一个实例覆盖）。这是实测得出的教训。
 *
 * ⚠ 读改写有微小竞争（两个心跳可能同时写）。代价是偶尔丢一条登记 ——
 *   可以接受：它只用于"看见有几方在写"，不参与任何判决。
 */
function notePublisher(boardRoot, registryPath) {
  const root = String(boardRoot || '').trim()
  if (!root) return
  const p = registryPath || '<HOME>/.dsh/opsmap.publishers.json'
  try {
    let reg = {}
    try { reg = JSON.parse(readFileSync(p, 'utf8')) || {} } catch { reg = {} }
    reg[Date.now()] = { root: root, at: new Date().toISOString() }
    /* 只保留最近 50 条：这是一份"最近谁在写"的记录，不是历史账 */
    const keys = Object.keys(reg).map(Number).sort((a, b) => b - a).slice(0, 50)
    const next = {}
    for (const k of keys) next[k] = reg[k]
    writeFileSync(p, JSON.stringify(next, null, 1), 'utf8')
  } catch { /* 登记失败绝不影响出图 */ }
}

/** 读登记表，返回"最近 N 分钟内有哪些不同的板面根在写"。 */
export function recentPublishers(windowMs = 30 * 60 * 1000) {
  try {
    const reg = JSON.parse(readFileSync('<HOME>/.dsh/opsmap.publishers.json', 'utf8')) || {}
    const since = Date.now() - windowMs
    const roots = new Set()
    for (const k of Object.keys(reg)) if (Number(k) >= since) roots.add(reg[k].root)
    return [...roots]
  } catch { return [] }
}

function writeObserved(p, text, what, boardRoot, registryPathFor) {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (cut > 0 && !ensureDir(p.slice(0, cut))) return false
  try {
    writeFileSync(p, text, 'utf8')
    notePublisher(boardRoot, registryPathFor)
    return true
  } catch (e) {
    /* 写不出去绝不能影响出图 —— 但要记账，不中断 ≠ 不被看见 */
    noteWriteFailure(what, e)
    return false
  }
}

/**
 * 把**未裁剪**的完整卡片按目标写到磁盘，供页签经 HTTP 读取。
 *
 * 与 publishStatus 的分工：那份是给看门狗读的**摘要**（几 KB），
 * 这份是给页签渲染的**全量**（实测约 44KB）。分开是因为消费者不同 ——
 * 看门狗每 5 分钟读一次，不该让它读 44KB。
 *
 * 导出是为了可测：单测断言文件真的落地。
 */
export async function publishCard(cardDir, text, goal, boardRoot) {
  const dir = String(cardDir).replace(/[\\/]+$/, '')
  return writeObserved(dir + '/' + cardFileFor(goal && goal.id), text, 'card', boardRoot, dir + '/publishers.json')
}

/**
 * 构造观测口摘要。**纯函数**，可单测 —— 这一点很关键。
 *
 * ══ 为什么必须把它抽出来 ══
 *
 * 这份摘要有**两个独立的消费者代码**：
 *   · 写：本函数（地图侧）
 *   · 读：charter-duty 的 collectSignals（看门狗侧，读 ms.at / ms.swarm.gap / ms.goal.id）
 * 两处各写各的，形状一旦对不上，后果是**静默的**：
 * 看门狗会判成「从未刷新过」，报出「地图没在刷新」——而真相是字段名错了。
 * 这类"两个调用点各自漂移、谁也不报错"在本项目里已经踩过多次。
 *
 * 抽成纯函数之后，两侧都能对着它写断言：
 *   · 地图侧断言「我确实产出这些键」
 *   · 看门狗侧断言「我确实按这些键读」
 * 任一侧面改了键名，它自己的测试就会红。
 */
export function buildStatusSummary(payload, goal) {
  const M = payload.metrics && payload.metrics.headline ? payload.metrics.headline : null
  const D = payload.dispatch && payload.dispatch.counts ? payload.dispatch.counts : null
  const SW = payload.swarmView || null
  const T = payload.targets || null
  /* ★ 2026-11-05：**待你审批的件数**。
   *
   * 为什么它在摘要里而 headline 里没有：`board.approvals` 早就被地图读进来了，
   * 但只当"报备合规"的比对素材（report_items 有没有对应记录）。于是一个
   * `status: 'pending'` 的审批申请 —— 唯一「有人正等着指挥官拍板」的状态 ——
   * 在地图上**完全不可见**：`decisions` 数的是主攻方向，`blockers` 数的是被阻断的
   * 条目，两者都不是"等你签字"。
   *
   * 这里只放**事实**（几条、分别是什么），不重算规则。判「什么算在等一个人」的
   * 规则在板面 `board_snapshot.waiting_on` 里只有一份 —— 地图不该长出第二份。
   * 数 `status === 'pending'` 是事实，不是口径。
   */
  /* ★★ 2026-11-05 二次修正：审批在 `payload.situation.approvals`，**不是** `payload.board.approvals`。
   *
   *   第一版我按"板面数据应该挂在 board 下面"想当然写了 `payload.board.approvals`。
   *   实测 payload 的顶层键是
   *     ok, generatedAt, engine, diag, goal, recursion, identity, charter, criteriaStatus,
   *     ledger, targets, intelDrive, kb, metrics, schwerpunkt, dispatch, swarmView, cop, brief,
   *     doctrine, situation
   *   —— **没有 board**。于是 `payload.board && …` 恒为 undefined，approvalsPending 恒为 null：
   *   功能是**空转**的，而且测试是绿的（因为测试也按我以为的形状造数据）。
   *
   *   「代码读错路径 + 测试按同一份误解造数据」= 假绿的标准配方。
   *   现在两处都改用引擎**真正**的出口：`situation.approvals`（元素形如
   *   { id, actionClass, target, status }，见 engine 第 2431 行）。
   */
  const AP = Array.isArray(payload.situation && payload.situation.approvals)
    ? payload.situation.approvals.filter((a) => a && String(a.status) === 'pending')
    : null
  return {
    at: payload.generatedAt,
    engine: payload.engine,
    goal: goal ? { id: goal.id, label: goal.label, charterJson: goal.charterJson, source: goal.source, sessionId: goal.sessionId } : null,
    headline: M ? { scorable: M.scorable, triage: M.triage, blockers: M.blockers, decisions: M.decisions } : null,
    dispatch: D ? { total: D.total, executable: D.executable, twoStep: D.twoStep, needsHuman: D.needsHuman } : null,
    swarm: SW ? { mapTotal: SW.mapTotal, visibleCount: SW.visibleCount, gap: SW.gap } : null,
    targets: T ? { covered: T.covered, units: (T.units || []).length, realGap: (T.realGap || []).length, orphan: (T.orphan || []).length } : null,
    approvalsPending: AP === null
      ? null
      : {
        count: AP.length,
        items: AP.slice(0, 8).map((a) => ({ id: a.id ?? null, actionClass: a.actionClass ?? a.action_class ?? null, target: a.target ?? null })),
      },
    charterOk: !!(payload.charter && payload.charter.ok),
    charterIssues: payload.charter && payload.charter.validation ? (payload.charter.validation.issues || []).length : null,
  }
}

/**
 * 发布观测口（best-effort）。
 *
 * 纪律与 charter-pin / charter-duty 的状态文件一致：
 *   ① 写不出去**绝不影响出图**（try/catch 全吞）
 *   ② 只写**可以安全公开**的摘要，不是整个 payload（payload 里有过 4 万字节的派工层，
 *      把它塞进状态文件只是把溢出问题挪个地方）
 */
/**
 * 发布观测口的**摘要**。
 *
 * ★ 为什么也按目标分文件（实测踩到）
 *
 *   心跳按顺序刷所有目标，若都写同一个文件，**留下的就是最后刷的那个**。
 *   实测：war/hive 心跳跑完一轮后，`opsmap.status.json` 里是
 *   `system-war-legion`（开发用的系统宪章）那份 —— 主攻方向 83、落差 -4。
 *   而看门狗读到它，会以为那是**战场上**的情况。
 *   数字看起来完全正常、没有任何报错，唯一症状是"看门狗报告的落差跟战场对不上"。
 *
 *   所以：
 *     · `<base>.<目标id>.json` —— 每个目标一份，各自可查（不互相覆盖）
 *     · `<base>`               —— **只由"主目标"写**，主目标 = goals.json 里的第一个
 *       （任务目标排第一是约定）。看门狗读基名那份，于是它看的一定是战场，
 *       不是某个开发用的宪章。
 *
 *   看门狗侧的契约（at / swarm / goal）**没变** —— 它读到的仍是"某个确定目标"的摘要，
 *   只是那个目标现在确定下来了，而不是随机取决于循环顺序。
 *
 * ★ 2026-11-06（v26 复核留下的第 1 项）：**把口径写进文件里**
 *
 *   上一轮修掉了"谁最后写谁赢"，但没有修掉**读者仍需推断**这件事：
 *   一个叫 `opsmap.status.json` 的文件，读起来仍然像"全局状态"。
 *   复核清单里这一条当时是"仍未做"，现在补上 —— 摘要自己带上
 *
 *     statusScope: 'primary-goal' | 'single-goal'
 *     goals:      本轮心跳参与的目标 id 列表（**null = 不知道**，不是"没有"）
 *     ambiguous:  基名那份是不是"只是一个目标"（多目标时为 true）
 *     ambiguousWhy: 一句话说明该去哪里看其余目标
 *
 *   理由和宪章里那条「读不到 ≠ 没有」是同一条：**含糊要写在文件里，
 *   不能靠读者推断**。数字层面一个字没改，改的是"这份东西是什么意思"。
 */
/**
 * 摘要的**口径**：这份文件到底是"一个目标的状态"还是"多个目标的状态"。
 *
 * 抽成纯函数而不是写在 `publishStatus` 里的理由，和 `isPrimaryGoal` 一样：
 * **规则只能有一个实现，而且要能被单测直接钉住**。这里要防的失效形态是
 * 「数字都对、含义错了」—— 一个叫 `opsmap.status.json` 的文件读起来像全局状态，
 * 实际只是主目标那一份。没有任何报错，症状只有"看门狗报告的落差跟战场对不上"。
 *
 * 三条约定：
 *   1. `goals === null/undefined` ⇒ `goals: null, ambiguous: null`。**不知道 ≠ 没有**
 *      —— 拿不到清单时说"拿不到"，不说"只有一个目标"。
 *   2. 只有主目标那份、且本轮目标多于一个时才 `ambiguous: true`，并附一句
 *      `ambiguousWhy` 指向其余目标的文件名。数字层面一个字不改，改的是"这是什么"。
 *   3. 按目标分的那份（`<base>.<goalId>.json`）永远是 `single-goal`：
 *      文件名已经说明了它是谁。
 */
export function statusScope(base, isPrimary, goals) {
  const ids = Array.isArray(goals) ? goals.filter((g) => g && g.id).map((g) => String(g.id)) : null
  const ambiguous = ids === null ? null : !!(isPrimary && ids.length > 1)
  return {
    statusScope: isPrimary ? 'primary-goal' : 'single-goal',
    goals: ids,
    ambiguous,
    ambiguousWhy: ambiguous
      ? '这份是**主目标**（goals.json 第一个）的摘要，不是全局状态；其余 ' + (ids.length - 1)
        + ' 个目标各自在 ' + String(base).replace(/\.json$/, '.<goalId>.json')
      : null,
  }
}

function publishStatus(cfg, payload, goal, isPrimary, goals) {
  const base = String(cfg.statusPath)
  const summary = buildStatusSummary(payload, goal)
  Object.assign(summary, statusScope(base, isPrimary, goals))
  /* 把观测写入的健康状况写进摘要自己里：
     这份写成功了才有人看得到它；写失败则由 noteWriteFailure 打 console.error。
     两条路合起来保证"写不出去"不会无声无息。 */
  summary.publish = publishHealth()
  const text = JSON.stringify(summary, null, 2)
  writeObserved(base.replace(/\.json$/, '.') + cardFileFor(goal && goal.id), text, 'status', cfg && cfg.hiveRoot, base.replace(/[^\/]*$/, 'publishers.json'))
  if (isPrimary) writeObserved(base, text, 'status(primary)', cfg && cfg.hiveRoot, base.replace(/[^\/]*$/, 'publishers.json'))
  return summary
}

/**
 * 读一个 JSON 文件（用宿主 fs 服务的 resolve/stat/readText 三件套，与引擎同款）。
 * 读不到或解析失败一律返回 null —— 调用方负责决定退回什么默认。
 */
async function readJsonFile(fs, p) {
  try {
    const t = await fs.resolve(p)
    if (!(await fs.stat(t))) return null
    return JSON.parse(await fs.readText(t))
  } catch {
    return null
  }
}

/**
 * 解析目标清单里的**全部目标**（心跳要逐个刷新）。
 * 形状与 resolveBoundGoal 的返回值保持一致 —— 两条路产出同一种东西，
 * 下游（refresh / publishCard）不需要知道它是谁给的。
 */
export async function allGoals(fs, cfg) {
  const root = String((cfg && cfg.charterRoot) || CHARTER_ROOT)
  const goalsDoc = await readJsonFile(fs, root + '/goals.json')
  const list = goalsDoc && Array.isArray(goalsDoc.goals) ? goalsDoc.goals : []
  if (list.length === 0) {
    /* 读不到清单时退回一个内置默认目标 —— 心跳宁可退化，不能什么都不刷。 */
    return [{
      id: null,
      label: '默认目标',
      scope: 'mission',
      charterJson: 'charter.json',
      charterDoc: 'CHARTER.md',
      source: 'fallback-hardcoded',
      sessionId: null,
      goalsFileFound: false,
    }]
  }
  return list
    .filter(function (g) { return g && g.id })
    .map(function (g) {
      return {
        id: String(g.id),
        label: String(g.label || g.id),
        scope: String(g.scope || ''),
        charterJson: String(g.charterJson || 'charter.json'),
        charterDoc: String(g.charterDoc || 'CHARTER.md'),
        source: 'heartbeat',
        sessionId: null,
        goalsFileFound: true,
      }
    })
}

/**
 * 跑一遍判决链并把结果发布到两个观测点（摘要 + 完整卡片）。
 *
 * 抽出来的理由：**工具路径与心跳路径必须做同一件事**。
 * 两处各写一遍必然漂移 —— 而这种漂移的症状是「页签看到的是心跳那份、
 * 对话看到的是工具那份，数字还不一样」，非常难查。
 */
async function refreshAndPublish(fs, cfg, goal, isPrimary, goals) {
  const payload = await refresh(fs, cfg, goal)
  const card = buildCard(payload)
  const digestText = digest(payload)
  publishStatus(cfg, payload, goal, !!isPrimary, goals)
  await publishCard(cfg.cardDir, JSON.stringify({ digest: digestText, card }), goal)
  return { payload, goal, card, digestText }
}

/**
 * 主目标 = goals.json 里的第一个（任务目标排第一是约定）。
 *
 * ★ 为什么要有「主目标」这个概念
 *
 *   观测口的**基名**只有一个，而目标是多个。若让最后一个写的赢，
 *   看门狗看到的就是随机的某一个目标 —— 实测那次是开发用的系统宪章，
 *   于是"看门狗报告的落差跟战场对不上"，而数字看起来完全正常。
 *
 * ★ 为什么它是一个**纯函数**
 *
 *   原来这条规则写在两处：心跳用 `i === 0`、工具路径用
 *   `goal.id === (await primaryGoalId(...))`。两处今天一致，但**没有任何东西
 *   保证它们明天也一致** —— 改一处就漂，而症状是"看门狗盯着另一个目标"。
 *   这正是本项目反复踩的形态（同一件事两个调用点各自实现）。
 *   ⇒ 规则收进这一个纯函数，两条路都调它；单测直接钉住它的行为。
 *
 * 取不到清单（空数组）时返回 false ⇒ 那条路不写基名，只写按目标分的那份。
 * 这比"随便挑一个当主目标"诚实：没有约定就说没有，而不是编一个。
 */
export function isPrimaryGoal(goals, goal) {
  if (!Array.isArray(goals) || goals.length === 0) return false
  const first = goals[0]
  if (!first) return false
  if (!goal) return false
  return first.id === goal.id
}

/**
 * 解析「调用方会话绑定了哪个目标」。
 *
 * ══ 为什么必须有这一步（这是一个真实的分叉）══
 *
 * 地图原来**硬编码**读 `charterRoot + '/charter.json'`。而 charter-pin 那边已经把
 * 目标做成可绑定的：`charter/goals.json` 列目标清单（id → 宪章文件），
 * `charter/bindings.json` 记「会话 → goal id」，锚点按绑定注入。
 *
 * 于是同一句话里出现两个目标：
 *   · 锚点告诉会话「你的目标是 A」
 *   · 地图报的是 B 的判据（criteriaStatus 来自硬编码那份）
 * 而且**没有任何地方会报错** —— 这正本项目反复踩的「两个调用点各自漂移」。
 *
 * ══ 会话身份从哪来 ══
 *
 * `execute(args, exec)` 的 `exec` 由 agent loop 填，形状实测为
 * `{ name, arguments, agent: { id } }`（据本仓库 hive/plugins/roe-gate 的实测记录）。
 * 取不到会话身份时**退回默认目标**，绝不因为拿不到身份就不出图 ——
 * 地图宁可退化成"按默认目标算"，也不能变成"什么都没有"，而且它会把
 * `source` 如实标出来（session-binding / default / fallback-hardcoded），
 * 让人一眼看出这份结论是**按哪个目标**算的。
 */
export async function resolveBoundGoal(fs, cfg, exec) {
  const root = String((cfg && cfg.charterRoot) || CHARTER_ROOT)
  const goalsDoc = await readJsonFile(fs, root + '/goals.json')
  const list = goalsDoc && Array.isArray(goalsDoc.goals) ? goalsDoc.goals : []
  const byId = new Map()
  for (const g of list) if (g && g.id) byId.set(String(g.id), g)

  let sid = null
  try {
    const a = exec && exec.agent
    sid = (a && a.session && a.session.id) || (a && a.id) || null
  } catch {
    sid = null
  }

  let boundGoal = null
  let boundScope = null
  if (sid) {
    const bi = await readJsonFile(fs, root + '/bindings.json')
    const b = bi && bi.bindings && bi.bindings[sid]
    if (b) {
      boundScope = b.scope ? String(b.scope) : null
      if (b.goal) boundGoal = String(b.goal)
    }
  }

  /* ★★ 老格式绑定（只有 scope，没有 goal）必须**按它自己的 scope 推**。
   *
   *   实测抓到的真 bug：`resolveBoundGoal` 原来在缺 goal 时**直接退到默认目标**，
   *   完全没看绑定里存的 scope。而真实绑定表 455 条**全是老格式**
   *   （跑着的插件还没写过 goal），其中 264 条是 system ——
   *   于是它们**全部被解析成任务目标**，一个都没报错。
   *   症状：cordis 会话的页签显示任务地图，而它的锚点说的是系统宪章。
   *
   *   charter-pin 处理同一个字段是正确的（它写的是 pickGoalId(goals, known.scope)）——
   *   **同一份数据、两处读者，一处对一处错**，正是本项目反复踩的形态。
   *   这里照它的规则办：先按 scope 找专属目标，再退 defaultGoalByScope，最后才退默认。 */
  const dflt = (goalsDoc && goalsDoc.defaultGoalByScope) || {}
  const byScope = {}
  for (const g of list) {
    if (g && g.id && g.scope && byScope[String(g.scope)] === undefined) byScope[String(g.scope)] = String(g.id)
  }
  const mission = list.find(function (g) { return g && g.scope === 'mission' })

  /* ★ 逐级判定，**并让 source 反映实际走的是哪一级**。
   *
   *   ⚠ 这里踩过一次：原来是三元表达式
   *     `boundGoal ? 'session-binding' : boundScope ? 'inferred-by-scope' : ...`
   *   —— 它只看"有没有 scope"，不看"那个 scope 到底有没有对应目标"。
   *   于是 scope 在清单里查不到、结果退到默认目标时，标签仍写着 inferred-by-scope。
   *   **标签必须反映实际是怎么定下来的**，否则排查时会被它带错方向。 */
  let goalId = null
  let src = 'fallback-hardcoded'
  if (boundGoal) {
    goalId = boundGoal
    src = 'session-binding'
  } else if (boundScope && (dflt[boundScope] || byScope[boundScope])) {
    goalId = dflt[boundScope] || byScope[boundScope]
    src = 'inferred-by-scope'
  } else if (dflt.mission) {
    goalId = dflt.mission
    src = 'default'
  } else if (mission && mission.id) {
    goalId = String(mission.id)
    src = 'default'
  } else if (list[0] && list[0].id) {
    goalId = String(list[0].id)
    src = 'default'
  }
  const g = goalId ? byId.get(String(goalId)) : null

  return {
    id: goalId,
    label: g ? String(g.label || g.id) : null,
    scope: g ? String(g.scope || '') : boundScope || null,
    charterJson: g ? String(g.charterJson || 'charter.json') : 'charter.json',
    charterDoc: g ? String(g.charterDoc || 'CHARTER.md') : 'CHARTER.md',
    /* 来源要能区分四件事（可信度不同，不能说成一回事）：
     *   session-binding   —— 绑定里直接写了 goal（新格式，最可信）
     *   inferred-by-scope —— 绑定只有 scope，且那个 scope 有对应目标（当前真实情况）
     *   default           —— 有绑定但 scope 查不到 / 压根没有绑定 / 清单读不到 ⇒ 用默认
     *   fallback-hardcoded—— 连目标清单都没有，退回内置默认 */
    source: src,
    sessionId: sid,
    goalsFileFound: list.length > 0,
    /* 可观测：这条绑定是老格式还是新格式。455 条全是老格式这件事，
     * 不写出来就没人知道"推导路径"其实是当前唯一在跑的路径。 */
    bindingFormat: boundGoal ? 'with-goal' : boundScope ? 'scope-only' : 'none',
  }
}

/**
 * 跑完整条判决链，返回完整 payload（16 键 + goal）。
 *
 * ★ 只读：这里只调 fs 的读方法，绝不写板面。地图产出的是**调用参数**，
 *   由 lead 用 board_* 工具执行 —— 写权限一旦开给地图，exec.agent.id 溯源、
 *   认领心跳租约、「不登记就锁死写入」、审批门禁四个不变量全部作废。
 */
export async function refresh(fs, cfg, goal) {
  const c = Object.assign({}, DEFAULTS, cfg || {})
  /* ★ 板面有多新（2026-10-23 加）
   *
   *   为什么：实测存在两块板面，其中一块（~/.hive）是**一周前**的。
   *   一个会话如果读的是旧板面，它看到的"战况"全是一周前的 —— 而它自己看不出来。
   *   板面根（boardRoot）只说"读的是哪块"，不说"这块有多旧"。两件事都要。
   *
   *   取三个板面目录下所有 json 的 mtime 最大值。读不到就给 null（不编）。 */
  const boardNewest = (function () {
    try {
      let newest = 0
      for (const d of ['assets', 'objectives', 'findings']) {
        const dir = String(c.hiveRoot).replace(/\/+$/, '') + '/' + d
        let ents = []
        try { ents = fsSync.readdirSync(dir) } catch { continue }
        for (const e of ents) {
          if (!/\.json$/i.test(e)) continue
          try { newest = Math.max(newest, fsSync.statSync(dir + '/' + e).mtimeMs) } catch { /* 单个读不到不算 */ }
        }
      }
      return newest > 0 ? new Date(newest).toISOString() : null
    } catch { return null }
  })()

  const diag = {
    boardRoot: c.hiveRoot, boardNewest: boardNewest, doctrineRoot: c.doctrineRoot, charterRoot: c.charterRoot, targetsFile: c.targetsFile,
    missing: [], readErrors: [], doctrineMissing: [], charterMissing: [], counts: [], targets: '',
    /* 诊断里记下「按哪个目标算的」——出问题时第一眼要看的就是它 */
    goal: goal ? { id: goal.id, source: goal.source, charterJson: goal.charterJson, sessionId: goal.sessionId } : null,
  }
  const board = {}
  for (let i = 0; i < BOARD_DIRS.length; i++) board[BOARD_DIRS[i]] = await listBoard(fs, BOARD_DIRS[i], diag, c.hiveRoot)
  const doc = await loadDoctrine(fs, diag, c.doctrineRoot)
  const charter = await loadCharter(fs, diag, c.charterRoot, goal && goal.charterJson)
  const exclusions = buildExclusions(doc['intel-semantics'])
  const model = buildModel(board, doc, exclusions)
  const ledger = buildLedger(model.chains, doc['score-table'], exclusions)
  const units = await loadTargets(fs, diag, c.targetsFile)
  const targetMatch = units ? matchUnits(units, model.chains, doc['intel-semantics'], ledger, doc.identity) : null
  model.targets = targetMatch
  const intelDrive = evaluateIntel(model, doc['intel-semantics'], board)
  const schwerpunkt = buildSchwerpunkt(model, ledger, intelDrive, targetMatch, doc.decision)
  // 派工层依赖决策层（它把建议翻译成 board 调用），蜂群视野依赖两者（做对照）
  /* ★★ 末尾必须传 doc（不只是 doc.decision）—— 第 18 轮抓到的真实缺陷。
   *
   * buildDispatch 的第 7 个参数是 scoutSanctioned（侦察法，来自 doctrine/recon.json），
   * 它由 `doctrine.recon` 提供。只传 doc.decision 时那个参数是 undefined，
   * 于是侦察法**永远读不到** —— 派工命令里那段「怎么找入口」永远走
   * 「侦察法单未加载」分支，或者干脆不出现。
   *
   * 这正是本项目反复出现的形态：**两个调用点各自漂移，谁也不报错**。
   * 动态插件形态（v14.host.js 的 apply 块）我改了；磁盘部署形态（本文件）
   * 忘了同步，而且因为两边都"能跑"，没有任何地方会报出来。
   * 实测证据：M5 探针在动态形态下能看到 5 条方法，在部署形态下一条都看不到。 */
  const dispatch = buildDispatch(model, ledger, intelDrive, targetMatch, schwerpunkt, doc.decision, doc)
  const swarmView = buildSwarmView(model, targetMatch, dispatch)
  const metrics = computeMetrics(model, ledger, intelDrive, targetMatch, doc.metrics, doc.decision, schwerpunkt, dispatch, swarmView)
  const crit = criteriaStatus(model, ledger)

  /* ★★ 把**系统宪章**（s1–s6）的实测值合并进来（2026-10-22 补）
   *
   *   缺口（实测）：`criteriaStatus` 只实现了**任务宪章**的 c1–c5。
   *   系统宪章的 s1–s6 找不到条目，于是全部落到下面的兜底
   *   `{ value: null, status: 'na' }` ——
   *   页签上那句「目标判据 0/6 达成」**是个空壳**，宪章里六条
   *   「可机械校验的判据」一条都没被机械校验过。
   *
   *   而其中 s4 是有明确目标值的：**>= 80% of war sessions**。
   *   实测出来是 6%（13/210）—— 这条 FAIL 从来没被任何界面报出来过。
   *
   *   ⚠ 为什么不在这里现算：
   *     s4 要扫 492 个会话文件（解压约 2GB），一次一两分钟；而地图心跳是
   *     **10 分钟一轮** —— 塞进来会把心跳拖垮，还每轮重复劳动。
   *     所以分两层：**测量慢、落文件**（tools/measure-system-criteria.mjs），
   *     **展示快、每轮读**（这里）。文件不在就照旧报 na，不崩、不编。
   *
   *   ⚠ 只认 `s` 开头的判据 —— 不去碰 c1–c5（那是引擎自己算的，来源不同，
   *     混在一起会让"这个数字哪来的"变得说不清）。 */
  try {
    const raw = readFileSync('<HOME>/.dsh/charter/criteria-measured.json', 'utf8')
    const measured = JSON.parse(raw)
    for (const id of Object.keys(measured.criteria || {})) {
      if (!/^s\d+$/.test(id)) continue
      const m = measured.criteria[id]
      if (!m) continue
      crit[id] = {
        id: id,
        value: m.value === undefined ? null : m.value,
        status: m.status || 'na',
        detail: (m.detail || '') + '　［实测于 ' + (measured.at || '?') + '］',
      }
    }
  } catch (e) {
    /* ⚠ 区分两种"没有值"，它们的处置完全不同：
     *   · 文件不存在 / JSON 坏了 → 正常情形（还没测过）⇒ 保持 na，不吭声
     *   · 其它（ReferenceError 之类）→ **我们的代码错了** ⇒ 必须出声，
     *     否则"合并永远不发生"会静默地一直存在下去。
     *   （写这段时就踩到了：readFileSync 忘了 import，被裸 catch 吞掉。） */
    const benign = e && (e.code === 'ENOENT' || e instanceof SyntaxError)
    if (!benign) {
      console.error('[opsmap] 读实测判据文件出错（不是"没测过"）：' + (e && e.message ? e.message : e))
    }
  }

  const critOut = (charter && charter.criteria ? charter.criteria : []).map(function (x) {
    return crit[x.id] || { id: x.id, value: null, status: 'na', detail: x.blocked_reason || x.source }
  })
  /* ★★ D3「成果递归衍生」的实测数（第 17 轮补上）
   *
   * 为什么必须补：桥接层一直在读 `rep.recursion`（notify 的 D3 观察段、
   * map_orders 的标题行），但 payload **从来没有这个键** —— 实测
   * `p.recursion === undefined`。后果是静默的，而且很难发现：
   *   · notify 里 `const R = rep.recursion` → undefined → `R && ...` 永不成立
   *     ⇒ 那一段 D3 观察**从未输出过一次**；
   *   · map_orders 里 `rep.recursion || {findings:0,...}` → 退化默认值
   *     ⇒ 那一行永远打印「成果 0 条（衍生过 0，未衍生 0，其中 verified 0）」
   *       —— 一个**看起来像数据**的常量，比空白更坏。
   * 两处都不报错。这正是「静默的失败模式」。
   *
   * ⚠ 两个源的分工（我在这里白排查了一轮，记下来）：
   *   · v14.host.js 是**动态插件形态**的引擎源，make-engine.mjs 只取它
   *     marker（`return {\n  apply(ctx) {`）**之前**的顶层函数，生成
   *     opsmap-engine.js。整个 apply 块（插件外壳）不进生成物。
   *   · lib/index.js 是**磁盘部署形态**的外壳，是手写的，sync-preset.mjs 抄的是它。
   *   ⇒ refresh() 在 **index.js** 里（因为动态形态下它在 apply 块里，进不了生成物）。
   *     所以算 D3 的代码必须是 opsmap-engine.js 的**顶层函数**，
   *     由 index.js 的 refresh() 调用。第一版我写进了 v14.host.js 的 apply 块，
   *     结果生成物里没有、字段依旧 undefined。
   */
  const recursion = computeRecursion(model, ledger, doc['score-table'])
  /* ★★ 态势图（COP）—— 指挥员那句「像国战游戏那样看清楚战场」。
   *
   * 为什么在**外壳**里算，而不是改引擎：
   *   引擎（opsmap-engine.js）是 make-engine.mjs **机器生成**的，改它要走整条再生链
   *   （改 v14.host.js → make-engine → sync-to-hive）。
   *   而外壳的 refresh() **已经读了板面** —— `board.objectives` 就是原始意图卡数组，
   *   `claim.agent` / `claim.heartbeat_at` 都在里面。一行生成物都不用动。
   *
   * 它回答三件事：
   *   哪些点在哪        → nodes[].name + addrs
   *   哪个点正在战斗     → nodes[].live > 0
   *   哪些队伍正在过去   → nodes[].cmd（待发命令）+ nodes[].holders（已在打的）
   *
   * ★ 口径纪律：这里的 live/expired 必须与板面、与引擎同一把尺（30 分钟心跳）。
   *   三处各写一个 TTL = 三处各自漂移，而谁都不会报错 —— 本项目栽过好几次。
   *   所以常量只在这一处定义，并在此注明它与 board 的同名常量一致。 */
  const COP_CLAIM_TTL_MS = 30 * 60 * 1000
  const copNow = Date.now()
  const objCards = Array.isArray(board.objectives) ? board.objectives : []
  const assetCards = Array.isArray(board.assets) ? board.assets : []

  const perAsset = new Map()
  const ensureA = (id) => {
    if (!perAsset.has(id)) perAsset.set(id, { live: 0, expired: 0, open: 0, closed: 0, tested: 0, liveHolders: [], staleHolders: [] })
    return perAsset.get(id)
  }
  for (const o of objCards) {
    const b = ensureA(String(o.asset_id || '(无归属)'))
    const st = String(o.status || '')
    if (st === 'open') b.open++
    else if (st === 'closed') b.closed++
    else if (st === 'tested') b.tested++
    const cl = o.claim
    if (cl && !cl.released_at) {
      const beat = Date.parse(cl.heartbeat_at || '')
      const who = cl.agent ? String(cl.agent).slice(0, 8) : ''
      if (Number.isFinite(beat) && copNow - beat < COP_CLAIM_TTL_MS) { b.live++; if (who) b.liveHolders.push(who) }
      else { b.expired++; if (who) b.staleHolders.push(who) }
    }
  }

  /* 地址 → 资产 id。必须在下面的命令分类**之前**算好：
     分类要用「这个 assetId 属于某个靶标单元吗」来判，而那个判断依赖 unit.assets。 */
  const addr2asset = new Map(assetCards.map((a) => [String(a.address || ''), String(a.id || '')]))
  const unitAssetIds = new Set()
  for (const u of (targetMatch && targetMatch.units) || []) {
    for (const ad of u.assets || []) {
      const id = addr2asset.get(String(ad))
      if (id) unitAssetIds.add(id)
    }
  }

  const cmdsByAsset = new Map()
  /* ★ 命令一条都不许丢 —— 但「挂不上点」有两种，必须分开报，否则第二种会静默消失。
   *
   *   (1) 没有 assetId  → 流程级 / 需人裁定的活（「缺报备 R5-1」「出口台账为空」）
   *   (2) 有 assetId，但那个资产不属于任何靶标单元
   *                     → 「清单外资产」「corpus 语料」这一类
   *
   * 第 4 轮只处理了 (1)。第 9 轮实测 (2) 有 9 条**完全隐形** —— 而它们恰恰最该被看见：
   * 报备闭环未建立（合规红线）、清单外资产（正是「不可伪造情报、守纪律」的核心）。
   * 不显示不等于没发生，等于看不见违反。所以两类都收进 unassigned，各自带上原因。 */
  const unassignedCmds = []
  for (const e of (dispatch && dispatch.entries) || []) {
    const rec = {
      rank: e.rank, kind: e.kind, ready: !!e.readyToFile, human: !!e.needsHuman,
      executor: String(e.executor || ''), title: String(e.title || '').slice(0, 60),
    }
    const a = String(e.assetId || '')
    if (!a) { rec.why = 'no-asset-id'; unassignedCmds.push(rec); continue }
    if (!unitAssetIds.has(a)) { rec.why = 'asset-not-in-any-unit'; unassignedCmds.push(rec); continue }
    if (!cmdsByAsset.has(a)) cmdsByAsset.set(a, [])
    cmdsByAsset.get(a).push(rec)
  }

  const copNodes = []
  for (const u of (targetMatch && targetMatch.units) || []) {
    const addrs = (u.assets || []).map(String)
    const ids = addrs.map((ad) => addr2asset.get(ad)).filter(Boolean)
    let live = 0, expired = 0, open = 0, cmd = 0, ready = 0, human = 0
    const holders = [], stale = []
    for (const id of ids) {
      const b = perAsset.get(id)
      if (b) { live += b.live; expired += b.expired; open += b.open; holders.push(...b.liveHolders); stale.push(...b.staleHolders) }
      const cl = cmdsByAsset.get(id) || []
      cmd += cl.length
      ready += cl.filter((x) => x.ready && !x.human).length
      human += cl.filter((x) => x.human).length
    }
    copNodes.push({
      no: u.no, name: String(u.text || ''),
      stage: (u.status && u.status.label) || '', rank: (u.status && u.status.rank) || 0,
      addrs, live, expired, open, cmd, ready, human,
      holders: [...new Set(holders)], stale: [...new Set(stale)],
      scorable: u.scorable || 0,
      /* 「哪些点在哪」：没有经纬度，用 zone 分层（实测取值 internet / local） */
      zones: [...new Set(ids.map((id) => { const a = assetCards.find((x) => String(x.id) === id); return a ? String(a.zone || '') : '' }).filter(Boolean))],
    })
  }

  const cop = {
    nodes: copNodes,
    counts: {
      total: copNodes.length,
      fighting: copNodes.filter((n) => n.live > 0).length,
      stalled: copNodes.filter((n) => n.expired > 0).length,
      pending: copNodes.filter((n) => n.open > 0).length,
      withCommands: copNodes.filter((n) => n.cmd > 0).length,
      readyCommands: copNodes.reduce((s, n) => s + n.ready, 0),
      humanCommands: copNodes.reduce((s, n) => s + n.human, 0),
      liveTeams: [...new Set(copNodes.flatMap((n) => n.holders))].length,
      staleTeams: [...new Set(copNodes.flatMap((n) => n.stale))].length,
      /* 全局级/挂不上点的命令（不挂在任何靶标点的活）—— 单独报，否则它们在图上不存在 */
      unassignedCommands: unassignedCmds.length,
      unassignedReady: unassignedCmds.filter((x) => x.ready && !x.human).length,
      unassignedHuman: unassignedCmds.filter((x) => x.human).length,
      /* 两类分开报。合成一个数会让人误以为全是「流程级」或全是「清单外」——
         而这两类要的处理完全不同：一类找 lead 补流程，一类要人裁定归属。 */
      unassignedNoAsset: unassignedCmds.filter((x) => x.why === 'no-asset-id').length,
      unassignedOffTarget: unassignedCmds.filter((x) => x.why === 'asset-not-in-any-unit').length,
    },
    /* 「指挥部 / 全局任务」——不属于任何一个点的活。
       不把它们塞进 nodes（那会让"19 个点"变成 20 个，破坏与靶标清单的一一对应）。 */
    unassigned: unassignedCmds,
    ttlMs: COP_CLAIM_TTL_MS,
    note: 'live = 30 分钟内心跳的认领（口径与板面/引擎一致）；expired = 弃在半路的；cmd = 指向该点的派工命令；没有经纬度，所以是拓扑布点不是地理图。unassigned 是挂不上任何点的命令，分两类：no-asset-id（流程级/需人裁定）与 asset-not-in-any-unit（清单外资产、语料等）。守恒：sum(nodes.cmd) + unassignedCommands 必须等于 dispatch.entries.length。',
  }

  /* ══ 战况一览（2026-10-23 加）═════════════════════════════════════════
   *
   *   为什么加：指挥官的原话 ——
   *     「我是一眼看不出来的……我现在根本看不出来，根本不知道局势如何，更别提指挥了」
   *
   *   查过之后发现两件事：
   *     ① 地图**算过**的东西不少，但页签只画细节、**不画局势** ✗
   *     ② 这张卡片里最该被一眼看到的那条（"最近成果是 25.9 小时前"）**哪都没显示** ✗
   *
   *   所以这里算出"五秒能看完"的那几行，全来自已有数据，**不做任何推断**：
   *     · 最近成果是什么时候（findings 的 created_at）
   *     · 立项进度（objectives 的 status：closed / open / tested）
   *     · 在打的分队数、待派命令数（cop.counts 已有）
   *     · 每个靶标挂了多少成果、其中多少 verified、最近一次是什么时候
   *
   *   ⚠ 体积纪律：内联卡片只剩 ~150 字节余量（45000 预算 / 44854 实测）。
   *     所以 perTarget **只放数字与短名**，不放进任何散文；
   *     放散文会把 cop.nodes 挤出裁剪预算，反而把态势图弄丢 ✗。
   *   ⚠ 一个字段取不到就给 null，**不编 0** —— "0 条成果"和"读不到"是两回事。 */
  const brief = (function () {
    try {
      const m = model || {}
      /* ⚠ 用 model 已有的聚合，**不自己重算** —— 单一真相来源。
         第一版我遍历 chains→objectives 去数 status，而多数 chain 的 objectives 是空的 ⇒
         数出 {closed:0, open:0, tested:0}（全空）✗。model.byStatus 本来就是对的。 */
      const finds = (Array.isArray(m.allFindings) ? m.allFindings : []).filter((f) => !f.dropped)
      let latest = 0
      const perAsset = new Map()
      for (const f of finds) {
        const ta = Date.parse(String(f.createdAt || f.created_at || ''))
        const okT = isFinite(ta)
        if (okT && ta > latest) latest = ta
        const key = String(f.assetId || '')
        if (!key) continue
        const cur = perAsset.get(key) || { f: 0, v: 0, at: 0, last: '' }
        cur.f++
        if (String(f.resultKind) === 'verified') cur.v++
        if (okT && ta >= cur.at) {
          cur.at = ta
          cur.last = String(f.summary || '').replace(/\s+/g, ' ').trim().slice(0, 42)
        }
        perAsset.set(key, cur)
      }

      /* assetId → 短名（地址优先；没有地址就用名字的前一段） */
      const nameOf = new Map()
      for (const ch of m.chains || []) {
        const a = ch && ch.asset
        if (!a || !a.id) continue
        const nm = String(a.address || a.name || a.id).replace(/\s+/g, ' ').trim()
        nameOf.set(String(a.id), nm.slice(0, 24))
      }

      const per = [...perAsset.entries()]
        .map(([id, x]) => ({ a: nameOf.get(id) || id, f: x.f, v: x.v, at: x.at ? new Date(x.at).toISOString() : null, last: x.last }))
        .sort((x, y) => (y.v - x.v) || (y.f - x.f) || (y.at - x.at))

      const bs = (m.byStatus && typeof m.byStatus === 'object') ? m.byStatus : {}
      const cc = cop && cop.counts ? cop.counts : {}
      const num = (v) => (typeof v === 'number' ? v : null)
      return {
        ok: true,
        latestFindingAt: latest ? new Date(latest).toISOString() : null,
        staleHours: latest ? Math.round((Date.now() - latest) / 36000) / 100 : null,
        findings: finds.length,
        objectives: { closed: num(bs.closed), open: num(bs.open), tested: num(bs.tested) },
        fighting: num(cc.fighting),
        liveTeams: num(cc.liveTeams),
        readyCommands: num(cc.readyCommands),
        unassignedCommands: num(cc.unassignedCommands),
        /* 前 12 个（按 verified 数排）—— 再多就不是"一眼"了 */
        perTarget: per.slice(0, 12),
        targetsWithFindings: per.length,
        note: '全部取自引擎已算好的 model（byStatus / allFindings / cop.counts），**不做阶段推断** —— 板面上没有"作战阶段"这个字段，靠散文猜会误报（实测过）。',
      }
    } catch (e) {
      /* 读不到就如实说读不到，绝不编一份看起来像数据的空壳 */
      return { ok: false, error: String((e && e.message) || e) }
    }
  })()

  /* ★★ 战法库匹配（2026-10-22 加）—— 对宪章判据 s4 的**结构性回答**
   *
   *   实测：s4 目标是「>= 80% of war sessions 加载 personal-kb」，实际 6%（13/210）。
   *   persona 写着「开工前先检索战法库」，提示词层只拿到 37%（war）。
   *   宪章自己写着「结构性 > 提示性」—— 所以不再把提示词写得更响，
   *   而是**让战法自己流到统帅眼前**：每轮刷新把与当前在打的东西相关的卡列出来，
   *   检索变成刷新的副产品，不再依赖模型记得。
   *
   *   ⚠ 只做**词面**匹配（frontmatter 的 vuln/type/tags + 标题与结论正文），不涉语义。
   *     给的是"可能相关"，不是"一定相关"。匹配不到就如实说没命中，**不凑数**。
   *   ⚠ 读不到经验库就如实报读不到 —— 不静默给空数组（这一路栽过太多次）。 */
  const kbTop = (function () {
    try {
      /* ⚠ 这里必须用 **node:fs**，不能用函数参数里那个 fs shim ——
         经验库是本地目录，而 shim 只有 resolve/stat/readText/readdir，
         **没有 readdirSync**。用它 ⇒ 抛错 ⇒ 被上面那句 catch 吞掉 ⇒
         报成"经验库里没读到卡"（报的是错的原因，不是真因）。 */
      const errs = []
      const cards = loadKbCards('<KB>/cards', {
        readdir: (d) => fsSync.readdirSync(d, { withFileTypes: true }),
        file: (q) => { try { return fsSync.readFileSync(q, 'utf8') } catch { return null } },
        onError: (d, err) => errs.push(d + ': ' + ((err && err.message) || err)),
      })
      if (!cards.length) return { ok: false, reason: errs.length ? ('读目录失败 ' + errs.slice(0, 2).join(' | ')) : '经验库里没有 .md 卡', cards: [], total: 0 }
      /* 查词 = 「当前在打什么」：主攻方向的靶标与地址、覆盖缺口的靶标、派工工件 */
      /* ★ 查词 = 「当前在打什么」。
       *
       *   ⚠ 这里**不问字段叫什么**，把所有字符串叶子都收进来。
       *     实测踩到：我按 e.unit / e.asset / e.title 取，结果全是 "[object Object]"
       *     —— 板面那些条目的字段名与我的猜测不一样，110 个查词全成垃圾，零命中。
       *     猜字段名这件事在本项目里已经栽过很多次（scope、criteria、agentPreset…）。
       *     与其再猜一次，不如按结构取：是字符串就用，是对象就往下走。
       *
       *   ⚠ 但同时设上限（每个来源最多 N 个词、单源整体最多 400 个），
       *     否则一个巨大的对象会把匹配器压垮，也会让"为什么命中"说不清。 */
      const q = []
      const seen = new Set()
      const push = (x) => {
        const t = String(x == null ? '' : x).trim()
        /* 太短会命中一切（等于没匹配）；[object Object] 这类是取错字段的信号，直接丢 */
        if (t.length < 3 || t.length > 40) return
        if (t.includes('[object')) return
        if (seen.has(t)) return
        seen.add(t)
        q.push(t)
      }
      const harvest = (src, cap) => {
        let n = 0
        const walk = (v, depth) => {
          if (n >= cap) return
          if (typeof v === 'string' || typeof v === 'number') { push(v); n++; return }
          if (!v || typeof v !== 'object' || depth > 2) return
          if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return }
          for (const k of Object.keys(v)) {
            /* 只收"描述性的"键，跳过 id/时间/计数这类噪音 */
            if (/^(id|ids|at|time|ms|n|no|count|seq|rank|path|color)$/.test(k)) continue
            walk(v[k], depth + 1)
          }
        }
        walk(src, 0)
      }
      harvest((schwerpunkt && schwerpunkt.entries) || [], 160)
      harvest((targetMatch && targetMatch.realGap) || [], 40)
      harvest((dispatch && dispatch.entries) || [], 120)
      /* ★★ 词汇映射（2026-10-22 加）—— 板面的词 ≠ 卡片的词
       *
       *   实测：板面+doctrine 的 61 个词 与 卡片 336 个词，**完全相同的只有 1 个**。
       *   所以词面直连不成立。映射表放在 charter/kb-vocab.json ——
       *   **人工判断，可读可审可测**，而不是把"哪类活动对应哪类战法"藏在匹配代码里。
       *
       *   ⚠ 表里没有的 vuln 值一律跳过，并记进 unmapped 报出来 —— 不静默忽略。 */
      let vocab = null, unmapped = []
      try {
        vocab = JSON.parse(fsSync.readFileSync('<HOME>/.dsh/charter/kb-vocab.json', 'utf8'))
      } catch (e) {
        /* 映射表读不到 ⇒ 退化为词面直连（以前的形态），并把原因带出去 */
        vocab = null
      }
      const map = (vocab && vocab.cardVulnToBoardTerms) || null
      const cardVulns = [...new Set(cards.map((x) => x.vuln).filter(Boolean))]
      if (map) for (const v of cardVulns) if (!map[v]) unmapped.push(v)
      /* 翻译：对每张卡，用它 vuln 映射出的板面词去查；映射缺失则退回用它自己的词 */
      /* ★ 翻译走**共享函数**（引擎里那份）—— 生产与测试必须同源，
         否则测试测不到生产真正走的路（实测踩到过）。 */
      const tr = translateBoardTermsToVulns(q, vocab)
      const r = Object.assign(matchKbCards(cards, tr.queries), {
        mapped: tr.mapped,
        matchedVulns: tr.matchedVulns,
      })
      /* 战法库的"形状"：按 type 分组计数。零命中时这一句是有用信息。 */
      const cnt = {}
      for (const x of cards) { const t = x.type || '(无类型)'; cnt[t] = (cnt[t] || 0) + 1 }
      const shape = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).map((t) => t + ' ' + cnt[t]).join(' · ')
      return {
        shape: shape, mapped: r.mapped, unmapped: unmapped,
        ok: true, total: r.total, terms: r.terms.length,
        cards: r.cards.slice(0, 6).map((x) => ({ id: x.id, type: x.type, title: x.title, brief: x.brief, matchedBy: x.matchedBy })),
      }
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e), cards: [], total: 0 }
    }
  })()

  return {
    /* ★ 这里的版本号必须与 v14.host.js 里那处保持一致 ——
       make-engine.mjs 现在有硬闸，对不上会直接让构建失败。
       为什么要有那道闸：这个数字与实际代码不一致时，payload.engine 会报旧版本，
       而代码是新版本，于是任何按版本号判断行为的逻辑（诊断脚本、验证器）都会看错，
       且**没有任何东西会报错**。两处真相各自漂移正是本会话反复踩的坑。 */
    ok: true, generatedAt: new Date().toISOString(), engine: 'opsmap-engine/35', diag: diag,
    /* ★ 把「这份结论按哪个目标算的」写进 payload，页签与诊断都能看到。
       没有它，锚点说目标 A、地图报 B 的时候，两边都不报错，人也看不出来。 */
    goal: goal || null,
    recursion: recursion,
    identity: (targetMatch && targetMatch.identity) ? targetMatch.identity : null,
    charter: charter, criteriaStatus: critOut, ledger: ledger, targets: targetMatch, intelDrive: intelDrive,
    kb: kbTop,
    metrics: metrics, schwerpunkt: schwerpunkt, dispatch: dispatch, swarmView: swarmView,
    cop: cop,
    /* ★ 战况一览（2026-10-23 加）—— payload 上带一份，buildCard 再把它搬进卡片。
       ⚠ 第一版我直接加进了 buildCard，于是它只出现在卡片里、payload 里没有 ——
         而探针/验收器读的是 payload ⇒ "读不到" ✗。补在这里。 */
    brief: brief,
    doctrine: {
      roe: doc.roe, scoring: doc.scoring, strategy: doc.strategy, scoreTable: doc['score-table'],
      intelSemantics: doc['intel-semantics'] ? { version: doc['intel-semantics'].version, why_this_exists: doc['intel-semantics'].why_this_exists, discipline: doc['intel-semantics'].discipline } : null,
      metricsMeta: doc.metrics ? { version: doc.metrics.version, purpose: doc.metrics.purpose, rule: doc.metrics.rule, hard_lessons: doc.metrics.hard_lessons } : null,
      decisionMeta: doc.decision ? { version: doc.decision.version, purpose: doc.decision.purpose, principle: doc.decision.principle, whyNotJustATodoList: doc.decision.why_not_just_a_todo_list, updatedAt: doc.decision.updated_at } : null,
      identityMeta: doc.identity ? {
        version: doc.identity.version, purpose: doc.identity.principle, whyThisIsAFile: doc.identity.why_this_is_a_file,
        theBugThisExistsToPrevent: doc.identity.the_bug_this_exists_to_prevent, invariants: doc.identity.invariants || [],
        registrySize: (doc.identity.registry || []).length, registryGaps: doc.identity.registry_gaps || null,
        integrityChecks: doc.identity.integrity_checks || [], adr: '<HOME>/.dsh/doctrine/ADR-001-身份模型.md',
      } : null,
      tacticsMeta: doc.tactics ? {
        version: doc.tactics.version, updatedAt: doc.tactics.updated_at, note: doc.tactics.note,
        entries: (doc.tactics.tactics || []).map(function (t) {
          return {
            id: t.id, name: t.name, category: t.category, basis: t.basis, defaultRoe: t.default_roe,
            tactics: (t.tactics || []).map(function (x) {
              return { id: x.id, name: x.name, roe: x.roe, how: x.how, discipline: x.discipline, refs: x.refs || [] }
            }),
          }
        }),
      } : null,
    },
    situation: model,
  }
}

/** 把完整 payload 压成模型能读的一句话摘要（模型只需要能与不能，不需要 370KB）。 */
/* ★ 2026-11-05 导出：digest 的措辞是**契约**（verify-map-chain 逐项比文字与结构），
   所以要能对这个函数本身写断言 —— 尤其是"拿不到数据时说不说"。 */
export function digest(p) {
  if (!p || !p.ok) return '作战地图：引擎未能生成 payload。'
  const M = p.metrics, SW = p.swarmView, D = p.dispatch, SP = p.schwerpunkt, T = p.targets
  const h = M && M.ok ? M.headline : null
  const L = []
  L.push('作战地图 v17 · 引擎已刷新（' + p.generatedAt + '）')
  /* ★ 报出「按哪个目标算的」。这一行是这次修的核心可见性：
     地图原来硬编码读 charter.json，与锚点按会话绑定选的目标可能不是同一个，
     而两边都不报错。现在把它写出来，人对不上时可以一眼看见。 */
  if (p.goal && p.goal.id) {
  /* ★ 报出**读的是哪块板面**：实测存在两个板面根，读数会在两个世界之间翻。
     数字看得见、来源看不见 ⇒ 无法判断该信不信。这一行让它自我解释。 */
  if (p.diag && p.diag.boardRoot) L.push('板面：' + p.diag.boardRoot)
  /* 板面过旧就说出来 —— 读的人看不出"这块板子多久没动了"，就会把一周前的战况当现在 */
  if (p.diag && p.diag.boardNewest) {
    const h = (Date.now() - Date.parse(p.diag.boardNewest)) / 3600000
    L.push('板面最新写入：' + (h >= 48 ? Math.floor(h / 24) + ' 天前' : h >= 1 ? Math.floor(h) + ' 小时前' : Math.floor(h * 60) + ' 分钟前') +
      (h >= 24 ? '　⚠ 这块板面已经不新了，上面的数字可能不代表当前战况' : ''))
  }
  /* ★ 多于一个发布者时**必须说出来**（2026-10-23 加）
   *
   *   实测：两份地图实例读不同板面（war 读 ~/.war、hive 读 ~/.hive），却写
   *   同一批卡片文件 ⇒ 同一个板面在同一时刻能显示两个世界
   *   （13/36 零覆盖 19  vs  32/36 零覆盖 0）。
   *
   *   「哪块板面是正典」要人来定 —— 但**读到哪个世界**不该是谜。
   *   这一行让告警跟着数据走：谁看到这张图，谁就知道它可能不是唯一一份。
   *   只有一个发布者时**不出现** —— 不多话。 */
  try {
    const pubs = recentPublishers(30 * 60 * 1000)
    if (pubs.length > 1) {
      L.push('')
      L.push('⚠ **有 ' + pubs.length + ' 份地图实例在写同一批观测文件**（' + pubs.join(' ｜ ') + '）——')
      L.push('   读数取决于谁最后写。上面这些数字可能来自**另一块板面**。')
    }
  } catch { /* 读不到登记表就不说 */ }
    L.push('目标：' + (p.goal.label || p.goal.id) + '（`' + p.goal.id + '`，判据取自 ' + p.goal.charterJson +
      '，来源 ' + p.goal.source + '）')
  }
  if (h) L.push('可计分 ' + h.scorable + '　待研判 ' + h.triage + '　阻断项 ' + h.blockers + '　主攻方向 ' + h.decisions)
  if (SP && SP.ok) L.push('主攻方向 ' + SP.counts.total + ' 条（文书线 ' + SP.counts.paper + ' / 突击线 ' + SP.counts.assault + '）')
  if (T) L.push('靶标覆盖 ' + T.covered + '/' + T.units.length + '　真正零覆盖 ' + T.realGap.length + '　清单外 ' + T.orphan.length)
  /* ★ 拿不到靶标清单时**必须明说**，不能整行消失（2026-11-05）
   *
   *   原来的写法是 `if (T) L.push(...)` —— T 为 null 时这一行**静默消失**。
   *   实测后果：`verify-map-chain` 报「digest 的 17 个数字都能在卡片里对上」失败，
   *   而它给出的理由是空的 —— 因为缺的四项根本不在 digest 里，正则连匹配都匹配不上。
   *
   *   更要紧的是读这份 digest 的是**指挥官与模型**：四行消失之后，
   *   读者得到的信息是"地图没提靶标" —— 而真相是"没有导入靶标清单"。
   *   这与本项目反复吃过的"读不到 ≠ 没有"是同一个错，只不过这次错在**沉默**上。
   */
  else L.push('靶标覆盖 —　真正零覆盖 —　清单外 —（未导入靶标清单：这一格是**读不到**，不是"一家都没有"）')
  if (D && D.ok) L.push('派工层：可直接建卡 ' + D.counts.executable + ' 条 / 需两步 ' + D.counts.twoStep + ' 条 / 需人 ' + D.counts.needsHuman + ' 条')
  if (SW && SW.ok) L.push('蜂群视野：地图建议 ' + SW.mapTotal + ' 条，蜂群此刻看得见 ' + SW.visibleCount + ' 条（落差 ' + SW.gap + '）')
  L.push('')
  /* ★ 战法库：这一行就是"让战法流到眼前"的落点 ——
     统帅不必记得去查，刷新地图即见。 */
  if (p.kb && p.kb.ok) {
    if (p.kb.cards.length) {
      L.push('战法库：与当前主攻方向相关 ' + p.kb.cards.length + ' 张（库内 ' + p.kb.total + '）')
      for (const k of p.kb.cards) L.push('  · ' + k.id + '［' + k.type + '］' + String(k.brief || k.title || '').slice(0, 52))
    } else {
      /* ⚠ 零命中时**不说"没有相关的"** —— 实测那既无用又误导：
         板面说的是资产名/地址/动作词，战法卡按技法打标签（nacos/swagger/密码/frp），
         两套词汇本来就不重叠 ⇒ "没命中"说明的是**匹配器接不上**，不是"没有相关战法"。
         改说战法库的**形状**：它有多少张、都是什么类型 —— 这是有用的，而且诚实。 */
      L.push('战法库：' + p.kb.total + ' 张' + (p.kb.shape ? '（' + p.kb.shape + '）' : '') +
        ' —— 与当前主攻方向**词面未命中**（板面用资产/动作词，卡按技法打标签，两套词汇不重叠）。要按技法检索，用 personal-kb 技能。')
    }
  } else if (p.kb) {
    L.push('战法库：读不到（' + p.kb.reason + '）')
  }
  L.push('完整地图在会话的「作战地图」页签里（人看）。')
  L.push('⚠ 地图只读，不写板面。派工层里的 board 调用参数需要由 lead 用 board_* 工具执行；')
  L.push('   尤其 register-gap / open-front 必须先 board_asset_add 建资产卡，否则意图卡无处可挂。')
  return L.join('\n')
}

/**
 * 抽一份「给人看」的紧凑结构，供浏览器半边的工具卡片渲染。
 *
 * ★ 为什么不能把完整 payload 塞进工具结果：
 *   完整 payload 是 **427,249 字节**（第 8 轮实测；第 7 轮是 419,139 —— 板面在长，
 *   数字会漂，所以这句话要标测量时间，不要当成常量引用）。工具结果是对话内容，
 *   会进模型上下文 —— 塞 400KB 等于每一轮都把上下文打爆。
 *   所以卡片只吃这一份摘要（约 5KB），完整地图仍然只在「作战地图」页签里。
 *
 * ★ 字段全部来自实测形状（不是凭记忆写的）：
 *   metrics.headline = {scorable, realGap, triage, blockers, decisions}
 *   dispatch.counts  = {total, executable, twoStep, needsHuman}
 *   dispatch.entries = [{rank, kindName, short, title, blocking, lane, verb, executor, ...}]
 *   swarmView        = {mapTotal, visibleCount, gap}
 *   schwerpunkt.counts = {total, paper, assault, blockers, externalPending}
 *   targets          = {covered, units[], realGap[], orphan[]}
 *
 * ★ 卡片只取前 8 条派工项。22 条全塞进去既没必要（人看不完），
 *   也让卡片失去「一眼看清」的意义。
 */
/* ══════════════════════════════════════════════════════════════════════════
 * 内联预算 —— 让工具结果永远不越过 DSH 的溢出阈值
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ★ 为什么必须有这一段（实测，不是预防性设计）
 *
 *   DSH 有 `spill-policy: { maxInlineBytes: 50000 }`（见 dsh-base/cordis.patch.yml:350）：
 *   工具结果一旦超过 **50000 UTF-8 字节**，就把完整内容写进溢出文件，
 *   内联只留「头 + 尾 + 一句 (Omitted N bytes. Full formatted result stored at: …)」。
 *
 *   实测本工具的结果是 **59949 字节**（美化格式）⇒ 必然溢出 ⇒
 *   内联字节成了**残缺的 JSON** ⇒ 浏览器半边的「作战地图」页签 JSON.parse 失败
 *   ⇒ 走兜底分支显示原文，**地图打不开**。
 *   而页签按「视图与告示同源」的设计读的正是这份内联字节，所以它无法自救。
 *
 * 两条修法：
 *
 *   ① **不要美化。** `JSON.stringify(x, null, 1)` 的缩进白占 **15465 字节（26%）**。
 *      这个载荷的读者只有两个：模型（只读 digest，677 字节）和浏览器（要 JSON.parse）。
 *      **没有任何一个读者需要缩进。**
 *      去掉之后 59949 → 44484 字节，立刻回到预算内，且一个字节的信息都不丢。
 *
 *   ② **按预算裁剪并诚实标注。** 板面会长大（派工项随资产增加），
 *      所以①只是"现在够用"，不是"永远够用"。这里按字节做二分裁剪，
 *      把裁掉多少条写进 `dispatch.allOmitted` —— 页签会显示出来。
 *      **「少了多少」必须看得见**：否则裁剪本身就成了新的失真源，
 *      而"视图与告示同源"这条纪律要的就是不撒谎。
 *
 * 预算取 45000（阈值 50000 留 5000 余量），给 digest 增长与字段微调留空间。
 */
export const INLINE_BUDGET_BYTES = 45000

/**
 * 把 {digest, card} 压进预算内。**纯函数**，可单测（喂一个超大的合成板面即可验证）。
 *
 * @returns {{ text: string, bytes: number, omittedAll: number, overBudget?: boolean }}
 */
export function fitInlinePayload(digestText, card, budgetBytes = INLINE_BUDGET_BYTES) {
  const encode = (c) => JSON.stringify({ digest: digestText, card: c })
  const bytes = (s) => Buffer.byteLength(s, 'utf8')

  const full = encode(card)
  const fullBytes = bytes(full)
  if (fullBytes <= budgetBytes) return { text: full, bytes: fullBytes, omittedAll: 0 }

  /* ══ 分级裁剪（2026-10-23 改成三级）══════════════════════════════════
   *
   *   原来只有**一级**：裁 `dispatch.all`。而实测（用活板面正确测量之后）
   *   卡片体积是 **44854 / 45000** —— 只剩 146 字节余量 ✗。
   *   也就是说：只要再长一点，一级裁完仍然超预算，就没有第二条退路了。
   *
   *   现在按"最不要紧的先裁"排序，每一级都留一个可用的骨架：
   *     ① `dispatch.all`  —— 派工清单的明细（页签有完整的）
   *     ② `cop.nodes`     —— 态势图的**节点明细**（保留计数与格数，页签有完整的）
   *     ③ `dispatch.top`  —— 连骨架里的 8 条也让位（最后手段，页签仍在）
   *
   *   ⚠ 每一级都**如实记账**（omittedAll / omittedCop / omittedTop），
   *     不静默丢掉东西。读的人要知道这张卡被裁过。
   *   ⚠ 三级都裁完还超预算 ⇒ 返回 `overBudget: true`，**不假装成功**。 */
  const build = (stage) => {
    const c = Object.assign({}, card)
    const omits = { omittedAll: 0, omittedCop: 0, omittedTop: 0 }
    if (card && card.dispatch) {
      const all = Array.isArray(card.dispatch.all) ? card.dispatch.all : null
      if (all) { c.dispatch = Object.assign({}, card.dispatch, { all: [], allOmitted: all.length }); omits.omittedAll = all.length }
    }
    if (stage >= 2 && card && card.cop && Array.isArray(card.cop.nodes)) {
      const n = card.cop.nodes.length
      c.cop = Object.assign({}, card.cop, { nodes: [], nodesOmitted: n })
      omits.omittedCop = n
    }
    if (stage >= 3 && c.dispatch && Array.isArray(c.dispatch.top)) {
      const n = c.dispatch.top.length
      c.dispatch = Object.assign({}, c.dispatch, { top: [], topOmitted: n })
      omits.omittedTop = n
    }
    const s = encode(c)
    return { text: s, bytes: bytes(s), ...omits }
  }

  /* 逐级试；第一级内部再对 `dispatch.all` 保留条数做二分（尽量少裁） */
  for (let stage = 1; stage <= 3; stage++) {
    const all = (stage === 1 && card && card.dispatch && Array.isArray(card.dispatch.all)) ? card.dispatch.all : null
    if (stage === 1 && all && all.length) {
      const at = (n) => {
        const c = Object.assign({}, card, {
          dispatch: Object.assign({}, card.dispatch, { all: all.slice(0, n), allOmitted: all.length - n }),
        })
        const s = encode(c)
        return { text: s, bytes: bytes(s), omittedAll: all.length - n, omittedCop: 0, omittedTop: 0 }
      }
      let lo = 0, hi = all.length, best = null
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const probe = at(mid)
        if (probe.bytes <= budgetBytes) { best = { n: mid, ...probe }; lo = mid + 1 } else hi = mid - 1
      }
      if (best) return best
    }
    const r = build(stage)
    if (r.bytes <= budgetBytes) return r
  }

  /* 三级都裁完还超 ⇒ 如实报 overBudget，不假装成功 */
  const last = build(3)
  return { ...last, overBudget: true }
}

export function buildCard(p) {
  if (!p || !p.ok) return null
  const M = p.metrics, D = p.dispatch, SW = p.swarmView, SP = p.schwerpunkt, T = p.targets
  const list = (D && Array.isArray(D.entries)) ? D.entries : []
  /* 只保留渲染需要的字段。抽成函数是因为下面要用两次（见 top / all 的分工）。 */
  const slim = (e) => ({
    rank: e.rank, kind: e.kind, kindName: e.kindName, short: e.short,
    title: e.title, blocking: !!e.blocking,
    verb: e.verb, executor: e.executor,
    tool: (e.call && e.call.tool) ? e.call.tool : null,
    /* ★ lane 与 ready 在 30 条上共占约 660 字节，而**没有任何读者**：
       · 页签逐条只画 rank / blocking / short|kindName|kind / title / verb / executor
         （见 card.js 的 TOP.map），从没读过这两个；
       · 它们的聚合含义已经在别处说清了 —— lane 聚合到 decision.counts.assault/paper，
         ready 聚合到 dispatch.counts.executable。
       第 11 轮加战术层时卡片只剩 121 字节余量，就是靠砍掉这两个腾出的空间。
       ⚠ 哪天页签要逐条显示「主攻/文书」，就把它加回来 —— 但那时要重新量体量。 */
  })
  /* ★ 逐靶标阶段（第 36 轮补）—— 回答指挥员那句「看不出来到底做到哪步了」。
   *
   * 缺口：引擎的 unitStatus() 早就算好了每个单位的阶段
   *   （零覆盖 / 板面漏登记 / 已登记未立项 / 已交战无结果 / 仅画像无结果 /
   *     有结果待定档 / 有可计分成果），
   * 但 buildCard 只传了 4 个**总数**（covered / units / realGap / orphan），
   * 于是界面从来没有画过逐靶标阶段。实测：19 家靶标里
   * 有可计分成果 1 家、有结果待定档 2 家、仅画像无结果 15 家、已交战无结果 1 家 ——
   * 这个形状界面一个字节都没显示过。
   *
   * 分工照 `top / all` 的成例：同一份字节喂两个槽位，各自渲染需要的粒度 ——
   *   · 卡片（进模型上下文）只画阶段分布一行；
   *   · 页签（只在浏览器，不进上下文）画逐靶标明细。
   * 体量实测：约 +1.5KB（19 家）。 */
  const stages = []
  if (T && Array.isArray(T.units)) {
    const ix = {}
    for (const u of T.units) {
      const lb = (u.status && u.status.label) || '(无阶段)'
      if (ix[lb] === undefined) {
        ix[lb] = { label: lb, rank: (u.status && u.status.rank) || 0, color: (u.status && u.status.color) || '', n: 0, units: [] }
        stages.push(ix[lb])
      }
      const b = ix[lb]
      b.n++
      /* 只带渲染要用的四个字段。`text` 用引擎原文 —— 界面不替它改名，
         否则「显示的名字」和「引擎认的名字」会各自漂移。 */
      b.units.push({
        t: String(u.text || ''),
        a: (u.assets || []).join(' '),
        o: u.objCount || 0,
        s: u.scorable || 0,
      })
    }
    /* 按 rank 升序 = 按「离分数由远到近」。同 rank 内家数多的排前面
       —— 最大的一堆通常就是瓶颈所在，让它先被看见。 */
    stages.sort((x, y) => (x.rank - y.rank) || (y.n - x.n) || x.label.localeCompare(y.label))
  }

  return {
    at: p.generatedAt,
    engine: p.engine,
    /* ★ 卡片必须带上「按哪个目标算的」。
     *
     *   地图现在按**调用方会话绑定的目标**跑判决链（resolveBoundGoal），
     *   而锚点那边也是按绑定选目标。两边同源了，但**人看不出来** ——
     *   页签只显示数字，不显示这份数字是哪份宪章下算出来的。
     *   哪天出现"锚点说 A、地图报 B"，没有这一行就无从对账。 */
    goal: p.goal || null,

    /* ★★ 目标判据的当前状态（实测发现：这才是卡片里唯一随目标变化的东西）
     *
     *   由来：心跳实测发现两个目标的卡片**数字一模一样**（主攻方向 83、落差 -4）——
     *   因为 headline / 派工层 / 蜂群视野 / 靶标覆盖全部来自**板面**，与宪章无关。
     *   地图里唯一随目标变化的产物是 criteriaStatus，而它此前**被卡片整个丢掉了**。
     *   后果：换了目标，页签只是换了个名字，看不出"这个目标达成得怎么样"。
     *
     *   而系统宪章的目的第一条写的正是「指挥官随时能读到『离达成还差什么』」——
     *   地图算了它、页签不画它，等于这条目的没人接。
     *
     *   字段：id / text（判据原文，来自宪章）/ value（引擎算的当前值）/ status / detail（依据）。
     *   ⚠ 判据文字**照抄宪章原文**，界面不替它改名 —— 否则"显示的名字"与
     *     "宪章认的名字"会各自漂移（这是本项目反复踩过的形态）。 */
    /* ★ 战法库匹配结果（2026-10-22 加）
     *
     *   为什么卡片也要带：digest 是给**模型**读的，卡片是给**人**看的（页签画它）。
     *   只加进 digest ⇒ 统帅看得到、指挥官看不到 —— 而宪章第三条目的写的正是
     *   「指挥官随时能读到离达成还差什么」。两边同源，别只给一边。
     *
     *   带上 matchedBy（为什么命中），否则读的人无法判断这条建议凭不凭得住。 */
    /* ★ 地图读的是**哪块板面**（2026-10-23 加）
     *
     *   为什么必须报出来：实测存在**两个板面根**（war 预设读 ~/.war，hive 预设读 ~/.hive），
     *   而两者写同一批卡片文件 ⇒ 页签读数会在两个世界之间来回翻
     *   （32/36 健康 vs 13/36 零覆盖 19）。
     *   **看到数字却不知道它是从哪张板子上算的，就无法判断该信不信。**
     *   报出根目录之后，这种翻转就是自我解释的。 */
    boardRoot: (p.diag && p.diag.boardRoot) ? p.diag.boardRoot : null,
    /* 板面**有多旧** —— 与「读的是哪块」是两件事：
       一块新板子可以很旧，一块老板子也可以刚被写过。两个都要报。 */
    boardNewest: (p.diag && p.diag.boardNewest) ? p.diag.boardNewest : null,
    /* ★ 战况一览（2026-10-23 加）—— 指挥官要「一眼看出局势」的那几行。
       它**不含散文**（体积纪律），只有数字与短名；解释见 index.js 里 brief 的注释。 */
    brief: p.brief || null,
    kb: (p.kb && p.kb.ok) ? {
      total: p.kb.total,
      shape: p.kb.shape || null,
      unmapped: p.kb.unmapped || [],
      cards: (p.kb.cards || []).map(function (x) {
        return { id: x.id, type: x.type, title: x.title, brief: x.brief, matchedBy: x.matchedBy || [] }
      }),
    } : (p.kb ? { total: p.kb.total || 0, shape: null, unmapped: p.kb.unmapped || [], cards: [], error: p.kb.reason || null } : null),
    criteria: (function () {
      const ch = p.charter
      if (!ch || !ch.ok || !Array.isArray(ch.criteria)) return null
      const out = Array.isArray(p.criteriaStatus) ? p.criteriaStatus : []
      const byId = {}
      for (const x of out) byId[x.id] = x
      return ch.criteria.map(function (c) {
        const r = byId[c.id] || {}
        return {
          id: c.id,
          text: c.text || '',
          value: (r.value === undefined ? null : r.value),
          status: r.status || 'na',
          detail: r.detail || c.source || '',
        }
      })
    })(),

    headline: (M && M.ok) ? M.headline : null,
    /* ★ 待你审批的件数（2026-11-05）—— 与 buildStatusSummary 用同一个事实源。
     *
     * 为什么这一格必须上卡片，而不是只留在状态摘要里：摘要是**看门狗读的**，
     * 人看不见。而「有人正等你拍板」是唯一一件只有指挥官能做、且不做就卡住的事 ——
     * 它该出现在最显眼的地方。
     *
     * 只放计数与极少字段：卡片是工具结果的一部分，每轮都进模型上下文（见 top/all 的体量纪律）。
     * 只在 > 0 时由页签画（0 是噪音：没有待批的事不值得占一格注意力）。 */
    approvalsPending: (function () {
      /* 与 buildStatusSummary 同一条路径：引擎真正的出口是 `situation.approvals`
         （第一版写成 `board.approvals` ⇒ 恒为 null，功能空转。见上面的说明）。 */
      const ap = p.situation && Array.isArray(p.situation.approvals) ? p.situation.approvals : null
      if (ap === null) return null
      const pend = ap.filter((a) => a && String(a.status) === 'pending')
      return {
        count: pend.length,
        items: pend.slice(0, 5).map((a) => ({ id: a.id ?? null, actionClass: a.actionClass ?? a.action_class ?? null, target: a.target ?? null })),
      }
    })(),
    /* ★★ 决策块（第 10 轮）—— 回答「现在最该打哪、为什么、哪几件卡在人手上」。
     *
     * 为什么要单开一块，而不是让界面自己从 dispatch 里挑：
     *   「为什么」这个信息**一直都在**——schwerpunkt.items[].why / detail / action / yield
     *   是决策层逐条写好的（军法层生成，有出处）。但 slim() 只挑字段，把它全丢了，
     *   于是界面上只剩「#1 缺报备 R5-1」这种**结论**，没有**理由**。
     *   指挥员看到的是一张待办清单，而不是一份能判断「该不该听它的」的建议。
     *
     * 这就是最初那句诉求的落点：「接下来攻击面应该怎么做 / 通常有哪些战术可以尝试」。
     *   不是要更多数字，是要一句话说清「打哪 + 凭什么」。
     *
     * 只取 1 条（不是 8 条）：卡片体量只剩千余字节，而指挥员真正要判断的永远是
     * 「第一条该不该做」。第 2-8 条在下面的派工层里，顺序没变。 */
    decision: (function () {
      const items = (p.schwerpunkt && Array.isArray(p.schwerpunkt.items)) ? p.schwerpunkt.items : []
      const ents = (D && Array.isArray(D.entries)) ? D.entries : []
      if (!items.length) return null
      const head = items[0]
      /* ⚠ 两个源别搞混（第 10 轮踩过）：
         schwerpunkt.items 有 why / detail / action（决策层的理由），**没有 executor**；
         dispatch.entries 有 executor / needsHuman（派工层谁去干），**没有 why**。
         所以按 rank 关联：理由取前者，人/机归属取后者。 */
      const headEnt = ents.find((e) => e.rank === head.rank) || {}
      return {
        now: {
          rank: head.rank, kindName: head.kindName, short: head.short,
          title: String(head.title || '').slice(0, 60),
          /* 理由原文取自决策层，不在这里编。截断是体量所迫，
             完整 why/detail 仍在 payload.schwerpunkt.items[0]。 */
          why: String(head.why || '').slice(0, 150),
          action: String(head.action || '').slice(0, 70),
          lane: String(head.lane || ''), blocking: !!head.blocking,
          executor: String(headEnt.executor || ''),
        },
        /* 三个数回答「这活到底谁在干」：
           assault = 工蜂唯一能自己执行的类别；needsHuman = 必须人裁定的。
           assault 与 beeReady 都是 0 而 paper 满格 —— 意思就是「现在卡的不是打，是文书」。 */
        counts: {
          total: items.length,
          assault: items.filter((e) => String(e.lane || '') === 'assault').length,
          paper: items.filter((e) => String(e.lane || '') === 'paper').length,
          blocking: items.filter((e) => !!e.blocking).length,
          needsHuman: ents.filter((e) => !!e.needsHuman).length,
          beeReady: ents.filter((e) => String(e.executor || '').indexOf('工蜂') >= 0).length,
        },
        /* 不在这里重复列「哪几件要人拍板」的具体条目 —— cop.unassigned 里已经带了
           那些命令（含 human 标记与标题），页签直接读那份即可。
           卡片体量只剩几百字节，同一个清单出两份是纯浪费。 */
      }
    })(),
    /* ★★ 打法层（第 11 轮）—— 回答最初诉求的第四句：「基于当前信息通常有哪些战术可以尝试」。
     *
     * 数据一直在，而且**引擎早就算好了**：buildModel 里 `tactics: matchTactics(doc, a)`，
     * 按 host_regex / title_regex / server_regex / port_in 匹配 assets（见 opsmap-engine.js:2213），
     * 结果挂在 situation.chains[].tactics 上。实测 30 条链里 11 个资产命中、5 类战术。
     * 只是一直没人把它画出来 —— card.js 里 `tactic` 出现 0 次。
     *
     * 为什么不铺 17 类：卡片只剩几百字节，铺满既放不下也没用 —— 指挥员要的是
     * 「眼下这几个面上通常可以试什么」，不是一本兵法目录。
     * 所以按**当前命中面**排序（命中资产多的在前），只取前 3 条，并带上命中的地址，
     * 让人能对上号。全量（33 条子战术，含 how / roe / discipline）留在 payload.doctrine.tacticsMeta。
     *
     * 纪律（不可伪造情报的延伸）：这里**只搬运引擎的匹配结果**，不自己拼映射表。
     * 战术与资产的对应关系只由 doctrine 的 detect 规则决定，代码里不许出现靶标知识。 */
    tactics: (function () {
      const chains = (p.situation && Array.isArray(p.situation.chains)) ? p.situation.chains : []
      const byId = new Map()
      let hitAssets = 0
      for (const c of chains) {
        const tis = Array.isArray(c.tactics) ? c.tactics : []
        if (!tis.length) continue
        hitAssets++
        const addr = String((c.asset && c.asset.address) || '')
        for (const t of tis) {
          const k = String(t.id || '')
          if (!k) continue
          if (!byId.has(k)) byId.set(k, { id: k, name: String(t.name || '').slice(0, 18), n: 0, steps: Number(t.stepCount) || 0, addrs: [] })
          const e = byId.get(k)
          e.n++
          if (addr && e.addrs.length < 2 && e.addrs.indexOf(addr) < 0) e.addrs.push(addr.slice(0, 26))
        }
      }
      const arr = [...byId.values()].sort((x, y) => (y.n - x.n) || (y.steps - x.steps))
      if (!arr.length) return null
      return { top: arr.slice(0, 3), kinds: arr.length, assets: hitAssets }
    })(),
    dispatch: D ? {
      total: D.counts.total, executable: D.counts.executable,
      twoStep: D.counts.twoStep, needsHuman: D.counts.needsHuman,
      /* ★ top 与 all 的分工（第 8 轮定的）
       *
       * 之前只有 top（前 8 条），而 22 条里的 **3 条 assault（工蜂唯一能执行的
       * 那类）恰好排在第 20-22 位，全被砍掉** —— 摘要给模型看的时候，最重要的
       * 三条反而看不见。这不是「少一点细节」，是漏掉了主攻方向。
       *
       * 现在两条都出，但各自服务不同的读者：
       *   top  → **卡片**（进模型上下文，必须小）。保持 8 条不变。
       *   all  → **页签**（只在浏览器里，不进上下文，所以可以全量 22 条）。
       *
       * 体量实测：摘要 2,237 B → 带 all 之后约 5,280 B（+3,043 B）。
       * 这是每轮多 3KB 换「主攻方向不再被截断」，值。 */
      top: list.slice(0, 8).map(slim),
      all: list.map(slim),
    } : null,
    swarm: SW ? { mapTotal: SW.mapTotal, visibleCount: SW.visibleCount, gap: SW.gap } : null,
    schwerpunkt: SP ? { total: SP.counts.total, paper: SP.counts.paper, assault: SP.counts.assault } : null,
    targets: T ? { covered: T.covered, units: T.units.length, realGap: T.realGap.length, orphan: T.orphan.length } : null,
    /* 逐靶标阶段。null 表示「拿不到」（没导入靶标清单），不是「一家都没有」——
       界面必须把这两种画得不一样。 */
    stages: stages.length ? stages : null,
    /* 态势图（COP）。null = 算不出来（不该发生），与"一个点都没有"必须画得不一样。
     *
     * ★ 为什么这里要**逐字段投影**，不整份透传（第 9 轮改）：
     *   卡片是工具结果的一部分，会进模型上下文，第 8 节把上限钉在 16KB。
     *   整份透传时 cop 一项就 6,766 B，而其中 kind / ready / executor / why / zones
     *   这些字段**页签根本不用**（见 card.js 的 renderCop）—— 纯占位。
     *   第 9 轮把「清单外资产」那 9 条补进 unassigned 之后，卡片从 15,548 涨到
     *   17,205，直接越 16,384 的上限。所以按「页签真正读什么」投影。
     *
     *   完整记录仍在 payload.cop（页签以外、按需读取的读者拿全量），**信息没丢**：
     *   - unassigned 页签只用 rank / human / title（+ 计数里的两类细分）
     *   - nodes 页签只用 no/name/addrs/stage/rank/live/expired/open/cmd/scorable/holders/stale
     *   哪天页签要显示 why 或 zones，就在下面加回来 —— 但那时要重新量体量。 */
    cop: (p.cop && Array.isArray(p.cop.nodes) && p.cop.nodes.length) ? {
      nodes: p.cop.nodes.map((n) => ({
        no: n.no, name: n.name, addrs: n.addrs, stage: n.stage, rank: n.rank,
        live: n.live, expired: n.expired, open: n.open, cmd: n.cmd, scorable: n.scorable,
        holders: n.holders, stale: n.stale,
      })),
      counts: p.cop.counts,
      unassigned: (p.cop.unassigned || []).map((u) => ({ rank: u.rank, human: u.human, title: u.title, why: u.why })),
      ttlMs: p.cop.ttlMs,
      note: p.cop.note,
    } : null,
  }
}

export function apply(ctx, config) {
  const fs = ctx.get('fs')
  if (fs === undefined) { console.error('[opsmap] fs 服务不可用，地图无法读取 board'); return }
  const cfg = Object.assign({}, DEFAULTS, config || {})

  /* 注册 opsmap_refresh：指挥员/工蜂在对话里一句话把最新局势拉出来。
   *
   * 写法照抄 hive/plugins/board —— 它也在 preset 的 apply 里注册工具，而且
   * 那些工具（board_snapshot 等）在蜂群会话里确实可用。所以这是本仓库里
   * 「preset 插件注册工具」唯一经过实战验证的写法：
   *     ctx.tools.register(defineTool({...}))
   * 不加 ctx.effect 包裹（register 返回的 disposer 由 Cordis 按注册时的 ctx
   * 自行托管，再套一层会被当成外层 effect 的清理函数而立刻撤销注册）。
   *
   * ⚠ 不要试图用 `ctx.tools.schemas()` / `ctx.tools.get()` 从宿主平面验证这个
   *   工具「有没有注册上」—— **那个方法是错的**。本会话实测：连 board_snapshot
   *   （蜂群每天在调）在任何 scope 下都查不到，包括 standingKeyFor 返回的 key。
   *   我因此一度得出「注册不生效」的错误结论，还顺手排除了五个无关嫌疑。
   *   schema 读取看不到 preset 作用域里的工具，这是读取面的边界，不是注册的失败。
   *   正确的验证方式只有一个：**在真实会话里看工具表**（见 README 与 HANDOFF）。
   */
  ctx.tools.register(
    defineTool({
      name: 'opsmap_refresh',
      description:
        '刷新作战地图引擎并返回一句话摘要：主攻方向条数、派工层可执行条数、以及「地图建议 vs 蜂群此刻看得见」的落差。' +
        '人看的完整地图在会话的「作战地图」页签。地图只读，不写板面。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(_args, exec) {
        /* ★ 先解析「调用方会话绑定了哪个目标」，再按那个目标跑判决链。
         *
         *   在此之前这里是硬编码的 charter.json —— 于是锚点说目标 A、
         *   地图报 B 的判据，两边都不报错。resolveBoundGoal 的注释里有完整说明。 */
        const goal = await resolveBoundGoal(fs, cfg, exec)

        /* ★ isPrimary 的判定**只有一个来源**：isPrimaryGoal(goals, goal)。
         *   原来心跳用 `i === 0`、工具用 `goal.id === primaryGoalId(...)` ——
         *   同一条规则两处实现，改一处就漂成"看门狗盯着另一个目标"。
         *   而且它**不是**"是不是会话绑的那个"：两个会话各绑一个目标时，
         *   基名那份会被来回覆盖，看门狗读到什么取决于谁最后刷新。 */
        const goalsForPrimary = await allGoals(fs, cfg)
        const { card, digestText } = await refreshAndPublish(fs, cfg, goal, isPrimaryGoal(goalsForPrimary, goal), goalsForPrimary)

        /* 返回 JSON：`digest` 给模型读（人类可读的那段话），`card` 给浏览器半边的
         * 工具卡片渲染。两者都源自同一个 payload，所以卡片不可能和模型看到的
         * 数字不一致 —— 这正是 hive/board-ui 那条「视图与告示同源」的原则。
         *
         * schema 是 string，所以这里必须返回字符串；JSON 是合法字符串。
         * 模型读 digest 就够了，card 那一段它可以直接忽略。
         *
         * ★ 这里**不美化、且按字节预算裁剪**（见 fitInlinePayload 的说明）：
         *   美化会让结果越过 DSH 的 50000 字节溢出阈值，内联字节变成残缺 JSON；
         *   裁掉多少条会写进 card.dispatch.allOmitted，页签会如实显示。
         *
         * ★ 页签**不再依赖这份字节**了（它读磁盘上按目标分的那份完整的）。
         *   这里裁剪只为两件事：给模型省上下文、避免越过溢出阈值。
         *   所以「少画几条」不再是对页签的妥协，只是对上下文的克制。 */
        return fitInlinePayload(digestText, card).text
      },
    }),
  )

  /* ── 心跳：按目标逐个自动刷新 ────────────────────────────────────────
   *
   * ★ 补的是初衷里明说的「如果需要心跳机制……那就进行设计并开发」。
   *   在此之前我只做了"上报"（mapStale 报出地图多久没刷新），没做"自动刷新" ——
   *   于是「指挥官随时能看到战场局势」实际是「有人问的时候才看得到」。
   *   这个定时器让后者变成前者：不管有没有人问，地图都在自己更新。
   *
   * 三条纪律：
   *   ① **默认关闭**（heartbeatMs: 0）。会自己动起来的定时器该由部署方显式授权，
   *      而不是插件自己拍。war/hive 的组合里显式开启。
   *   ② **刷所有目标**，不只默认那个。页签按会话绑定取对应那份，
   *      所以每个可能有会话绑上去的目标都得有新鲜的那一份。
   *   ③ **unref + ctx.effect 清理**。unref 保证它不阻止进程退出；
   *      effect 保证卸载时定时器被清掉。两者缺一都会留下幽灵。
   *
   * 它**只读板面、只写观测文件** —— 与「地图不写板面」不冲突。
   */
  const beat = Number(cfg.heartbeatMs)
  if (Number.isFinite(beat) && beat > 0) {
    const beatState = { ticks: 0, errors: 0, lastAt: null, goals: 0, lastError: null }
    const hbPath = String(cfg.statusPath).replace(/\.json$/, '.heartbeat.json')

    /* 心跳自己的观测口。**在每跳结束时写**，不再另开一个定时器 ——
     * 上一版有个每 60 秒独立刷新的定时器，那既多一个幽灵源，
     * 又会在没有任何一跳发生时也照写（看起来像"心跳活着"，其实是空转）。
     * 现在"写完最后一跳才写观测口"，观测口的 lastAt 就等于最后一跳的时刻。 */
    const flushBeat = () => {
      writeObserved(hbPath, JSON.stringify(Object.assign({}, beatState, { publish: publishHealth() }), null, 2), 'heartbeat')
    }

    const runBeat = async () => {
      try {
        const goals = await allGoals(fs, cfg)
        beatState.goals = goals.length
        for (const g of goals) {
          try {
            /* 主目标的判定走**同一个纯函数**（isPrimaryGoal），与工具路径一致 ——
               原来这里是 `i === 0`、那边是 `goal.id === primaryGoalId(...)`，
               同一条规则两处实现，改一处就漂。 */
            await refreshAndPublish(fs, cfg, g, isPrimaryGoal(goals, g), goals)
          } catch (e) {
            /* 单个目标失败不影响其余 —— 逐目标隔离。
               否则一个坏目标会让其余目标也永远不刷新，而界面上看不出来。 */
            beatState.errors++
            beatState.lastError = 'goal ' + (g && g.id) + ': ' + String((e && e.message) || e)
          }
        }
        beatState.ticks++
        beatState.lastAt = new Date().toISOString()
      } catch (e) {
        beatState.errors++
        beatState.lastError = String((e && e.message) || e)
      }
      await flushBeat()
    }

    /* 延后第一跳（照 board2「不要和启动抢窗口」的成例），然后按周期跑。
       unref 保证它不阻止进程退出；effect 保证卸载时被清掉。两者缺一都会留下幽灵。 */
    const first = setTimeout(() => { void runBeat() }, Math.min(beat, 15000))
    if (first && typeof first.unref === 'function') first.unref()
    const timer = setInterval(() => { void runBeat() }, beat)
    if (timer && typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => {
      clearTimeout(first)
      clearInterval(timer)
    })
  }
}

export default { name, apply, inject }
