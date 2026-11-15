/**
 * war-fanout-gate - bound the number of live worker subagents
 *
 * MEASURED JUSTIFICATION (2026-11-11, live war-lead session):
 *   The lead dispatched 9 worker subagents in one instruction. Over the following
 *   19 minutes the host process went:
 *       RSS 260 MB -> 2,932 MB     (CPU 927s / 1,140s wall ~= 77% of one core)
 *   That is worse than the 2.2 GB peak that used to produce 13-second GC pauses.
 *   Historical repeat measurement: V8 major-GC pause grows catastrophically with
 *   live-set size (1.4 s at ~700 MB, up to 81.6 s at ~1.2 GB), and every live
 *   child session contributes its own event graph and projections to that live set.
 *
 * ARTEX reference: per-task worker loops default to 3 (server/manager.go:283-284),
 * concurrent tasks 5 (manager.go:285-287). Bounded fan-out is the norm, not a cap
 * on capability: three parallel probes plus a batching discipline covers the work.
 *
 * WHAT IT DOES
 *   Hooks `tools/pre-execute` (waterfall). When the tool is a delegation tool
 *   (subagent / subagent_fork / subagent_codex / subagent_claude_code) and the
 *   caller already owns `maxChildren` live children, it returns
 *   { kind: 'deny', reason } so the model is told to wait for or batch the work
 *   instead of spawning yet another worker.
 *
 * CONTRACT (verified against dsh-tools/lib/types/index.d.ts)
 *   'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>)
 *     : Promise<PreToolDecision>
 *   PreToolDecision = { kind:'allow' } | { kind:'deny'; reason: string }
 *                   | { kind:'ask'; reason?: string }
 *   ToolExecution.agent?: Agent   <- the calling agent, when the outer call has one
 *
 * SAFETY
 *   - never throws: any failure returns the host's own decision
 *   - shadow by default (enabled:false): only logs what it WOULD deny
 *   - counts only this caller's own live children when ownership is queryable,
 *     and never blocks non-delegation tools
 *   - if the live registry is unavailable, it allows (never blocks blind)
 *
 * ENCODING WARNING: edit with a UTF-8 safe writer only（文件工具），
 * 禁止用 PowerShell Set-Content 写本文件。本文件为 UTF-8 无 BOM，注释中文。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export const name = 'war-fanout-gate'

/** Tools that create a worker. */
export const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code'])

/** Default cap on live children per lead. */
export const DEFAULT_MAX_CHILDREN = 3

/** 子代理条目没有可读的 status 字符串时，落在这个桶里（不是丢掉，是显式记名）。 */
export const CENSUS_MISSING_STATUS = '(missing)'

/** 样本上限：日志要紧凑，所以只留 3 条。 */
export const CENSUS_SAMPLE_LIMIT = 3

/** True when this tool name spawns a worker. */
export function isDelegationTool(name) {
  return DELEGATION_TOOLS.has(String(name ?? ''))
}

/** 把任意活对象的字段压成 JSON 安全的标量——样本里绝不允许出现活对象。 */
function scalarField(v) {
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') return v
  if (v === null || v === undefined) return null
  return '[' + t + ']'
}

