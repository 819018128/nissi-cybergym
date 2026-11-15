/**
 * war-kb-first — 派兵之前，先问一眼自己攒下来的东西。
 * ─────────────────────────────────────────────────────────────────────────
 * 这一行存在的理由只有一句：**「先查经验库」不能是一句提示词。**
 *
 * 实测依据：宪章判据 s4（加载 personal-kb 的作战会话占比）长期停在
 * **40%（46/116）**，目标是 ≥80%。也就是说，六成的仗是在**不看战法库**的情况下打的 ——
 * 而经验库里已有 92 张卡。这不是能力问题：`skill` 工具一直在目录里，
 * 只写了一句「建议先查」。**建议只能改变概率，闸门才能改变必然。**
 *
 * 它拦什么
 * ─────────────────────────────────────────────────────────────────────────
 * 主帅（顶级会话）在本会话里**第一次派兵**（`subagent` / `subagent_fork`）之前，
 * 若还没查过战法库，这一次派兵被**拒一次**，并附上"怎么解除"的原话。
 *
 * ══ 为什么是「拒一次」而不是「一直拒」══
 *
 * 一直拒会造出一个死锁风险：万一 `skill` 工具在某次挂了、或这一仗真的没有可查的东西，
 * 军团就会彻底不动。而**拒一次的代价是一个回合**，收益是主帅必须正视这件事。
 * 于是设计成：
 *
 *   第一次派兵 → 拒绝 + 说清怎么做（或说清"确实无需查库"时怎么继续）
 *   紧接着再派一次 → **放行**，但记一次 `bypassed`
 *
 * 这不是漏洞，是**明确标价的绕行**：绕行必须发生在一个有意识的重试动作上，
 * 并且被计数、被写进 status 文件、可以被复盘读到。相比之下「提示词里写一句建议」
 * 连"你有没有绕"都不知道。
 *
 * 三条不变量（改动本文件前先读）
 * ─────────────────────────────────────────────────────────────────────────
 *   1. **判不出角色时放行**。`origin === 'subagent'` 的是工人会话，它们派不了兵；
 *      读不到角色（没有 header）就当主帅 —— 但这一条只在 `refuseOnce` 生效的前提下，
 *      代价最多一个回合，不会瘫痪军团。**两个错误不对称。**
 *   2. **失败不抛**。记录/写入失败被吞掉：观测者不能成为被观测系统的故障源。
 *   3. **有 kill switch**。`WAR_KB_FIRST=0` 或配置 `enabled: false` ⇒ 完全放行。
 *
 * 「查过库」怎么算（可复核，不含糊）
 * ─────────────────────────────────────────────────────────────────────────
 * 在本会话里出现过下列任一调用即算：
 *   · `skill` 且 `name` 含 `personal-kb`；
 *   · `read` / `grep` / `glob` 且路径里出现 `经验库` 或 `personal-kb`。
 * 只认这几种 —— 不拿"参数里出现过这些字"滥算，否则任何一次 `board_intel_get`
 * 都能把闸门骗过去，那就又变成装饰了。
 */

import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'war-kb-first'

/** 只声明 `tools`：守卫要注册，这是唯一的硬依赖。 */
export const inject = ['tools']

/** 触发闸门的工具名。派兵的两种形态（普通 / 分支继承）。 */
const GATED_TOOLS = new Set(['subagent', 'subagent_fork'])

/** 算作"查过战法库"的工具名与其参数里要比对的字段。 */
const KB_TOOLS = new Set(['skill', 'read', 'grep', 'glob'])

const KB_NEEDLES = ['personal-kb', '经验库']

/** 参数里这些字段算"路径/名字"；不扫整段 JSON，避免误判。 */
const ARG_FIELDS = ['name', 'path', 'pattern', 'file_path', 'dir', 'query']

function argsMentionKb(args) {
  if (!args || typeof args !== 'object') return false
  for (const field of ARG_FIELDS) {
    const v = args[field]
    if (typeof v !== 'string' || v === '') continue
    for (const needle of KB_NEEDLES) if (v.includes(needle)) return true
  }
  return false
}

/** 角色判定与 no-hands 同源：worker = `origin === 'subagent'`；读不到就当主帅。 */
function roleOf(agent) {
  const origin = agent?.session?.header?.origin
  if (origin === 'subagent') return 'worker'
  return 'lead'
}

const agentIdOf = (agent) => {
  const id = agent?.id
  return typeof id === 'string' && id !== '' ? id : null
}

