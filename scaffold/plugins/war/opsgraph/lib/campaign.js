/**
 * 战役内核的操作层：把「意图图 + 持久化」包成规划器/执行者真正会调的那几个动作。
 *
 * 对照 ARTEX：planner 读态势 → 派意图；worker 领意图 → 写回 → 停。
 * 这里就是那两组动作，不碰宿主、不碰工具，纯粹对盘上的图做事，因此可被单测。
 *
 * 与 ARTEX 的刻意差异：
 *   - 不需要 CAS：单写者（一次只有一个 planner / 一个 worker 在写）。
 *   - 不需要事务：追加式日志 + 原子重写，崩了重放即可。
 */
import { appendNode, appendEdge, load, persistNodes } from './store.js'
import {
  nextNodeId,
  selectReady,
  transition,
  buildProjection,
  renderOverview,
  isIntentState,
  recoverRunning,
} from './graph.js'

/** 事件日志折叠：同 id 后写覆盖先写。 */
export function foldNodes(nodes) {
  const byId = new Map()
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = String(node?.id ?? '')
    if (id === '') continue
    byId.set(id, node)
  }
  return [...byId.values()]
}

/**
 * 读图：**只折叠，不做恢复**。
 *
 * 这一行是踩出来的。第一版在这里调用了 loadWithRecovery，于是每次读盘都会把 claimed /
 * running 回卷成 pending —— worker 刚领到活，下一次读就把这一领用抹掉了，交活时再判
 * 迁移就是 claimed->done 变 pending->done，直接被状态机拒掉（体现为"交活失败"）。
 *
 * ARTEX 的 ResetRunningIntents 只在**服务启动时**跑一次，不是每次读都跑。恢复必须是
 * 显式的、一次性的：见 recoverOnBoot()。
 */
export async function loadGraph(dir) {
  const raw = await load(dir)
  return {
    nodes: foldNodes(raw.nodes),
    edges: raw.edges,
    released: [],
    badLines: raw.badLines,
  }
}

/**
 * 启动时跑一次崩溃恢复：把上一次进程留下的 claimed / running 意图回卷成 pending。
 *
 * 只能在战役内核启动时调用。中途调用会让所有在跑的领用全部失效。
 */
export async function recoverOnBoot(dir) {
  /* ★ 必须先折叠、再恢复（2026-11-12 实测假警报）：原始行里历史某一行曾经是 running，
     但折叠之后该节点现在是 exhausted —— 拿未折叠的行去恢复，会把早就结束的意图当成
     "上次进程的残渣"释放一遍，日志写 `boot-recovered released:[i1]` 而实际上什么都没发生，
     而且每次启动都无条件重写一遍文件。
     日志里"看起来动了"和"真的动了"是两件事，这里按真的来。 */
  const raw = await load(dir)
  const folded = foldNodes(raw.nodes)
  const rec = recoverRunning(folded)
  if (rec.released.length > 0) await persistNodes(dir, rec.nodes)
  return {
    released: rec.released,
    nodes: rec.nodes,
    badLines: raw.badLines,
  }
}

/**
 * 派一条意图。
 *
 * `needs` 是前置（对应 ARTEX「前置步骤已完成、其依赖的 fact 已存在」），会被同时写成
 * `derived_from` 边——血缘必须在写的时候记，事后补不回来。
 */
export async function addIntent(dir, request) {
  const graph = await loadGraph(dir)
  const id = nextNodeId(graph.nodes, 'intent')
  const node = {
    id,
    kind: 'intent',
    state: 'pending',
    priority: typeof request?.priority === 'number' ? request.priority : 0,
    payload: {
      title: String(request?.title ?? ''),
      detail: String(request?.detail ?? ''),
      vulnclass: request?.vulnclass === undefined ? '' : String(request.vulnclass),
    },
    needs: Array.isArray(request?.needs) ? request.needs.map(String) : [],
    anchors: Array.isArray(request?.anchors) ? request.anchors.map(String) : [],
    origin: String(request?.origin ?? 'planner'),
    createdAt: new Date().toISOString(),
  }
  await appendNode(dir, node)
  for (const need of node.needs) {
    await appendEdge(dir, { from: id, rel: 'derived_from', to: need, at: node.createdAt })
  }
  return node
}

/** 加一条事实（worker 写回的主要产物，也是解锁下游意图的钥匙）。 */
export async function addFact(dir, request) {
  const graph = await loadGraph(dir)
  const id = nextNodeId(graph.nodes, 'fact')
  const node = {
    id,
    kind: 'fact',
    state: 'done',
    payload: { text: String(request?.text ?? '') },
    anchors: Array.isArray(request?.anchors) ? request.anchors.map(String) : [],
    origin: String(request?.origin ?? 'worker'),
    createdAt: new Date().toISOString(),
  }
  await appendNode(dir, node)
  return node
}

/** 记一条战果（漏洞）。板面已有战果账本，这里存的是它在图上的锚点。 */
export async function addFinding(dir, request) {
  const graph = await loadGraph(dir)
  const id = nextNodeId(graph.nodes, 'finding')
  const node = {
    id,
    kind: 'finding',
    state: 'done',
    payload: {
      title: String(request?.title ?? ''),
      severity: String(request?.severity ?? ''),
    },
    anchors: Array.isArray(request?.anchors) ? request.anchors.map(String) : [],
    origin: String(request?.origin ?? 'worker'),
    createdAt: new Date().toISOString(),
  }
  await appendNode(dir, node)
  return node
}

