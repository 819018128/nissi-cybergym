/**
 * war-notice-broker - notice shaper for war mode (shadow mode by default)
 *
 * WHY (measured baseline, 2026-11-11, 434 turns across 3 lead sessions):
 *   - 72.1% of turns were NOT started by the human
 *       subagent reports 51.2% | map reconcile 15.2% | hive patrol 3.5%
 *   - longest turn 881.7 min; 4 turns over 20 min; 13 turns over 12 steps
 *   - effective turns (>=1 tool call) 82.0%
 *
 * ARTEX reference (source evidence):
 *   - server/manager.go:1751-1756  Notify channel cap 1 + select default (drop)
 *   - server/engine.go:809-819     800ms debounce
 *   - server/manager.go:1762-1778 + planner.go:173-215  batch drain into one prompt
 *   - planner.go:303-305           ZERO intents is a legal outcome
 *
 * HOW IT HOOKS
 *   Host event `agent/pre-step` (waterfall). Contract in
 *   dsh-agent-loop/lib/index.js:492-514, 538-546:
 *     - return { kind:'enter', messages:[...] }  -> replace messages for this step
 *     - return { kind:'reject' }                 -> turn ends as blocked
 *     - at step===0 return { kind:'enter', messages:[] }
 *                                                -> turn ends as completed,
 *                                                   ZERO model calls (index.js:543-546)
 *
 * THREE TIERS, ALL OFF BY DEFAULT
 *   observe (default)  enable:false        judge + log only, ZERO behaviour change
 *   merge              enable:true         merge multiple notices in one batch
 *   drop               +drop:true          an all-noise batch ends the turn unopened
 *   step budget        stepBudget:12       phase 2 shadow: log when step 12 is reached
 *
 * SAFETY BOUNDARIES (enforced in code, not by convention)
 *   - never throws: any failure returns the host's own decision (base)
 *   - never drops a batch containing source.kind === 'user'
 *   - merge MUST preserve the runtime-context message the host appends
 *     (see buildMergedMessages - rebuilding from payload.messages silently loses it)
 *
 * ENCODING WARNING: this file contains CJK literals (the notice prefixes) that must
 * match the producers byte-for-byte. It was once destroyed by a PowerShell
 * Get-Content -Raw / Set-Content -Encoding UTF8 round-trip. Edit it with a UTF-8
 * safe writer only. Escaped \uXXXX forms are used so the prefixes survive even a
 * lossy editor.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const name = 'war-notice-broker'

/** Notice prefixes. Escaped so no lossy round-trip can corrupt them. */
export const PATROL_PREFIX = '[\u8702\u7fa4\u5de1\u68c0]'
export const RECONCILE_PREFIX = '[\u5730\u56fe\u5bf9\u8d26'
export const SUBAGENT_PREFIX = 'Background subagent '
export const CONTEXT_PREFIX = 'Current runtime context'
/** Command anchor in map-reconcile notices: U+27E6 / U+27E7 around op:N. */
const OP_ANCHOR = /\u27E6op:\d+\u27E7/
/** Board card ids. */
const CARD_ID = /\b(?:obj|find|chain)-[a-z0-9]+/i

/** First text block of a message, or '' (never throws). */
export function textOf(message) {
  try {
    for (const block of message?.content ?? []) {
      if (block && block.type === 'text' && typeof block.text === 'string') return block.text
    }
  } catch {
    /* unreadable content -> empty */
  }
  return ''
}

/**
 * Classify one message.
 * @returns {'user'|'patrol'|'reconcile'|'subagent-report'|'runtime-context'|'plugin'|'other'}
 */
export function classify(message) {
  const text = textOf(message)
  const kind = String(message?.source?.kind ?? '')
  if (kind === 'user') return 'user'
  if (text.startsWith(PATROL_PREFIX)) return 'patrol'
  if (text.startsWith(RECONCILE_PREFIX)) return 'reconcile'
  if (text.startsWith(SUBAGENT_PREFIX)) return 'subagent-report'
  if (text.startsWith(CONTEXT_PREFIX)) return 'runtime-context'
  if (kind === 'plugin') return 'plugin'
  return 'other'
}