/**
 * 把 agents.list() 在「卡口检查那一刻」返回的东西压成一份可写日志的普查。
 *
 * 为什么要它：闸门只数 status 恰好等于 'running' 的孩子，而它又在被数的孩子
 * 出现之前运行。实测 16 次派发 liveChildren 都是 0、deny 从未触发，旧日志只记
 * 结果数字，于是下面两种解释无法区分：
 *   (a) 派发实际上串行/短命，0 是对的，闸门只是在等；
 *   (b) 注册表的 status 词汇那一刻从不等于 'running'，计数器结构性恒为 0。
 * 这份普查记的是「当时注册表长什么样」，下一次真实派发就能把两者分开。
 *
 * 纯函数、总函数：undefined / null / 非数组 / 一堆垃圾 / 访问器抛异常，
 * 都返回一份摘要，绝不抛。
 *
 * 返回形状：
 *   agents            数组声称持有的条目总数
 *   subagents         session.header.origin === 'subagent' 的条目数
 *   statusFieldPresent 是否有任意条目给出了字符串 status（这正是闸门判断
 *                     trackStatus 还是退回 origin-only 的那个探针）
 *   statuses          只统计「子代理条目」的 status 直方图 —— 因为那才是闸门计数
 *                     的定义域；没有字符串 status 的条目落进 '(missing)' 桶。
 *                     （若一个子代理都没有，这里就是 {}，此时看 subagents=0 即知）
 *   unreadable        完全无法分类的条目（不是对象，或访问器抛异常）—— 计数，
 *                     不静默丢弃
 *   ownedByQueryable  agents 服务是否暴露 isOwnedBy（决定闸门能否按精确归属过滤）
 *   sample            最多 CENSUS_SAMPLE_LIMIT 条子代理条目，只含标量字段
 *
 * @param {unknown} list agents.list() 的返回值，什么都可能。
 * @param {boolean|object} ownership 归属可查性：直接给布尔，或给一个带
 *        isOwnedByQueryable / isOwnedBy 的对象。
 */
export function registryCensus(list, ownership) {
  let ownedByQueryable = false
  try {
    if (typeof ownership === 'boolean') ownedByQueryable = ownership
    else if (ownership !== null && typeof ownership === 'object') {
      ownedByQueryable =
        typeof ownership.isOwnedByQueryable === 'boolean'
          ? ownership.isOwnedByQueryable
          : typeof ownership.isOwnedBy === 'function'
    }
  } catch {
    ownedByQueryable = false
  }

  const summary = {
    agents: 0,
    subagents: 0,
    statusFieldPresent: false,
    statuses: {},
    unreadable: 0,
    ownedByQueryable,
    sample: [],
  }

  let entries
  try {
    entries = Array.isArray(list) ? list : []
  } catch {
    entries = []
  }

  try {
    for (const a of entries) {
      summary.agents++
      // 不是对象就不是代理记录：计数，但归入 unreadable，不静默丢。
      if (a === null || typeof a !== 'object') {
        summary.unreadable++
        continue
      }

      let origin = ''
      try {
        origin = String(a.session?.header?.origin ?? '')
      } catch {
        // 读 origin 就抛：无法判断是否子代理，计入 unreadable。
        summary.unreadable++
        continue
      }

      // statusFieldPresent 看的是「所有条目」，不是只看子代理：这正是闸门里
      // list.some(entry => typeof entry?.status === 'string') 那个探针的语义，
      // 记成另一个定义会让日志和决策对不上。
      let hasStatus = false
      let statusText = ''
      try {
        const raw = a.status
        if (typeof raw === 'string') {
          hasStatus = true
          statusText = raw
        }
      } catch {
        hasStatus = false
      }
      if (hasStatus) summary.statusFieldPresent = true

      if (origin !== 'subagent') continue
      summary.subagents++
      const bucket = hasStatus ? statusText : CENSUS_MISSING_STATUS
      summary.statuses[bucket] = (summary.statuses[bucket] ?? 0) + 1

      if (summary.sample.length < CENSUS_SAMPLE_LIMIT) {
        let id = null
        try {
          id = scalarField(a.id)
        } catch {
          id = null
        }
        summary.sample.push({ id, status: hasStatus ? statusText : null, origin: 'subagent' })
      }
    }
  } catch {
    // 敌意可迭代对象：保留已经数到的部分，闸门仍然不抛。
  }

  return summary
}

