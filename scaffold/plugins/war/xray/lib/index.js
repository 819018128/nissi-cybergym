/**
 * war-xray — 战争模式的 X 光机
 *
 * WHY THIS EXISTS
 * ---------------
 * 战争模式的板面（board）、地图（opsmap）、桥接（bridge）都有代码保证，
 * 唯独「运行时到底把时间花在哪」是黑盒。统帅能看见战果，看不见过程：
 * 哪一步卡了 40 分钟、哪个工具被空转调用 20 次、哪个 turn 在等模型、
 * 哪个分队派出去就没声了 —— 全靠事后回忆。
 *
 * 本插件不改变任何行为，只做三件事：
 *   1. 监听 DSH 暴露的生命周期事件，追加写入 jsonl；
 *   2. 提供 xray_report，把一次运行拆成「思考 / 工具 / 空转 / 间隔」四类耗时；
 *   3. 提供 xray_hotspots，跨会话统计堵点频次，回答「这套体系有没有变好」。
 *
 * WHY A FILE, NOT A SERVICE
 * -------------------------
 * 同 board 的理由：多个独立挂载的 preset 共享同一份观测数据，需要一个按路径
 * 共享的存储，而不是一个 realm 内的服务实例。本插件只注册工具、只写自己的
 * 目录，不 provide() 任何服务，因此不需要 isolate realm。
 *
 * WHY IT MUST NEVER THROW
 * -----------------------
 * 它是旁观者。任何一次记录失败都不允许影响被观测的会话 —— 所有写盘路径都
 * 包在 try/catch 里，失败即静默丢弃。这是观测工具的基本纪律：
 * 观测者不能成为被观测系统的故障源。
 *
 * DATA LAYOUT
 * -----------
 *   <WAR_ROOT>/_xray/YYYY-MM-DD.<instanceId>.jsonl
 *       一行一个事件，追加写。**每个实例只写自己的文件**（事故说明见 record()）。
 *       instanceId = p<pid 的 36 进制>-<进程内实例序号>-<4 位随机>，
 *       所以「这条事件是谁写的」可以直接从文件名读出来，不必靠猜。
 *   <WAR_ROOT>/_xray/YYYY-MM-DD.jsonl
 *       老布局（多实例共写一个文件）。**读取端仍然读**，写入端不再写 ——
 *       换布局不能把历史数据一起换掉。
 *
 * 事件种类（kind 字段）：
 *   pre-step    agent 每一步开始
 *   request     agent 发起模型请求（思考时间起点）
 *   req-error   模型请求失败
 *   turn-stop   turn 即将结束
 *   status      agent 状态变化
 *   error       agent 异常
 *   sub-start   子代理建立
 *   sub-end     子代理结束（带 terminal outcome）
 *   tool        工具调用（含耗时）
 *   gap         地图命令未落地（由 xray 自行对账时写入）
 *   turn/start  turn 开始（2026-11-05 新增）
 *   step/start  step 开始（2026-11-05 新增）
 *   turn/end    turn 结束，带 reason.kind（2026-11-05 新增）
 *   inbox/spliced  收件箱被拼接，带 outcome（2026-11-05 新增）
 *
 * WHY THE LAST FOUR CAME LATE, AND FROM A DIFFERENT BUS
 * -----------------------------------------------------
 * 前九种全部来自 agent 的 **dispatch 事件**（emit / serial / waterfall）。
 * dsh-agent-loop 的 dispatch 表只有这八个名字：
 *   agent/pre-step · agent/request · agent/request-error · agent/turn-stopping
 *   agent/status · agent/error · agent/inbox/{inserted,discarded,claimed}
 * 而 turn/start · step/start · turn/end · agent/inbox/spliced **不在那张表里** ——
 * 它们是 **SessionEvent**：`this.session.append('turn/start', {turn})` 写进会话日志，
 * 循环里没有任何 emit 对应它们。所以「补埋点」不是在这里多加一行 ctx.on 就完事，
 * 而是在总线上找一个能看见会话日志的入口。
 *
 * 那个入口是 **`session/event`**（dsh-session 模块原话：persistence plugins
 * subscribe to `session/event`, drain on `session/flush`）。它的回调签名与其它
 * 事件不同：`(session, event)`，两个参数。
 *
 * 两条代价必须写死在这里，否则下一个人会踩：
 *   1. 它是**全量会话事件流**，含 `assistant/chunk` 流式分片（一次回答可上千条）
 *      ⇒ 订阅端**必须白名单过滤**（SESSION_EVENT_KINDS），否则观测文件会被写爆；
 *   2. `session` / `event` 是运行时活对象 ⇒ 只读 `session.id`、`event.type`、
 *      `event.data.*` 这几个叶子字段，绝不 JSON.stringify 整个对象。
 *
 * 为什么值得补：崩溃形态「turn/start → inbox/spliced → turn/end 中间无 step/start」
 * 此前**无法判定**（四种 kind 计数全为 0，2026-10-30 那 5 次崩溃因此没能定因），
 * 而 turn/end 自带的 `reason.kind` 正好回答此前一直缺的「回合为何停」。
 *
 * 2026-11-07 · 两个半区（P1 方向修正，台账 F-041…F-047）
 * -------------------------------------------------------
 * 上面那段历史仍然成立，但采集**范围**变了。取证结论是：dsh 自己的会话轨迹
 * （<DSH_HOME>/sessions/**\/session.jsonl.zstd）已经完整包含 token、工具成败与
 * 耗时、步/回合边界、模型重试、上下文压缩、审批与沙箱变更 —— 而 xray 平行采的
 * 5,240 条事件里约 93% 与它重复，最值钱的 token 与重试恰好一条没采。
 *
 * 所以现在分两个半区，**每个分析轴只有一个来源**：
 *
 *   采集半区（本文件的 record()，collect='slim' 时只写这四类）
 *     error        agent 异常，**带 stack**（轨迹里只有 message，这是 xray 独有的）
 *     status       agent 状态变化（轨迹里没有）
 *     sub-start    子代理建立（轨迹只有 subagent/descriptor：有存在性、无时序）
 *     sub-end      子代理结束（同上，且带 terminal outcome）
 *
 *   分析半区（lib/trace.js 读轨迹，翻译成 xray 形状的事件）
 *     步 / 模型请求 / 工具调用与耗时 / 回合边界 / 自身调用采用率 / token /
 *     重试 / 压缩 / 审批
 *
 * 为什么分析半区要"翻译成 xray 事件"而不是另写一套：analyze() 的口径是「相邻
 * 事件的间隔归属于前一条」（request ⇒ 等模型，tool ⇒ 等工具）。轨迹的事件名不同，
 * 时间形态却完全对得上，翻译一层就够了。改四处分析器必然漂移，改一处不会。
 *
 * `collect: 'full'` 仍然保留 —— 想看"旧口径与新口径差多少"（或轨迹不可用时）把
 * 它打开即可，历史全量文件也照旧能读。默认 slim。
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { listTraces, loadTrace, readTraceAsEvents, traceLabel } from './trace.js'

export const name = 'war-xray'
export const inject = ['tools']

// 进程内实例序号：同一个进程可能挂多份 war-xray（多 ctx / 多 preset），
// 光靠 pid 区分不开，所以实例 id 里必须带一个进程内自增位。
let instanceCounter = 0

// ── 小工具 ──────────────────────────────────────────────────────────────────

const nowMs = () => Date.now()
const dayKey = (d) => new Date(d).toISOString().slice(0, 10)

/** 安全取一个可能不存在的深字段，永不抛错。 */
function pick(obj, ...keys) {
  let cur = obj
  for (const k of keys) {
    if (cur === null || cur === undefined) return undefined
    try { cur = cur[k] } catch { return undefined }
  }
  return cur
}

/** 把任意值压成一个短字符串，用于落盘，避免把整个会话历史写进 xray。 */
function brief(v, max = 160) {
  if (v === null || v === undefined) return undefined
  let s
  if (typeof v === 'string') s = v
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v)
  else {
    try { s = JSON.stringify(v) } catch { s = String(v) }
  }
  if (typeof s !== 'string') s = String(s)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 从 Error（或任何带 stack 的对象）里取**前若干帧**做成一行。
 *
 * 为什么不能直接用 brief()：brief 会把所有空白压成单空格，栈就变成一坨看不出
 * 层级的文字。这里保留帧边界（用 ' | ' 连接）但**只取前 maxLines 帧** ——
 * 落盘要的是「崩在哪个函数」，不是整条栈。
 *
 * 为什么要它：2026-10-30 那 5 次崩溃的 error 事件只有 message
 * （`Cannot read properties of undefined (reading 'kind')`），没有 stack，
 * 于是数据只能证明「崩在 pre-step 之后 0–1ms」，证明不了「是哪个插件、哪一行」。
 * 上游 `agent/error` 的 payload 是 `{turn, step, error}`，**error 是 Error 对象本身**
 * —— 栈一直都在，是我们没落盘。
 */
function stackOf(err, maxLines = 8, max = 900) {
  try {
    const raw = pick(err, 'stack')
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, maxLines)
    const s = lines.join(' | ')
    return s.length > max ? s.slice(0, max) + '…' : s
  } catch {
    return undefined
  }
}

/** 从 Unix 毫秒格式化成人类可读的时长。 */
function dur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return ms + 'ms'
  const s = ms / 1000
  if (s < 60) return s.toFixed(1) + 's'
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  if (m < 60) return m + 'm' + (rs ? rs + 's' : '')
  const h = Math.floor(m / 60)
  return h + 'h' + (m % 60 ? (m % 60) + 'm' : '')
}

// ── 身份归因：per-agent 统计的地基 ──────────────────────────────────────────
//
// WHY THIS EXISTS（真实缺陷，2026-10-30：「请求」列恒为 0）
// ------------------------------------------------------
// 旧实现取身份的写法是 `pick(info, 'this', 'agent', 'id')`，全文件出现 7 次。
// 事件 payload 上**根本没有 `this` 这个键** —— pick 走到第一层就返回 undefined，
// 于是 request / pre-step / status / error / turn-stop 落盘时 `agent` 字段被
// JSON.stringify 直接丢掉。落盘样本就是
//     {"t":1793350112296,"seq":3,"kind":"request"}
// 而同一份文件里的 tool 事件却带着
//     "agent":"1f4c0816-e810-4b7b-8e65-7fb194afe283"
// （那条走的是 exec.agent.id，是另一条取值路径，所以它没坏）。
// 于是报告里「各 agent 活动量」的「请求」恒为 0，而总请求数是真值。
// 这不是数据缺失，是**取值路径写错**——7 个 handler 一起错。
//
// 上游事实（读源码确认，不是猜）：
//   · dsh-agent/lib/types/dispatch.js → agentEvents()：
//       const fused = (payload) => ({ ...payload, agent })
//       waterfall(name, payload, ...rest) → ctx.waterfall(carrier, name, fused(payload), …)
//     身份是派发器**注入 payload** 的，键名就叫 `agent`。
//   · dsh-agent/lib/types/runtime-types.d.ts → Events 声明：
//       'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; … }, next)
//     且 `Agent.id` 的注释是「The single identity shared with session」。
//   · cordis/lib/index.js → EventsService.dispatch()：
//       const thisArg = … args.shift()   ← 第一个实参被取走当 this 并 bind
//     所以 listener 的实参只剩 (payload, next)，args[0] 就是 payload。
// 结论：唯一正确的取值路径是 payload.agent.id。

/**
 * 事件身份 → 字符串 id。取不到一律返回 null，**绝不抛错**（观测者不能成为故障源）。
 * 返回 null 而不是 undefined 是有意的：字段恒定存在，报告才能把"未归因"当一类
 * 显式计数，而不是靠"字段缺失"这种看不见的状态。
 */
export function agentIdOf(p) {
  try {
    const a = pick(p, 'agent')
    if (typeof a === 'string') return a ? (brief(a, 60) || null) : null
    const id = pick(a, 'id') ?? pick(p, 'agentId') ?? pick(p, 'sessionId')
    if (id === undefined || id === null || id === '') return null
    return brief(id, 60) || null
  } catch { return null }
}

/** 一个 agent（或"未归因"）的活动量桶。字段与落盘 kind 一一对应，不掺派生量。 */
function emptyBucket() {
  return {
    events: 0, requests: 0, tools: 0, preSteps: 0, errors: 0,
    subStarts: 0, subEnds: 0,
    modelWaitMs: 0, modelWaitSegments: 0,
    toolSpanMs: 0, toolSpanSegments: 0,
    firstT: 0, lastT: 0,
  }
}

/** 桶合并（跨文件折叠用）：求和 + 时间取包络。 */
function mergeBucket(dst, src) {
  if (!dst || !src) return dst
  for (const k of Object.keys(emptyBucket())) {
    if (k === 'firstT') dst.firstT = dst.firstT ? Math.min(dst.firstT, src.firstT || dst.firstT) : (src.firstT || 0)
    else if (k === 'lastT') dst.lastT = Math.max(dst.lastT || 0, src.lastT || 0)
    else dst[k] = (dst[k] || 0) + (src[k] || 0)
  }
  return dst
}

/**
 * 按 agent 归因的全部统计 —— **唯一**实现：analyze()（xray_report）与
 * xray_compare 都读它，因此两边口径不可能漂移。
 *
 * 间隔归因沿用 xray_report 既有口径：一段空档归属于「前一条事件」——
 *   · 前一条是 request ⇒ 这段是等模型响应（落进**前一条事件**那个 agent 的桶）
 *   · 前一条是 tool    ⇒ 这段是工具在执行（同上）
 * 这样每个间隔都属于且只属于一个桶，于是
 *     Σ 各 agent 的 modelWaitMs + 未归因 modelWaitMs === 全局 modelWaitMs
 * 是**结构上成立**的等式，而不是"应该大致相等"。报告里会把这条等式打出来。
 *
 * 注意（并发下的诚实边界）：多个 agent 的事件在这一个实例文件里是**交错**的，
 * 所以"某 agent 的等模型时长"在它与其他 agent 并发时是**上限**——那段间隔可能是
 * 别的 agent 的事件把它切短的。它是一份精确的**划分**，不是独立测量。
 *
 * @param {object[]} events 落盘事件（任意顺序）
 * @returns {{byAgent:object, unattributed:object, events:number, modelWaitMs:number,
 *            modelWaitSegments:number, toolSpanMs:number, toolSpanSegments:number}}
 */
export function attributeByAgent(events) {
  const byAgent = {}
  const unattributed = emptyBucket()
  const out = {
    byAgent, unattributed, events: 0,
    modelWaitMs: 0, modelWaitSegments: 0, toolSpanMs: 0, toolSpanSegments: 0,
  }
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : []
  if (!list.length) return out
  const sorted = list.slice().sort((a, b) => (a.t - b.t) || ((a.seq ?? 0) - (b.seq ?? 0)))

  let lastT = sorted[0].t
  let prevBucket = null
  let prevKind = null
  let prevStream = null
  for (const e of sorted) {
    const gap = e.t - lastT
    // 间隔先归属给**前一条事件**的桶（含"前一条未归因"的情况）。
    //
    // 跨流不算（2026-11-07）：一份报告会把主会话与各子代理会话的轨迹合并成一张表，
    // 而它们是**并行**的。A 会话的工具开始到 B 会话的下一条事件，那段间隔谁也不属于；
    // 硬算会造出「A 的工具执行了 40 分钟」这种假账（与"重放投影造出假耗时"同族）。
    // 判据是 stream 相同：xray 事件标 'xray'，轨迹事件标各自的文件路径，
    // 历史数据没有这个字段 ⇒ undefined === undefined ⇒ 行为与改前一致。
    const sameStream = (prevStream ?? null) === (e.stream ?? null)
    if (prevBucket && prevKind && sameStream) {
      if (prevKind === 'request') {
        prevBucket.modelWaitMs += gap
        prevBucket.modelWaitSegments++
        out.modelWaitMs += gap
        out.modelWaitSegments++
      } else if (prevKind === 'tool') {
        prevBucket.toolSpanMs += gap
        prevBucket.toolSpanSegments++
        out.toolSpanMs += gap
        out.toolSpanSegments++
      }
    }

    const id = typeof e.agent === 'string' && e.agent ? e.agent : null
    const bucket = id ? (byAgent[id] ||= emptyBucket()) : unattributed
    bucket.events++
    out.events++
    if (!bucket.firstT) bucket.firstT = e.t
    bucket.lastT = e.t
    switch (e.kind) {
      case 'request': bucket.requests++; break
      case 'pre-step': bucket.preSteps++; break
      case 'tool': bucket.tools++; break
      case 'error':
      case 'req-error': bucket.errors++; break
      // sub-start / sub-end 的归属对象是**子代理**（字段 child），不是写入者，
      // 所以不在这里按 e.agent 计；由 summarizeSquads() 按 child 记到子代理头上。
      default: break
    }

    prevBucket = bucket
    prevKind = e.kind
    prevStream = e.stream ?? null
    lastT = e.t
  }
  return out
}

/**
 * 分队账本：派兵 / 收兵 / 派了没收。
 *
 * 归口规则（三种 case 互斥且穷尽，派过兵的 agent 必落其一）：
 *   ① 有 sub-end                     → 收兵（harvested）
 *   ② 无 sub-end 且无任何 tool 事件   → 派了没收（noEndNoTool）＝ 派出去什么都没干
 *   ③ 无 sub-end 但有 tool 事件       → 干了活没报收（noEndHasTool）
 *
 * 退化保护：数据里没有 sub-start/sub-end 时，hasStarts/hasEnds 为 false，
 * 由渲染层如实说"本窗口看不到派兵事件"，**不会**报出一个 0% 的收兵率——
 * "没有数据"和"收兵率为零"是两件事，混为一谈就是假结论。
 *
 * @param {object[]} events
 * @returns {object} 见上方字段
 */
export function summarizeSquads(events) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : []
  const att = attributeByAgent(list)
  const agents = att.byAgent
  const sq = {
    agents,
    unattributed: att.unattributed,
    starts: 0,
    ends: 0,
    dispatchToolCalls: 0,
    dispatched: [],
    harvested: [],
    endedNoStart: [],
    noEndNoTool: [],
    noEndHasTool: [],
    harvestedAmongDispatched: [],
    hasStarts: false,
    hasEnds: false,
  }
  const seenStart = new Set()
  const seenEnd = new Set()
  const ensure = (id) => (agents[id] ||= emptyBucket())

  for (const e of list) {
    if (e.kind === 'sub-start') {
      sq.starts++
      const child = typeof e.child === 'string' && e.child ? e.child : null
      if (child) {
        ensure(child).subStarts++
        if (!seenStart.has(child)) { seenStart.add(child); sq.dispatched.push(child) }
      }
    } else if (e.kind === 'sub-end') {
      sq.ends++
      const child = typeof e.child === 'string' && e.child ? e.child : null
      if (child) {
        ensure(child).subEnds++
        if (!seenEnd.has(child)) { seenEnd.add(child); sq.harvested.push(child) }
      }
    } else if (e.kind === 'tool' && e.tool === 'subagent') {
      // 派兵动作：工具被调了一次。它未必产出可观测的 sub-start（spawn 失败、
      // 或 sub-start 落在别的分片里），所以它是**覆盖率的分母**，不是"成功派兵"。
      sq.dispatchToolCalls++
    }
  }

  sq.hasStarts = sq.starts > 0
  sq.hasEnds = sq.ends > 0
  sq.endedNoStart = sq.harvested.filter((id) => !seenStart.has(id))
  for (const id of sq.dispatched) {
    const b = agents[id] || emptyBucket()
    if (b.subEnds > 0) { sq.harvestedAmongDispatched.push(id); continue }
    if (b.tools > 0) sq.noEndHasTool.push(id)
    else sq.noEndNoTool.push(id)
  }
  return sq
}

