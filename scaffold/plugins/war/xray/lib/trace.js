/**
 * trace.js — 把 dsh 会话轨迹（session.jsonl.zstd）翻译成 X 光机认识的东西
 *
 * WHY THIS FILE EXISTS（2026-11-07 · P1 的方向修正）
 * ------------------------------------------------
 * 2026-11-05 的取证结论：dsh 自己就把每次会话完整写在
 *   <DSH_HOME>/sessions/<workspace 打平>/session-<uuid>/session.jsonl.zstd
 * 里面有 token 用量、工具调用与结果、步/回合边界、模型重试、上下文压缩、审批与沙箱变更。
 * war-xray 平行采集的 5,240 条事件里约 93% 与它重复，而最值钱的 token 与重试恰好一条没采
 * （台账 F-041）。
 *
 * 所以插件改成两个半区：
 *   ① 采集半区**只留轨迹里没有的三类**：agent/error 的 stack、agent/status、
 *      subagent start/end 的时序（轨迹只有 subagent/descriptor，带存在性无时序）；
 *   ② 分析半区**从轨迹读**：token / 工具成败与耗时 / 步与回合边界 / 重试 / 压缩。
 * 本文件就是 ②。它的职责只有一个：**把轨迹翻译成 xray 事件**，这样
 * analyze() / renderReport / xray_hotspots / xray_compare 一行都不用改。
 *
 * WHY TRANSLATE INSTEAD OF REWRITE THE ANALYZERS
 * ----------------------------------------------
 * analyze() 的口径是「相邻事件的间隔归属于前一条事件」（request ⇒ 在等模型，
 * tool ⇒ 在等工具）。轨迹里的事件名与它不同（step/start、assistant/message、
 * tool/call），但**时间形态完全对得上**：
 *     轨迹 step/start        → xray request（请求在飞，等响应）
 *     轨迹 tool/call         → xray tool   （工具已开始，等结果）
 *     轨迹 turn/start|end    → 边界事件   （把回合之间的"人不在"隔离成 otherMs）
 * 于是翻译一层就够，不必把四套分析器各改一遍 —— 改四处必然漂移，改一处不会。
 *
 * 三条纪律（都是踩过的坑，别在实现里"优化"掉）
 * -------------------------------------------
 * ① **多帧 zstd**：轨迹是每次 append 写一帧，一个文件里几千个独立帧。
 *    zlib.zstdDecompressSync(buf) 只解第一帧就返回 —— 直接调用会得到"1 条记录"，
 *    而文件里可能有上万条（台账 F-042）。必须按魔数 28 B5 2F FD 切分逐帧解，
 *    解压失败把切片并入下一帧重试（魔数可能偶然出现在压缩数据内部）。
 * ② **只认权威事件**：{seq,time} 是权威日志，{seq0,time0} 是前端**重放投影**
 *    （时间戳是重放时刻）。混用会把"回填的工具结果"算成"工具跑了 555 秒"（F-043）。
 * ③ **批量回填不算耗时**：会话恢复/页面重载时一批 result 同一秒落地，那不是执行
 *    耗时；判据是"同一秒落地 ≥3 条 result"，且反向对照入测试（F-044）。
 *
 * 本文件**不写任何东西**：只读轨迹，把数字拿出来。正文（chunk / system prompt）
 * 一律不进内存以外的任何地方 —— 观测层不许复制正文（读书笔记坑 3）。
 *
 * 与 <WORK>\_xray_retro.mjs 的关系
 * --------------------------------------------
 * 那个脚本是同一套口径的**独立实现**（CLI 形态，带人类可读渲染）。两边刻意不共享
 * 代码：独立实现才能互相校验。test/trace-adapter.test.mjs 就是拿同一份合成轨迹
 * 跑两边、逐项比对数字 —— 谁改了其中一边而另一边没跟上，测试立刻红。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/* ───────────────────────── 多帧 zstd 解码 ───────────────────────── */

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * 逐帧解压多帧 zstd。返回 { text, frames, falseMagic }。
 *
 * falseMagic 是"看起来像帧头但解不开"的次数：它只影响计数，不影响成败 ——
 * 解压失败时把切片并入下一帧重试，所以真魔数一个都不会丢。
 */
