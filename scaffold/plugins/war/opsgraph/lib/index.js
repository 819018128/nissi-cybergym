/**
 * war-opsgraph —— 战役内核在宿主侧的接线。
 *
 * 这一层只做三件事：
 *   ① 把 campaign.js 的动作暴露成模型可调的工具；
 *   ② 按角色分流（主帅派意图、分队领活交活），用**代码拒绝**而不是提示词约束；
 *   ③ 挂心跳：真有待办时把空闲的主帅叫醒（对应 ARTEX plannerLoop 的 heartbeat）。
 *
 * 设计纪律：
 *   - 记忆在图里（<WAR_ROOT>/_graph），不在会话里。主帅可以丢历史，图还在。
 *   - 读盘不跑崩溃恢复；恢复只在进程启动跑一次（踩过：每次读都恢复会把在跑的领用抹掉）。
 *   - 唤醒通道用 jobs 完成通知（已验证可行）。拿不到 jobs 就只降级为无唤醒，工具照常。
 *   - 允许「没活」：claim 返回 no-ready、overview 的可派为 0，都是正常结果。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  overview,
  addIntent,
  claimNext,
  finishIntent,
  reopenIntent,
  addFact,
  loadGraph,
  hasWork,
  recoverOnBoot,
} from './campaign.js'
import { checkBudget, budgetLine, budgetRefusal } from './budget.js'

export const name = 'war-opsgraph'
export const inject = ['tools']

/** 启动恢复每个进程只跑一次：它是「上一次进程的残渣」，不是每次读都要做的事。 */
const bootOnce = new Map()