/** Notice kinds eligible for merging / dropping. */
export function isNoticeKind(kind) {
  return kind === 'patrol' || kind === 'reconcile' || kind === 'subagent-report'
}

/**
 * Does this notice say anything new?
 * RULE: a patrol/reconcile notice counts as substantive only when it names a concrete
 * entity (an op anchor or a card id). Subagent reports are always substantive.
 */
export function hasSubstance(kind, message) {
  if (kind === 'patrol' || kind === 'reconcile') {
    const text = textOf(message)
    return OP_ANCHOR.test(text) || CARD_ID.test(text)
  }
  return true
}

/**
 * Pure decision: what should happen to this batch?
 *
 * 第二参数是 `opening`（「这是本回合的第一个通知批次」），**不是步号**。
 * 与 `shouldDeferRound()` 同一个病、同一个改法：实测 73 条批次记录里没有一条落在 step 0
 * （53 条在 step 1），所以 `step === 0` 让 drop 档在生产里永不可达，而单测全绿只因为夹具
 * 自己构造了 step 0 —— 与合并闸门一模一样的假绿（第五次命中）。
 * `opening === true` 严格判定：缺失 / 非布尔 / 假值一律不放行丢弃。
 * 续包属于一个已经在付钱的回合，丢它省不到任何东西，只会把正在进行的工作掐掉。
 */
export function decide(messages, opening) {
  const kinds = messages.map(classify)
  let userCount = 0
  const noticeIndexes = []
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === 'user') userCount++
    if (isNoticeKind(kinds[i])) noticeIndexes.push(i)
  }
  const substanceFree = noticeIndexes.filter((i) => !hasSubstance(kinds[i], messages[i]))
  const allNoticesAreNoise = noticeIndexes.length > 0 && substanceFree.length === noticeIndexes.length

  return {
    kinds,
    userCount,
    noticeCount: noticeIndexes.length,
    substanceFreeCount: substanceFree.length,
    canMerge: noticeIndexes.length > 1,
    canDrop: opening === true && userCount === 0 && allNoticesAreNoise,
  }
}

/**
 * 影子计数器：把「判据怎么说」与「开关有没有开」拆成两组字段。
 *
 * 为什么开关**不能**乘进影子计数（实测，不是推理）：
 * 旧写法是 `wouldDrop: allowDrop && d.canDrop ? messages.length : 0`。
 * `allowDrop` 是执行开关，而它在 36/36 次挂载里都是 false（`enforce=false` 的影子期），
 * 于是 `wouldDrop` **结构上恒为 0** —— 76/76 条批次记录里 `wouldDrop > 0` 的批次是 **0 条**。
 * 这等于让计数器自己乘掉了它要观测的那个量：普查只能读到「一条都没丢」，永远读不到
 * 「闸门本来会丢几条」。判据写错了也照样是 0，drop 档的决策干脆不可观测 —— 这与
 * `stepNo === 0` 是同一个病：判据在生产里恒假，而单测全绿只因为夹具自己构造了让它成立的值。
 *
 * 所以：`wouldMerge` / `wouldDrop` **只**回答判据怎么说（永远照实记录），
 * `mergeEnabled` / `dropEnabled` 单独记录开关状态。两者相乘才是「是否真的执行」。
 * 这样下一次普查能分清「闸门本来会拦」与「闸门被关掉了」——这两件事的结论完全相反。
 *
 * @param {{canMerge:boolean, canDrop:boolean, noticeCount:number}} d decide() 的返回值
 * @param {number} batchSize messages.length
 * @param {{allowMerge:boolean, allowDrop:boolean}} switches 执行开关
 * @returns {{wouldMerge:number, wouldDrop:number, mergeEnabled:boolean, dropEnabled:boolean}}
 */