export function apply(ctx, config) {
  const cfg = config ?? {}
  const root = typeof cfg.root === 'string' && cfg.root ? cfg.root : (process.env.WAR_ROOT || '<HOME>/.war')
  const logDir = path.join(root, '_broker')
  const logFile = path.join(logDir, 'fanout.jsonl')
  const maxChildren = typeof cfg.maxChildren === 'number' ? cfg.maxChildren : DEFAULT_MAX_CHILDREN
  const enabled = cfg.enabled === true

  let logBroken = false
  async function log(entry) {
    if (logBroken) return
    try {
      await fs.mkdir(logDir, { recursive: true })
      await fs.appendFile(logFile, JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      logBroken = true
    }
  }

  void log({ at: new Date().toISOString(), kind: 'startup', enabled, maxChildren })

  /** 取一次注册表快照：计数和普查必须看同一个数组，否则日志和决策会互相矛盾。 */
  function registrySnapshot() {
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.list !== 'function') return null
    let list
    try {
      list = agents.list()
    } catch {
      return null
    }
    if (!Array.isArray(list)) return null
    return { agents, list }
  }

  /** Count live worker agents owned by (or at least attributed to) this caller. */
  function liveChildren(snapshot, caller) {
    if (snapshot === null) return null
    const agents = snapshot.agents
    const list = snapshot.list
    // Liveness, not existence. A finished continuable child STAYS REGISTERED (idle) so the
    // lead can send_message it later; counting it against the cap would lock the lead out
    // forever once it had dispatched `maxChildren` workers. Measured 2026-11-12: agents.list()
    // still reports children that finished long ago, so the old unfiltered count was PERMANENT.
    // Fall back to origin-only counting when the registry exposes no status at all.
    const trackStatus = list.some((entry) => typeof entry?.status === 'string')
    let count = 0
    for (const a of list) {
      let origin = ''
      try {
        origin = String(a?.session?.header?.origin ?? '')
      } catch {
        origin = ''
      }
      if (origin !== 'subagent') continue
      if (trackStatus) {
        let status = ''
        try {
          status = String(a?.status ?? '')
        } catch {
          status = ''
        }
        // Only a child that is actually working occupies a slot.
        if (status !== 'running') continue
      }
      // Prefer exact ownership when the registry can answer it.
      let owned = true
      if (caller !== undefined && typeof agents.isOwnedBy === 'function') {
        try {
          owned = agents.isOwnedBy(String(a.id), caller) === true
        } catch {
          owned = true
        }
      }
      if (owned) count++
    }
    return count
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    // The gate exists for the LEAD's fan-out. The `war` preset also runs every worker
    // subagent, and a worker's own dispatch (if any) must not be counted against the
    // lead's cap.
    if (String(exec?.agent?.session?.header?.origin ?? '') === 'subagent') return next()
    const base = await next()
    try {
      if (base !== undefined && base.kind !== 'allow') return base
      const tool = String(exec?.name ?? '')
      if (!isDelegationTool(tool)) return base

      const caller = exec?.agent
      const snapshot = registrySnapshot()
      const count = liveChildren(snapshot, caller)
      if (count === null) return base // registry unavailable: never block blind

      // 决策日志多带一份「当时注册表长什么样」。计数、deny 理由、shadow 语义一律不变；
      // 变的只是日志记法，目的就是让下一次真实派发能回答旧日志答不了的那个问题。
      let ownedByQueryable = false
      try {
        ownedByQueryable = typeof snapshot.agents.isOwnedBy === 'function'
      } catch {
        ownedByQueryable = false
      }
      const registry = registryCensus(snapshot.list, ownedByQueryable)

      if (count < maxChildren) {
        void log({ at: new Date().toISOString(), kind: 'allowed', tool, liveChildren: count, maxChildren, enabled, registry })
        return base
      }

      const reason =
        'fan-out gate: ' +
        count +
        ' worker subagents are already live (cap ' +
        maxChildren +
        '). Do not spawn another. Reuse a running worker via send_message, or batch the remaining ' +
        'work into one dispatch once a slot frees up. Live sessions are billed against the same ' +
        'process heap; measured effect of 9 parallel workers: RSS 260 MB -> 2,932 MB in 19 minutes.'

      if (!enabled) {
        void log({ at: new Date().toISOString(), kind: 'would-deny', tool, liveChildren: count, maxChildren, enabled, registry })
        return base
      }

      void log({ at: new Date().toISOString(), kind: 'denied', tool, liveChildren: count, maxChildren, enabled, registry })
      return { kind: 'deny', reason }
    } catch {
      return base
    }
  })
}