/** 收兵率 = 有 sub-end 的分队数 / 有 sub-start 的分队数。分母为 0 时返回 null。 */
export function harvestRate(sq) {
  if (!sq || !sq.dispatched || !sq.dispatched.length) return null
  return sq.harvestedAmongDispatched.length / sq.dispatched.length
}

/**
 * 派兵覆盖率 = 观测到的分队数 / 派兵动作数。
 *
 * 分母口径必须写明，否则这个百分比会被读成别的东西：
 *   · 首选 subagent 工具调用次数（"派了几次兵"的直接计数）；
 *   · 该窗口没有 subagent 工具调用但有 sub-start 时，退回 sub-start 事件数，
 *     并在文本里标明"退回口径"。
 * 注意 send_message / workflow / ralph 也会拉起子代理，它们不经过 subagent 工具，
 * 因此这个分母可能偏小、比率可能 > 100% —— 出现这种情况时如实标注，不做截断。
 *
 * @returns {{numerator:number, denominator:number, rate:number|null, basis:string}|null}
 */
export function dispatchCoverage(sq) {
  if (!sq) return null
  const numerator = (sq.dispatched || []).length
  if (sq.dispatchToolCalls > 0) {
    return {
      numerator, denominator: sq.dispatchToolCalls,
      rate: numerator / sq.dispatchToolCalls,
      basis: 'subagent 工具调用次数 ' + sq.dispatchToolCalls + ' 次',
    }
  }
  if (sq.starts > 0) {
    return {
      numerator, denominator: sq.starts,
      rate: numerator / sq.starts,
      basis: 'sub-start 事件数 ' + sq.starts + ' 次（本窗口无 subagent 工具调用，退回派兵事件数）',
    }
  }
  return null
}

// ── 空转口径：极大连续运行（口径 A）与累计签名（口径 B）────────────────────
//
// 2026-10-30 由累计改为连续，原因：标签一直写的是连续。
// --------------------------------------------------------------
// 改前实现用 seenSig 全窗口累计：同一 (tool,args) 第 3 次出现就记一次，**不要求
// 相邻**；而报告标题写「同工具同参数 ≥3 次」、诊断规则的正文写「连续被调用
// ≥3 次」、浏览器卡片也写"连续"。同一个词在两处指两件事 —— 这是可测的缺陷，
// 不只是文案不整齐：
//   · 报数偏高：零散出现的重复被算成"空转"，而零散重复通常有正当理由；
//   · **依赖窗口切法**：同一签名散落在两个回看窗口里就两边都不报、落在同一个
//     窗口里就报一次。于是"空转"这个数字会随 --minutes 漂移，没法做前后对比。
// 连续口径是局部量：一段极大连续运行要么在窗口里、要么不在，窗口大小不改变它。
//
// 定义（与 <WORK>\_xray_repeat_metric.mjs 的「口径 A」逐条一致，
// 两个工具的数字因此可以直接对照）：
//   · 序列 = 只取 kind==='tool' 的事件，按 t 升序（同 t 用 seq 保持稳定）
//     —— 工具调用之间夹着 request/pre-step **不打断**相邻性，因为它们不是工具调用
//   · 签名 = tool + '|' + 原始 args 字符串（**不做** JSON 归一化：offset/limit
//     不同就是不同签名）
//   · 一段「极大连续运行」= 相邻工具调用签名相同的最长序列
//   · 长度 ≥ minRun 的才记 1 组
// 口径 B（累计签名）仍然照算，但**只用于报告里并列展示与交叉核对**，不再驱动判定。

/** 签名：tool + '|' + 原始 args。与度量脚本的 sigOf() 同义。 */
export function loopSigOf(e) {
  const tool = String((e && e.tool) || '(no-tool)')
  const raw = e && e.args
  const args = typeof raw === 'string' ? raw
    : (raw === undefined || raw === null ? '' : (brief(raw, 400) || ''))
  return tool + '|' + args
}

/**
 * 同时算出两种口径。纯函数：同样输入永远同样输出（可单测、可反向对照）。
 * @param {object[]} events 事件数组（任意顺序）
 * @param {number} minRun 长度阈值，默认 3（= DIAG_DEFAULTS.loopTimes）
 * @returns {{minRun:number, toolCalls:number,
 *   consecutive:object[], consecutiveGroups:number, consecutiveByTool:Map<string,number>,
 *   cumulative:object[], cumulativeGroups:number, cumulativeByTool:Map<string,number>}}
 */
export function countRepeatLoops(events, minRun = 3) {
  const toolCalls = (Array.isArray(events) ? events : [])
    .filter((e) => e && e.kind === 'tool')
    .sort((a, b) => (a.t - b.t) || ((a.seq ?? 0) - (b.seq ?? 0)))

  // ── 口径 A：极大连续运行 ──
  const runs = []
  let cur = null
  for (const e of toolCalls) {
    const sig = loopSigOf(e)
    if (cur && cur.sig === sig) {
      cur.times++
      cur.lastT = e.t
    } else {
      cur = {
        sig,
        tool: String(e.tool || '(no-tool)'),
        args: typeof e.args === 'string' ? e.args : '',
        times: 1, firstT: e.t, lastT: e.t,
      }
      runs.push(cur)
    }
  }
  const consecutive = runs.filter((r) => r.times >= minRun)

  // ── 口径 B：累计签名（不要求相邻）—— 同一个实现，只是分组方式不同 ──
  const sigCount = new Map()
  for (const e of toolCalls) {
    const sig = loopSigOf(e)
    let r = sigCount.get(sig)
    if (!r) {
      r = { sig, tool: String(e.tool || '(no-tool)'), args: typeof e.args === 'string' ? e.args : '', times: 0, firstT: e.t, lastT: e.t }
      sigCount.set(sig, r)
    }
    r.times++
    r.lastT = e.t
  }
  const cumulative = [...sigCount.values()].filter((r) => r.times >= minRun)

  const byTool = (list) => {
    const m = new Map()
    for (const g of list) m.set(g.tool, (m.get(g.tool) || 0) + 1)
    return m
  }
  return {
    minRun,
    toolCalls: toolCalls.length,
    consecutive,
    cumulative,
    consecutiveGroups: consecutive.length,
    cumulativeGroups: cumulative.length,
    consecutiveByTool: byTool(consecutive),
    cumulativeByTool: byTool(cumulative),
  }
}

// ── 表格：横向要能看，就得按显示宽度对齐（CJK 算 2 列）────────────────────
/** 显示宽度：CJK / 全角字符占 2 列。用 String.length 对齐中文表头会全歪。 */
export function dispWidth(s) {
  let w = 0
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0)
    const wide = (c >= 0x1100 && (
      c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)))
    w += wide ? 2 : 1
  }
  return w
}
const padEndW = (s, w) => String(s ?? '') + ' '.repeat(Math.max(0, w - dispWidth(s)))
const padStartW = (s, w) => ' '.repeat(Math.max(0, w - dispWidth(s))) + String(s ?? '')
/**
 * dur() 的取整包装：`dur()` 在 <1000ms 时是 `ms + 'ms'` 直出，而**平均值**必然是
 * 分数毫秒 —— 于是表格里会出现 `342.30392156862746ms` 这种把 17 位小数摆在人眼
 * 前面的输出。这里只在新代码的调用点上取整，不改 dur() 本身（它的既有输出被
 * 别的报告行与卡片读数依赖，改动面不值得）。
 */
const durMs = (ms) => dur(Number.isFinite(ms) ? Math.round(ms) : ms)

/**
 * 渲染一张等宽文本表。纯函数：同样输入永远同样输出（可单测）。
 * @param {Array<string|{label:string,align?:'left'|'right'}>} headers
 * @param {Array<Array<any>>} rows
 * @returns {string[]} 行数组（含表头与分隔线），每行都以两个空格缩进
 */
export function renderTable(headers, rows) {
  const H = (Array.isArray(headers) ? headers : []).map((h) => (
    typeof h === 'string' ? { label: String(h), align: 'left' } : { label: String(h?.label ?? ''), align: h?.align === 'right' ? 'right' : 'left' }
  ))
  if (!H.length) return []
  const R = (Array.isArray(rows) ? rows : []).map((r) => {
    const cells = Array.isArray(r) ? r : [r]
    return H.map((_, i) => String(cells[i] ?? ''))
  })
  const w = H.map((h, i) => Math.max(dispWidth(h.label), ...R.map((r) => dispWidth(r[i]))))
  const line = (cells) => '  ' + cells
    .map((c, i) => (H[i].align === 'right' ? padStartW(c, w[i]) : padEndW(c, w[i])))
    .join('  ')
    .replace(/\s+$/, '')
  const out = [line(H.map((h) => h.label))]
  out.push('  ' + w.map((x) => '─'.repeat(x)).join('  '))
  for (const r of R) out.push(line(r))
  return out
}

/**
 * 「分队」一节的文本（xray_report 与 diagnose 共用同一份数据）。
 * 纯函数，不读盘不读时钟。退化情况下如实说明，不伪造百分比。
 */
export function renderSquadLines(sq, opts) {
  const top = Number.isFinite(opts?.top) ? opts.top : 12
  const L = []
  L.push('── 分队（派兵 / 收兵）──')
  if (!sq) {
    L.push('  没有分队账本（本窗口回调失败）—— 不是"零收兵"，是这一节没跑到。')
    return L
  }
  if (!sq.hasStarts && !sq.hasEnds) {
    L.push('  本窗口看不到派兵事件（既无 sub-start 也无 sub-end）。')
    L.push('  ⇒ 收兵率**不可计算**（不是 0%）；覆盖率同样不可计算。' +
      (sq.dispatchToolCalls
        ? ' 参考：本窗口有 ' + sq.dispatchToolCalls + ' 次 subagent 工具调用（派兵动作），但没有对应的 sub-start 观测 —— 要么分队还没起来，要么观测缺口。'
        : ' 本窗口也没有 subagent 工具调用。'))
    return L
  }
  if (!sq.hasStarts) {
    L.push('  只看到收兵端：sub-end ' + sq.ends + ' 次，没有任何 sub-start。')
    L.push('  ⇒ 收兵率**不可计算**（分母 = 有 sub-start 的分队数 = 0）。')
    if (sq.harvested.length) L.push('  涉及分队：' + sq.harvested.slice(0, top).join('、'))
    return L
  }

  const cov = dispatchCoverage(sq)
  const hr = harvestRate(sq)
  const pct = (x) => (x === null ? '-' : (x * 100).toFixed(1) + '%')

  L.push('  派兵 sub-start ' + sq.starts + ' 次（去重后 ' + sq.dispatched.length + ' 个分队）' +
    ' ｜ 收兵 sub-end ' + sq.ends + ' 次' +
    ' ｜ subagent 工具调用 ' + sq.dispatchToolCalls + ' 次')
  if (cov) {
    L.push('  派兵覆盖率 ' + pct(cov.rate) + '（' + cov.numerator + '/' + cov.denominator + '）' +
      '  分母口径：' + cov.basis)
    if (cov.rate !== null && cov.rate > 1) {
      L.push('    ⚠ 覆盖率 > 100% —— 分母偏小：send_message / workflow / ralph 也会拉起子代理，' +
        '它们不经过 subagent 工具，因此不计入分母。这不是错误，是口径边界。')
    }
  } else {
    L.push('  派兵覆盖率 不可计算（没有可用的分母）')
  }
  L.push('  收兵率 ' + (hr === null ? '不可计算（无 sub-start）' : pct(hr) +
    '（' + sq.harvestedAmongDispatched.length + '/' + sq.dispatched.length + ' 个分队有 sub-end）'))

  const kindOf = (ids) => ids.map((id) => brief(id, 30) || id).join('、')
  if (sq.noEndNoTool.length) {
    L.push('  派了没收（有 sub-start，既无 sub-end 也无任何 tool 事件 = 派出去什么都没干）：' +
      sq.noEndNoTool.length + ' 个')
    for (const id of sq.noEndNoTool.slice(0, top)) {
      const b = sq.agents[id] || {}
      L.push('    · ' + brief(id, 40) + '  事件 ' + (b.events || 0) + ' 条' +
        (b.firstT ? ' ｜ 派于 ' + new Date(b.firstT).toTimeString().slice(0, 8) : ''))
    }
  } else {
    L.push('  派了没收：无（每个派出的分队要么报了收兵，要么至少干过活）')
  }
  if (sq.noEndHasTool.length) {
    L.push('  干活但没报收（有 tool 事件、无 sub-end）：' + sq.noEndHasTool.length + ' 个 —— ' +
      kindOf(sq.noEndHasTool.slice(0, top)))
  }
  if (sq.endedNoStart.length) {
    L.push('  有收兵但看不到派兵（有 sub-end、无 sub-start）：' + sq.endedNoStart.length + ' 个 —— ' +
      kindOf(sq.endedNoStart.slice(0, top)) + '（多半是 sub-start 落在别的观测分片里）')
  }
  if (sq.unattributed.requests > 0) {
    L.push('  注：本窗口有 ' + sq.unattributed.requests + ' 条模型请求没有 agent 身份（未归因）。' +
      '若某分队只有请求、没有工具调用，它可能被误判为"派了没收"——先修观测字段再看这条。')
  }
  return L
}

/**
 * 「各 agent 活动量」一节 + 守恒断言。
 * 守恒式：Σ(各 agent 请求数) + 未归因请求数 === 总请求数。
 * 式子是结构上成立的（每个事件只会落进一个桶），打出来是给人复核用的：
 * 一旦不成立，说明代码被改坏了，而不是统计口径问题。
 */
export function renderAgentActivityLines(a, opts) {
  const top = Number.isFinite(opts?.top) ? opts.top : 10
  const byAgent = (a && a.byAgent) || {}
  const unattr = (a && a.unattributed) || emptyBucket()
  const totalRequests = Number.isFinite(a?.requests) ? a.requests : 0
  const rows = Object.entries(byAgent)
  const L = []
  L.push('── 各 agent 活动量 ──')
  if (!rows.length && !unattr.events) {
    L.push('  （无）本窗口没有任何带身份的事件。')
    return L
  }
  rows.sort((x, y) => y[1].events - x[1].events)
  const sum = { events: 0, tools: 0, requests: 0 }
  for (const [, s] of rows) { sum.events += s.events; sum.tools += s.tools; sum.requests += s.requests }
  const table = rows.slice(0, top).map(([id, s]) => [
    brief(id, 40), String(s.events), String(s.tools), String(s.requests),
    s.modelWaitSegments ? durMs(s.modelWaitMs / s.modelWaitSegments) : '-',
  ])
  L.push(...renderTable(
    ['agent', { label: '事件', align: 'right' }, { label: '工具', align: 'right' }, { label: '请求', align: 'right' }, { label: '平均等模型', align: 'right' }],
    table,
  ))
  if (rows.length > top) L.push('  …（另有 ' + (rows.length - top) + ' 个 agent 未列出）')
  if (unattr.events) {
    L.push('  ' + padEndW('(未归因)', 42) + ' ' + String(unattr.events).padStart(4) + '  ' +
      String(unattr.tools).padStart(4) + '  ' + String(unattr.requests).padStart(4) + '   ← 身份缺失的事件');
  }
  const conserved = sum.requests + unattr.requests === totalRequests
  L.push('  守恒：各 agent 请求合计 ' + sum.requests + ' + 未归因 ' + unattr.requests +
    ' = ' + (sum.requests + unattr.requests) + ' ｜ 总请求 ' + totalRequests +
    (conserved ? '  ✓' : '  ✗ 不守恒 —— 归因代码被改坏了，不是数据问题'))
  return L
}

/** 单条观测流的纯计数（xray_compare 按天折叠时用；不做归因，只数数与量间隔）。 */
export function streamStats(events) {
  const out = {
    events: 0, requests: 0, tools: 0, errors: 0, steps: 0, subStarts: 0, subEnds: 0,
    spanMs: 0, maxGapMs: 0, firstT: 0, lastT: 0, agents: new Set(),
  }
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : []
  if (!list.length) return out
  const sorted = list.slice().sort((a, b) => (a.t - b.t) || ((a.seq ?? 0) - (b.seq ?? 0)))
  out.firstT = sorted[0].t
  out.lastT = sorted[sorted.length - 1].t
  out.spanMs = out.lastT - out.firstT
  let lastT = out.firstT
  for (const e of sorted) {
    const gap = e.t - lastT
    if (gap > out.maxGapMs) out.maxGapMs = gap
    lastT = e.t
    out.events++
    if (typeof e.agent === 'string' && e.agent) out.agents.add(e.agent)
    switch (e.kind) {
      case 'request': out.requests++; break
      case 'tool': out.tools++; break
      case 'pre-step': out.steps++; break
      case 'error':
      case 'req-error': out.errors++; break
      case 'sub-start': out.subStarts++; break
      case 'sub-end': out.subEnds++; break
      default: break
    }
  }
  return out
}

/**
 * 跨分队对比：把多个观测流折叠成「每个 agent 一行」。
 *
 * WHY PER-STREAM FIRST, THEN ADD
 * -----------------------------
 * 相邻间隔只在**同一条流里**有意义。多个实例/多个分片混在一起算，会发生
 * 「A 文件的最后一条」和「B 文件的第一条」被当成相邻，凭空造出一个巨大的假空档。
 * 所以先按流各自归因（summarizeSquads → attributeByAgent），再把**求和量**相加。
 * @param {Array<{file?:string, day?:string, events:object[]}>} streams
 */
export function compareAgents(streams) {
  const acc = new Map()
  const dispatched = new Set()
  const unattributed = emptyBucket()
  for (const s of Array.isArray(streams) ? streams : []) {
    const sq = summarizeSquads(s && s.events)
    for (const [id, b] of Object.entries(sq.agents)) {
      const cur = acc.get(id) || emptyBucket()
      mergeBucket(cur, b)
      acc.set(id, cur)
    }
    for (const id of sq.dispatched) dispatched.add(id)
    mergeBucket(unattributed, sq.unattributed)
  }
  const agents = []
  for (const [id, b] of acc) {
    agents.push({
      agent: id,
      role: dispatched.has(id) ? '分队' : '主干',
      events: b.events, requests: b.requests, tools: b.tools,
      subStarts: b.subStarts, subEnds: b.subEnds,
      modelWaitMs: b.modelWaitMs, modelWaitSegments: b.modelWaitSegments,
      toolSpanMs: b.toolSpanMs, toolSpanSegments: b.toolSpanSegments,
      modelAvgMs: b.modelWaitSegments ? b.modelWaitMs / b.modelWaitSegments : NaN,
      toolAvgMs: b.toolSpanSegments ? b.toolSpanMs / b.toolSpanSegments : NaN,
      firstT: b.firstT, lastT: b.lastT,
    })
  }
  agents.sort((x, y) => y.events - x.events || y.requests - x.requests)
  return { agents, unattributed }
}