export function apply(ctx, config) {
  const configuredRoot = typeof config?.root === 'string' && config.root !== '' ? config.root : null
  const root = () => configuredRoot ?? path.join(os.homedir(), '.war')
  const enabled = (config?.enabled ?? true) !== false && process.env.WAR_KB_FIRST !== '0'
  const statusFile = () => path.join(root(), '_kb-first', 'status.json')

  /** agent id → { kbSeen, refusedOnce, bypassed } */
  const state = new Map()
  const st = () => ({
    enabled,
    leads: 0,
    workers_seen: 0,
    dispatches: 0,
    refused_once: 0,
    kb_seen: 0,
    bypassed: 0,
    kb_seen_agents: [],
    last: null,
    last_refusal_at: null,
    updated_at: null,
    kb_rule: 'skill(personal-kb) 或 read/grep/glob 的路径含 经验库',
    tool_names: [...GATED_TOOLS],
  })
  const counters = st()

  /**
   * 写状态：**同步写 + 失败不抛**（不变量 2）。
   *
   * 一开始这里是异步排队写，结果踩了一个很典型的坑：守卫是**同步**返回理由的，
   * 而"拒了没拒、放行没放行"是**立刻**要知道的事；异步一排队，读 status 的人
   * （人、判据、测试）就会读到上一拍的快照 —— 于是"记了一次绕行"这件事
   * 在文件里看起来没发生。**观测值必须与动作同一拍落地**，这里不值得为几百字节开异步。
   */
  function persist() {
    if (!enabled) return
    try {
      counters.updated_at = new Date().toISOString()
      const file = statusFile()
      fsSync.mkdirSync(path.dirname(file), { recursive: true })
      fsSync.writeFileSync(file, JSON.stringify(counters, null, 2), 'utf8')
    } catch { /* 观测者不制造故障 */ }
  }

  function slot(agentId) {
    if (!state.has(agentId)) {
      state.set(agentId, { kbSeen: false, refusedOnce: false, bypassCounted: false, bypasses: 0 })
    }
    return state.get(agentId)
  }

  ctx.tools.guard((exec) => {
    if (!enabled) return undefined
    const toolName = exec?.name
    if (typeof toolName !== 'string' || toolName === '') return undefined

    const agent = exec?.agent
    const agentId = agentIdOf(agent)
    const role = roleOf(agent)

    /* ── 先记"查过库"：守卫能看到每一次调用，包括 skill 自己 ────────── */
    if (KB_TOOLS.has(toolName) && argsMentionKb(exec?.arguments)) {
      if (agentId !== null) {
        const s = slot(agentId)
        if (!s.kbSeen) {
          s.kbSeen = true
          counters.kb_seen += 1
          if (!counters.kb_seen_agents.includes(agentId)) counters.kb_seen_agents.push(agentId)
          counters.last = { at: new Date().toISOString(), kind: 'kb_seen', agent: agentId, tool: toolName }
          persist()
        }
      }
      return undefined /* 查库本身永远放行 */
    }

    if (!GATED_TOOLS.has(toolName)) return undefined

    /* ── 派兵：只对主帅设闸；工人与未知角色放行（不变量 1）────────── */
    if (role === 'worker') {
      counters.workers_seen += 1
      persist()
      return undefined
    }
    if (agentId === null) return undefined /* 认不出是谁 ⇒ 不动手 */

    const s = slot(agentId)
    counters.leads += 1
    counters.dispatches += 1
    counters.last = {
      at: new Date().toISOString(), kind: 'dispatch', agent: agentId, tool: toolName, kb_seen: s.kbSeen,
    }

    if (s.kbSeen) { persist(); return undefined }

    if (!s.refusedOnce) {
      s.refusedOnce = true
      counters.refused_once += 1
      counters.last_refusal_at = new Date().toISOString()
      persist()
      return (
        'REFUSED（kb-first）：这一仗还没查过战法库就要派兵 —— 先花一步问问自己攒下来的东西。\n'
        + '\n'
        + '  · 查库：skill(name="personal-kb")，或直接 read/grep 经验库里的卡\n'
        + '  · 查完再派兵就不会再被拦\n'
        + '  · 确实无可查（首次打这类目标 / 库里没有对应面）⇒ **紧接着再派一次就放行**，\n'
        + '    那一次会被记成 bypassed，复盘时看得见\n'
        + '\n'
        + '为什么是硬的：s4 实测 40%（46/116）—— 六成的仗是在不看 92 张战法卡的情况下打的。\n'
        + '「建议先查」改变的是概率，这一道闸改变的是必然。'
      )
    }

    /* ── 绕行：**每个主帅只记一次** ────────────────────────────────
     *
     * 第一版这里是 `bypassed += 1` 无条件累加，测出来 3 次派兵记了 2 次绕行 ——
     * 那个数字就变成了"派了几次兵"，而不是"有几个主帅在没查库的情况下硬上"。
     * 一个读不懂的计数器比没有计数器更坏：它会让人以为自己看懂了。
     * 现在语义写死：bypassed = **有多少个主帅绕了这道闸**，每 agent 至多 1。 */
    if (!s.bypassCounted) {
      s.bypassCounted = true
      counters.bypassed += 1
      counters.last = { at: new Date().toISOString(), kind: 'bypassed', agent: agentId, tool: toolName }
    }
    persist()
    return undefined
  })

  /* 首次落盘：让"闸门装上了"这件事在任何一次派兵之前就可读。 */
  persist()
}