export function decodeFrames(buf) {
  const offs = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i)
  }
  const parts = []
  let pending = null
  let frames = 0
  let falseMagic = 0
  for (let i = 0; i < offs.length; i++) {
    const end = i + 1 < offs.length ? offs[i + 1] : buf.length
    const slice = buf.subarray(offs[i], end)
    const chunk = pending ? Buffer.concat([pending, slice]) : slice
    try {
      parts.push(zlib.zstdDecompressSync(chunk))
      frames++
      pending = null
    } catch {
      if (pending) falseMagic++
      pending = chunk
    }
  }
  if (pending) {
    try { parts.push(zlib.zstdDecompressSync(pending)); frames++ } catch { falseMagic++ }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames, falseMagic }
}

/* ───────────────────────── 找轨迹 ───────────────────────── */

const DSH_HOME = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** <DSH_HOME>/sessions */
export function sessionsRoot() {
  return path.join(DSH_HOME(), 'sessions')
}

/** 递归找全部 session.jsonl.zstd，带 mtime/size（默认按 mtime 倒序）。 */
export function listTraces(root = sessionsRoot()) {
  const out = []
  const walk = (dir) => {
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'session.jsonl.zstd') {
        try {
          const st = fs.statSync(p)
          out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size })
        } catch { /* 读不到就跳过：观测者不因为自己的目录问题炸掉调用方 */ }
      }
    }
  }
  walk(root)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/**
 * 解析一份轨迹。接受三种写法（与 _xray_retro.mjs --session 一致）：
 *   · 完整路径（存在即用）
 *   · session id / id 片段 / 目录名片段（含即命中，取最新的一份）
 *   · 'latest' / 空（取最近改动的）
 * @returns {string|null} 轨迹绝对路径
 */
export function findTrace(spec, root = sessionsRoot()) {
  if (!spec) return null
  const s = String(spec)
  try { if (fs.existsSync(s) && fs.statSync(s).isFile()) return s } catch { /* 不是路径 */ }
  const all = listTraces(root)
  if (!all.length) return null
  if (s === 'latest' || s === '1') return all[0].path
  const hit = all.find((t) => t.path.includes(s))
  return hit ? hit.path : null
}

/* ───────────────────────── 读 + 缓存 ───────────────────────── */

// 模块级缓存：xray_report 会在一个回合里被调用多次，而一份 3.4 MB 的轨迹要解
// ~200ms。键 = 路径 + mtime + size —— 会话在跑的时候文件在长，mtime/size 一变就重读，
// 所以缓存不会把"刚发生的事"藏起来。上限 8 份，超了丢最旧的（Map 插入序即 LRU 近似）。
const CACHE = new Map()
const CACHE_CAP = 8

/** 丢掉缓存（测试用；正常运行不需要）。 */
export function clearTraceCache() { CACHE.clear() }

/**
 * 读一份轨迹并把它算成一个 Trace 对象（纯数据，不含任何活对象）。
 * @param {string} tracePath
 * @returns {object|null} 读不到返回 null（绝不抛错）
 */
export function loadTrace(tracePath) {
  let buf
  let st
  try {
    st = fs.statSync(tracePath)
    buf = fs.readFileSync(tracePath)
  } catch { return null }
  const key = tracePath + '|' + Math.round(st.mtimeMs) + '|' + st.size
  const hit = CACHE.get(key)
  if (hit) return hit

  let decoded
  try { decoded = decodeFrames(buf) } catch { return null }
  const raw = []
  let bad = 0
  for (const line of decoded.text.split('\n')) {
    if (!line) continue
    try { raw.push(JSON.parse(line)) } catch { bad++ }
  }

  const t = parseTrace(raw, {
    tracePath,
    frames: decoded.frames,
    falseMagic: decoded.falseMagic,
    badLines: bad,
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs,
  })
  if (t) {
    CACHE.set(key, t)
    while (CACHE.size > CACHE_CAP) CACHE.delete(CACHE.keys().next().value)
  }
  return t
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
const clip = (s, n) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim()
  return v.length > n ? v.slice(0, n) + '…' : v
}

/**
 * 一份轨迹 → 事实对象。**只取数字与短文本**（工具名、错误码），正文一律不取。
 *
 * 逐项与 _xray_retro.mjs 的 analyze() 对齐；测试逐字段比对（见 trace-adapter.test.mjs）。
 */