export function shadowCounts(d, batchSize, switches) {
  const noticeCount = typeof d?.noticeCount === 'number' ? d.noticeCount : 0
  const size = typeof batchSize === 'number' && batchSize > 0 ? batchSize : 0
  return {
    // 判据，不带开关：开关关着也要照实记，否则这个数就永远测不到判据对不对。
    wouldMerge: d?.canMerge === true ? noticeCount : 0,
    wouldDrop: d?.canDrop === true ? size : 0,
    // 开关，不带判据：只回答「执行这条路当时通不通」。
    mergeEnabled: switches?.allowMerge === true,
    dropEnabled: switches?.allowDrop === true,
  }
}

/**
 * Build the merged message list.
 *
 * Base is `baseMessages` - the host's own default decision, which appends a
 * runtime-context message at the end that is NOT present in payload.messages
 * (dsh-agent-loop index.js:505-508). Rebuilding from payload.messages silently
 * drops it; this function therefore filters by reference identity.
 *
 * @returns merged array, or null when nothing to merge
 */
export function buildMergedMessages(payloadMessages, baseMessages) {
  const noticeMessages = payloadMessages.filter((m) => isNoticeKind(classify(m)))
  if (noticeMessages.length < 2) return null
  const mergedText = noticeMessages.map((m) => textOf(m)).filter((t) => t !== '').join('\n\n----\n\n')
  if (mergedText === '') return null
  const noticeSet = new Set(noticeMessages)
  const merged = { ...noticeMessages[0], content: [{ type: 'text', text: mergedText }] }
  const out = []
  let placed = false
  for (const m of baseMessages) {
    if (noticeSet.has(m)) {
      if (!placed) {
        out.push(merged)
        placed = true
      }
      continue
    }
    out.push(m)
  }
  return placed ? out : null
}

/**
 * Settlement instruction injected when a turn reaches its step budget.
 *
 * Mirrors ARTEX's per-run wrap-up (agent/wrapup.go): persist what is already known,
 * hand unfinished work to the next turn, say one sentence, stop. It deliberately does
 * NOT cancel the turn - the model still writes its own ending step.
 */
export function wrapupText(budget) {
  return [
    '【回合预算】本轮已到第 ' + budget + ' 步。不要再展开新的探索或新的验证。',
    '',
    '立刻收口，按这个顺序：',
    '1. 把已经做完但还没落库的写下去：board_objective_record / board_finding_add /',
    '   board_campaign_close / insert_assets 之类，该写就写。',
    '2. 还没做完的不要硬塞进本轮：拆成意图卡（board_objective_add）交给下一轮或分队，',
    '   写清前提、边界和验收标准。',
    '3. 最后用一句纯文本总结：这一轮做完了什么、还剩什么、下一步建议是什么。',
    '',
    '这条是系统按步数预算发的，不是用户在打断你 —— 正常收尾即可。',
  ].join('\n')
}

/**
 * Which budget, if any, has expired for this step. Pure so it can be tested without a host.
 *
 * Steps win when both expire in the same step: the step budget is the tighter, more
 * predictable bound and its settlement text stays the plain one.
 *
 * @returns {'steps'|'time'|null}
 */
export function budgetReasonFor(stepNo, stepBudget, elapsedMs, timeBudgetMs) {
  // `>=`, not `===`: if this broker mounts mid-turn (a turn already past the budget),
  // an exact match would never fire and the turn would run unbounded. Firing at every
  // later step is harmless - the caller settles once per turn.
  if (stepNo >= stepBudget) return 'steps'
  if (timeBudgetMs > 0 && elapsedMs >= timeBudgetMs) return 'time'
  return null
}