/**
 * 领一条可派的意图（worker 侧）。
 *
 * 返回 `{ intent: null, reason: 'no-ready' }` 是**正常结果**——ARTEX 的 planner 大多数
 * 唤醒派 0 个意图，worker 也一样可能领不到活。调用方不得把它当异常。
 */
export async function claimNext(dir, who) {
  const graph = await loadGraph(dir)
  const ready = selectReady(graph.nodes, { limit: 1 })
  if (ready.length === 0) return { intent: null, reason: 'no-ready' }
  const target = ready[0]
  const now = new Date().toISOString()
  /* 「领」和「开跑」在一次调用里完成：pending -> claimed -> running，只落最终的 running。
     不让 worker 自己走一步 claimed 再说一声 running —— 那会多出一条谁都不会写的中间态，
     而且一旦漏写，交活时的 claimed->done 会被状态机拒掉（第一版就是这么炸的）。
     `claimed` 保留给将来真正需要「预留但不开跑」的场景（人工审核后再执行）。 */
  const claimed = transition(graph.nodes, target.id, 'claimed', {
    claimedBy: String(who ?? ''),
    claimedAt: now,
  })
  if (claimed === null) return { intent: null, reason: 'transition-rejected' }
  const running = transition(claimed, target.id, 'running', { startedAt: now })
  if (running === null) return { intent: null, reason: 'transition-rejected' }
  const updated = running.find((n) => n.id === target.id)
  await appendNode(dir, updated)
  return { intent: updated, reason: 'ok' }
}

/**
 * worker 交活：写回事实/战果 + 把意图迁到终态。
 *
 * state 允许 done / exhausted / blocked：
 *   - done      拿到了东西；
 *   - exhausted 打完了没结果（ARTEX 的关键语义：这不是失败，可以重开换方向）；
 *   - blocked   外部原因卡住（需要人或授权）。
 */
export async function finishIntent(dir, id, request) {
  const graph = await loadGraph(dir)
  const node = graph.nodes.find((n) => String(n.id) === String(id))
  if (node === undefined) return { ok: false, error: 'intent-not-found' }
  const state = String(request?.state ?? 'done')
  if (state !== 'done' && state !== 'exhausted' && state !== 'blocked') {
    return { ok: false, error: 'invalid-state:' + state }
  }
  if (!isIntentState(state)) return { ok: false, error: 'invalid-state:' + state }

  const facts = []
  for (const text of Array.isArray(request?.facts) ? request.facts : []) {
    const fact = await addFact(dir, { text, anchors: request?.anchors, origin: String(request?.who ?? 'worker') })
    facts.push(fact.id)
    await appendEdge(dir, { from: id, rel: 'yields', to: fact.id, at: new Date().toISOString() })
  }
  const findings = []
  for (const item of Array.isArray(request?.findings) ? request.findings : []) {
    const finding = await addFinding(dir, {
      title: item?.title,
      severity: item?.severity,
      anchors: request?.anchors,
      origin: String(request?.who ?? 'worker'),
    })
    findings.push(finding.id)
    await appendEdge(dir, { from: id, rel: 'proves', to: finding.id, at: new Date().toISOString() })
  }

  const fresh = await loadGraph(dir)
  const next = transition(fresh.nodes, id, state, {
    finishedAt: new Date().toISOString(),
    finishedBy: String(request?.who ?? 'worker'),
    note: String(request?.note ?? ''),
    produced: [...facts, ...findings],
  })
  if (next === null) return { ok: false, error: 'transition-rejected' }
  await appendNode(dir, next.find((n) => n.id === String(id)))
  return { ok: true, state, facts, findings }
}

/** 重开一条意图（判错了、有新材料、或预算用尽后换方向）。 */
export async function reopenIntent(dir, id, reason) {
  const graph = await loadGraph(dir)
  const next = transition(graph.nodes, id, 'pending', {
    reopenedAt: new Date().toISOString(),
    reopenReason: String(reason ?? ''),
  })
  if (next === null) return { ok: false, error: 'transition-rejected' }
  await appendNode(dir, next.find((n) => n.id === String(id)))
  return { ok: true }
}

/** 规划器读的态势：投影 + 可直接塞进上下文的那段文字。 */
export async function overview(dir, assetIds) {
  const graph = await loadGraph(dir)
  const projection = buildProjection(graph.nodes, graph.edges, assetIds)
  return {
    projection,
    text: renderOverview(projection),
    released: graph.released,
    badLines: graph.badLines,
  }
}

/**
 * 战役是否还有活干——触发唤醒通道的唯一判据。
 *
 * 只有真的有可派意图、或有在跑的意图时才该叫醒规划器。否则每次图变都唤醒，就退化成
 * 现在这样「一条通知烧一个回合」。这是 ARTEX「大多数唤醒派 0 个」的另一面：不是让它
 * 派 0 个，而是根本别为 0 个去叫它。
 */
export function hasWork(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  let running = 0
  for (const node of list) {
    if (node?.kind !== 'intent') continue
    const state = String(node?.state ?? '')
    if (state === 'running' || state === 'claimed') running += 1
  }
  const ready = selectReady(list, { limit: 1 })
  return { ready: ready.length > 0, running, busy: ready.length > 0 || running > 0 }
}
