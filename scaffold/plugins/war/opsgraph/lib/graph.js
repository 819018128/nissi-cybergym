/**
 * 意图图核心（对应 ARTEX 的探索图，简化到文件即可承载的形态）。
 *
 * WHY: 现在的战争模式把「记忆、规划、执行」全塞在主帅会话的对话历史里，所以打得越久
 * 上下文越膨胀、判定越模糊。ARTEX 的做法是把它们拆开：记忆在图里、规划器无状态、worker
 * 一意图一回合。这个模块只负责记忆层，全部是纯函数，不碰文件、不碰宿主。
 *
 * 图形态（对照 ARTEX db/exploration.go + db/intent_admission.go）：
 *   节点 kinds: goal | intent | fact | finding | hint
 *   边   rels : spawns | derived_from | yields | proves
 *   锚点      : 节点 -> 资产 id（对应 ARTEX 的 exploration_anchors）
 *   意图状态  : pending -> claimed -> running -> done | exhausted | blocked
 *
 * 与 ARTEX 的差异（刻意的）：
 *   - 单写者，所以不需要 CompareAndSetIntentState 那种 CAS；靠状态机白名单挡非法迁移。
 *   - 没有 Postgres，追加式 JSONL + 每次读重建投影；崩了重放就行。
 */

export const NODE_KINDS = ['goal', 'intent', 'fact', 'finding', 'hint']
export const EDGE_RELS = ['spawns', 'derived_from', 'yields', 'proves']
export const INTENT_STATES = ['pending', 'claimed', 'running', 'done', 'exhausted', 'blocked']

/** 终态：不再推进，但可被「重开」拉回 pending（对应 ARTEX 的 ReopenIntent）。 */
export const TERMINAL_STATES = ['done', 'exhausted', 'blocked']

/**
 * 允许的意图状态迁移。白名单而不是黑名单：任何未列出的迁移都非法。
 * `exhausted` 是 ARTEX 的关键设计——预算用尽的意图不算失败，可以换方向重来。
 */
const TRANSITIONS = {
  pending: ['claimed', 'blocked', 'exhausted'],
  claimed: ['running', 'pending', 'blocked'],
  running: ['done', 'exhausted', 'blocked', 'pending'],
  done: ['pending'],
  exhausted: ['pending'],
  blocked: ['pending'],
}

export function isNodeKind(kind) {
  return NODE_KINDS.includes(kind)
}

export function isEdgeRel(rel) {
  return EDGE_RELS.includes(rel)
}

export function isIntentState(state) {
  return INTENT_STATES.includes(state)
}

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state)
}

/** 状态迁移是否合法。未知状态一律 false。 */
export function canTransition(from, to) {
  const allowed = TRANSITIONS[from]
  if (allowed === undefined) return false
  return allowed.includes(to)
}