/**
 * Should this wake-up get a model round at all? (ARTEX `plannerLoop` parity, B1 + B3.)
 *
 * ARTEX drains a burst of change signals for `debounce` (800ms) and runs ONE planning
 * round, and its loop is guarded so a settled / paused / goalless task never burns a model
 * call. DSH cannot coalesce inside the consumer: measured 0 mergeable batches in 803
 * offline batches and 34 live ones, because each notice already arrives as its own batch by
 * the time `agent/pre-step` sees it. But DSH CAN refuse to OPEN the round, which is the same
 * saving taken one step earlier.
 *
 * Eligible are only the "state changed, go look" signals (patrol, reconcile). A human
 * message or a subagent report is work product: always accepted.
 *
 * Anti-starvation: DSH has no heartbeat wake (ARTEX's `plannerLoop` does), so a held notice
 * must be released by age. Past `maxDeferMs` it is accepted even inside the coalesce window.
 *
 * `opening` 的语义是「这是本回合的第一个通知批次」，不是 `step === 0`。
 * 实测依据（真实 broker 日志 73 条批次记录）：没有任何一批到达过 step 0，全部是 step >= 1
 * （其中 53 条是 step 1）。所以任何以步号为前提的判据在生产里永远不成立，整道闸门是死代码，
 * 单测全绿只因为单测自己构造了 step 0。2026-11-13 的一次真实心跳唤醒直接给出了形状：
 * turn 92，首包落在 step 1，距唤醒 81ms。
 *
 * @param {{opening:boolean, kinds:string[], nowMs:number, lastRoundAtMs:number|null,
 *          oldestPendingAtMs:number|null, coalesceMs:number, maxDeferMs:number}} input
 * @returns {'accept'|'defer'}
 */
export function shouldDeferRound(input) {
  const opening = input?.opening === true
  const kinds = Array.isArray(input?.kinds) ? input.kinds : []
  const nowMs = typeof input?.nowMs === 'number' ? input.nowMs : 0
  const coalesceMs = typeof input?.coalesceMs === 'number' ? input.coalesceMs : 0
  const maxDeferMs = typeof input?.maxDeferMs === 'number' ? input.maxDeferMs : 0
  const lastRoundAtMs = typeof input?.lastRoundAtMs === 'number' ? input.lastRoundAtMs : null
  const oldestPendingAtMs = typeof input?.oldestPendingAtMs === 'number' ? input.oldestPendingAtMs : null

  // 只有本回合的首包才可能被推迟：续包属于一个已经付过钱的回合，推迟它省不到任何东西，
  // 只会把正在进行的工作卡住。
  if (opening !== true) return 'accept'
  if (kinds.length === 0) return 'accept'
  for (const kind of kinds) {
    if (kind !== 'patrol' && kind !== 'reconcile') return 'accept'
  }
  // Release by age before the window check, so a stale notice can never be held forever.
  if (oldestPendingAtMs !== null && maxDeferMs > 0 && nowMs - oldestPendingAtMs >= maxDeferMs) return 'accept'
  if (lastRoundAtMs === null) return 'accept'
  if (coalesceMs > 0 && nowMs - lastRoundAtMs < coalesceMs) return 'defer'
  return 'accept'
}