function idsOf(raw) {
  return String(raw ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function linesOf(raw) {
  return String(raw ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function isWorker(exec) {
  try {
    return String(exec?.agent?.session?.header?.origin ?? '') === 'subagent'
  } catch {
    return false
  }
}

export function apply(ctx, config) {
  const cfg = config ?? {}
  const root = typeof cfg.root === 'string' && cfg.root ? cfg.root : process.env.WAR_ROOT || '<HOME>/.war'
  const graphDir = typeof cfg.graphDir === 'string' && cfg.graphDir ? cfg.graphDir : path.join(root, '_graph')
  const kernelLog = path.join(graphDir, 'kernel.jsonl')

  const heartbeatMs = typeof cfg.heartbeatMs === 'number' && cfg.heartbeatMs > 0 ? cfg.heartbeatMs : 45000
  const minWakeGapMs = typeof cfg.minWakeGapMs === 'number' && cfg.minWakeGapMs > 0 ? cfg.minWakeGapMs : 90000
  const maxWakes = typeof cfg.maxWakes === 'number' && cfg.maxWakes > 0 ? cfg.maxWakes : 40
  const wakeEnabled = cfg.wake !== false
  // 预算上限：无人值守的第三道刹车。0/缺省回落到 budget.js 里的默认值。
  const budgetLimits = {
    maxIntents: typeof cfg.maxIntents === 'number' ? cfg.maxIntents : undefined,
    maxWallMs: typeof cfg.maxWallMs === 'number' ? cfg.maxWallMs : undefined,
  }

  let logBroken = false
  async function log(entry) {
    if (logBroken) return
    try {
      await fs.mkdir(graphDir, { recursive: true })
      await fs.appendFile(kernelLog, JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      logBroken = true
    }
  }

  // 一次性的启动恢复。
  if (!bootOnce.has(graphDir)) {
    bootOnce.set(graphDir, true)
    void recoverOnBoot(graphDir)
      .then((r) => {
        if (r.released.length > 0) {
          void log({ at: new Date().toISOString(), kind: 'boot-recovered', released: r.released })
        }
      })
      .catch((error) => {
        void log({ at: new Date().toISOString(), kind: 'boot-recover-failed', error: String(error?.message ?? error) })
      })
  }

  void log({
    at: new Date().toISOString(),
    kind: 'startup',
    graphDir,
    wakeEnabled,
    heartbeatMs,
    minWakeGapMs,
    maxWakes,
    hasJobs: ctx.get('jobs') !== undefined,
  })

  /* ── 工具：图态势（两端都要）──────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'graph_overview',
      description:
        'Read the battle graph: how many goals/intents/facts/findings, which intents are ready to dispatch, ' +
        'and which authorized assets have never been tested. This is the ONLY state the planner should trust — ' +
        'the conversation history is not the memory. Returns compact text meant to be read every round.',
      parameters: {
        assets: {
          type: 'string',
          description: 'Optional: comma or newline separated authorized asset ids, to compute coverage.',
        },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        try {
          const result = await overview(graphDir, idsOf(args?.assets))
          const head = []
          if (result.released.length > 0) head.push('（本轮释放了上次进程残留的领用: ' + result.released.join(',') + '）')
          if (result.badLines > 0) head.push('（图里有 ' + result.badLines + ' 行损坏已跳过）')
          // 预算要出现在态势里：主帅每一轮都应该看见"还剩多少额度"，而不是撞墙才知道。
          const graphNow = await loadGraph(graphDir)
          return [...head, result.text, budgetLine(checkBudget(graphNow.nodes, budgetLimits))].join('\n')
        } catch (error) {
          return 'ERROR: graph_overview failed — ' + String(error?.message ?? error)
        }
      },
    }),
  )

  /* ── 工具：planner 侧（派意图 / 重开 / 记事实）────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'intent_add',
      description:
        'PLANNER ONLY. Dispatch ONE intent into the frontier. Most rounds should dispatch zero — that is a ' +
        'correct outcome, not a failure. Use needs to record prerequisites (a fact id, or an intent id that must ' +
        'reach done); the dependency is enforced, so a dependent intent cannot be claimed early. ' +
        'anchors bind the intent to authorized asset ids so coverage can be computed later.',
      parameters: {
        title: { type: 'string', required: true, description: 'One line: what this intent tests or proves.' },
        detail: { type: 'string', description: 'How to do it, enough for a worker that has no other context.' },
        priority: { type: 'number', description: 'Higher dispatches first. Default 0.' },
        needs: { type: 'string', description: 'Comma/newline separated node ids that must be ready first.' },
        anchors: { type: 'string', description: 'Comma/newline separated authorized asset ids.' },
        vulnclass: { type: 'string', description: 'Optional vulnerability class label.' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args, exec) {
        if (isWorker(exec)) return 'REFUSED: only the planner may dispatch intents. Finish your current intent instead.'
        try {
          // 预算到点就拒绝派活：继续派是无人值守下最容易失控的一件事。
          const before = await loadGraph(graphDir)
          const budget = checkBudget(before.nodes, budgetLimits)
          if (budget.exceeded) {
            void log({ at: new Date().toISOString(), kind: 'budget-refused', reasons: budget.reasons, stats: budget.stats })
            return budgetRefusal(budget)
          }
          const node = await addIntent(graphDir, {
            title: args?.title,
            detail: args?.detail,
            priority: args?.priority,
            needs: idsOf(args?.needs),
            anchors: idsOf(args?.anchors),
            vulnclass: args?.vulnclass,
          })
          return 'dispatched ' + node.id + ' [' + node.payload.title + ']' + (node.needs.length > 0 ? ' needs=' + node.needs.join(',') : '')
        } catch (error) {
          return 'ERROR: intent_add failed — ' + String(error?.message ?? error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'intent_reopen',
      description:
        'PLANNER ONLY. Reopen a finished intent (done/exhausted/blocked) back to pending — new facts arrived, ' +
        'the judgement was wrong, or the exhausted direction deserves another angle. Coverage history is kept.',
      parameters: {
        intent: { type: 'string', required: true, description: 'Intent id, e.g. i3.' },
        reason: { type: 'string', description: 'Why it is being reopened. Recorded for audit.' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args, exec) {
        if (isWorker(exec)) return 'REFUSED: only the planner may reopen intents.'
        const r = await reopenIntent(graphDir, String(args?.intent ?? ''), args?.reason)
        return r.ok ? 'reopened ' + String(args?.intent) : 'ERROR: ' + String(r.error)
      },
    }),
  )

  /* ── 工具：worker 侧（领活 / 交活）────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'intent_claim',
      description:
        'WORKER ONLY. Claim exactly one ready intent and start running it. Returns the intent body, or a clear ' +
        '"no-ready" line — having nothing to claim is normal (the frontier may be empty), so do not treat it as an error. ' +
        'Claims are live: a crash reverts them at the next boot.',
      parameters: {
        worker: { type: 'string', description: 'Optional label for who claims it.' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        try {
          const who = String(args?.worker ?? 'worker')
          const r = await claimNext(graphDir, who)
          if (r.intent === null) return 'no-ready (' + r.reason + '): nothing claimable right now.'
          const i = r.intent
          return [
            'claimed ' + i.id + ' [' + i.payload.title + ']',
            i.payload.detail ? 'detail: ' + i.payload.detail : '',
            i.anchors.length > 0 ? 'anchors: ' + i.anchors.join(',') : '',
            i.needs.length > 0 ? 'needs: ' + i.needs.join(',') : '',
          ]
            .filter((s) => s !== '')
            .join('\n')
        } catch (error) {
          return 'ERROR: intent_claim failed — ' + String(error?.message ?? error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'intent_finish',
      description:
        'WORKER ONLY. Write back and stop. state: done (got something), exhausted (tried, nothing found — NOT a ' +
        'failure, reopenable), blocked (needs authorization or a prerequisite). facts are newline separated, one ' +
        'observation each; findings are newline separated "title|severity". Facts unlock dependent intents.',
      parameters: {
        intent: { type: 'string', required: true, description: 'Intent id you claimed.' },
        state: { type: 'string', required: true, description: 'done | exhausted | blocked' },
        facts: { type: 'string', description: 'Newline separated facts to write back.' },
        findings: { type: 'string', description: 'Newline separated "title|severity".' },
        note: { type: 'string', description: 'One line about how it went.' },
        worker: { type: 'string', description: 'Optional label.' },
        anchors: { type: 'string', description: 'Optional asset ids this work touched.' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        try {
          const findings = linesOf(args?.findings).map((line) => {
            const parts = line.split('|')
            return { title: (parts[0] ?? '').trim(), severity: (parts[1] ?? '').trim() }
          })
          const r = await finishIntent(graphDir, String(args?.intent ?? ''), {
            state: args?.state,
            facts: linesOf(args?.facts),
            findings,
            note: args?.note,
            who: args?.worker,
            anchors: idsOf(args?.anchors),
          })
          if (r.ok !== true) return 'ERROR: ' + String(r.error)
          return (
            'finished ' + String(args?.intent) + ' as ' + r.state +
            (r.facts.length > 0 ? '; facts=' + r.facts.join(',') : '') +
            (r.findings.length > 0 ? '; findings=' + r.findings.join(',') : '')
          )
        } catch (error) {
          return 'ERROR: intent_finish failed — ' + String(error?.message ?? error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'fact_add',
      description: 'Record one fact without finishing an intent (also usable by the planner when it reads something itself).',
      parameters: {
        text: { type: 'string', required: true, description: 'One observation.' },
        anchors: { type: 'string', description: 'Optional asset ids.' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        try {
          const node = await addFact(graphDir, { text: args?.text, anchors: idsOf(args?.anchors) })
          return 'fact ' + node.id + ' recorded'
        } catch (error) {
          return 'ERROR: fact_add failed — ' + String(error?.message ?? error)
        }
      },
    }),
  )

  /* ── 心跳：真有待办时把空闲的主帅叫醒 ─────────────────────────────────── */

  const jobs = ctx.get('jobs')
  if (!wakeEnabled || jobs === undefined) {
    void log({ at: new Date().toISOString(), kind: 'wake-disabled', reason: wakeEnabled ? 'no jobs service' : 'config' })
    return
  }

  let leadAgent = null
  let arm = null // { resolve, jobId, armedAt }
  let lastWakeAt = 0
  let wakeCount = 0
  let capped = false

  function disarm(status, detail) {
    if (arm === null) return
    const pending = arm
    arm = null
    try {
      pending.resolve({ status, detail })
    } catch {
      /* 已经结掉就算了 */
    }
  }

  function armChannel() {
    if (leadAgent === null || arm !== null || capped) return
    let resolveDone = null
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })
    try {
      const jobId = String(
        jobs.start({
          kind: 'wartest',
          label: 'opsgraph heartbeat: waiting for dispatchable work',
          owner: leadAgent,
          run: () => ({
            cancel: () => disarm('killed', 'cancelled'),
            done,
          }),
        }),
      )
      arm = { resolve: resolveDone, jobId, armedAt: Date.now() }
      void log({ at: new Date().toISOString(), kind: 'wake-armed', jobId })
    } catch (error) {
      void log({ at: new Date().toISOString(), kind: 'wake-arm-failed', error: String(error?.message ?? error) })
    }
  }

  /* 定时器：用宿主全局的 setInterval，**不要**用 `ctx.setInterval`。
     2026-11-12 实测：`ctx.setInterval` 要求插件声明 `inject: ['timer']`，缺了它会让
     **整个预设挂载失败**（`cannot get property "timer" without inject`），表现是
     「战争模式选不了」——点击被静默拒，会话仍是原预设。预设插件跑在 Node 里，
     全局定时器可用；用 ctx.effect 注册清理，recompose 卸载时不会泄漏。 */
  const startHeartbeat = (fn, ms) => {
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => {
          const handle = setInterval(fn, ms)
          return () => clearInterval(handle)
        })
        return
      }
    } catch {
      /* effect 不可用就退到裸定时器：泄漏一个 interval 好过挂载失败 */
    }
    setInterval(fn, ms)
  }

  let ticking = false
  startHeartbeat(() => {
    if (ticking) return
    ticking = true
    void (async () => {
      try {
        if (leadAgent === null) return
        const graph = await loadGraph(graphDir)
        const work = hasWork(graph.nodes)
        if (!work.busy) {
          armChannel()
          return
        }
        if (arm === null) {
          armChannel()
          return
        }
        if (wakeCount >= maxWakes) {
          if (!capped) {
            capped = true
            void log({ at: new Date().toISOString(), kind: 'wake-capped', wakeCount, maxWakes })
            disarm('failed', 'wake cap reached')
          }
          return
        }
        const now = Date.now()
        if (now - lastWakeAt < minWakeGapMs) return
        const sinceArmed = now - (arm.armedAt ?? now)
        if (sinceArmed < minWakeGapMs) return
        lastWakeAt = now
        wakeCount += 1
        void log({
          at: new Date().toISOString(),
          kind: 'wake-fired',
          wakeCount,
          ready: work.ready,
          running: work.running,
          sinceArmedMs: sinceArmed,
        })
        disarm('completed', 'dispatchable work: ready=' + String(work.ready) + ' running=' + String(work.running))
        setTimeout(() => armChannel(), 50)
      } catch (error) {
        void log({ at: new Date().toISOString(), kind: 'heartbeat-error', error: String(error?.message ?? error) })
      } finally {
        ticking = false
      }
    })()
  }, heartbeatMs)

  // 拿到主帅 agent 的唯一可靠时机：它第一次进回合时。
  ctx.on('agent/pre-step', (payload, next) => {
    try {
      if (!isWorker({ agent: payload?.agent }) && leadAgent === null && payload?.agent !== undefined) {
        leadAgent = payload.agent
        void log({ at: new Date().toISOString(), kind: 'lead-bound', agent: String(payload?.agent?.id ?? '') })
        armChannel()
      }
    } catch {
      /* 心跳绑不上不该影响主流程 */
    }
    return next()
  })
}