export function parseTrace(raw, meta = {}) {
  const all = Array.isArray(raw) ? raw : []
  const CHUNK = new Set(['assistant/chunk', 'reasoning-chunks', 'text-chunks', 'tool-call-chunks'])
  // 纪律 ②：只认权威事件。session 头是唯一没有 seq 的例外。
  const authoritative = all.filter((e) => e.seq != null || e.type === 'session')
  const ev = authoritative.filter((e) => !CHUNK.has(e.type))
  const ofType = (ty) => ev.filter((e) => e.type === ty)
  const tm = (e) => num(e.time ?? e.time0)

  const header = all.find((e) => e.type === 'session') || {}
  const title = (all.find((e) => e.type === 'session/title') || {}).data?.title || ''

  const times = authoritative.map(tm).filter((x) => x > 0)
  const tStart = times.length ? Math.min(...times) : 0
  const tEnd = times.length ? Math.max(...times) : 0
  const wallMs = Math.max(0, tEnd - tStart)

  /* ── 回合 ── */
  const turns = []
  const turnEnds = ofType('turn/end')
  const turnStarts = ofType('turn/start')
  for (const te of turnEnds) {
    const turn = te.data?.turn
    const ts = turnStarts.find((e) => e.data?.turn === turn)
    const reason = te.data?.reason
    turns.push({
      turn,
      startMs: ts ? tm(ts) : null,
      endMs: tm(te),
      durMs: ts ? tm(te) - tm(ts) : null,
      reasonKind: reason && typeof reason === 'object' ? reason.kind : reason,
      reasonError: reason && typeof reason === 'object' && reason.error
        ? { message: clip(reason.error.message, 160), code: reason.error.code, status: reason.error.status }
        : null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
      steps: 0,
      toolCalls: 0,
    })
  }
  const turnOf = (n) => turns.find((x) => x.turn === n)

  /* ── 步：step/start ~ step/end，等模型 = start→assistant/message ── */
  const steps = []
  const msgByStep = new Map()
  for (const m of ofType('assistant/message')) msgByStep.set(m.data?.turn + '|' + m.data?.step, m)
  const endByStep = new Map()
  for (const s of ofType('step/end')) endByStep.set(s.data?.turn + '|' + s.data?.step, s)
  for (const ss of ofType('step/start')) {
    const turn = ss.data?.turn
    const step = ss.data?.step
    const msg = msgByStep.get(turn + '|' + step)
    const se = endByStep.get(turn + '|' + step)
    steps.push({
      turn, step,
      startMs: tm(ss),
      endMs: se ? tm(se) : null,
      msgMs: msg ? tm(msg) : null,
      modelMs: msg ? tm(msg) - tm(ss) : null,
      postMsgMs: se && msg ? tm(se) - tm(msg) : null,
      usage: msg?.data?.usage || null,
      model: msg?.data?.message?.source?.model || null,
      provider: msg?.data?.message?.source?.provider || null,
    })
    const t = turnOf(turn)
    if (t) t.steps++
  }

  /* ── 工具：call ↔ result 按 callId 配对 ── */
  const earliestByCall = (list, idOf) => {
    const m = new Map()
    for (const e of list) {
      const id = idOf(e)
      if (!id) continue
      const tt = tm(e)
      const prev = m.get(id)
      if (!prev || tt < prev.t) m.set(id, { e, t: tt })
    }
    return m
  }
  const callById = earliestByCall(ofType('tool/call'), (c) => c.data?.callId)
  const resultByCall = earliestByCall(ofType('tool/result'), (r) => r.data?.message?.source?.callId)

  // 纪律 ③：同一秒落地 ≥3 条 result ⇒ 批量回填，其墙钟差不是执行耗时。
  const secondBucket = new Map()
  for (const { t } of resultByCall.values()) {
    const k = Math.floor(t / 1000)
    secondBucket.set(k, (secondBucket.get(k) || 0) + 1)
  }
  const isBackfilled = (t) => (secondBucket.get(Math.floor(t / 1000)) || 0) >= 3

  const toolEvents = []
  for (const [id, { e: c, t: callT }] of callById) {
    const hit = resultByCall.get(id)
    const r = hit?.e
    const resT = hit?.t ?? null
    const contentText = r ? JSON.stringify(r.data?.message?.content ?? r.data ?? '') : ''
    const failed = r ? /"isError"\s*:\s*true|^"?ERROR|ERROR:/.test(contentText) : null
    const backfilled = resT != null ? isBackfilled(resT) : false
    toolEvents.push({
      turn: c.data?.turn,
      step: c.data?.step,
      name: c.data?.name,
      args: String(c.data?.arguments ?? ''),
      callMs: callT,
      resultMs: resT,
      durMs: resT != null ? resT - callT : null,
      backfilled,
      failed,
      hasResult: !!r,
    })
    const t = turnOf(c.data?.turn)
    if (t) t.toolCalls++
  }
  toolEvents.sort((a, b) => a.callMs - b.callMs)

  /* ── token ── */
  const usageEvents = ofType('assistant/message').filter((e) => e.data?.usage)
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }
  for (const e of usageEvents) {
    const u = e.data.usage
    for (const k of Object.keys(usage)) usage[k] += num(u[k])
    const t = turnOf(e.data?.turn)
    if (t) for (const k of Object.keys(usage)) t.usage[k] += num(u[k])
  }
  const billedInput = usage.inputTokens + usage.cacheReadTokens
  const hitRate = billedInput > 0 ? usage.cacheReadTokens / billedInput : null

  /* ── 重试 / 压缩 / 审批（轨迹独有，xray 从来采不到）── */
  const retries = ofType('llm/retry')
  const retryByCode = {}
  let retryDelayMs = 0
  for (const r of retries) {
    const f = r.data?.failure || {}
    const code = f.code || '(无 code)'
    retryByCode[code] = (retryByCode[code] || 0) + 1
    retryDelayMs += num(r.data?.delayMs)
  }
  const compaction = {
    prune: ofType('compaction/prune').length,
    start: ofType('compaction/start').length,
    summary: ofType('compaction/summary').length,
    end: ofType('compaction/end').length,
  }
  const inboxSpliced = ofType('agent/inbox/spliced')
  const headers = ofType('request/header')
  const configChanges = headers.filter((h) => h.data?.reason && h.data.reason !== 'initial').length
  const audit = {
    permission: ofType('permission/preset').length,
    sandbox: ofType('sandbox/mode').length,
    approval: ofType('approval/policy').length,
    command: ofType('command/run').length,
    sandboxModes: [...new Set(ofType('sandbox/mode').map((e) => e.data?.mode).filter(Boolean))],
  }
  const contextWindow = num(
    (ofType('request/context').slice(-1)[0] || {}).data?.contextWindow ??
    (ofType('request/context').slice(-1)[0] || {}).data?.window
  ) || null

  /* ── 工具聚合：耗时 / 失败 / 无结果 / 回填 ── */
  const toolAgg = new Map()
  for (const x of toolEvents) {
    if (!toolAgg.has(x.name)) {
      toolAgg.set(x.name, { name: x.name, count: 0, totalMs: 0, maxMs: 0, failed: 0, noResult: 0, backfilled: 0 })
    }
    const a = toolAgg.get(x.name)
    a.count++
    if (x.backfilled) a.backfilled++
    else if (x.durMs != null) { a.totalMs += Math.max(0, x.durMs); a.maxMs = Math.max(a.maxMs, x.durMs) }
    if (x.failed) a.failed++
    if (!x.hasResult) a.noResult++
  }
  const toolTable = [...toolAgg.values()].sort((a, b) => b.totalMs - a.totalMs)
  const backfilledCount = toolEvents.filter((x) => x.backfilled).length
  const toolCredibleMs = toolEvents.reduce(
    (a, x) => a + (!x.backfilled && x.durMs != null ? Math.max(0, x.durMs) : 0), 0)

  // 「等人回答」必须单独拆开：ask_user_question 的耗时是人在打字，不是引擎慢（F-045）。
  const isHumanWait = (name) => /ask[_-]?user|^question$/i.test(String(name))
  const humanWaitMs = toolEvents.reduce(
    (a, x) => a + (isHumanWait(x.name) && !x.backfilled && x.durMs != null ? Math.max(0, x.durMs) : 0), 0)
  const humanWaitCount = toolEvents.filter((x) => isHumanWait(x.name)).length
  const engineToolMs = Math.max(0, toolCredibleMs - humanWaitMs)

  /* ── 重复调用（空转候选）── */
  const sig = new Map()
  for (const x of toolEvents) {
    const k = x.name + ' ' + x.args
    if (!sig.has(k)) sig.set(k, { name: x.name, args: x.args, times: 0, turns: new Set() })
    const s = sig.get(k)
    s.times++
    s.turns.add(x.turn)
  }
  const repeats = [...sig.values()]
    .map((s) => ({ name: s.name, args: s.args, times: s.times, turns: s.turns.size }))
    .filter((s) => s.times >= 3 || (s.times >= 2 && s.turns === 1))
    .sort((a, b) => b.times - a.times)

  /* ── 时间归因：先分清「引擎在工作」还是「人不在」（F-045 的同一条纪律）── */
  const modelMsSum = steps.reduce((a, s) => a + (s.modelMs ?? 0), 0)
  const postMsgMsSum = steps.reduce((a, s) => a + (s.postMsgMs ?? 0), 0)
  const activeTurns = turns.filter((t) => t.startMs != null && t.endMs != null)
  let activeMs = activeTurns.reduce((a, t) => a + Math.max(0, t.durMs || 0), 0)
  let activeSource = '回合窗口'
  if (!activeTurns.length || activeMs === 0) {
    const ss = steps.map((s) => s.startMs).filter((x) => x != null)
    const se = steps.map((s) => s.endMs).filter((x) => x != null)
    if (ss.length && se.length) {
      activeMs = Math.max(...se) - Math.min(...ss)
      activeSource = 'step 区间（该轨迹没有回合边界）'
    } else {
      activeMs = wallMs
      activeSource = '挂钟（没有回合/步边界，含人在场间隙）'
    }
  }
  let stepGapMs = 0
  let turnEdgeMs = 0
  for (const t of activeTurns) {
    const inTurn = steps.filter((s) => s.turn === t.turn && s.startMs != null).sort((a, b) => a.startMs - b.startMs)
    if (!inTurn.length) continue
    turnEdgeMs += Math.max(0, inTurn[0].startMs - t.startMs)
    const last = inTurn[inTurn.length - 1]
    if (last.endMs != null) turnEdgeMs += Math.max(0, t.endMs - last.endMs)
    for (let i = 0; i + 1 < inTurn.length; i++) {
      if (inTurn[i].endMs != null) stepGapMs += Math.max(0, inTurn[i + 1].startMs - inTurn[i].endMs)
    }
  }
  const idleMs = Math.max(0, wallMs - activeMs)
  const activeOtherMs = Math.max(0, activeMs - modelMsSum - stepGapMs - turnEdgeMs)

  return {
    tracePath: meta.tracePath || '',
    sizeBytes: num(meta.sizeBytes),
    mtimeMs: num(meta.mtimeMs),
    decode: { frames: num(meta.frames), falseMagic: num(meta.falseMagic), badLines: num(meta.badLines) },
    title,
    header: {
      id: header.id || null,
      preset: header.agentPreset || null,
      cwd: header.cwd || null,
      depth: header.delegationDepth ?? null,
      // 父会话 / 来源：子代理会话的 header 上就有 parentSession 与 origin='subagent'。
      // 报告只该合并**本会话派出去的**那些子代理 —— 同一个进程里别的会话派出的
      // 子代理混进来，会让"这一仗"的时间跨度和 token 直接翻倍（实测见过 29 小时的跨度）。
      parent: header.parentSession || null,
      origin: header.origin || null,
      createdAt: header.createdAt ?? null,
    },
    counts: {
      lines: all.length,
      structural: ev.length,
      chunks: authoritative.length - ev.length,
      projected: all.length - authoritative.length,
      turns: turns.length,
      steps: steps.length,
      modelResponses: usageEvents.length,
      toolCalls: toolEvents.length,
      userMessages: ofType('user/message').length,
      inboxSpliced: inboxSpliced.length,
      retries: retries.length,
    },
    window: { tStart, tEnd, wallMs },
    turns, steps, toolEvents, toolTable, repeats,
    // 收件箱拼接的时刻表：它与 xray 采集的 inbox/spliced 是同一件事，交叉校验要逐条对账。
    inboxSplicedTimes: inboxSpliced.map(tm),
    usage, billedInput, hitRate,
    retries: { count: retries.length, delayMs: retryDelayMs, byCode: retryByCode },
    compaction, audit, configChanges, contextWindow,
    toolCredibleMs, backfilledCount, engineToolMs, humanWaitMs, humanWaitCount,
    time: {
      modelMsSum, postMsgMsSum,
      activeMs, idleMs, stepGapMs, turnEdgeMs, activeOtherMs, activeSource,
      retryMs: retryDelayMs,
    },
  }
}