/**
 * 跨天对比：按日期折叠（每个分片单独统计，取最大空档时也只在流内比较）。
 * @param {Array<{file?:string, day?:string, events:object[]}>} streams
 */
export function compareDays(streams) {
  const byDay = new Map()
  for (const s of Array.isArray(streams) ? streams : []) {
    const day = s && s.day ? String(s.day) : '(未知日期)'
    const st = streamStats(s && s.events)
    const cur = byDay.get(day) || {
      day, files: 0, events: 0, requests: 0, tools: 0, errors: 0, steps: 0,
      spanMs: 0, maxGapMs: 0, subStarts: 0, subEnds: 0, agents: new Set(),
    }
    cur.files++
    cur.events += st.events
    cur.requests += st.requests
    cur.tools += st.tools
    cur.errors += st.errors
    cur.steps += st.steps
    cur.spanMs += st.spanMs
    cur.maxGapMs = Math.max(cur.maxGapMs, st.maxGapMs)
    cur.subStarts += st.subStarts
    cur.subEnds += st.subEnds
    for (const id of st.agents) cur.agents.add(id)
    byDay.set(day, cur)
  }
  const days = [...byDay.values()].sort((x, y) => (x.day < y.day ? 1 : x.day > y.day ? -1 : 0))
  for (const d of days) {
    d.avgStepMs = d.steps ? d.spanMs / d.steps : NaN
    d.agentCount = d.agents.size
  }
  return days
}

// ── 自动异常判定：把原始数字变成判定 ────────────────────────────────────────
//
// WHY THIS IS A PURE MODULE-LEVEL FUNCTION
// ----------------------------------------
// 用户真正要的不是"看到 1234 条事件、最大空档 41m"，而是"这是不是有问题、该改
// 什么"。把判断写在这里、而不是写进卡片渲染里，有三个后果都是想要的：
//   ① 它可以被单测直接喂输入、断言输出 —— 不需要起浏览器、不需要真跑一轮；
//   ② 工具文本输出和浏览器卡片读的是**同一份判定**，不会出现"卡片说异常、
//      模型读到的文本说正常"这种两套口径；
//   ③ 判定规则将来变松/变严时，改动点只有这里一处。
//
// 它**不做 IO、不读时间、不碰全局**：同样输入永远同样输出。阈值走参数，不写死
// 在调用点上 —— 否则测试要么得复制一份阈值，要么只能测个大概。
//
// INPUT（缺字段一律按 0 / 空处理，绝不抛错）
//   { events, spanMs, steps, requests, toolCalls, errors, subagents, subEnds,
//     reportCalls, maxGap:{ms,nextKind,nextTool}|null, loops:[{tool,times}],
//     errorTexts:[{kind,text}], windowMinutes, idleWarnMs, idleBadMs }
// OUTPUT
//   { level:'ok'|'warn'|'bad', verdict:'<一句人话>',
//     findings:[{ severity:'warn'|'bad', signal, meaning, action }] }
//
// 阈值的默认值与 xray 的既有口径对齐：60s 起注意、300s 起异常。

const DIAG_DEFAULTS = {
  windowMinutes: 120,
  idleWarnMs: 60_000,
  idleBadMs: 300_000,
  // "request 为 0 而会话还在跑"的判断需要一段像样的观察窗口，否则刚开会话就会
  // 误报。30 分钟以下一律不下这个结论。
  starvingWindowMs: 30 * 60_000,
  // 空转阈值：**极大连续运行**多长算空转（口径 A）。判定、xray_report 的展开、
  // xray_hotspots 的排行都读这一个值；口径 B（累计）用同一个阈值但只作对照展示。
  loopTimes: 3,
}

/**
 * 一段空档到底在等谁 —— **唯一**的归因实现，判别、报告文本、浏览器卡片都读它。
 *
 * WHY BOTH ENDS, NOT JUST THE FOLLOWING EVENT
 * -------------------------------------------
 * 需求写的是「紧跟 pre-step/request ⇒ 在等模型；紧跟 tool ⇒ 在等工具」。按事件
 * 形状核对后发现：`request` 与 `tool` 两条事件都是在**动作开始时**写的
 * （request 在发起模型请求时、tool 在工具执行前由 ctx.tools.guard 落盘）。
 * 所以一段空档真正属于谁，看的是它**从哪个动作里长出来**，也就是前一条事件：
 *   · 前一条是 request ⇒ 请求在飞，这段是在等模型响应；
 *   · 前一条是 tool    ⇒ 工具已开始执行，这段是在等工具跑完。
 * 而"紧跟什么"只在没有前驱可依时才作判据（会话刚开、日志被截、前一条是
 * status/turn-stop 之类）。
 *
 * 只按"紧跟"判，会导致「在等工具」在真实数据里几乎永不触发 —— 那这条规则就
 * 等于不存在，而用户要的恰恰是把这两者分开。所以两端都看：先看前驱（更强），
 * 再按需求原文看后继（兜底）。两者冲突时信前驱，并在文本里写明依据的是哪一端。
 *
 * @param {string} prevKind 空档**前**一条事件的 kind（可空）
 * @param {string} nextKind 空档**后**一条事件的 kind（可空）
 * @returns {'model'|'tool'|'other'}
 */
export function classifyGap(prevKind, nextKind) {
  const prev = String(prevKind || '')
  const next = String(nextKind || '')
  if (prev === 'request') return 'model'
  if (prev === 'tool') return 'tool'
  if (next === 'pre-step' || next === 'request') return 'model'
  if (next === 'tool') return 'tool'
  return 'other'
}

/** 归因 → 报告里的中文标记（报告文本与卡片共用一句人话）。 */
export function gapWaitLabel(cls) {
  if (cls === 'model') return '在等模型'
  if (cls === 'tool') return '在等工具'
  return ''
}

/**
 * 把统计量变成 { level, verdict, findings }。纯函数，永不抛错。
 * @param {object} stats 见上方 INPUT 说明。
 * @returns {{level:'ok'|'warn'|'bad', verdict:string, findings:Array<object>}}
 */