/** 分配节点 id：按 kind 前缀 + 递增序号，读侧不必依赖 uuid。 */
export function nextNodeId(nodes, kind) {
  const prefix = { goal: 'g', intent: 'i', fact: 'f', finding: 'v', hint: 'h' }[kind] ?? 'n'
  let max = 0
  for (const node of nodes ?? []) {
    const id = String(node?.id ?? '')
    if (!id.startsWith(prefix)) continue
    const n = Number(id.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return prefix + (max + 1)
}

/**
 * 把一次状态迁移应用到节点副本上。非法迁移返回 null（调用方据此记一条拒绝日志）。
 */
export function transition(nodes, id, to, extra) {
  if (!isIntentState(to)) return null
  const list = Array.isArray(nodes) ? nodes : []
  const index = list.findIndex((n) => String(n?.id) === String(id))
  if (index < 0) return null
  const node = list[index]
  const from = String(node?.state ?? '')
  if (!canTransition(from, to)) return null
  const next = { ...node, ...(extra ?? {}), state: to }
  const out = list.slice()
  out[index] = next
  return out
}

/**
 * 崩溃恢复：把 running / claimed 的意图拉回 pending 并留下标记。
 * 对应 ARTEX 的 ResetRunningIntents——服务重启时卡在 running 的意图否则永远没人领。
 *
 * @returns {{nodes: object[], released: string[]}}
 */
export function recoverRunning(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  const released = []
  const out = list.map((node) => {
    if (node?.kind !== 'intent') return node
    const state = String(node?.state ?? '')
    if (state !== 'running' && state !== 'claimed') return node
    released.push(String(node.id))
    return { ...node, state: 'pending', releasedFrom: state }
  })
  return { nodes: out, released }
}

function needIdsOf(node) {
  const needs = node?.needs
  if (!Array.isArray(needs)) return []
  return needs.map((x) => String(x))
}

/**
 * 取一条意图的前置是否已满足。
 * 规则（对照 ARTEX「前置步骤已完成、其依赖的 fact 已存在」）：
 *   - 依赖的节点必须存在；
 *   - 依赖的节点若是 intent，必须已 done；
 *   - 依赖的节点若是 fact / finding，存在即算满足。
 * 缺失的依赖视为未满足（宁可少派，不可乱序）。
 */
export function needsSatisfied(node, byId) {
  for (const need of needIdsOf(node)) {
    const dep = byId.get(need)
    if (dep === undefined) return false
    if (dep.kind === 'intent' && String(dep.state) !== 'done') return false
  }
  return true
}

/**
 * frontier：可以立刻派的意图。
 *
 * 允许返回空数组——这是 ARTEX planner 的一等公民（「大多数唤醒派 0 个」），
 * 调用方不得把它当异常。
 */
export function selectReady(nodes, options) {
  const limit = typeof options?.limit === 'number' && options.limit > 0 ? options.limit : 8
  const list = Array.isArray(nodes) ? nodes : []
  const byId = new Map()
  for (const node of list) byId.set(String(node?.id), node)
  const ready = []
  for (const node of list) {
    if (node?.kind !== 'intent') continue
    if (String(node?.state ?? '') !== 'pending') continue
    if (!needsSatisfied(node, byId)) continue
    ready.push(node)
  }
  ready.sort((a, b) => {
    const pa = typeof a?.priority === 'number' ? a.priority : 0
    const pb = typeof b?.priority === 'number' ? b.priority : 0
    if (pa !== pb) return pb - pa
    return String(a?.id).localeCompare(String(b?.id))
  })
  return ready.slice(0, limit)
}

/** 资产覆盖度：哪些资产从没被任何已完成/已排空的意图碰过（对应 ARTEX 的覆盖图）。 */
export function coverage(nodes, allAssetIds) {
  const assets = Array.isArray(allAssetIds) ? allAssetIds.map((x) => String(x)) : []
  const touched = new Set()
  for (const node of Array.isArray(nodes) ? nodes : []) {
    /* 覆盖是**证据**口径，不是意图状态口径。
       WHY 改（2026-11-12 实测）：一场管道冒烟测试把 i1 交了 `exhausted`，一个网络请求都没发，
       覆盖度却把 A1 记成"已测过"。系统因此分不清「打过了没结果」和「压根没打」——
       而覆盖度正是判断"还剩什么没打"的依据，虚高的覆盖度会让主帅以为打完了。
       新口径：只有**事实或战果**锚定到该资产，才算测过。
       「看一眼返回 401 并记下来」必然留下事实；「没打」不会——两者自然分开，
       既不需要新状态，也不依赖意图状态可不可信。 */
    const kind = String(node?.kind ?? '')
    if (kind !== 'fact' && kind !== 'finding') continue
    for (const id of Array.isArray(node?.anchors) ? node.anchors : []) touched.add(String(id))
  }
  const untested = assets.filter((id) => !touched.has(id))
  return {
    total: assets.length,
    touched: assets.length - untested.length,
    untested,
  }
}

/** 只读投影：给规划器看的态势。不返回原始节点数组，避免调用方误把它当真值库。 */
export function buildProjection(nodes, edges, allAssetIds) {
  const list = Array.isArray(nodes) ? nodes : []
  const byKind = {}
  for (const kind of NODE_KINDS) byKind[kind] = 0
  const intentByState = {}
  for (const state of INTENT_STATES) intentByState[state] = 0
  for (const node of list) {
    const kind = String(node?.kind ?? '')
    if (kind in byKind) byKind[kind] += 1
    if (kind === 'intent') {
      const state = String(node?.state ?? '')
      if (state in intentByState) intentByState[state] += 1
    }
  }
  const edgeList = Array.isArray(edges) ? edges : []
  return {
    byKind,
    intentByState,
    counts: {
      nodes: list.length,
      edges: edgeList.length,
      openGoals: list.filter((n) => n?.kind === 'goal' && String(n.state) !== 'done').length,
      doneGoals: list.filter((n) => n?.kind === 'goal' && String(n.state) === 'done').length,
    },
    frontier: selectReady(list, { limit: 8 }).map((n) => ({
      id: String(n.id),
      title: String(n?.payload?.title ?? ''),
      priority: typeof n?.priority === 'number' ? n.priority : 0,
      anchors: Array.isArray(n?.anchors) ? n.anchors.map(String) : [],
    })),
    coverage: coverage(list, allAssetIds),
  }
}

/**
 * 渲染成规划器可读的紧凑文本。故意短：这是每一轮都要带进上下文的，不是给人看的报表。
 */
export function renderOverview(projection) {
  const p = projection ?? {}
  const k = p.byKind ?? {}
  const s = p.intentByState ?? {}
  const cov = p.coverage ?? { total: 0, touched: 0, untested: [] }
  const lines = []
  lines.push(
    '目标 ' + String((k.goal ?? 0)) + '（达成 ' + String(p?.counts?.doneGoals ?? 0) + '）',
  )
  lines.push(
    '意图 ' +
      String(k.intent ?? 0) +
      '：pending ' + String(s.pending ?? 0) +
      ' / running ' + String(s.running ?? 0) +
      ' / done ' + String(s.done ?? 0) +
      ' / exhausted ' + String(s.exhausted ?? 0) +
      ' / blocked ' + String(s.blocked ?? 0),
  )
  lines.push('事实 ' + String(k.fact ?? 0) + ' / 漏洞 ' + String(k.finding ?? 0) + ' / 提示 ' + String(k.hint ?? 0))
  const frontier = Array.isArray(p.frontier) ? p.frontier : []
  if (frontier.length === 0) {
    lines.push('可派：0 条（没有新方向——派 0 条是正常结果，不是异常）')
  } else {
    lines.push('可派：' + String(frontier.length) + ' 条')
    for (const item of frontier) {
      lines.push(
        '  · ' + item.id + ' [prio ' + String(item.priority) + '] ' + item.title +
          (item.anchors.length > 0 ? ' @' + item.anchors.join(',') : ''),
      )
    }
  }
  lines.push('覆盖：' + String(cov.touched) + '/' + String(cov.total) + ' 资产被测过')
  if (Array.isArray(cov.untested) && cov.untested.length > 0) {
    const head = cov.untested.slice(0, 8)
    lines.push('未测：' + head.join(',') + (cov.untested.length > head.length ? ' …' : ''))
  }
  return lines.join('\n')
}