/* ─────────────────── 翻译成 xray 事件（分析器吃这个）─────────────────── */

/**
 * 一份 Trace → xray 事件数组。形状与 lib/index.js 里 record() 落盘的完全一致
 * （{t, seq, kind, ...}），于是 analyze() 一行都不用改。
 *
 * 映射与理由：
 *   step/start    → pre-step（步数口径）+ request（"请求在飞"的起点，等模型靠它算）
 *   tool/call     → tool（含 tool/args，空转签名靠它）；xray_* 自身调用 → self-call
 *   turn/start    → turn/start（边界）
 *   turn/end      → turn/end（边界）。**必须有** —— 否则回合 N 最后一个工具到回合
 *                   N+1 第一个请求之间那段"人不在"，会被归因成"工具在执行"，
 *                   白白多报几个小时的工具耗时。
 *
 * agent 一律填本轨迹的 session id：轨迹是按会话分的，一个文件里只有一个主体。
 * @param {object} trace loadTrace() 的产物
 * @param {{agent?:string}} [opts]
 * @returns {object[]}
 */
export function toXrayEvents(trace, opts = {}) {
  if (!trace || !Array.isArray(trace.steps)) return []
  const agent = opts.agent || (trace.header && trace.header.id) || null
  const out = []
  let seq = 0
  const push = (t, kind, extra) => {
    out.push({ t, seq: ++seq, kind, agent, ...extra })
  }

  // 回合边界先进：同一时刻的事件靠 seq 排先后，边界必须在步之前。
  const marks = []
  for (const t of trace.turns) {
    if (t.startMs != null) marks.push({ t: t.startMs, kind: 'turn/start', turn: t.turn })
    if (t.endMs != null) marks.push({ t: t.endMs, kind: 'turn/end', turn: t.turn, reason: t.reasonKind })
  }
  marks.sort((a, b) => a.t - b.t)
  for (const m of marks) {
    const { t, kind, ...rest } = m
    push(t, kind, rest)
  }

  for (const s of trace.steps) {
    push(s.startMs, 'pre-step', { step: s.step })
    // +1ms：与 pre-step 分开排，否则同一毫秒里两条事件的先后不确定，
    // 「等模型」的分段计数会随排序抖动（1ms 对任何结论都无影响）。
    push(s.startMs + 1, 'request', {})
  }

  for (const x of trace.toolEvents) {
    if (!x.name) continue
    if (/^xray_/.test(String(x.name))) {
      // 自身调用单独成 kind：不进工具排行/空转（工具口径不受污染），但采用率可测。
      push(x.callMs, 'self-call', { tool: x.name, args: clip(x.args, 120) })
    } else {
      push(x.callMs, 'tool', { tool: x.name, args: clip(x.args, 200) })
    }
  }

  // 收件箱拼接（用户插话 / 分队回传进入回合的入口）。它不影响步与工具的口径，
  // 但少了它，"这一回合被打断过几次"就只能靠回忆 —— 轨迹里有，就取出来。
  for (const t of trace.inboxSplicedTimes || []) push(t, 'inbox/spliced', {})

  out.sort((a, b) => a.t - b.t || a.seq - b.seq)
  // 排序后重编号：analyze() 用 (t, seq) 做稳定排序，seq 必须与最终顺序一致。
  for (let i = 0; i < out.length; i++) out[i].seq = i + 1
  return out
}

/**
 * 一次取全：路径 → { trace, events }。读不到返回 null。
 * 这是插件里唯一需要知道的入口。
 */
export function readTraceAsEvents(tracePath, opts = {}) {
  const trace = loadTrace(tracePath)
  if (!trace) return null
  return { trace, events: toXrayEvents(trace, opts) }
}

/** 轨迹的展示名：id 前 8 位 + 标题片段（报告里指认"读的是哪一份"）。 */
export function traceLabel(trace) {
  if (!trace) return '(无轨迹)'
  const id = String(trace.header?.id || '').replace(/^session-/, '').slice(0, 8)
  const title = clip(trace.title || '', 28)
  return (id || '?') + (title ? ' · ' + title : '')
}