export function diagnose(stats = {}) {
  const s = stats && typeof stats === 'object' ? stats : {}
  const n = (v, d = 0) => (Number.isFinite(v) ? v : d)
  const opt = (k) => (Number.isFinite(s[k]) ? s[k] : DIAG_DEFAULTS[k])

  const events = n(s.events ?? s.total)
  const spanMs = n(s.spanMs)
  const requests = n(s.requests)
  const toolCalls = n(s.toolCalls)
  const errors = n(s.errors)
  const subStarts = n(s.subagents)
  const subEnds = n(s.subEnds)
  const reportCalls = n(s.reportCalls)
  const windowMinutes = opt('windowMinutes')
  const idleWarnMs = opt('idleWarnMs')
  const idleBadMs = opt('idleBadMs')
  const starvingWindowMs = opt('starvingWindowMs')
  const loopTimes = opt('loopTimes')

  const errorTexts = Array.isArray(s.errorTexts) ? s.errorTexts.filter(Boolean) : []
  const loops = Array.isArray(s.loops) ? s.loops.filter((x) => x && Number.isFinite(x.times)) : []
  const rawGap = s.maxGap && Number.isFinite(s.maxGap.ms) ? s.maxGap : null

  const findings = []
  // 无事件 = 没有可判定对象。这里**不**返回 bad：观测不到不等于系统坏，
  // "观测断了"和"真没请求"必须由人看落盘来判断，判定本身不下这个结论。
  if (events <= 0) {
    return {
      level: 'ok',
      verdict: '最近 ' + windowMinutes + ' 分钟内没有观测到任何事件，暂无判定对象。',
      findings: [],
    }
  }

  /* ── 规则 1：错误 ─────────────────────────────────────────────────────── */
  if (errors > 0) {
    const top = errorTexts[0]
    findings.push({
      severity: 'bad',
      signal: errors + ' 次错误' + (top && top.text ? '（最近：' + top.text + '）' : ''),
      meaning:
        '模型请求或 agent 抛了异常。这类失败通常会让整个 turn 提前结束 —— ' +
        '它比任何堵点都更值得先修，因为它丢的是整段工作而不是几秒。',
      action: '先定位这段错误文本出现在哪一步（错误前后紧跟的 kind），再决定重试、降级还是换路由。',
    })
  }

  /* ── 规则 2：最大堵点 —— 分清「在等模型」和「在等工具」 ──────────────────
   * 这是本判定最重要的一条：同一个 5 分钟空档，落在模型请求里说明模型慢，
   * 落在工具执行里说明工具慢。两者的优化动作完全不同，混为一谈就会去优化错的
   * 那一半。归因规则见 classifyGap()。 */
  if (rawGap && rawGap.ms >= idleWarnMs) {
    const nextKind = String(rawGap.nextKind || '?')
    const prevKind = String(rawGap.prevKind || '')
    const tool = rawGap.nextTool ? String(rawGap.nextTool) : ''
    const where = classifyGap(prevKind, nextKind)
    const sever = rawGap.ms > idleBadMs ? 'bad' : 'warn'
    const basis = prevKind ? '前一条是 ' + prevKind : '前一条不可知'
    const span = '（' + basis + '，后一条是 ' + nextKind + '）'
    if (where === 'model') {
      findings.push({
        severity: sever,
        signal: '最大堵点 ' + dur(rawGap.ms) + span + ' —— 在等模型',
        meaning:
          '这段空档从一次模型请求里长出来：请求已经发出，模型还没回。' +
          '上下文越长、工具返回越厚，这段通常越长。',
        action: '分会话 / 精简上下文 / 减小单次工具返回体积；这条不是工具的锅，别去优化工具。',
      })
    } else if (where === 'tool') {
      findings.push({
        severity: sever,
        signal: '最大堵点 ' + dur(rawGap.ms) + span + ' —— 在等工具' + (tool ? '（' + tool + '）' : ''),
        meaning:
          '这段空档从一次工具调用里长出来：模型已经把活派下去了，工具还在跑' +
          '（或者在等它那一步的网络/磁盘）。',
        action: '优化那个工具本身：缩小扫描范围、加缓存、换更快的等价命令；分会话不会让它变快。',
      })
    } else {
      // 两端都不明确：不硬归因。宁可说不确定，也不要给出一个会被当成事实的错误归因。
      findings.push({
        severity: sever,
        signal: '最大堵点 ' + dur(rawGap.ms) + span,
        meaning:
          '这段空档两端都不是模型请求或工具执行（前一条 ' + (prevKind || '不可知') +
          '，后一条 ' + nextKind + '），属于收尾/生命周期阶段。',
        action: '如果这一段占比很大，先看「各 agent 活动量」里是谁停在这个阶段，再决定要不要拆会话。',
      })
    }
  }

  /* ── 规则 3：空转 ─────────────────────────────────────────────────────── */
  const hotLoops = loops.filter((x) => x.times >= loopTimes)
  if (hotLoops.length) {
    const names = hotLoops.slice(0, 4).map((x) => x.tool + ' ×' + x.times)
    // 口径 B 的数字只作为"别混着比"的注脚出现 —— 它衡量的是另一个问题
    //（多支分队各读一遍同一份东西），跟这条判定不是一回事。
    const rep = s.repeat && typeof s.repeat === 'object' ? s.repeat : null
    const cumulativeNote = rep
      ? '（本判定用口径 A·连续。同期口径 B·累计有 ' + rep.cumulativeGroups +
        ' 个签名 ≥' + rep.minRun + ' 次 —— 那是跨分队/零散重复取证，是另一个问题，不要与本条混着比。）'
      : ''
    findings.push({
      severity: 'warn',
      signal: '空转：' + names.join('、') + (hotLoops.length > 4 ? ' 等 ' + hotLoops.length + ' 项' : ''),
      meaning:
        '同一个工具用同一批参数**连续**被调用 ≥' + loopTimes + ' 次（极大连续运行，不是累计）。' +
        '这几乎总是"上一次的结果没被读到 / 没被采信"，于是又调了一遍。' + cumulativeNote,
      action: '检查那几次调用之间模型收到了什么（结果被截断？报错被吞？）；必要时把一次调用做厚，而不是重复调用。',
    })
  }

  /* ── 规则 4：关键事件长时间为 0 —— 必须区分「观测断了」与「真没发生」───────
   * 这是最容易误判的一条：把"没观测到"直接报成"故障"是假警报，反过来直接放过
   * 又会漏掉真正停摆的会话。所以判定只报"这一项缺失"，并明确要求人先分辨原因。*/
  if (requests === 0 && spanMs >= starvingWindowMs && (events > 0 || toolCalls > 0 || spanMs > 0)) {
    findings.push({
      severity: 'warn',
      signal: '窗口跨度 ' + dur(spanMs) + ' 内模型请求为 0',
      meaning:
        '会话在跑、事件在落，但一条 request 都没有。两种可能，必须先分辨：' +
        '① 观测断了（订阅丢了 / 落盘失败 / 只读到别人的分片）；② 这段时间真的没有发起过模型请求' +
        '（例如一直在跑工具、或 turn 早已结束但进程还在活动）。判定本身无法区分这两者。',
      action: '先看 _xray 下最新文件的 mtime 与事件种类分布：还在增长⇒观测是活的，那就是真没请求；' +
        '不再增长⇒按观测故障排查订阅。',
    })
  }

  /* ── 规则 5：派了兵但没收兵 ───────────────────────────────────────────── */
  if (subStarts > 0 && subEnds === 0 && reportCalls === 0) {
    findings.push({
      severity: 'warn',
      signal: subStarts + ' 个分队派出，但既无 sub-end 也无 report 调用',
      meaning:
        '有形无实：分队被拉起来了，却没有收兵记录，也没有回传报告的调用。' +
        '要么它们还在跑（那就等），要么它们静默失败了（那就要人去收）。',
      action: '用 list_agents 核对还有谁在跑；跑完的补一次 report，静默的就 interrupt 掉。',
    })
  }

  /* ── 规则 6：分队账本 —— 派兵覆盖率 / 收兵率 / 派了没收 ────────────────────
   * 规则 5 只说"派了但一条收兵都没有"这个总量；规则 6 要看**逐个分队**：
   * 谁派出去了、谁回来了、谁连一下工具都没调过。这是"统帅看不见过程"里
   * 最贵的一类盲区 —— 分队静默失败时，统帅只会觉得"这一轮很慢"。 */
  const sq = s.squads && typeof s.squads === 'object' ? s.squads : null
  if (sq && sq.hasStarts) {
    const cov = dispatchCoverage(sq)
    const hr = harvestRate(sq)
    const covTxt = cov && cov.rate !== null ? (cov.rate * 100).toFixed(0) + '%' : '不可计算'
    const hrTxt = hr === null ? '不可计算' : (hr * 100).toFixed(0) + '%'
    const idle = Array.isArray(sq.noEndNoTool) ? sq.noEndNoTool : []
    const busyNoEnd = Array.isArray(sq.noEndHasTool) ? sq.noEndHasTool : []
    if (idle.length > 0) {
      findings.push({
        severity: 'warn',
        signal: idle.length + ' 个分队「派了没收」（有 sub-start，既无 sub-end 也无任何 tool 事件）',
        meaning:
          '这些子代理被拉起来了，然后什么都没干：没有一次工具调用，也没有收兵记录。' +
          '合计派兵覆盖率 ' + covTxt + '、收兵率 ' + hrTxt + '。' +
          '静默失败比报错更贵 —— 报错会进错误列表，静默只会让这一轮"看起来慢"。',
        action: '用 list_agents 逐个核对是否还在跑；跑完的让它补一次 report，' +
          '静默的直接 interrupt_agent 收掉，并把任务改派（别重复派同一个任务）。',
      })
    } else if (cov && cov.rate !== null && cov.rate < 1) {
      findings.push({
        severity: 'warn',
        signal: '派兵覆盖率 ' + covTxt + '（' + cov.numerator + '/' + cov.denominator + '，分母口径：' + cov.basis + '）',
        meaning:
          '派兵动作比可观测到的分队多：有的派兵没有产出 sub-start，或者 sub-start 落在别处。' +
          '这种时候"没有任何分队在跑"这个结论是不可信的 —— 先看差在哪一次派兵上。',
        action: '对照 xray_hotspots 里 subagent 工具调用的返回：失败的派兵要看它的错误，' +
          '成功的要看它是否真的起了 sub-start。',
      })
    } else if (busyNoEnd.length > 0 && sq.ends === 0) {
      // 有工具活动、但一条 sub-end 都没有：通常是还在跑，也可能收兵端坏了。
      findings.push({
        severity: 'warn',
        signal: busyNoEnd.length + ' 个分队有工具活动，但本窗口一条 sub-end 都没有（收兵率 ' + hrTxt + '）',
        meaning:
          '分队在干活，却看不到收兵。两种可能必须先分开：①它们还在跑（那就等）；' +
          '②收兵端没被观测到（subagent/end 订阅丢了或落在别的分片）。判定本身无法区分。',
        action: '先 list_agents 确认还有谁在跑；若已全部结束却仍无 sub-end，按观测故障排查订阅。',
      })
    }
  }

  /* ── 规则 7：观测字段缺失（"请求"列恒为 0 的那类病）────────────────────────
   * 单列一条的理由：这不是运维问题，是**观测自身的病**。它会让"各 agent 活动量"
   * 整张表看起来像"什么都没发生"，从而掩盖真的问题。判定必须自己先说破。 */
  const unattrReq = n(s.unattributedRequests)
  const unattrEv = n(s.unattributedEvents)
  if (unattrReq > 0 && requests > 0) {
    findings.push({
      severity: 'warn',
      signal: unattrReq + '/' + requests + ' 条模型请求没有 agent 身份（未归因，另有 ' + unattrEv + ' 条事件无身份）',
      meaning:
        '这些 request 事件的 payload 里取不到身份，于是「各 agent 活动量」的「请求」列会低报甚至为 0，' +
        '而总请求数是对的 —— 两列数字自相矛盾时，先信这条。' +
        '常见原因：宿主还是旧代码（agent 字段是本次修复才落的盘），或落盘的是修复前的历史数据。',
      action: '重启 dsh web 让新代码生效，再看新落盘的 request 事件是否带 "agent" 字段；' +
        '历史分片里的旧事件不会补写，跨天对比时要按日期区分。',
    })
  }
  /* ── 汇总 ─────────────────────────────────────────────────────────────
   * bad 优先于 warn 优先于 ok。verdict 取**最严重的那一条**的信号 + 结论句，
   * 后面追加"另有 N 条"——一句话能读懂，又不至于把其它问题藏起来。 */
  const rank = { bad: 2, warn: 1 }
  findings.sort((x, y) => (rank[y.severity] || 0) - (rank[x.severity] || 0))
  if (!findings.length) {
    return {
      level: 'ok',
      verdict:
        '没有错误，没有超过 ' + dur(idleWarnMs) + ' 的堵点，没有同参数空转 —— 本次运行是干净的。',
      findings: [],
    }
  }
  const worst = findings[0]
  const level = worst.severity === 'bad' ? 'bad' : 'warn'
  const head = worst.severity === 'bad' ? '发现异常：' : '需要注意：'
  const verdict = head + worst.signal + (findings.length > 1 ? '（另有 ' + (findings.length - 1) + ' 条）' : '')
  return { level, verdict, findings }
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const rootDir = () => config?.hiveRoot || process.env.WAR_ROOT || '<HOME>/.war'
  const xrayDir = () => path.join(rootDir(), '_xray')

  // ── 采集 / 分析 两个半区的开关（2026-11-07）───────────────────────────────
  //
  // collect = 'slim'（默认）只采轨迹里没有的四类；'full' 是 2026-11-05 之前的全量行为。
  // trace   = 是否把会话轨迹合并进报告，默认 true；关掉它 slim 模式下就没有步/工具/
  //           token 可读了（只剩错误栈与分队账本）—— 这是有意的：轨迹是分析的数据源，
  //           不是可选装饰。
  const COLLECT = String(config?.collect || 'slim').toLowerCase() === 'full' ? 'full' : 'slim'
  const USE_TRACE = config?.trace !== false
  // 一份报告最多解析多少份轨迹（主会话 + 各子代理会话）。16 个分队的战役大约会命中
  // 这个上限；超出的部分在报告里显式写"还有 N 份没读"，绝不让它静默变成 0。
  const TRACE_MAX = Math.max(1, Number(config?.traceMaxFiles) || 24)
  const SLIM_KINDS = new Set(['error', 'status', 'sub-start', 'sub-end'])

  // ── 写入者身份 ────────────────────────────────────────────────────────────
  // 每个挂载实例一个稳定 id，落在文件名上：一个目录里有多少写入者、谁写的、
  // 哪条属于谁，`ls _xray` 就能读出来。事件体**一个字段都不加** ——
  // 观测量必须与重构前逐字段一致（_xray_parity_probe.mjs 就是拿这个当判据的），
  // 而且身份是"整个文件一个值"，写进每一行纯属重复。
  const instanceId = 'p' + process.pid.toString(36) + '-' + (++instanceCounter) + '-' +
    randomBytes(2).toString('hex')
  const fileFor = (day) => path.join(xrayDir(), day + '.' + instanceId + '.jsonl')

  // 进程内自增序号：同一毫秒内的多条事件也能稳定排序（**仅本实例内唯一**）。
  let seq = 0

  // 内存中的近期事件，供 xray_report 快速出报告（不必每次读全文件）。
  // 上限之外滚动丢弃 —— xray 的价值在「最近怎么走的」，不是「全部历史」。
  const RECENT_CAP = 4000
  const recent = []

  // ── 落盘：每实例一个文件 + 一个常开的写句柄 ───────────────────────────────
  //
  // WHY THIS IS NO LONGER `appendFile(同一个 YYYY-MM-DD.jsonl)`（缺陷，2026-10-30）
  // ---------------------------------------------------------------------
  // 旧实现把所有写入者（多进程 + 同进程多次 apply）都追进同一个文件。观测文件
  // `2026-10-30.jsonl` 里 seq=1 出现 13 次 —— 13 个写入者在写同一个文件，而
  // seq 是 per-instance 自增的，这份数据里没有任何东西能把它们分开。
  //
  // 修复前实测（<WORK>\_xray_dup_repro.mjs，12 个写入者 × 16KB 行）：
  // 单次 append 在 O_APPEND 语义下是原子的，**0 条被截断**；也就是说"并发 append
  // 直接把字节写坏"在本机复现不出来。而报告里那 89 条"截断行"可以用**读取端**
  // 精确复现（_xray_snap_reverse.mjs：对同一批完好字节做 W≈320 定宽截断，得到
  // 423 可解析 + 89 截断 = 512（物理行 513），89 条全是 kind:"tool"、全部是
  // 完好行的前缀）。所以"写坏"的证据在读取侧，而写入侧的问题不在字节，在
  // **归属**：多写入者共用一个文件，谁写坏了、谁漏写了、少了哪条，事后无法判定。
  //
  // 所以修法是双保险，两边都不赌：
  //   ① 写入端 —— 每实例独立文件 + 一个常开的写句柄（不是每行开一次文件）：
  //      写入者之间不再共享任何文件，"别人的字节插进我这一行"在结构上不再可能；
  //      一个文件只有一个写者，"截断发生在谁身上"也变成可判定的。
  //   ② 读取端（见 readDayFiles）—— 解析失败的行跳过**并计数**，绝不抛错：
  //      历史碎片、被外部工具切出来的半行，都不允许把 xray_report 变成故障源。
  let wstream = null
  let wstreamDay = ''

  /** 取当前日期对应的写句柄（每实例每天 1 个）。取不到返回 null。 */
  function openStream(day) {
    if (wstream && wstreamDay === day && !wstream.destroyed) return wstream
    try { if (wstream && !wstream.destroyed) wstream.end() } catch { /* 换日/换句柄失败就放弃旧的 */ }
    wstream = null
    wstreamDay = ''
    try { fsSync.mkdirSync(xrayDir(), { recursive: true }) } catch { /* 目录建不出来：放弃落盘 */ }
    let s
    try {
      s = fsSync.createWriteStream(fileFor(day), { flags: 'a', encoding: 'utf8' })
    } catch { return null }
    // 没有这个 handler，一次 EACCES/ENOSPC 就是**未处理的 'error' 事件 = 进程崩**。
    // 观测者是旁观者：连自己的错误都必须自己咽下去。
    s.on('error', () => { if (wstream === s) { wstream = null; wstreamDay = '' } })
    wstream = s
    wstreamDay = day
    return s
  }

  /** 追加写一条事件。任何异常都在这里被吞掉 —— 记录失败不许变成调用方的失败。 */
  function record(kind, payload) {
    try {
      // ── 采集闸门（collect='slim'）─────────────────────────────────────────
      // 只有"轨迹里没有的那几类"才落盘。其余（tool/request/pre-step/turn 边界/
      // inbox-spliced）轨迹里都有且更全，分析半区直接从轨迹读（lib/trace.js）。
      //
      // 为什么闸门在 record() 而不是在各个 handler 里：handler 一共十来处，
      // 把判据抄十遍就等于有十个地方会漂移；放在唯一写入口，只有一处为真。
      if (COLLECT === 'slim' && !SLIM_KINDS.has(kind)) return undefined

      const ev = { t: nowMs(), seq: ++seq, kind, ...payload }
      recent.push(ev)
      if (recent.length > RECENT_CAP) recent.splice(0, recent.length - RECENT_CAP)

      // 落盘不 await：观测不应给主流程增加延迟。失败也只影响观测。
      const s = openStream(dayKey(ev.t))
      if (s) s.write(JSON.stringify(ev) + '\n')
      return ev
    } catch {
      // 连取路径 / 序列化 / 入缓冲都失败（理论上不该发生）：这条观测就此丢弃，
      // 但绝不允许把异常抛回 waterfall 链 —— 观测者不能成为故障源。
      return undefined
    }
  }

  // ── 事件订阅：唯一一套实现 ─────────────────────────────────────────────────
  //
  // WHY THIS SECTION LOOKS LIKE THIS（真实事故，2026-10-30）
  // ------------------------------------------------------
  // 这里曾经并存两套订阅封装（一套带 waterfall 选项位，一套专供放行用）。
  // 并存本身就是坑 —— 「改了一处、以为两处都生效」，两套行为还不一致：
  // 一套会把 next() 的返回值 await 一遍，另一套不会；而带选项位那套的默认分支
  // 注册出来的监听器**根本不返回 next()**。现在只留一套（本文件的 subscribe）。
  //
  // 事故经过：agent/pre-step 的监听器没有把链交下去 → 瀑布返回 undefined →
  // 上游 dsh-agent-loop 的 preStep() 紧接着读 `decision.kind`：
  //   TypeError: Cannot read properties of undefined (reading 'kind')
  // 表现是「发任何消息都报这一句」，且与用户说了什么无关；轨迹为
  //   turn/start → agent/inbox/spliced → turn/end(error)，中间**没有** step/start。
  //
  // WHY IT CANNOT HAPPEN AGAIN
  // --------------------------
  // 放行不是约定，也不是业务处理器的责任：
  //   · 业务处理器只拿得到 payload，**拿不到 next** —— 它没有机会忘记放行。
  //   · 是否转发由 wrapper 决定：上游递来一个函数参数（waterfall 的 next），
  //     就原样 `return next()`；没有就返回 undefined。
  //   · 业务处理器的返回值被**丢弃**：观测者不得参与链的决策（返回值就是决策）。
  //
  // Cordis 三种 dispatch（cordis/lib/index.js → EventsService）：
  //   emit(...args)       同步调用，返回值无人读      → agent/status、subagent/*
  //   serial(...args)     逐个 await；返回值非 undefined 即 bail → agent/turn-stopping
  //   waterfall(...args)  返回值 = 最外层监听器的返回值；不调 next() = 静默否决整条链
  //                       → agent/pre-step、agent/request、agent/request-error
  //
  // 各事件 payload 的真实形状（dsh-agent/lib/types/runtime-types.d.ts）：
  //   { agent: Agent, turn: number, step: number, ... }
  // `agent` 是 Agent 对象，其身份字段是 `agent.id`（即 SessionId）。

  // 已知 waterfall 事件清单：只用于兜底路由，正确性由 wrapper 保证（见下）。
  // 加新订阅时先查 dsh-agent-loop 里是 dispatch.emit / serial / waterfall，再选入口。
  const WATERFALL_EVENTS = new Set(['agent/pre-step', 'agent/request', 'agent/request-error'])

  /**
   * 全文件唯一的订阅实现 —— 唯一一处 ctx.on。
   *
   * 对 dispatch 模式**不做假设**：上游多递一个函数参数，那就是 waterfall 的 next，
   * 原样交回；没有就是 emit/serial，返回值没人在意。
   * 因此即使将来有人把 waterfall 事件误写成 sub(...)，链条也不会被否决。
   */
  function subscribe(eventName, handler) {
    try {
      ctx.on(eventName, async (...args) => {
        const info = args[0]
        const last = args[args.length - 1]
        // 最后一个参数是函数 ⇒ 这条是 waterfall 链，它是 next（不是 payload）。
        const next = typeof last === 'function' ? last : undefined
        // 第二个实参是**原始参数数组**（handler(info, args)），只为一个事件存在：
        //   `session/event` 的回调签名是 (session, event) 两个参数，
        //   只递 args[0] 会把 event 丢掉，于是四种 SessionEvent 一条都记不下来。
        // 其余 handler 都只用第一个参数，多给一个不影响它们。
        try { handler(info, args) } catch { /* 观测失败绝不外溢到被观测系统 */ }
        // 只读 ≠ 不返回值：有 next 就必须交回整条链的结果，且一个字都不改写。
        if (next) return next()
        return undefined
      })
    } catch { /* 该事件在当前组合下不存在，忽略 */ }
  }

  /**
   * waterfall 事件入口：显式声明「这条链必须放行」。
   * 与 sub 共用同一个 wrapper —— 入口承担可读性，wrapper 承担正确性，
   * 于是不存在「两个实现互相漂移」的可能。
   */
  const subWaterfall = (eventName, handler) => subscribe(eventName, handler)

  /** emit / serial 事件入口：返回值无人读取。 */
  const sub = (eventName, handler) => {
    // 误把 waterfall 事件传给 sub 不会坏（wrapper 照样放行），这里只纠正意图。
    if (WATERFALL_EVENTS.has(eventName)) return subWaterfall(eventName, handler)
    return subscribe(eventName, handler)
  }

  const agentOf = (p) => brief(pick(p, 'agent', 'id'), 60)
  const turnOf = (p) => brief(pick(p, 'turn'))
  const stepOf = (p) => brief(pick(p, 'step'))
  const modelOf = (p) => brief(pick(p, 'agent', 'options', 'model'), 40)

  // ── waterfall 事件：唯一显式入口 subWaterfall ──────────────────────────────
  //
  // 这三条都是 Cordis waterfall（已核对 dsh-agent-loop/lib/index.js）：
  //   dispatch.waterfall("agent/pre-step",    …)  ← 上游读 decision.kind
  //   dispatch.waterfall("agent/request",     …)  ← 上游读 provider/model
  //   dispatch.waterfall("agent/request-error", …) ← 上游读 action.kind === 'retry'
  // 三处都必须放行；不放行分别炸成 TypeError / "has no provider/model" / 重试被吞。
  // 放行动作不写在这里 —— 见上面的 subscribe()。

  // ↓ waterfall：观测完必须放行
  subWaterfall('agent/pre-step', (info) => {
    record('pre-step', {
      // 身份 ⇒ payload.agent.id（证据链见文件头 agentIdOf）。
      agent: agentIdOf(info),
      step: brief(pick(info, 'step') ?? pick(info, 'index')),
      // model 字段一直是空的：上游 payload 里没有 model，但 Agent 自带
      // options.model（runtime-types.d.ts: readonly options: AgentOptions）。
      // 填上它，「哪个分队的哪次请求用了哪个模型」才能对得上账。
      model: brief(pick(info, 'model') ?? pick(info, 'agent', 'options', 'model'), 40),
    })
  })

  // ↓ waterfall：观测完必须放行
  subWaterfall('agent/request', (info) => {
    record('request', {
      // 身份 ⇒ payload.agent.id（证据链见文件头 agentIdOf）。
      agent: agentIdOf(info),
      model: brief(pick(info, 'model') ?? pick(info, 'agent', 'options', 'model'), 40),
      // 请求发起时刻 = 思考时间起点。响应到达时由 tool/pre-step 的间隔体现。
      toolCount: brief(pick(info, 'tools', 'length')),
    })
  })

  // ↓ waterfall：这一条原先挂在普通 sub 上，等于把整条重试链吞掉了 ——
  //   dsh-agent-loop 拿到 undefined 的 action 后 `action?.kind !== 'retry'` 成立，
  //   于是抛 LlmError 而不是交给 dsh-llm-retry 退避重试。
  //   事件名与落盘字段一字未改，改的只是「是否放行」。
  subWaterfall('agent/request-error', (info) => {
    record('req-error', {
      // 身份 ⇒ payload.agent.id（证据链见文件头 agentIdOf）。
      agent: agentIdOf(info),
      message: brief(pick(info, 'error', 'message') ?? pick(info, 'message'), 300),
    })
  })

  sub('agent/turn-stopping', (info) => {
    record('turn-stop', {
      // 身份 ⇒ payload.agent.id（证据链见文件头 agentIdOf）。
      agent: agentIdOf(info),
      reason: brief(pick(info, 'reason')),
    })
  })

  sub('agent/status', (info) => {
    record('status', {
      // 身份 ⇒ payload.agent.id（证据链见文件头 agentIdOf）。
      agent: agentIdOf(info),
      status: brief(pick(info, 'status') ?? pick(info, 'phase'), 40),
    })
  })

  sub('agent/error', (info) => {
    record('error', {
      // 身份 ⇒ payload.agent.id（证据链见文件头 agentIdOf）。
      agent: agentIdOf(info),
      // turn / step 一直都在 payload 里（dsh-agent-loop: throwError() 发的是
      // `{ turn, step, error }`），此前没落盘 ⇒ 崩溃事件无法与那次 turn 对上号。
      turn: brief(pick(info, 'turn')),
      step: brief(pick(info, 'step')),
      // Error 对象本身也在 payload 里 ⇒ 名字/错误码/栈都拿得到。
      // 此前只记 message，导致「是哪个插件崩的、崩在哪一行」判不了（0/18 带栈）。
      name: brief(pick(info, 'error', 'name'), 60),
      code: brief(pick(info, 'error', 'code') ?? pick(info, 'error', 'cause', 'code'), 40),
      message: brief(pick(info, 'error', 'message') ?? pick(info, 'message'), 300),
      stack: stackOf(pick(info, 'error')),
    })
  })

  sub('subagent/start', (info) => {
    record('sub-start', {
      // WHY parent 恒为 null：subagent/start 的 payload 是
      //   { runId, provider, id, local }   （dsh-subagent/lib/index.js → observeRun）
      // 父代理身份**不在 payload 里** —— 它只以 dispatch 的 this（scope carrier）形式
      // 传递，而 dsh-scope 的 scopeTarget() 刻意把 subject 藏在内部 WeakMap（注释原话：
      // "a carrier whose subject remains available only through event arguments"）。
      // 所以这里不猜、不臆造：落 null，报告里如实按"父身份不可得"处理。
      // 子代理的归属由 child 字段承担（申请单/收兵账本都以 child 为键）。
      parent: null,
      child: brief(pick(info, 'id') ?? pick(info, 'info', 'id'), 60),
      provider: brief(pick(info, 'provider') ?? pick(info, 'info', 'provider'), 40),
      objective: brief(pick(info, 'objectiveId') ?? pick(info, 'info', 'objectiveId'), 60),
    })
  })

  sub('subagent/end', (info) => {
    record('sub-end', {
      child: brief(pick(info, 'id') ?? pick(info, 'info', 'id'), 60),
      outcome: brief(pick(info, 'outcome') ?? pick(info, 'info', 'outcome'), 60),
    })
  })

  // ── 会话事件流：turn / step 边界（2026-11-05 新增）────────────────────────
  //
  // WHY HERE AND NOT ABOVE：这四个事件**不是** dispatch 事件，所以不在
  // 「waterfall / serial / emit」那三类的任何一类里 —— 它们是 SessionEvent。
  // 机理与代价已在文件头「WHY THE LAST FOUR CAME LATE」写全，这里只留实现约束：
  //
  //   1. 必须**白名单过滤**。session/event 是全量流，`assistant/chunk` 流式分片
  //      一次回答可上千条；不过滤 = 观测文件被写爆 = 观测器把自己变成故障源。
  //   2. 只读叶子字段（session.id / event.type / event.data.*），
  //      活对象不进 JSON.stringify。
  //   3. 不占 `seq`：record() 自己发观测序号；会话自己的 seq 若需要另起字段名，
  //      绝不覆盖（覆盖会让「同一条流的相邻性」判断失真）。

  const SESSION_EVENT_KINDS = new Map([
    ['turn/start', 'turn/start'],
    ['step/start', 'step/start'],
    ['turn/end', 'turn/end'],
    ['agent/inbox/spliced', 'inbox/spliced'],
  ])

  // 本实例见过的会话（id → {depth, at}）。**分析半区靠它找到对应的轨迹**：
  // 轨迹目录是 <DSH_HOME>/sessions/<cwd 打平>/session-<uuid>/session.jsonl.zstd，
  // 没有这个 id 就无法知道"该读哪一份"。它只在内存里，不落盘（文件名里已有一份身份）。
  //
  // WHY A REGISTRY AND NOT ONE VARIABLE（2026-11-07 实测踩到）
  // -------------------------------------------------------
  // 预设的 standing mount 在进程内是**共享**的：主会话和它派出的每个子代理会话
  // 都会走同一个 session/event 监听器。只记"最后一个见到的 id"，报告就可能整个
  // 挂到某个子代理身上（它的 id 以 session- 开头，形状一模一样，看不出错）。
  // 实测：一个 11-07 的文件里同时有 1 个 depth=0 的根会话和 8 个 depth=1 的子会话。
  // 所以记 depth，报告一律锚到**最近的根会话**；子代理交给 parentSession 链去认。
  const sessionsSeen = new Map()

  /** 最近活动的根会话 id（depth 未标时按 0 处理）；一个都没有返回 null。 */
  function rootSessionId() {
    let best = null
    for (const [id, meta] of sessionsSeen) {
      const depth = Number.isFinite(meta.depth) ? meta.depth : 0
      if (depth !== 0) continue
      if (!best || meta.at > best.at) best = { id, at: meta.at }
    }
    return best ? best.id : null
  }

  sub('session/event', (session, args) => {
    // 会话身份先取，再走白名单 —— collect='slim' 时下面四种 kind 都不落盘，
    // 但这个 id 仍然必须取到，否则报告找不到轨迹。
    const sid = brief(pick(session, 'id'), 60)
    if (sid && /^session-/.test(sid)) {
      const depthRaw = pick(session, 'meta', 'delegationDepth') ?? pick(session, 'delegationDepth')
      sessionsSeen.set(sid, {
        depth: Number.isFinite(Number(depthRaw)) ? Number(depthRaw) : 0,
        at: nowMs(),
      })
      // 防御：极端长会里见过成百上千个会话时不留垃圾（只保留最近 200 个）。
      if (sessionsSeen.size > 200) {
        const oldest = [...sessionsSeen.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) sessionsSeen.delete(oldest[0])
      }
    }

    const event = Array.isArray(args) ? args[1] : undefined
    const kind = SESSION_EVENT_KINDS.get(pick(event, 'type'))
    if (!kind) return // ← 流式分片在这里被丢掉：一个字节都不落盘
    const data = pick(event, 'data')
    const agent = sid

    if (kind === 'turn/end') {
      // TurnEndReason 是合并可扩展的联合：completed / aborted{reason} /
      // blocked / failed{error:{message,code}}。落 kind 一档 + 失败时的 message，
      // 正好补上此前一直缺的「回合为何停」（turn-stop 事件的 payload 里没有 reason，
      // 实测 1/127 有值 —— 真正的原因一直在这个事件里）。
      record(kind, {
        agent,
        turn: brief(pick(data, 'turn')),
        reason: brief(pick(data, 'reason', 'kind'), 40),
        error: brief(pick(data, 'reason', 'error', 'message'), 200),
      })
      return
    }

    if (kind === 'inbox/spliced') {
      // 收件箱被拼接（含 outcome:'canceled' 这种被取消的情况）——
      // 此前完全不可见，而它正是「用户插话 / 分队回传」进入回合的入口。
      record(kind, {
        agent,
        target: brief(pick(data, 'target'), 40),
        start: brief(pick(data, 'start')),
        inserted: brief(pick(data, 'inserted', 'length')),
        removed: brief(pick(data, 'removedCount')),
        outcome: brief(pick(data, 'outcome'), 20),
      })
      return
    }

    // turn/start 的 data 是 { turn }；step/start 的是 { turn, step }。
    record(kind, {
      agent,
      turn: brief(pick(data, 'turn')),
      step: brief(pick(data, 'step')),
    })
  })

  // ── 工具调用拦截 ──────────────────────────────────────────────────────────
  // ctx.tools.guard 在每次工具执行前被调用，返回 undefined 即放行。
  // 这里只记录，绝不拦截：xray 是观察者，不是闸门。

  try {
    if (ctx.tools && typeof ctx.tools.guard === 'function') {
      ctx.tools.guard((exec) => {
        // collect='slim' 时不记录工具调用：轨迹的 tool/call ↔ tool/result 不仅更全
        // （带真实耗时、成败、callId 配对），还不用守卫去猜。这一条提前返回，
        // 顺带让每次工具调用少一次 brief/JSON 序列化。
        if (COLLECT === 'slim') return undefined
        try {
          const toolName = String(pick(exec, 'name') ?? '')
          if (!toolName) return undefined
          // xray 自己的调用**不记成 tool**，但要记成独立的 `self-call`。
          //
          // 为什么改（2026-11-05 · P1）：原先这里直接 `return undefined`。纪律本身对
          // （不进工具排行，避免自我观测污染"工具在干什么"），代价是**结构性不可测**
          // —— 全量 5,214 条事件里 xray_* 调用 0 次，于是「这件工具到底有没有人用」
          // 永远答不了，而"0 次"看起来和"没人用"一模一样。
          //
          // 现在两侧都守住：
          //   ① 独立 kind —— analyze() 不把它算进 toolCalls / toolBreakdown / 空转，
          //      所以工具口径与判定规则一个字都不受影响；
          //   ② 它仍是一条事件 —— 于是采用率可数（报告头部「自身调用 N」）。
          // 体积上每次 xray 调用只多一条，不存在"撑爆"问题；真正会撑爆的是
          // session/event 的流式分片，那边靠白名单挡（见文件头）。
          if (toolName.startsWith('xray_')) {
            record('self-call', {
              tool: toolName,
              agent: brief(pick(exec, 'agent', 'id'), 60),
              args: brief(pick(exec, 'arguments'), 120),
            })
            return undefined
          }
          record('tool', {
            tool: toolName,
            agent: brief(pick(exec, 'agent', 'id'), 60),
            args: brief(pick(exec, 'arguments'), 200),
          })
        } catch { /* 静默 */ }
        return undefined // 永远放行
      })
    }
  } catch { /* guard 不可用则跳过工具级观测 */ }

  // ── 读盘：新老布局并存 ────────────────────────────────────────────────────
  //
  // 老文件 YYYY-MM-DD.jsonl 与新文件 YYYY-MM-DD.<instanceId>.jsonl **都要读**：
  // 换布局的那一刻，正在跑的旧进程还在写老文件，历史数据也躺在老文件里。
  // 只认新布局 = 换一次布局就把历史读断了。
  const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.[A-Za-z0-9_-]+)?\.jsonl$/

  /** 从文件名取日期键；不是观测文件返回 null。 */
  function dayOfFile(fname) {
    const m = DAY_FILE_RE.exec(fname)
    return m ? m[1] : null
  }

  /**
   * 读一组观测文件，逐行容错解析。
   *
   * 解析失败的行（历史碎片、被外部工具按宽度切出来的半行）**跳过并计数**：
   * 观测者不允许因为自己的脏数据把调用方炸掉。上一版这里是
   * `try { JSON.parse } catch {}`（xray_hotspots）—— 行虽然被跳过，但
   * 没有计数，于是"数据缺了"这件事在报告里完全看不见。
   */
  async function readDayFiles(dir, names) {
    const events = []
    const stats = { files: 0, lines: 0, parsed: 0, skipped: 0, legacyFiles: 0, instanceFiles: 0 }
    for (const fname of names) {
      let raw = ''
      try { raw = await fs.readFile(path.join(dir, fname), 'utf8') } catch { continue }
      stats.files++
      if (fname === fname.slice(0, 10) + '.jsonl') stats.legacyFiles++
      else stats.instanceFiles++
      for (const ln of raw.split('\n')) {
        const s = ln.endsWith('\r') ? ln.slice(0, -1) : ln
        if (!s) continue
        stats.lines++
        try { events.push(JSON.parse(s)); stats.parsed++ } catch { stats.skipped++ }
      }
    }
    events.sort((a, b) => a.t - b.t || a.seq - b.seq)
    return { events, stats }
  }

  /** 列出最近 days 天内的观测文件（新布局 + 老布局，按文件名排序）。 */
  async function listDayFiles(dir, days) {
    let files = []
    try { files = await fs.readdir(dir) } catch { return [] }
    const cutoff = nowMs() - days * 86400_000
    return files
      .filter((f) => {
        const day = dayOfFile(f)
        return day !== null && new Date(day + 'T00:00:00Z').getTime() >= cutoff
      })
      .sort()
  }

  // ── 分析：把 recent 聚合成一次运行的耗时分解 ─────────────────────────────

  function analyze(events) {
    const out = {
      total: 0,
      spanMs: 0,
      steps: 0,
      requests: 0,
      toolCalls: 0,
      errors: 0,
      subagents: 0,
      selfCalls: 0,        // xray_* 自身调用次数（采用率口径，**不进** toolCalls）
      toolBreakdown: {},   // tool → { count, firstT, lastT }
      thinkGaps: [],       // 相邻 request 与下一个 pre-step 的间隔
      idleGaps: [],        // 相邻事件间隔 > 阈值，视为空转/等待
      byAgent: {},
      // 身份缺失的事件落到这里 —— 它是**一类**被显式计数的东西，不是"看不见的缺失"。
      // 报告的守恒式要用到它：Σ各 agent 请求 + 未归因请求 = 总请求。
      unattributed: emptyBucket(),
      squads: null,        // 分队账本（summarizeSquads 的产物），无事件时为 null
      bigGaps: [],
      emptyLoops: [],      // 口径 A·连续：极大连续运行 ≥loopTimes 次（判定读这个）
      repeat: null,        // countRepeatLoops() 的完整产物：两种口径都在里面
      // ── 以下为「口径修正」新增字段（原有字段一个不删、语义不变）────────────
      // 旧口径 `平均每步耗时 = spanMs / steps` 把工具执行时间算进了「每步」，
      // 于是"模型慢"和"工具慢"混成一个数，读的人无法据此优化。这里按**相邻事件
      // 间隔归属于前一个事件的种类**重新归因：
      //   前一条是 request → 这段间隔是「等模型响应」
      //   前一条是 tool    → 这段间隔是「工具在执行（+ 紧随其后的收尾）」
      // 其余（turn-stop/status/sub-* 等）归入 otherMs，不冒充任何一类。
      modelWaitMs: 0,      // Σ 前一条是 request 的间隔
      modelWaitSegments: 0,
      toolSpanMs: 0,       // Σ 前一条是 tool 的间隔
      toolSpanSegments: 0,
      otherMs: 0,
      subEnds: 0,          // 分队收兵记录
      reportCalls: 0,      // subagent report 工具调用次数
      errorTexts: [],      // [{ kind, text }] 最多 5 条，供判定引用
      firstT: 0,
      lastT: 0,
      lastRequestT: 0,
    }
    if (!events.length) return out

    const IDLE_MS = Number(config?.idleThresholdMs ?? 60_000)
    const sorted = events.slice().sort((a, b) => a.t - b.t || a.seq - b.seq)
    out.total = sorted.length
    out.spanMs = sorted[sorted.length - 1].t - sorted[0].t

    let lastT = sorted[0].t
    let prevKind = null
    let prevStream = null
    let prevTool = ''
    let prevAgent = null
    out.firstT = sorted[0].t
    out.lastT = sorted[sorted.length - 1].t

    for (const e of sorted) {
      const gap = e.t - lastT
      // 跨流间隔一律不算（理由见 attributeByAgent 的同名注释）：合并多份轨迹时
      // 它们属于"两个并行会话之间"，既不归模型也不归工具，更不该进"其余"。
      const sameStream = (prevStream ?? null) === (e.stream ?? null)
      // 口径归因分两半：等模型 / 工具执行由 attributeByAgent() **一次算完**
      // （它同时产出 per-agent 的同一份数字，两边不可能漂移）；这里只留下第三类
      // 「其余」——收尾/生命周期阶段的间隔。第一类与第二类若在这里再加一次，
      // 就等于两份实现，xray_report 与 xray_compare 迟早对不上。
      if (sameStream && prevKind !== 'request' && prevKind !== 'tool') out.otherMs += gap

      if (sameStream && gap >= IDLE_MS && lastT > 0) {
        out.idleGaps.push({ from: lastT, to: e.t, gap, nextKind: e.kind, nextTool: e.tool })
        // prevKind 是归因的关键（见 classifyGap）：空档从哪个动作里长出来。
        // agent 一并带上：堵点属于谁，是「谁该被优化」的唯一线索。
        out.bigGaps.push({ gap, at: e.t, kind: e.kind, detail: e.tool || e.agent || '', prevKind, prevTool, agent: e.agent || null, prevAgent })
      }
      lastT = e.t
      prevAgent = e.agent || null
      prevStream = e.stream ?? null

      switch (e.kind) {
        case 'pre-step':
          out.steps++
          break
        case 'request':
          out.requests++
          out.lastRequestT = e.t
          break
        case 'tool': {
          out.toolCalls++
          if (e.tool === 'report') out.reportCalls++
          const b = (out.toolBreakdown[e.tool] ||= { count: 0, firstT: e.t, lastT: e.t })
          b.count++
          b.lastT = e.t
          // 空转检测**不在这里**：它需要"相邻工具调用"这条序列信息，逐事件累加
          // 拿不到相邻性（那正是 2026-10-30 那个口径缺陷的成因）。见循环之后的
          // countRepeatLoops()。
          break
        }
        case 'error':
        case 'req-error':
          out.errors++
          if (out.errorTexts.length < 5) {
            out.errorTexts.push({ kind: e.kind, text: brief(e.message, 120) || '(无错误文本)' })
          }
          break
        case 'sub-start':
          out.subagents++
          break
        case 'sub-end':
          out.subEnds++
          break
        // 自身调用：只计数，**不进 toolCalls / toolBreakdown / 空转**。
        // 这一分支存在的唯一目的就是让"采用率"从不可测变成可测，
        // 同时保证工具口径与此前完全一致（判定规则不受影响）。
        case 'self-call':
          out.selfCalls++
          break
        default:
          break
      }
      prevKind = e.kind
      prevTool = e.kind === 'tool' ? (e.tool || '') : ''
    }

    out.bigGaps.sort((a, b) => b.gap - a.gap)
    out.bigGaps = out.bigGaps.slice(0, 10)

    // ── 空转：一次算两种口径（口径 A 驱动判定，口径 B 只并列展示）──────────
    // 阈值统一取 DIAG_DEFAULTS.loopTimes —— 判定与展开口径自此只有一个来源。
    const rep = countRepeatLoops(sorted, DIAG_DEFAULTS.loopTimes)
    out.repeat = rep
    // emptyLoops 的**元素形状保持不变**（tool / args / times），只是来源从
    // "累计第 3 次" 变成 "极大连续运行 ≥3 次"，times = 该段运行的长度。
    out.emptyLoops = rep.consecutive
      .map((g) => ({ tool: g.tool, args: brief(g.args, 100), times: g.times }))
      .sort((x, y) => y.times - x.times)

    // ── per-agent 归因 + 分队账本：**一次算完**，供 renderReport 与 diagnose 共用 ──
    // 三个数字（等模型/工具执行/各 agent 桶）现在只有一个来源，
    // 于是「Σ各 agent + 未归因 = 全局」这条守恒式是结构性成立的。
    const att = attributeByAgent(sorted)
    out.byAgent = att.byAgent
    out.unattributed = att.unattributed
    out.modelWaitMs = att.modelWaitMs
    out.modelWaitSegments = att.modelWaitSegments
    out.toolSpanMs = att.toolSpanMs
    out.toolSpanSegments = att.toolSpanSegments
    out.squads = summarizeSquads(sorted)
    return out
  }

  /**
   * analysis → diagnose() 的输入。放在 apply 里是因为 idleThresholdMs 来自 config。
   * 这一步刻意只做**映射**，不做判断 —— 判断全在 diagnose() 里，才能被单测。
   * @param {object} a analyze() 的产物
   * @param {number} windowMinutes 本次报告的回看窗口
   */
  function diagnosticsOf(a, windowMinutes) {
    const worstGap = a.bigGaps && a.bigGaps.length ? a.bigGaps[0] : null
    return diagnose({
      events: a.total,
      spanMs: a.spanMs,
      steps: a.steps,
      requests: a.requests,
      toolCalls: a.toolCalls,
      errors: a.errors,
      errorTexts: a.errorTexts,
      subagents: a.subagents,
      subEnds: a.subEnds,
      reportCalls: a.reportCalls,
      maxGap: worstGap
        ? {
          ms: worstGap.gap,
          nextKind: worstGap.kind,
          nextTool: worstGap.detail || '',
          prevKind: worstGap.prevKind || '',
          prevTool: worstGap.prevTool || '',
        }
        : null,
      loops: a.emptyLoops,
      // 两种空转口径的完整产物：判定只读 emptyLoops（口径 A），repeat 里的口径 B
      // 数字只用于在 finding 正文里写一句"别混着比"。
      repeat: a.repeat,
      // 分队账本 + 未归因请求数：让「派了没收 / 覆盖率 / 观测字段缺失」也能成为判定，
      // 而不只是报告里的一行数字。两者都是纯数据，判断仍在 diagnose() 里。
      squads: a.squads,
      unattributedRequests: a.unattributed ? a.unattributed.requests : 0,
      unattributedEvents: a.unattributed ? a.unattributed.events : 0,
      windowMinutes,
      idleWarnMs: Number(config?.idleThresholdMs ?? 60_000),
      idleBadMs: Math.max(300_000, Number(config?.idleThresholdMs ?? 60_000)),
    })
  }

  /** 等级 → 中文标签，卡片与文本共用一份口径。 */
  const levelLabel = (level) => (level === 'bad' ? '异常' : level === 'warn' ? '注意' : '正常')

  function renderReport(a, diag, windowMinutes) {
    const L = []
    L.push('═══ XRAY REPORT ═══')
    L.push('事件 ' + a.total + ' 条 ｜ 跨度 ' + dur(a.spanMs) +
      ' ｜ 步 ' + a.steps + ' ｜ 模型请求 ' + a.requests +
      ' ｜ 工具调用 ' + a.toolCalls + ' ｜ 分队 ' + a.subagents +
      ' ｜ 错误 ' + a.errors +
      // 自身调用（xray_* 被调用次数）单独成项，**不加进工具调用**：它是采用率口径，
      // 不是"模型干了什么"的口径。只在非 0 时出现，避免空报告多一行噪音。
      // 注意：客户端卡片（lib/client.js）的 header 解析用的是逐字段正则
      // （/工具调用\s+(\d+)/ 之类），追加字段不会破坏它；但卡片**尚未展示这一项**，
      // 要展示得改 client.js 并重建 bundle（P2）。
      (a.selfCalls > 0 ? ' ｜ 自身调用 ' + a.selfCalls : ''))

    // ── 判定 ──
    // 为什么放在最前面：读这份报告的人（和模型）第一眼要的是"有没有问题"，
    // 不是事件总数。格式是**逐行可解析**的（等级/结论/发现N 三个固定前缀），
    // 客户端卡片就是照这个格式解析的，改格式必须同步改 lib/client.js。
    L.push('')
    L.push('── 判定 ──')
    L.push('等级: ' + diag.level + '（' + levelLabel(diag.level) + '）')
    L.push('结论: ' + diag.verdict)
    for (let i = 0; i < diag.findings.length; i++) {
      const f = diag.findings[i]
      L.push('发现' + (i + 1) + ': ' + f.signal + ' ｜ ' + f.meaning + ' ｜ 建议 ' + f.action)
    }

    // ── 耗时口径 ──
    // 旧口径原样保留（下游有人读它），新增的两种口径跟在后面：它们回答的是
    // "慢在模型还是慢在工具"，旧口径回答的是"整段平均下来每步多少"。
    if (a.requests > 0) {
      L.push('平均每步耗时 ' + dur(a.spanMs / Math.max(1, a.steps)) +
        ' ｜ 平均每请求 ' + dur(a.spanMs / Math.max(1, a.requests)))
    }
    L.push('平均等模型 ' + dur(a.modelWaitSegments ? a.modelWaitMs / a.modelWaitSegments : 0) +
      '（' + a.modelWaitSegments + ' 段）' +
      ' ｜ 工具执行总时长 ' + dur(a.toolSpanMs) + '（' + a.toolSpanSegments + ' 段）' +
      ' ｜ 其余 ' + dur(a.otherMs))
    L.push('  （口径：相邻事件的间隔归属到「前一条事件」—— 前一条是 request 就是等模型，' +
      '前一条是 tool 就是工具在执行。上面的「平均每步耗时」是旧口径，把两者混在一起，仅供对比。）')

    const tools = Object.entries(a.toolBreakdown).sort((x, y) => y[1].count - x[1].count)
    if (tools.length) {
      L.push('')
      L.push('── 工具调用 TOP ──')
      for (const [t, b] of tools.slice(0, 12)) {
        L.push('  ' + String(b.count).padStart(4) + '×  ' + t.padEnd(30) + ' 最后 ' + new Date(b.lastT).toTimeString().slice(0, 8))
      }
    }

    if (a.bigGaps.length) {
      L.push('')
      L.push('── 堵点 TOP (间隔最大的位置) ──')
      for (const g of a.bigGaps) {
        // 末尾的「· 在等模型 / 在等工具」既是给人看的结论，也是浏览器卡片分色
        // 的依据（卡片按这两个词给条目上色）。归因与判定共用 classifyGap()。
        const cls = classifyGap(g.prevKind, g.kind)
        const wait = gapWaitLabel(cls)
        L.push('  ' + dur(g.gap).padEnd(9) + ' 之后紧跟 ' + g.kind +
          (g.detail ? ' / ' + brief(g.detail, 60) : '') +
          (wait ? '  ·  ' + wait : ''))
      }
    } else {
      L.push('')
      L.push('── 堵点 ──')
      L.push('  无超过阈值的间隔')
    }

    // ── 疑似空转：**两种口径并列** ─────────────────────────────────────────
    // WHY BOTH NUMBERS, ALWAYS
    // ------------------------
    // 2026-10-30 之前这里只打一个数，而那个数是"累计口径"、标签却写"连续"，
    // 于是同一个词在两处指两件事，和 _xray_repeat_metric.mjs 的口径 A/B 一对
    // 就对不上，谁拿它做前后对比都会混。现在两个数一起打，各带一句说明：
    // 谁要引用，都能一眼看出自己引用的是哪一个。判定只看口径 A。
    if (a.repeat) {
      const rep = a.repeat
      L.push('')
      L.push('── 疑似空转（同工具同参数 ≥3 次） ──')
      if (a.emptyLoops.length) {
        for (const e of a.emptyLoops.slice(0, 8)) {
          L.push('  ' + e.tool + ' ×' + e.times + '  ' + (e.args || ''))
        }
      } else {
        L.push('  无「相邻签名相同、连续 ≥' + rep.minRun + ' 次」的运行 —— 这一项在连续口径下是干净的。')
      }
      L.push('  口径 A·连续（判定依据，本报告的"空转"只用它）：相邻工具调用签名相同的最长运行，' +
        '长度 ≥' + rep.minRun + ' 记 1 组 ⇒ 本窗口 ' + rep.consecutiveGroups + ' 组 / ' + rep.toolCalls + ' 次工具调用。' +
        '连续重复才是真空转：上一次的结果没被采信，紧接着又调了一遍。')
      L.push('  口径 B·累计（仅供参考，不参与判定）：同一签名全窗口出现 ≥' + rep.minRun +
        ' 次记 1 个签名 ⇒ 本窗口 ' + rep.cumulativeGroups + ' 个签名。' +
        '零散重复通常有正当理由（换了文件/换了参数边界），而且它随回看窗口大小漂移，' +
        '所以**不要**把这一行和上面那行放在一起比大小。')
    }

    // ── 分队（派兵 / 收兵）──
    // 放在「各 agent 活动量」之前：先看"派了几支、回来几支、谁派出去没动"，
    // 再看"每支干了多少活"。顺序反了会把"没干活"读成"活少"。
    L.push('')
    L.push(...renderSquadLines(a.squads))

    // ── 各 agent 活动量（含守恒断言）──
    // 卡片端按行前缀解析，这一节的标题与首行格式保持不变；新增的是下面的
    // 「未归因」行与「守恒」行 —— 它们不上卡，但模型读得到，而模型才是
    // 需要据此判断"该不该怀疑这张表"的那一方。
    if (Object.keys(a.byAgent).length || a.unattributed.events) {
      L.push('')
      L.push(...renderAgentActivityLines(a))
    }
    return L.join('\n')
  }

  // ── 分析半区：从会话轨迹取事件与事实（2026-11-07）────────────────────────
  //
  // WHY THIS IS A SEPARATE STEP FROM analyze()
  // ------------------------------------------
  // analyze() 只认识 xray 形状的事件，它对"数据从哪来"一无所知。这里负责把
  // 轨迹翻译成同样的形状（lib/trace.js），然后两种来源拼成一张表交给 analyze()。
  // 于是「口径」只有一份实现，来源变了口径不会变 —— 这正是上一轮把它拆成
  // 采集/分析两个半区的原因。
  //
  // 多份轨迹（主会话 + 各子代理会话）合并时的三条纪律：
  //   ① 每个事件带 stream（来源文件）。跨流的间隔一律不归因，否则并行会话之间
  //      的空档会被算成"某个工具执行了很久"；
  //   ② 同一轴不取两个来源：xray 采集的 tool/request/pre-step/turn 边界在合并
  //      轨迹时被丢弃（轨迹更全），采集侧只保留 slim 的四类；
  //   ③ 读不到就说读不到：跳过几份、为什么跳过，都写在报告里，绝不让"没读"看起来像"没有"。

  const fmtN = (n) => Math.round(Number(n) || 0).toLocaleString('en-US')

  /**
   * @param {number} since 窗口左端（ms）
   * @param {string|undefined} sessionSpec 显式指定的会话（id 片段 / 路径）
   * @param {object[]} slimEvents 采集半区的 slim 事件（用来找子代理 session id）
   * @returns {{events:object[], traces:object[], skipped:number, scanned:number, reason:string}}
   */
  function collectTracePart(since, sessionSpec, slimEvents) {
    const out = { events: [], traces: [], skipped: 0, scanned: 0, reason: '', sessionIds: new Set() }
    if (!USE_TRACE) { out.reason = '已在配置里关掉轨迹分析（trace: false）'; return out }

    // 一次性列目录：findTrace() 每次都走一遍 sessions 树，多分队时会很贵。
    const all = listTraces()
    if (!all.length) { out.reason = '没找到任何会话轨迹（' + (process.env.DSH_HOME || '%USERPROFILE%/.dsh') + '\\sessions）'; return out }
    const pickPath = (spec) => {
      if (!spec) return null
      const s = String(spec)
      const hit = all.find((t) => t.path.includes(s))
      return hit ? hit.path : null
    }

    // 主会话：显式参数 > 最近的**根**会话 > 本窗口事件里带的 agent 身份。
    //
    // **没有"随便挑最近一份轨迹"的兜底**：那样会在会话 id 对不上时，把别人的会话
    // 混进这份报告，而且看上去完全正常 —— 这是"读数张冠李戴"最典型的形状。
    // 找不到就说找不到。
    const hint = rootSessionId() || (slimEvents.find((e) => typeof e.agent === 'string' && /^session-/.test(e.agent)) || {}).agent
    const primary = pickPath(sessionSpec) || pickPath(hint)
    if (!primary) {
      out.reason = sessionSpec
        ? '指定的会话「' + String(sessionSpec) + '」找不到对应轨迹'
        : '还没看到本会话的 session id（等一条会话事件，或显式传 session 参数）'
      return out
    }
    const primaryTrace = loadTrace(primary)
    const primaryId = primaryTrace?.header?.id || String(hint || '')
    out.sessionIds.add(primaryId)

    // 候选：sub-start 的 child 字段（子代理 id）—— xray 采集的**名册**。
    // 这正是"采集半区只留分队时序"仍然值钱的地方：它给出名册，轨迹给出内容。
    const candidates = []
    const seenPath = new Set([primary])
    for (const e of slimEvents) {
      if (e.kind !== 'sub-start' || !e.child) continue
      const p = pickPath(e.child)
      if (p && !seenPath.has(p)) { seenPath.add(p); candidates.push(p) }
    }

    // 按 parentSession 链认亲：只有**祖先链最终落到本会话**的那些子代理才算这一仗的。
    // 不认亲的后果实测过：同一进程里前一个会话派出的子代理被并进来，报告的跨度
    // 从 1 小时变成 29 小时，token 也一起翻倍 —— 而数字本身看不出任何异常。
    const byPath = new Map(all.map((t) => [t.path, t]))
    const parentOf = new Map()
    for (const p of candidates) {
      const st = byPath.get(p)
      if (st && st.mtimeMs < since) continue // 窗口之后没再动过 ⇒ 不可能是本仗的（省一次解压）
      const tr = loadTrace(p)
      if (!tr) { out.skipped++; continue }
      parentOf.set(p, { tr, parent: tr.header?.parent || null, id: tr.header?.id || null })
    }
    const accepted = []
    const acceptedIds = new Set([primaryId])
    // 反复扫到稳定为止：深度 2+ 的子代理，其 parent 是某个子代理会话。
    for (let round = 0; round < 6; round++) {
      let grew = false
      for (const [p, v] of parentOf) {
        if (accepted.includes(p) || !v.parent) continue
        // parent 既可能是带 session- 前缀的根会话 id，也可能是子会话 id
        const parentHit = acceptedIds.has(v.parent) ||
          [...acceptedIds].some((x) => String(x).replace(/^session-/, '') === String(v.parent).replace(/^session-/, ''))
        const primaryHit = String(v.parent) === String(primaryId) ||
          String(v.parent).replace(/^session-/, '') === String(primaryId).replace(/^session-/, '')
        if (!parentHit && !primaryHit) continue
        accepted.push(p)
        if (v.id) acceptedIds.add(String(v.id))
        if (v.id) acceptedIds.add(String(v.id).replace(/^session-/, 'session-'))
        grew = true
      }
      if (!grew) break
    }
    out.skipped += parentOf.size - accepted.length
    for (const id of acceptedIds) out.sessionIds.add(id)

    const inWindow = [primary, ...accepted].slice(0, TRACE_MAX)
    out.skipped += Math.max(0, (1 + accepted.length) - inWindow.length)

    for (const p of inWindow) {
      const r = readTraceAsEvents(p)
      if (!r) { out.skipped++; continue }
      out.scanned++
      out.traces.push({ path: p, label: traceLabel(r.trace), trace: r.trace })
      // 轨迹事件**不做时间裁剪**：轨迹是按会话落盘的，"这一仗花了多少"就是这个
      // 会话的全量，而不是最近 N 分钟。minutes 只约束观测侧（旧全量数据、错误、
      // 分队事件）。两个口径在报告尾部各写各的，绝不混成一个数字。
      for (const e of r.events) out.events.push({ ...e, stream: p })
    }
    if (!out.scanned) out.reason = '轨迹读取失败（' + (1 + accepted.length) + ' 份都读不出来）'
    return out
  }

  /** 把多份轨迹的事实按轴求和（token/损耗/时间）。纯加法，不做跨会话推断。 */
  function aggregateTraceFacts(traces) {
    const agg = {
      files: traces.length,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
      turns: 0, steps: 0, toolCalls: 0, userMessages: 0,
      retries: 0, retryDelayMs: 0, retryByCode: {},
      prune: 0, summary: 0, configChanges: 0, contextWindow: null,
      badTurns: 0,
      modelMsSum: 0, activeMs: 0, idleMs: 0, stepGapMs: 0, turnEdgeMs: 0, activeOtherMs: 0,
      engineToolMs: 0, humanWaitMs: 0, humanWaitCount: 0, backfilled: 0,
      toolTable: [], topTurns: [],
      activeSource: '',
    }
    const toolByName = new Map()
    for (const item of traces) {
      const t = item.trace
      if (!t) continue
      for (const k of Object.keys(agg.usage)) agg.usage[k] += Number(t.usage?.[k] || 0)
      agg.turns += t.counts?.turns || 0
      agg.steps += t.counts?.steps || 0
      agg.toolCalls += t.counts?.toolCalls || 0
      agg.userMessages += t.counts?.userMessages || 0
      agg.retries += t.retries?.count || 0
      agg.retryDelayMs += t.retries?.delayMs || 0
      for (const [c, n] of Object.entries(t.retries?.byCode || {})) agg.retryByCode[c] = (agg.retryByCode[c] || 0) + n
      agg.prune += t.compaction?.prune || 0
      agg.summary += t.compaction?.summary || 0
      agg.configChanges += t.configChanges || 0
      if (t.contextWindow) agg.contextWindow = Math.max(agg.contextWindow || 0, t.contextWindow)
      agg.badTurns += (t.turns || []).filter((x) => x.reasonKind && x.reasonKind !== 'completed').length
      agg.modelMsSum += t.time?.modelMsSum || 0
      agg.activeMs += t.time?.activeMs || 0
      agg.idleMs += t.time?.idleMs || 0
      agg.stepGapMs += t.time?.stepGapMs || 0
      agg.turnEdgeMs += t.time?.turnEdgeMs || 0
      agg.activeOtherMs += t.time?.activeOtherMs || 0
      agg.engineToolMs += t.engineToolMs || 0
      agg.humanWaitMs += t.humanWaitMs || 0
      agg.humanWaitCount += t.humanWaitCount || 0
      agg.backfilled += t.backfilledCount || 0
      if (!agg.activeSource && t.time?.activeSource) agg.activeSource = t.time.activeSource
      for (const row of t.toolTable || []) {
        const cur = toolByName.get(row.name) || { name: row.name, count: 0, totalMs: 0, maxMs: 0, failed: 0, noResult: 0, backfilled: 0 }
        cur.count += row.count
        cur.totalMs += row.totalMs
        cur.maxMs = Math.max(cur.maxMs, row.maxMs)
        cur.failed += row.failed
        cur.noResult += row.noResult
        cur.backfilled += row.backfilled
        toolByName.set(row.name, cur)
      }
      for (const tn of t.turns || []) {
        if (tn.durMs == null) continue
        agg.topTurns.push({
          trace: item.label,
          turn: tn.turn,
          steps: tn.steps,
          durMs: tn.durMs,
          output: tn.usage?.outputTokens || 0,
          cacheRead: tn.usage?.cacheReadTokens || 0,
        })
      }
    }
    agg.toolTable = [...toolByName.values()].sort((a, b) => b.totalMs - a.totalMs)
    agg.topTurns = agg.topTurns.sort((a, b) => b.output - a.output).slice(0, 3)
    return agg
  }

  /**
   * 轨迹口径那一段。**只写实测数字**，并把口径与边界写在同一行，
   * 因为读这份报告的人（和模型）会直接拿这些数字下结论。
   */
  function renderTraceSection(tp, minutes) {
    const L = []
    L.push('')
    if (!tp.traces.length) {
      L.push('── 轨迹口径 ──')
      L.push('  没有可用的会话轨迹：' + (tp.reason || '未知原因'))
      L.push('  ⇒ 步 / 工具 / token 这几项本轮读不到（采集半区只采错误栈、分队时序、状态）。')
      return L.join('\n')
    }
    const agg = aggregateTraceFacts(tp.traces)
    const billed = agg.usage.inputTokens + agg.usage.cacheReadTokens
    const hit = billed > 0 ? (agg.usage.cacheReadTokens / billed) * 100 : null

    L.push('── 轨迹口径（分析半区：token / 耗时 / 损耗，直接读 dsh 会话轨迹）──')
    L.push('  读取      : ' + tp.traces.length + ' 份轨迹' +
      (tp.skipped ? '（另有 ' + tp.skipped + ' 份跳过：窗口外或超出 traceMaxFiles=' + TRACE_MAX + '）' : ''))
    L.push('  时间范围  : 本会话**全程**（轨迹按会话落盘，不做时间裁剪 —— 与上方「窗口」口径不同，' +
      '上方窗口只管观测侧那几类事件）')
    for (const it of tp.traces.slice(0, 6)) {
      const c = it.trace.counts || {}
      L.push('              · ' + it.label + '  回合 ' + (c.turns ?? 0) + ' ｜ 步 ' + (c.steps ?? 0) + ' ｜ 工具 ' + (c.toolCalls ?? 0))
    }
    if (tp.traces.length > 6) L.push('              · …另有 ' + (tp.traces.length - 6) + ' 份分队轨迹')
    L.push('  token     : 输入 ' + fmtN(agg.usage.inputTokens) +
      ' ｜ 缓存读 ' + fmtN(agg.usage.cacheReadTokens) +
      ' ｜ 输出 ' + fmtN(agg.usage.outputTokens) +
      ' ｜ 推理 ' + fmtN(agg.usage.reasoningTokens))
    L.push('  缓存命中率 : ' + (hit == null ? 'n/a' : hit.toFixed(1) + '%') +
      '（缓存读 / (缓存读+输入)；掉下来通常意味着前缀被改或压缩过）' +
      (agg.contextWindow ? ' ｜ 上下文窗口 ' + fmtN(agg.contextWindow) : ''))
    L.push('  引擎活跃   : ' + dur(agg.activeMs) + '（口径：' + (agg.activeSource || '回合窗口') + '）' +
      ' ｜ 等模型 ' + dur(agg.modelMsSum) + '（占活跃 ' +
      (agg.activeMs > 0 ? ((agg.modelMsSum / agg.activeMs) * 100).toFixed(1) : '0.0') + '%）' +
      ' ｜ 步间 ' + dur(agg.stepGapMs) + ' ｜ 回合前后 ' + dur(agg.turnEdgeMs) + ' ｜ 其余 ' + dur(agg.activeOtherMs))
    L.push('  空闲       : ' + dur(agg.idleMs) + ' ← 人不在/在想，**不是可优化项**，别拿它当损耗')
    L.push('  工具实测   : ' + dur(agg.engineToolMs) + '（已剔除回填 ' + agg.backfilled + ' 条）' +
      (agg.humanWaitCount ? ' ｜ 等人回答 ' + dur(agg.humanWaitMs) + '（' + agg.humanWaitCount + ' 次提问，是人在打字）' : ''))
    L.push('  重试       : ' + agg.retries + ' 次，等待 ' + dur(agg.retryDelayMs) +
      (agg.retries && Object.keys(agg.retryByCode).length
        ? '（' + Object.entries(agg.retryByCode).map(([k, v]) => k + '×' + v).join('、') + '）'
        : '') +
      ' ｜ 上下文压缩 prune ' + agg.prune + ' ／ 摘要 ' + agg.summary +
      ' ｜ 请求头变更 ' + agg.configChanges + ' 次')
    L.push('  异常回合   : ' + agg.badTurns + '/' + agg.turns + '（停止原因非 completed）')

    if (agg.toolTable.length) {
      L.push('')
      L.push('  工具耗时 TOP（轨迹 call↔result 配对，回填不计入）:')
      for (const r of agg.toolTable.slice(0, 10)) {
        L.push('    ' + String(r.name).padEnd(24) + String(r.count).padStart(4) + ' 次  ' +
          dur(r.totalMs).padStart(9) + '  最长 ' + dur(r.maxMs).padStart(7) +
          '  失败 ' + r.failed + '  无结果 ' + r.noResult)
      }
    }
    if (agg.topTurns.length) {
      L.push('  最贵的回合（按输出 token）:')
      for (const t of agg.topTurns) {
        L.push('    ' + t.trace + ' turn ' + t.turn + ' ｜ 步 ' + t.steps + ' ｜ 输出 ' + fmtN(t.output) +
          ' ｜ 缓存读 ' + fmtN(t.cacheRead) + ' ｜ ' + dur(t.durMs))
      }
    }
    return L.join('\n')
  }

  // ── 报告正文：工具与浏览器按钮共用的唯一实现 ─────────────────────────────
  //
  // WHY ONE FUNCTION, NOT TWO
  // -------------------------
  // 「点按钮拿到的报告」与「模型调 xray_report 拿到的报告」必须是同一份文本。
  // 两条路各写一遍的话，早晚会漂移成两套口径 —— 那时卡片和模型说的不一致，
  // 而没人能立刻看出是哪边错了。
  //
  // @param {number} minutes 回看窗口（分钟）
  // @param {string} [sessionSpec] 要分析的会话（id 片段 / 路径）；默认本实例所在会话
  // @returns {Promise<{text:string, empty:boolean, level:string, verdict:string, level?}>}
  /**
   * 报告锚到哪个会话 —— 三级优先，每一级都比下一级更权威：
   *   ① 显式参数 session（事后复盘别人的会话）
   *   ② ToolRunContext.agent.id（调用我的那个会话 —— 唯一正确答案）
   *   ③ 最近活动的**根**会话（浏览器 RPC 按钮没有调用方身份，只能退到这里）
   * 第 ③ 级在"同一进程里有两个根会话"时可能选错，所以报告尾部永远写明读了哪几份轨迹。
   */
  async function buildReportText(minutes, sessionSpec) {
    const since = nowMs() - minutes * 60_000
    let slice = recent.filter((e) => e.t >= since)
    let source = '内存缓冲 ' + slice.length + '/' + recent.length + ' 条'
    let skipped = 0
    if (!slice.length) {
      // 内存缓冲只覆盖「本实例本次运行」。实例重启后缓冲是空的，但盘上
      // 还有数据 —— 此时回落到文件（新老布局都读），否则会出现
      // 「明明有观测文件，report 却说一条事件都没有」。
      const dir = xrayDir()
      const names = await listDayFiles(dir, 2)
      const fromDisk = await readDayFiles(dir, names)
      slice = fromDisk.events.filter((e) => e.t >= since)
      skipped = fromDisk.stats.skipped
      if (slice.length) {
        source = '观测文件 ' + fromDisk.stats.files + ' 个（每实例分片 ' +
          fromDisk.stats.instanceFiles + ' / 老布局 ' + fromDisk.stats.legacyFiles + '），' +
          slice.length + ' 条' + (skipped ? '，跳过无法解析的行 ' + skipped + ' 条' : '')
      }
    }

    // 采集半区：合并轨迹时只认 slim 的四类（其余轴一律由轨迹提供，避免同轴两源）。
    //
    // 例外：**一份轨迹都没读到**时不裁。此时轨迹这一半是空的，再把采集侧的
    // 工具/步/请求裁掉，报告就变成"什么都没发生" —— 那是把"读不到"伪装成"没有"。
    // 这种降级在报告尾部会写明"轨迹不可用，退回观测口径"。
    const slim = slice.filter((e) => SLIM_KINDS.has(e.kind))
    const tracePart = collectTracePart(since, sessionSpec, slim)
    const useTraceAxes = tracePart.scanned > 0
    // 观测侧也要按会话收口：预设的 standing mount 在进程内是共享的，主会话与每个
    // 子代理会话都会往这里记账。不收口的话，上一个会话的 status/error 会混进这一仗的
    // 报告里 —— 而混进来的数字看不出任何异常，这正是最危险的一种错。
    const inScope = (e) => {
      if (!tracePart.sessionIds.size) return true              // 没读到轨迹：不裁
      const matches = (v) => {
        const bare = String(v).replace(/^session-/, '')
        for (const x of tracePart.sessionIds) {
          if (x === v || String(x).replace(/^session-/, '') === bare) return true
        }
        return false
      }
      // 错误/状态按 agent 归属
      if (typeof e.agent === 'string' && e.agent) return matches(e.agent)
      // 分队事件没有 agent 字段（父身份不可得），身份在 child 上 ——
      // 这一条漏了会出事：别的会话派出的分队会混进来，报告的跨度从 1 小时变 29 小时。
      if (typeof e.child === 'string' && e.child) return matches(e.child)
      return true
    }
    const scoped = slim.filter(inScope)
    const keptXray = useTraceAxes ? scoped : slice
    const merged = keptXray
      .map((e) => ({ ...e, stream: e.stream || 'xray' }))
      .concat(tracePart.events)

    if (!merged.length) {
      const text = 'XRAY: 最近 ' + minutes + ' 分钟内没有观测到事件。\n' +
        '采集侧：' + (COLLECT === 'slim' ? 'slim 模式只采错误栈/状态/分队时序，没有事件是正常的' : '全量模式本应每一步都有一条 pre-step') + '。\n' +
        '分析侧：' + (tracePart.reason || '轨迹里也没有窗口内的事件') + '。\n' +
        '可能是：① 本插件刚挂载，尚未经过一个完整 turn；② 事件订阅未生效（检查 agent.cordis.yml 是否挂载 war-xray）；③ 会话 id 与轨迹对不上。' +
        (skipped ? '\n（注：观测文件里有 ' + skipped + ' 行无法解析，已跳过 —— 不影响本报告的结论）' : '')
      return { text, empty: true, level: 'ok', verdict: '还没有数据' }
    }

    const a = analyze(merged)
    const diag = diagnosticsOf(a, minutes)
    let text = renderReport(a, diag, minutes)
    text += renderTraceSection(tracePart, minutes)
    text += '\n\n（窗口 ' + minutes + ' 分钟 ｜ 采集 ' + COLLECT + '：' + source +
      '，其中 slim 口径 ' + slim.length + ' 条' + (useTraceAxes && scoped.length !== slim.length ? '（属本会话的 ' + scoped.length + ' 条）' : '') +
      ' ｜ 分析：轨迹 ' + tracePart.scanned +
      '/' + (tracePart.scanned + tracePart.skipped) + ' 份' +
      (useTraceAxes ? '' : ' —— 轨迹不可用，步/工具/token 退回观测口径（若有）') + '）'
    return { text, empty: false, level: diag.level, verdict: diag.verdict }
  }

  // ── 工具：xray_report ────────────────────────────────────────────────────

  try {
    ctx.tools.register(
      defineTool({
        name: 'xray_report',
        description:
          '战争模式 X 光机：把本次运行拆成耗时分解与堵点排名。回答「时间花在哪、卡在哪、有没有空转」。数据来自两处：采集侧只读本插件自己的观测文件（错误栈/分队时序/状态），分析侧直接读 dsh 会话轨迹（token/工具耗时/步与回合边界）。只读，不碰板面、不改任何状态。',
        parameters: {
          minutes: { type: 'number', description: '回看最近多少分钟的事件，默认 120。' },
          reset: { type: 'boolean', description: '报告后清空内存缓冲，默认 false。' },
          session: { type: 'string', description: '要分析的会话：id 片段或轨迹路径。默认本会话（也可以填别的会话 id，事后复盘用）。' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args = {}, exec) {
          try {
            const minutes = Number(args.minutes) > 0 ? Number(args.minutes) : 120
            // 调用方身份：ToolRunContext.agent 是"代表谁在跑这次调用"（agent loop 设的），
            // 而 Agent.id 与 Session.id 是同一个值 —— 所以这里拿到的就是**调用我的那个
            // 会话**，不必再猜。它比"最近活动的根会话"可靠：同一进程里可以同时有多个会话。
            const caller = brief(pick(exec, 'agent', 'id'), 60)
            const spec = args.session ? String(args.session) : (caller || undefined)
            const built = await buildReportText(minutes, spec)
            let text = built.text
            if (!built.empty && args.reset) { recent.length = 0; text += '\n（已清空缓冲）' }
            return text
          } catch (e) {
            return 'XRAY ERROR: ' + (e && e.message ? e.message : String(e))
          }
        },
      })
    )
  } catch (e) {
    try { ctx.logger?.warn?.('[war-xray] 注册 xray_report 失败: ' + (e && e.message)) } catch { }
  }

  // ── 工具：xray_hotspots ──────────────────────────────────────────────────
  // 跨会话统计。回答的是「这套体系有没有变好」，而不是「这一次怎么样」。

  try {
    ctx.tools.register(
      defineTool({
        name: 'xray_hotspots',
        description:
          '战争模式 X 光机·跨次热区：扫描 _xray 下全部观测文件，统计历次运行的工具调用排行、堵点（超过阈值的空档）排行、空转模式与错误。回答「反复卡在哪、有没有变好」。只读观测文件。',
        parameters: {
          days: { type: 'number', description: '回看最近多少天的观测文件，默认 30。' },
          top: { type: 'number', description: '每张榜取前多少名，默认 10。' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args = {}) {
          try {
            const days = Number(args.days) > 0 ? Number(args.days) : 30
            const top = Number(args.top) > 0 ? Number(args.top) : 10
            const dir = xrayDir()
            let files = []
            try { files = await fs.readdir(dir) } catch { return 'XRAY: 还没有任何观测文件（' + dir + '）。先跑一轮再来。' }
            // 新布局 YYYY-MM-DD.<instanceId>.jsonl 与老布局 YYYY-MM-DD.jsonl 一并纳入：
            // 换布局那一刻，旧进程还在写老文件，历史也全在老文件里。
            const dayFiles = await listDayFiles(dir, days)
            // slim 采集下观测文件可能稀疏（只有错误/分队事件），而轨迹里什么都有 ——
            // 所以这里不再"没有观测文件就直接返回"，让分析侧把报告撑起来。
            if (!dayFiles.length && !USE_TRACE) return 'XRAY: 最近 ' + days + ' 天内没有观测文件。'

            const toolCount = new Map()
            const gapBuckets = new Map()   // 堵点：间隔 > idleThreshold 时紧跟的事件种类
            const gapEvents = []
            const errs = new Map()
            const loopSigs = new Map()            // 口径 A·连续：tool → 组数
            const loopSigsCumulative = new Map()  // 口径 B·累计：tool → 签名数（仅并列展示）
            const subOutcome = new Map()
            let totalEvents = 0, totalSessions = 0, totalTools = 0, totalGaps = 0
            let legacyFiles = 0, instanceFiles = 0, skippedLines = 0

            const IDLE_MS = Number(config?.idleThresholdMs ?? 60_000)

            // 逐**流**折叠：一个观测分片文件是一个流，一份会话轨迹也是一个流。
            // 堵点/空转只在同一条流里才有意义（相邻性是流内性质）—— 把多个实例
            // 或主/子会话混在一起算相邻，会凭空造出巨量假堵点（老坑，不重踩）。
            const foldStream = (evs) => {
              if (!evs.length) return
              totalSessions++
              let lastT = 0
              for (const e of evs) {
                if (lastT && e.t - lastT >= IDLE_MS) {
                  totalGaps++
                  const k = e.kind + (e.tool ? '/' + e.tool : '')
                  gapBuckets.set(k, (gapBuckets.get(k) || 0) + 1)
                  gapEvents.push({ gap: e.t - lastT, kind: k })
                }
                lastT = e.t
                if (e.kind === 'tool') {
                  totalTools++
                  toolCount.set(e.tool, (toolCount.get(e.tool) || 0) + 1)
                }
                if (e.kind === 'error' || e.kind === 'req-error') {
                  const m = brief(e.message, 80) || 'unknown'
                  errs.set(m, (errs.get(m) || 0) + 1)
                }
                if (e.kind === 'sub-end' && e.outcome) {
                  subOutcome.set(e.outcome, (subOutcome.get(e.outcome) || 0) + 1)
                }
              }
              // 空转按**流**算（相邻性只在同一条流里成立），且与 xray_report 走
              // 同一个实现 countRepeatLoops() —— 这里的标题一直写「连续 3 次以上」，
              // 改前却和 report 一样是累计计数：同一个缺陷，不一起修就还是两套口径。
              const rep = countRepeatLoops(evs, DIAG_DEFAULTS.loopTimes)
              for (const [tool, n] of rep.consecutiveByTool) {
                loopSigs.set(tool, (loopSigs.get(tool) || 0) + n)
              }
              for (const [tool, n] of rep.cumulativeByTool) {
                loopSigsCumulative.set(tool, (loopSigsCumulative.get(tool) || 0) + n)
              }
            }

            for (const fname of dayFiles) {
              // 逐文件读：每个文件是一个写入者的连续流。
              const one = await readDayFiles(dir, [fname])
              if (!one.stats.files) continue
              legacyFiles += one.stats.legacyFiles
              instanceFiles += one.stats.instanceFiles
              skippedLines += one.stats.skipped
              totalEvents += one.stats.parsed
              foldStream(one.events)
            }

            // ── 分析半区：把会话轨迹也当流折进来（2026-11-07）───────────────
            // slim 采集不再记工具调用，于是"工具排行 / 空转 / 堵点"这三张榜必须
            // 从轨迹取；否则热区报告会在 slim 下悄悄变成空表，而空表看起来像
            // "没有热区"（这正是台账 C-2 那条：没有数据的轴要显式说明）。
            let traceScanned = 0
            let traceSkipped = 0
            if (USE_TRACE) {
              const cutoff = nowMs() - days * 86400_000
              const cand = listTraces().filter((t) => t.mtimeMs >= cutoff)
              traceSkipped = Math.max(0, cand.length - TRACE_MAX)
              for (const item of cand.slice(0, TRACE_MAX)) {
                const r = readTraceAsEvents(item.path)
                if (!r) { traceSkipped++; continue }
                traceScanned++
                totalEvents += r.events.length
                foldStream(r.events)
              }
            }

            const L = []
            L.push('═══ XRAY HOTSPOTS（最近 ' + days + ' 天）═══')
            L.push('文件 ' + dayFiles.length + ' 个（每实例分片 ' + instanceFiles + ' / 老布局 ' + legacyFiles +
              '）｜ 事件 ' + totalEvents + ' 条 ｜ 工具调用 ' + totalTools + ' 次 ｜ 堵点 ' + totalGaps + ' 次')
            L.push('分析侧：会话轨迹 ' + traceScanned + ' 份' +
              (traceSkipped ? '（另有 ' + traceSkipped + ' 份超出 traceMaxFiles=' + TRACE_MAX + ' 未读 —— 不是"没有热区"，是没读）' : '') +
              (USE_TRACE ? '' : '（配置里已关闭 trace，工具排行/空转在 slim 采集下会是空的）'))
            if (skippedLines) {
              L.push('跳过无法解析的行 ' + skippedLines + ' 条（历史碎片 / 被外部工具按宽度切出来的半行）' +
                ' —— 已计数，不影响下面各项统计')
            }
            if (totalTools) L.push('平均每次工具调用前后出现堵点的比例 ' + ((totalGaps / totalTools) * 100).toFixed(1) + '%')

            L.push('')
            L.push('── 工具调用总排行 ──')
            if (!toolCount.size) L.push('  （无）')
            else for (const [k, v] of [...toolCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
              L.push('  ' + String(v).padStart(5) + '×  ' + k)
            }

            L.push('')
            L.push('── 堵点排行榜（空档 ≥ ' + dur(IDLE_MS) + ' 之后紧跟什么）──')
            if (!gapBuckets.size) L.push('  （无）')
            else for (const [k, v] of [...gapBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
              L.push('  ' + String(v).padStart(4) + ' 次  ' + k)
            }
            if (gapEvents.length) {
              const worst = gapEvents.sort((a, b) => b.gap - a.gap).slice(0, 5)
              L.push('')
              L.push('  最长的 5 次空档：')
              for (const w of worst) L.push('    ' + dur(w.gap).padEnd(9) + ' → ' + w.kind)
            }

            L.push('')
            L.push('── 反复空转（同工具同参数连续 ' + DIAG_DEFAULTS.loopTimes + ' 次以上的次数）──')
            L.push('  口径 A·连续（极大连续运行 ≥' + DIAG_DEFAULTS.loopTimes + ' 次记 1 组，与 xray_report 同一实现）')
            if (!loopSigs.size) L.push('  （无）')
            else for (const [k, v] of [...loopSigs.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
              L.push('  ' + String(v).padStart(4) + ' 次  ' + k)
            }
            // 口径 B 并列展示：两个数各回答一个问题，混着比会得出"没有浪费"的错误结论。
            const cumTotal = [...loopSigsCumulative.values()].reduce((s, x) => s + x, 0)
            L.push('  口径 B·累计（仅供参考，不参与判定）：同一签名全窗口 ≥' + DIAG_DEFAULTS.loopTimes +
              ' 次的签名合计 ' + cumTotal + ' 个' +
              (loopSigsCumulative.size
                ? '（' + [...loopSigsCumulative.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
                  .map(([k, v]) => k + ' ' + v).join('、') + '…）'
                : ''))
            L.push('  说明：连续口径量的是"同一步里紧接着又调一遍"（真空转）；累计口径量的是"零散/跨分队各调一遍同一签名"，' +
              '那是跨分队重复取证，是另一个问题。两个数不可互相比较，也不可互相替代。')

            L.push('')
            L.push('── 错误 ──')
            if (!errs.size) L.push('  （无）')
            else for (const [k, v] of [...errs.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
              L.push('  ' + String(v).padStart(4) + ' 次  ' + k)
            }

            L.push('')
            L.push('── 分队结局分布 ──')
            if (!subOutcome.size) L.push('  （无记录）')
            else for (const [k, v] of [...subOutcome.entries()].sort((a, b) => b[1] - a[1])) {
              L.push('  ' + String(v).padStart(4) + ' 次  ' + k)
            }

            return L.join('\n')
          } catch (e) {
            return 'XRAY ERROR: ' + (e && e.message ? e.message : String(e))
          }
        },
      })
    )
  } catch (e) {
    try { ctx.logger?.warn?.('[war-xray] 注册 xray_hotspots 失败: ' + (e && e.message)) } catch { }
  }

  // ── 工具：xray_compare（跨分队 / 跨天横向对比）────────────────────────────
  //
  // WHY A NEW TOOL INSTEAD OF A PARAMETER ON xray_report
  // ---------------------------------------------------
  // 三个理由都是结构性的，不是口味问题：
  //   ① **数据源不同**：xray_report 是「最近 N 分钟」，优先读内存缓冲（快路径）；
  //      对比必须跨天扫盘（listDayFiles(days) + 逐文件读）。把两种数据源塞进
  //      同一个工具，等于让一个工具拥有两个"当前窗口"定义 —— 读报告的人分不清
  //      屏幕上的数字来自内存还是来自盘上。
  //   ② **卡片契约**：浏览器卡片是按 xray_report 的文本格式逐行解析的
  //      （client.js 的 parseHead / parseVerdict 都锚定固定前缀与首行）。给
  //      xray_report 加模式 = 骑在这层契约上；新工具没有卡片，走宿主默认的
  //      文本渲染，零风险，也不需要第二份 client bundle。
  //   ③ **语义不同**：report 答「这一次怎么样」，hotspots 答「历次反复卡在哪」，
  //      compare 答「哪个分队更费、哪一天更差」—— 三个问题，三次调用。
  //
  // 口径纪律：跨文件**不做相邻性推断**。每个分片文件单独归因，再把求和量相加；
  // 「最大空档」只在流内比较后取最大值。混流算相邻会凭空造出巨量假空档、
  // 假的"在等模型"，这正是 xray_hotspots 早就避开的坑，这里沿用同一条纪律。

  try {
    ctx.tools.register(
      defineTool({
        name: 'xray_compare',
        description:
          '战争模式 X光机·横向对比：按分队(agent) 对比事件/请求/工具/平均等模型/平均工具执行时长，或按天对比事件/错误/平均每步/最大空档。表格化输出，用于回答「哪个分队更费、哪一天更差」。只读 _xray 观测文件，不碰板面、不改任何状态。',
        parameters: {
          by: { type: 'string', description: "对比维度：agent（按分队）| day（按天）| all（两者，默认）" },
          days: { type: 'number', description: '回看最近多少天的观测文件，默认 30。' },
          minutes: { type: 'number', description: '再叠加一个最近 N 分钟的窗口筛选（0 = 不筛，默认 0）。' },
          top: { type: 'number', description: '每个 agent/天 最多列多少行，默认 20。' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args = {}) {
          try {
            const by = String(args.by || 'all').toLowerCase()
            const days = Number(args.days) > 0 ? Number(args.days) : 30
            const top = Number(args.top) > 0 ? Number(args.top) : 20
            const minutes = Number(args.minutes) > 0 ? Number(args.minutes) : 0
            const dir = xrayDir()
            const names = await listDayFiles(dir, days)
            // 同上：观测文件为空不代表没数据，轨迹还在。
            if (!names.length && !USE_TRACE) return 'XRAY: 最近 ' + days + ' 天内没有观测文件（' + dir + '）。'

            const since = minutes > 0 ? nowMs() - minutes * 60_000 : 0
            const streams = []
            let skipped = 0
            for (const fname of names) {
              const one = await readDayFiles(dir, [fname])
              if (!one.stats.files) continue
              skipped += one.stats.skipped
              const evs = since ? one.events.filter((e) => e.t >= since) : one.events
              if (!evs.length) continue
              streams.push({ file: fname, day: dayOfFile(fname), events: evs })
            }

            // 分析半区：每份会话轨迹也是一条流（理由见 xray_hotspots 的同名注释）。
            // 按 agent 对比时它就是"按会话对比"—— 这点在报告里写清楚，别让读的人
            // 以为一个 session 就是一个分队。
            let traceStreams = 0
            if (USE_TRACE) {
              const cutoff = nowMs() - days * 86400_000
              for (const item of listTraces().filter((t) => t.mtimeMs >= cutoff).slice(0, TRACE_MAX)) {
                const r = readTraceAsEvents(item.path)
                if (!r) continue
                const evs = since ? r.events.filter((e) => e.t >= since) : r.events
                if (!evs.length) continue
                traceStreams++
                streams.push({
                  file: 'trace:' + traceLabel(r.trace),
                  day: dayKey(item.mtimeMs),
                  events: evs,
                })
              }
            }

            const L = []
            L.push('═══ XRAY COMPARE ═══')
            L.push('维度 ' + by + ' ｜ 最近 ' + days + ' 天 ｜ 观测分片 ' + (streams.length - traceStreams) +
              ' 个 + 会话轨迹 ' + traceStreams + ' 份 ｜ 事件 ' + streams.reduce((s, x) => s + x.events.length, 0) + ' 条' +
              (minutes ? ' ｜ 叠加窗口 ' + minutes + ' 分钟' : ''))
            if (traceStreams) {
              L.push('注：轨迹流按"一个会话一个流"计入 —— 按 agent 对比时，一行代表一个会话（含子代理会话），' +
                '不是一个真实的分队；要看真实分队请用 xray_report 的「各 agent 活动量」。')
            }
            if (skipped) L.push('跳过无法解析的行 ' + skipped + ' 条（已计数，不影响下面的数字）')
            if (!streams.length) {
              L.push('')
              L.push('这个范围内没有可读事件 —— 不是"各分队都很省"，是没有数据。')
              return L.join('\n')
            }

            const wantAgent = by === 'agent' || by === 'all'
            const wantDay = by === 'day' || by === 'all'

            if (wantAgent) {
              const { agents, unattributed } = compareAgents(streams)
              L.push('')
              L.push('── 按分队对比（' + agents.length + ' 个 agent 有身份，另有未归因事件 ' + unattributed.events + ' 条）──')
              if (!agents.length) {
                L.push('  一条带 agent 身份的事件都没有 —— 全部未归因。')
                L.push('  ⇒ 先重启 dsh web 让新落盘字段生效；历史分片的旧事件不会补写。')
              } else {
                L.push('  口径：等模型/工具执行时长沿用「相邻事件间隔归属前一条事件」，与 xray_report 同源；' +
                  '每个分片单独归因后再相加（跨文件不相邻，不会造假空档）。')
                L.push('  并发时这两个平均值是**上限**：别的 agent 的事件会把间隔切短。')
                L.push(...renderTable(
                  [
                    'agent', '角色',
                    { label: '事件', align: 'right' },
                    { label: '请求', align: 'right' },
                    { label: '工具', align: 'right' },
                    { label: 'sub-start', align: 'right' },
                    { label: 'sub-end', align: 'right' },
                    { label: '平均等模型', align: 'right' },
                    { label: '平均工具执行', align: 'right' },
                    { label: '首见时刻', align: 'right' },
                  ],
                  agents.slice(0, top).map((r) => [
                    brief(r.agent, 40), r.role, String(r.events), String(r.requests), String(r.tools),
                    String(r.subStarts), String(r.subEnds),
                    Number.isFinite(r.modelAvgMs) ? durMs(r.modelAvgMs) : '-',
                    Number.isFinite(r.toolAvgMs) ? durMs(r.toolAvgMs) : '-',
                    r.firstT ? new Date(r.firstT).toTimeString().slice(0, 8) : '-',
                  ]),
                ))
                if (agents.length > top) L.push('  …（另有 ' + (agents.length - top) + ' 个 agent 未列出）')
                if (unattributed.events) {
                  L.push('  未归因合计：事件 ' + unattributed.events + ' 条 ｜ 请求 ' + unattributed.requests +
                    ' 条 ｜ 工具 ' + unattributed.tools + ' 条')
                }
              }
            }

            if (wantDay) {
              const dayRows = compareDays(streams)
              L.push('')
              L.push('── 按天对比（' + dayRows.length + ' 天）──')
              L.push('  口径：最大空档 = **单个分片内**最大间隔，再按天取最大；' +
                '平均每步 = 当天总跨度 / 总步数（旧口径，含工具执行时间，仅供同类比较）。')
              L.push(...renderTable(
                [
                  '日期',
                  { label: '分片', align: 'right' },
                  { label: '事件', align: 'right' },
                  { label: '请求', align: 'right' },
                  { label: '工具', align: 'right' },
                  { label: '错误', align: 'right' },
                  { label: '步', align: 'right' },
                  { label: 'agent', align: 'right' },
                  { label: 'sub-start', align: 'right' },
                  { label: 'sub-end', align: 'right' },
                  { label: '平均每步', align: 'right' },
                  { label: '最大空档', align: 'right' },
                ],
                dayRows.map((d) => [
                  d.day, String(d.files), String(d.events), String(d.requests), String(d.tools),
                  String(d.errors), String(d.steps), String(d.agentCount),
                  String(d.subStarts), String(d.subEnds),
                  Number.isFinite(d.avgStepMs) ? durMs(d.avgStepMs) : '-',
                  durMs(d.maxGapMs),
                ]),
              ))
            }

            return L.join('\n')
          } catch (e) {
            return 'XRAY ERROR: ' + (e && e.message ? e.message : String(e))
          }
        },
      })
    )
  } catch (e) {
    try { ctx.logger?.warn?.('[war-xray] 注册 xray_compare 失败: ' + (e && e.message)) } catch { }
  }

  // ── 工具：xray_structure ─────────────────────────────────────────────────
  // 自动生成 preset 结构图 —— 相当于 IDA 那半边：不用人画，改配置后自动更新。

  try {
    ctx.tools.register(
      defineTool({
        name: 'xray_structure',
        description:
          '战争模式 X 光机·结构图：解析 agent.cordis.yml，输出当前 preset 挂了哪些组件、分别属于哪一层（身份/事实/决策/桥接/纪律/派兵/经验），并标出哪些环节有代码保障、哪些仅靠提示。用于「改配置后确认结构没画错」。只读。',
        parameters: {
          format: { type: 'string', description: '输出格式：tree（默认，分层树）或 mermaid（可贴进 Markdown 渲染）。' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args = {}) {
          try {
            const ymlPath = path.join(process.env.DSH_HOME || '<HOME>/.dsh',
              '.agent-presets', 'war', 'agent.cordis.yml')
            let src = ''
            try { src = await fs.readFile(ymlPath, 'utf8') } catch {
              return 'XRAY: 读不到 ' + ymlPath
            }
            // 极简解析：只抓 `- id: xxx` 与紧随的 `name: yyy`，不做完整 YAML 解析
            const items = []
            const lines = src.split('\n')
            for (let i = 0; i < lines.length; i++) {
              const m = /^\s*-\s*id:\s*(\S+)/.exec(lines[i])
              if (!m) continue
              const id = m[1]
              let name = ''
              for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                const nm = /^\s+name:\s*(\S+)/.exec(lines[j])
                if (nm) { name = nm[1]; break }
              }
              items.push({ id, name })
            }

            // 分层归类
            const LAYERS = [
              { key: '身份层', test: (i, n) => /persona|instructions/i.test(i), note: '提示驱动' },
              { key: '事实层', test: (i, n) => /^war-board(?!-ui)/.test(i), note: '有代码' },
              { key: '决策层', test: (i, n) => /opsmap/.test(i), note: '有代码' },
              { key: '桥接层', test: (i, n) => /bridge/.test(i), note: '有代码' },
              { key: '观测层', test: (i, n) => /xray/.test(i), note: '有代码' },
              { key: '纪律层', test: (i, n) => /rule-gate|egress|evidence|vulndb/.test(i), note: '有代码' },
              { key: '展示层', test: (i, n) => /board-ui/.test(i), note: '有代码' },
              { key: '派兵层', test: (i, n) => /subagent|workflow|ralph/.test(i), note: '有代码' },
              { key: '基础层', test: (i, n) => /^(skill-filesystem|planning|plan-mode|compaction|compaction-basic|command-compact|delegation)$/.test(i), note: 'DSH 自带' },
              { key: '工具层', test: (i, n) => /^tool-/.test(i), note: '有代码' },
            ]
            const grouped = new Map()
            for (const it of items) {
              let placed = false
              for (const L of LAYERS) {
                if (L.test(it.id, it.name)) {
                  if (!grouped.has(L.key)) grouped.set(L.key, { note: L.note, items: [] })
                  grouped.get(L.key).items.push(it)
                  placed = true
                  break
                }
              }
              if (!placed) {
                if (!grouped.has('其他')) grouped.set('其他', { note: '', items: [] })
                grouped.get('其他').items.push(it)
              }
            }

            const fmt = String(args.format || 'tree').toLowerCase()
            if (fmt === 'mermaid') {
              const out = ['graph TD']
              let n = 0
              for (const [k, v] of grouped) {
                out.push('  L' + (++n) + '["' + k + ' (' + v.items.length + ')"]')
                for (const it of v.items) {
                  const safe = (it.id || '').replace(/[^\w-]/g, '_')
                  out.push('  L' + n + ' --> N' + (++n <= 999 ? n : n) + '["' + it.id + '"]')
                }
              }
              return out.join('\n')
            }

            const L = []
            L.push('═══ WAR PRESET 结构图（' + items.length + ' 个组件）═══')
            L.push('来源: ' + ymlPath)
            // 按 LAYERS 的逻辑顺序输出，末尾再补未归类项
            const orderedKeys = LAYERS.map((x) => x.key)
            for (const k of orderedKeys) {
              const v = grouped.get(k)
              if (!v) continue
              L.push('')
              L.push('┌─ ' + k + '  [' + v.items.length + ']' + (v.note ? '  · ' + v.note : ''))
              for (const it of v.items) {
                L.push('│  ' + it.id + (it.name ? '  ←  ' + it.name : ''))
              }
              L.push('└─')
            }
            for (const [k, v] of grouped) {
              if (orderedKeys.includes(k)) continue
              L.push('')
              L.push('┌─ ' + k + '  [' + v.items.length + ']  · 未归类')
              for (const it of v.items) L.push('│  ' + it.id)
              L.push('└─')
            }
            L.push('')
            L.push('── 缺口自查 ──')
            const hasBoard = items.some((i) => /^war-board$/.test(i.id))
            const hasMap = items.some((i) => /opsmap/.test(i.id))
            const hasBridge = items.some((i) => /bridge/.test(i.id))
            const hasXray = items.some((i) => /xray/.test(i.id))
            L.push('  事实层(板面): ' + (hasBoard ? '✓' : '✗ 缺失'))
            L.push('  决策层(地图): ' + (hasMap ? '✓' : '✗ 缺失'))
            L.push('  桥接层(闭环): ' + (hasBridge ? '✓' : '✗ 缺失'))
            L.push('  观测层(X光机): ' + (hasXray ? '✓' : '✗ 未挂载'))
            return L.join('\n')
          } catch (e) {
            return 'XRAY ERROR: ' + (e && e.message ? e.message : String(e))
          }
        },
      })
    )
  } catch (e) {
    try { ctx.logger?.warn?.('[war-xray] 注册 xray_structure 失败: ' + (e && e.message)) } catch { }
  }

  // ── 包私有 Client→Host 通道：浏览器的按钮点一下就出报告 ────────────────────
  //
  // WHY THIS EXISTS
  // ---------------
  // 用户原话：「卡片出来了，这个可不可以给我做成一个按钮啊」。他不想每次都让
  // Agent 先调一次 `xray_report` 才看到卡片 —— 那要等一个完整的模型回合。
  //
  // WHY NOT "let the button send a chat message"
  // -------------------------------------------
  // 那是**零 token 要求的反面**：往对话里发一条消息，要等模型读到、决定调工具、
  // 工具再跑一遍，用户才看到卡片，而这一切还写进了历史。按钮必须走一条只在
  // client 与 host 之间往返、模型完全看不见的通道。
  //
  // HOW IT IS WIRED（两侧契约，均来自已安装的 @deepseek-ai/dsh-client-connection）
  // ------------------------------------------------------------------------
  //   Host   `ctx.connection.rpc.handle(channel, handler, {authority})`
  //          → lib/index.js 在 webServer 上挂一个 prefix 路由（path = channel）
  //   Client `ctx.connection.rpc.call(channel, endpoint, payload)`
  //          → POST `${origin}${channel}/${endpoint}`，信封
  //            `{type:'client-request', rpcId, method:endpoint, payload}`
  //          → 回 `{type:'server-response', rpcId, result}`，result 即 RpcResult
  //   契约口径由 rpcFetchHandler()（Host）与 createWebConnectionRpc()（Client）
  //   两端共同实现，method 必须与 URL 末段一致，否则 bad-request。
  //
  // 通道名 /war-xray 与其它任何插件都不冲突（CHANNEL_PATTERN 只允许单段）。
  // authority: 'loopback' —— 报告是只读的，但也只该被本机的页面拿到。
  //
  // 失败一律不抛：connection 服务不存在（非 web 部署 / headless）时，本插件其余
  // 功能必须完好，只是按钮会自己显示"通道不可用"。这条和"观测者不能成为故障源"
  // 是同一条纪律。
  const RPC_CHANNEL = '/war-xray'
  let rpcMounted = false

  /** 在给定 ctx 上挂 RPC 通道（幂等）。只做注册，不做判断。 */
  function mountRpc(host) {
    if (rpcMounted) return
    try {
      const connection = host && host.connection
      if (!connection || typeof connection !== 'object') return
      const rpc = connection.rpc
      if (!rpc || typeof rpc.handle !== 'function') return
      rpc.handle(
        RPC_CHANNEL,
        async (endpoint, payload) => {
          try {
            if (endpoint === 'ping') return { ok: true, value: { ok: true, name } }
            if (endpoint === 'report') {
              const minutes = Number(payload && payload.minutes) > 0 ? Number(payload.minutes) : 120
              const built = await buildReportText(minutes, payload && payload.session ? String(payload.session) : undefined)
              return {
                ok: true,
                value: {
                  text: built.text,
                  minutes,
                  empty: built.empty,
                  level: built.level,
                  verdict: built.verdict,
                  generatedAt: nowMs(),
                },
              }
            }
            return {
              ok: false,
              error: {
                code: 'bad-request',
                message: 'war-xray: unknown endpoint ' + JSON.stringify(String(endpoint)),
                details: { issues: [] },
              },
            }
          } catch (e) {
            // 业务失败也走 RpcResult 的 error 分支（不回 500），否则客户端只能看到
            // 一句 "transport failure"，看不出真正原因。
            return {
              ok: false,
              error: {
                code: 'bad-request',
                message: 'war-xray: ' + (e && e.message ? e.message : String(e)),
                details: { issues: [] },
              },
            }
          }
        },
        { authority: 'loopback' },
      )
      rpcMounted = true
    } catch { /* 通道不可用：按钮会显示原因，其它功能不受影响 */ }
  }

  // connection 可能比本插件晚挂载，所以走 cordis 的延迟注入；已经在了就直接挂。
  // 两条路都失败也无所谓 —— 报告照旧能由模型调工具拿到。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['connection'], (sub) => { mountRpc(sub) })
    }
  } catch { /* 注入不可用（例如 mock ctx）：跳过 */ }
  try { mountRpc(ctx) } catch { /* 同上 */ }
}

export default { name, inject, apply }