export function apply(ctx, config) {
  const cfg = config ?? {}
  const root = typeof cfg.root === 'string' && cfg.root ? cfg.root : (process.env.WAR_ROOT || '<HOME>/.war')
  const logDir = path.join(root, '_broker')
  const logFile = path.join(logDir, 'broker.jsonl')

  const enforce = cfg.enable === true
  const allowMerge = enforce && cfg.merge !== false
  const allowDrop = enforce && cfg.drop === true
  // Phase 2 settlement. Independent of `enable` (which governs merge/drop - those were
  // rejected by measurement: 0 mergeable batches in 803 offline + 34 live).
  const allowWrapup = cfg.wrapup === true

  // Phase 2 shadow: turn step budget.
  const stepBudget = typeof cfg.stepBudget === 'number' ? cfg.stepBudget : 12
  // ARTEX caps every run by WALL CLOCK (MaxDuration, default 1200s: server/server.go +
  // agent/taskclock.go) and settles in place when it expires. A STEP budget alone cannot
  // stop a turn that merely stalls waiting: the measured baseline had a median of 3 steps
  // yet an 881.7-minute longest turn. Same default here (20 min) so both cut in one place.
  const timeBudgetMs = typeof cfg.timeBudgetMs === 'number' && cfg.timeBudgetMs > 0 ? cfg.timeBudgetMs : 1200000
  const wrapupLogged = new Set()
  // agentId:turn -> first time this broker saw that turn. Bounded: a long-lived process
  // must not grow it without limit.
  const turnStartedAt = new Map()
  // ARTEX plannerLoop parity (B1/B3): coalesce "state changed, go look" wake-ups into the
  // next round that actually happens instead of letting each one open a turn of its own.
  // Measured on broker.jsonl: turn 2 of session 97dffd9a was opened by ONE reconcile notice
  // 23 seconds after the previous turn had already closed.
  const coalesceMs = typeof cfg.coalesceMs === 'number' && cfg.coalesceMs >= 0 ? cfg.coalesceMs : 20000
  const maxDeferMs = typeof cfg.maxDeferMs === 'number' && cfg.maxDeferMs >= 0 ? cfg.maxDeferMs : 180000
  const lastRoundAt = new Map()
  const pendingSince = new Map()
  // Held message objects, delivered with the next round that runs (ARTEX drains triggers
  // into the round that actually plans, instead of dropping them on the floor).
  const pendingNotices = new Map()
  // agentId -> 最近一次已经处理过「首包」的回合号。
  // 「这是不是本回合的第一个通知批次」只能按 agent + 回合记录，步号回答不了这个问
  // 题：实测真实 broker 日志里没有任何一批落在 step 0（73 条全部 step >= 1，其中 53
  // 条是 step 1），所以 `stepNo === 0` 让合并闸门在生产里不可达，而它的单测一直是绿的。
  // 有界：每个 agent 一条，每回合覆写，与上面的 map 同量级。
  const lastOpeningTurn = new Map()

  /** Settlement text for whichever budget expired ('steps' | 'time'). */
  function settlementText(reason, elapsedMs) {
    const raw = wrapupText(stepBudget)
    const body = Array.isArray(raw) ? raw.join('\n') : String(raw)
    if (reason !== 'time') return body
    const mins = Math.max(1, Math.round(elapsedMs / 60000))
    const cap = Math.max(1, Math.round(timeBudgetMs / 60000))
    return '（墙钟预算已用尽：本回合已跑 ' + mins + ' 分钟，上限 ' + cap + ' 分钟）\n' + body
  }

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

  // Startup proof: distinguishes "plugin never loaded" from
  // "loaded but agent/pre-step never dispatched to it".
  // Log the whole shaping configuration: a restart must be self-evidencing, otherwise
  // "is the new code live?" can only be answered by guessing (this project already lost a
  // cycle to that).
  void log({ at: new Date().toISOString(), kind: 'startup', enforce, allowMerge, allowDrop, stepBudget, timeBudgetMs, allowWrapup, coalesceMs, maxDeferMs, root })

  ctx.on('agent/pre-step', async (payload, next) => {
    // The `war` preset is mounted for the LEAD *and* for every dispatched worker
    // subagent. Only the lead's turns are worth shaping or logging: measured noise
    // was 9 workers each writing their own turn-1 step-1 record. Workers get the
    // host's own decision untouched.
    if (String(payload?.agent?.session?.header?.origin ?? '') === 'subagent') return next()
    const base = await next()
    try {
      if (base.kind !== 'enter') return base

      // Phase 2 settlement MUST run before the empty-batch early return:
      // continuation steps carry payload.messages.length === 0, which is exactly
      // where the step counter grows (measured: turn 40 step 9 had batch 0).
      const agentId = String(payload?.agent?.id ?? '')
      const turnNo = payload?.turn ?? -1
      const stepNo = payload?.step ?? -1
      // Turn clock: ARTEX bounds a run by wall clock as well as by turns.
      const turnKey = agentId + ':' + turnNo
      const seenAt = turnStartedAt.get(turnKey)
      if (seenAt === undefined) {
        turnStartedAt.set(turnKey, Date.now())
        if (turnStartedAt.size > 64) {
          const oldest = turnStartedAt.keys().next().value
          if (oldest !== undefined) turnStartedAt.delete(oldest)
        }
      }
      const elapsedMs = seenAt === undefined ? 0 : Date.now() - seenAt
      const budgetReason = budgetReasonFor(stepNo, stepBudget, elapsedMs, timeBudgetMs)
      let wrapup = null
      if (budgetReason !== null) {
        const key = agentId + ':' + turnNo
        if (!wrapupLogged.has(key)) {
          wrapupLogged.add(key)
          if (allowWrapup) {
            try {
              // Do NOT `import('@deepseek-ai/dsh-llm/message')` here: verified that it
              // does NOT resolve from this plugin directory (notice-broker ships no
              // node_modules of its own; only board2 / bridge27 do). An unresolvable
              // import would surface only at step 12 and silently turn the whole
              // settlement into a no-op - the exact failure mode this project hit twice.
              // createUserMessage adds exactly two things, role:'user' and a UUID id,
              // so build the identical shape from a node builtin instead.
              wrapup = {
                role: 'user',
                id: randomUUID(),
                content: [{ type: 'text', text: settlementText(budgetReason, elapsedMs) }],
                source: { kind: 'plugin:war-notice-broker', form: 'wrapup', summary: 'turn settlement' },
              }
              void log({ at: new Date().toISOString(), kind: 'wrapup-injected', agent: agentId, turn: turnNo, step: stepNo, budget: stepBudget, reason: budgetReason, elapsedMs: elapsedMs })
            } catch (error) {
              void log({ at: new Date().toISOString(), kind: 'wrapup-failed', agent: agentId, turn: turnNo, step: stepNo, error: String(error?.message ?? error) })
            }
          } else {
            void log({ at: new Date().toISOString(), kind: 'step-budget', agent: agentId, turn: turnNo, step: stepNo, budget: stepBudget, reason: budgetReason, elapsedMs: elapsedMs, enforce })
          }
        }
      }

      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      // Inject the settlement instruction into THIS step. Claimed messages (if any)
      // are kept so nothing is dropped; at a continuation step only the notice enters.
      if (wrapup !== null) {
        return { kind: 'enter', messages: messages.length === 0 ? [wrapup] : [...messages, wrapup] }
      }
      if (messages.length === 0) return base

      // 这一批是不是本回合的第一个通知批次？先读已记录的回合号，再记录本批的回合号。
      // 回合号缺失时一律不当作首包（落到 accept），坏 payload 不可能让闸门压住一个回合。
      const hasTurnNo = payload?.turn !== null && payload?.turn !== undefined
      const isOpeningBatch = hasTurnNo && lastOpeningTurn.get(agentId) !== turnNo
      lastOpeningTurn.set(agentId, turnNo)

      const d = decide(messages, isOpeningBatch)
      // 影子计数与开关分开记：`wouldMerge` / `wouldDrop` 只记判据（开关关着也照实记），
      // `mergeEnabled` / `dropEnabled` 只记开关。旧写法把开关乘进影子里，导致 allowDrop 恒
      // false 时 wouldDrop 结构上恒为 0，drop 档的决策不可观测（见 shadowCounts 注释）。
      const shadow = shadowCounts(d, messages.length, { allowMerge, allowDrop })
      void log({
        at: new Date().toISOString(),
        agent: String(payload?.agent?.id ?? ''),
        turn: payload?.turn ?? null,
        step: payload?.step ?? null,
        batch: messages.length,
        kinds: d.kinds,
        // 给闸门留可审计的真实输入。上面那行 `step` 保持原样，它是证据，不是判据。
        opening: isOpeningBatch,
        wouldMerge: shadow.wouldMerge,
        wouldDrop: shadow.wouldDrop,
        mergeEnabled: shadow.mergeEnabled,
        dropEnabled: shadow.dropEnabled,
        enforce,
      })

      // ARTEX B1/B3: gate the round BEFORE spending it.
      const nowMs = Date.now()
      const defer = shouldDeferRound({
        opening: isOpeningBatch,
        kinds: d.kinds,
        nowMs,
        lastRoundAtMs: lastRoundAt.has(agentId) ? lastRoundAt.get(agentId) : null,
        oldestPendingAtMs: pendingSince.has(agentId) ? pendingSince.get(agentId) : null,
        coalesceMs,
        maxDeferMs,
      })
      if (defer === 'defer') {
        if (!pendingSince.has(agentId)) pendingSince.set(agentId, nowMs)
        const held = pendingNotices.get(agentId) ?? []
        // Bound the hold: a long-lived agent must not accumulate notices without limit.
        pendingNotices.set(agentId, [...held, ...messages].slice(-20))
        void log({
          at: new Date().toISOString(),
          kind: 'round-deferred',
          agent: agentId,
          turn: turnNo,
          step: stepNo,
          opening: isOpeningBatch,
          kinds: d.kinds,
          heldMs: nowMs - (pendingSince.get(agentId) ?? nowMs),
          coalesceMs,
          maxDeferMs,
        })
        // 空消息列表 + 本回合首包 = 回合以 completed 收场，零次模型调用。
        // 机制与步号无关：首包带 step 1 还是 step 0，效果一样。
        return { kind: 'enter', messages: [] }
      }
      // 闸门读哪只钟：`lastRoundAt` 记的是「我们上一次真的干活是什么时候」。
      // 依据就是这道闸门自己的动机注释：实测的那个回合是「上一回合**结束**后 23 秒」
      // 进来的。旧写法只在首包分支里写这个字段，于是它记的是上一回合**开始**的时刻，
      // 把上一回合整整一段时长折进了本该是「空转时长」的间隔里 —— 同一条真实回核实测：
      // 起点到起点 75,755ms，而真实空转只有 1,736ms（20s 窗口在前者下几乎失去意义）。
      // 所以写在这里：闸门决策之后（上面那次读的必须是旧值）、任何真的被放行的批次都写。
      // 回合内到达的续包也会更新它，这是**有意为之**：续包本身永远不可能被推迟
      // （见 shouldDeferRound 第一条判据），所以它只会让下一个回合看到的间隔变成真实的
      // 空转时长，而不是被上一回合的时长污染。
      // 若将来真有一个「回合结束」钩子可用，那才是这只钟最精确的写法；现在拿不到，
      // 只能以「最后一次被接受的批次」近似。
      lastRoundAt.set(agentId, nowMs)
      if (isOpeningBatch === true) {
        pendingSince.delete(agentId)
        // Deliver whatever was held, on top of the host's own list (it carries the
        // runtime-context message that payload.messages does not contain).
        const held = pendingNotices.get(agentId)
        if (Array.isArray(held) && held.length > 0) {
          pendingNotices.delete(agentId)
          const current = Array.isArray(base.messages) ? base.messages : messages
          void log({ at: new Date().toISOString(), kind: 'round-coalesced', agent: agentId, turn: turnNo, step: stepNo, held: held.length })
          return { kind: 'enter', messages: [...held, ...current] }
        }
      }

      // Tier: drop. All notices are noise, no human message, and this is the turn's
      // first notice batch (`opening` - not a step number; see decide()'s doc comment).
      // Returning an empty message list ends the turn as completed with no model call.
      if (allowDrop && d.canDrop) {
        return { kind: 'enter', messages: [] }
      }

      // Tier: merge. Only when the batch holds no human message.
      if (allowMerge && d.canMerge && d.userCount === 0) {
        const merged = buildMergedMessages(messages, Array.isArray(base.messages) ? base.messages : [])
        if (merged !== null) return { kind: 'enter', messages: merged }
      }

      return base
    } catch {
      return base
    }
  })
}
