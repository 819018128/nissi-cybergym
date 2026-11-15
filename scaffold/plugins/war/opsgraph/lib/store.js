/**
 * 意图图的持久化层：追加式 JSONL + 原子重写。
 *
 * 设计取舍（对照 ARTEX 的 Postgres）：
 *   - **追加**：每回合只 append 几行，没有读-改-写窗口，崩溃最多丢最后一个半行。
 *   - **重放**：读侧把 JSONL 折叠成内存图，坏行跳过（一个半截行不该让整场战役读不出来）。
 *   - **原子重写**：崩溃恢复要把 running 回卷成 pending，那是"修改"，只能整份重写；
 *     写临时文件再 rename，任何时刻磁盘上都有一份完整可读的文件。
 *   - 单写者（战役内核一个实例），所以不需要 CAS / 锁。
 *
 * 与 DSH 无关：本模块只用 node:fs，可以被独立应用原样搬走。
 */
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { recoverRunning } from './graph.js'

const NODES = 'nodes.jsonl'
const EDGES = 'edges.jsonl'

export async function openStore(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

function parseLines(text) {
  const out = []
  let bad = 0
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // 崩溃可能留下半行；一条坏行不该拖垮整张图。
      bad += 1
    }
  }
  return { rows: out, bad }
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

export async function appendNode(dir, node) {
  if (node === undefined || node === null) throw new Error('appendNode: node required')
  await openStore(dir)
  await writeFile(join(dir, NODES), JSON.stringify(node) + '\n', { flag: 'a', encoding: 'utf8' })
  return node
}

export async function appendNodes(dir, nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  if (list.length === 0) return 0
  await openStore(dir)
  const payload = list.map((n) => JSON.stringify(n)).join('\n') + '\n'
  await writeFile(join(dir, NODES), payload, { flag: 'a', encoding: 'utf8' })
  return list.length
}

export async function appendEdge(dir, edge) {
  if (edge === undefined || edge === null) throw new Error('appendEdge: edge required')
  await openStore(dir)
  await writeFile(join(dir, EDGES), JSON.stringify(edge) + '\n', { flag: 'a', encoding: 'utf8' })
  return edge
}

/** 读原始行（含坏行计数），调用方据此把"图损坏"当成可观测事实而不是静默吞掉。 */
export async function readRaw(dir) {
  const nodesText = await readOptional(join(dir, NODES))
  const edgesText = await readOptional(join(dir, EDGES))
  const nodes = parseLines(nodesText)
  const edges = parseLines(edgesText)
  return {
    nodes: nodes.rows,
    edges: edges.rows,
    badLines: nodes.bad + edges.bad,
    nodeLines: nodes.rows.length,
    edgeLines: edges.rows.length,
  }
}

export async function load(dir) {
  const raw = await readRaw(dir)
  return { nodes: raw.nodes, edges: raw.edges, badLines: raw.badLines }
}

/**
 * 读图并把崩溃残留的 running/claimed 意图回卷成 pending。
 *
 * 回卷必须落盘（否则每次读都会重放一次"释放"日志，看起来像无限重试）；
 * 落盘用临时文件 + rename，保证任何时刻都有一份完整文件。
 */
export async function loadWithRecovery(dir) {
  const raw = await readRaw(dir)
  const rec = recoverRunning(raw.nodes)
  const released = rec.released
  if (released.length === 0) {
    return { nodes: raw.nodes, edges: raw.edges, badLines: raw.badLines, released }
  }
  await persistNodes(dir, rec.nodes)
  return { nodes: rec.nodes, edges: raw.edges, badLines: raw.badLines, released }
}

export async function persistNodes(dir, nodes) {
  await openStore(dir)
  const target = join(dir, NODES)
  const tmp = target + '.tmp'
  const payload = (Array.isArray(nodes) ? nodes : []).map((n) => JSON.stringify(n)).join('\n')
  await writeFile(tmp, payload === '' ? '' : payload + '\n', 'utf8')
  await rename(tmp, target)
  return nodes.length
}

/**
 * 压实：把追加日志重写成「每个 id 只保留最后一条」。
 *
 * 状态变更也是追加一条同 id 的节点，所以折叠时**后写覆盖先写**。
 * 这一条是整个读侧正确性的关键：图是事件日志，不是节点表。
 */
export async function compact(dir) {
  const raw = await readRaw(dir)
  const byId = new Map()
  for (const node of raw.nodes) {
    const id = String(node?.id ?? '')
    if (id === '') continue
    byId.set(id, node)
  }
  const nodes = [...byId.values()]
  await persistNodes(dir, nodes)
  // 边同样去重：from|rel|to 三元的最后一条为准。
  const edgeKey = (e) => String(e?.from) + '|' + String(e?.rel) + '|' + String(e?.to)
  const edgeMap = new Map()
  for (const edge of raw.edges) {
    if (edge === undefined || edge === null) continue
    edgeMap.set(edgeKey(edge), edge)
  }
  const edges = [...edgeMap.values()]
  const edgesTarget = join(dir, EDGES)
  const edgesTmp = edgesTarget + '.tmp'
  const edgesPayload = edges.map((e) => JSON.stringify(e)).join('\n')
  await writeFile(edgesTmp, edgesPayload === '' ? '' : edgesPayload + '\n', 'utf8')
  await rename(edgesTmp, edgesTarget)
  return {
    nodes: nodes.length,
    edges: edges.length,
    folded: raw.nodeLines - nodes.length,
    badLines: raw.badLines,
  }
}

/** 折叠后的内存图：后写覆盖先写，等价于 compact 但不落盘。 */
export async function fold(dir) {
  const raw = await readRaw(dir)
  const byId = new Map()
  for (const node of raw.nodes) {
    const id = String(node?.id ?? '')
    if (id === '') continue
    byId.set(id, node)
  }
  return { nodes: [...byId.values()], edges: raw.edges, badLines: raw.badLines }
}

export async function sizeOf(dir) {
  let bytes = 0
  for (const name of [NODES, EDGES]) {
    try {
      const info = await stat(join(dir, name))
      bytes += info.size
    } catch {
      /* 文件还不存在 */
    }
  }
  return bytes
}
