/**
 * hive-board — a shared, file-backed coordination board for multi-agent work,
 * plus the compact-immune rule context and the tool gate that make the protocol
 * stick rather than merely advise.
 *
 * WHY A FILE, NOT A CORDIS SERVICE
 * --------------------------------
 * The board must be readable and writable by several *independently mounted*
 * presets: one lead session and every worker session that shares its board.
 * A Cordis service cannot do that here.
 *   - An `isolate: {x: true}` realm is entry-local: each mounting preset would
 *     get its OWN private instance, so the lead and its workers would see
 *     disconnected boards.
 *   - A shared realm LABEL does not pool instances: `provide()` throws on the
 *     second registration under the same realm symbol. Labels join realms; they
 *     are not a sharing mechanism.
 *   - Moving the service to the host composition is what the composition rules
 *     forbid a preset author from doing.
 * A directory of small JSON files under the workspace sidesteps all three: it
 * is shared by path, it registers no service, and it touches no host row. This
 * plugin contributes only TOOLS, one prompt CONTEXT and one tool GUARD, so —
 * unlike a service-providing row — it needs no isolate realm at all.
 *
 * THE FOUR RULES THIS ENCODES
 * ---------------------------
 * Swarm's contribution is not clever code, it is a protocol that leaves a
 * trace. Four of its rules are enforced in CODE here, so a model cannot narrate
 * past them:
 *
 *   1. CLAIM-FIRST — a record or finding is refused unless the calling session
 *      holds the objective. Ownership is `exec.agent.id`, the runtime's own
 *      session identity, NOT an `agent` string the model supplies about itself.
 *   2. NO EVIDENCE, NO FINDING — a `verified` finding needs a url and evidence.
 *   3. REGISTER BEFORE YOU CONTINUE — once a verified finding exists, its author
 *      is blocked from every other board WRITE until it is registered into the
 *      result ledger. Losing a confirmed result to a forgotten bookkeeping step
 *      is the failure this prevents.
 *   4. GATE THE DESTRUCTIVE CALL — a destructive shell pattern is refused by a
 *      tool guard until an approval record for it exists.
 *
 * Liveness is a heartbeat with a TTL rather than a boolean, so a dead holder
 * expires and the objective becomes claimable again without a human unlocking
 * it. A RELEASED claim is likewise not a held claim.
 *
 * WHY RULES ARE A CONTEXT AND NOT A SECTION
 * -----------------------------------------
 * `systemPrompt.context()` contributions are re-assembled every step and
 * re-projected after every compaction, whereas a section is assembled once.
 * Discipline that only survives until the first compaction is not discipline.
 * The order (118) sits deliberately between the harness's own approval-policy
 * and delegation context lines so these constraints are read immediately after
 * them and win on any apparent conflict.
 *
 * A dispatched child joins its parent's scope, so without a guard the lead's
 * orchestration rules would be pushed into every worker it spawns. Hence `text`
 * is a PROVIDER: lead rules to a primary session, worker rules to any session
 * whose durable creation metadata says `origin === 'subagent'`.
 *
 * THE GUARD'S ONE HARD CONSTRAINT
 * -------------------------------
 * `ToolGuard` is SYNCHRONOUS — the registry calls `guard(exec)` and reads the
 * returned reason immediately. It therefore cannot touch the filesystem. Every
 * decision it makes comes from an in-memory mirror that this plugin keeps in
 * step with disk, hydrated once at mount and updated by every mutation it makes
 * itself. One plugin instance serves every session of a preset, so that mirror
 * is shared by the lead and all its workers.
 */

import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

const KINDS = ['assets', 'objectives', 'findings', 'intel', 'approvals', 'chains']
const CLAIM_TTL_MS = 30 * 60 * 1000
const OBJECTIVE_STATUS = new Set(['open', 'claimed', 'tested', 'closed'])

/**
 * 终结状态：这两种是**结论**，不是进度。
 * `open` 是交回板面（换了人、战术放弃），不要求任何证据 —— 那是如实的"我不知道"。
 */
const TERMINAL_STATUSES = new Set(['tested', 'closed'])

/** 这条判据的出处：任务宪章 §二 第 2 条 + 系统宪章 B8。 */
const RELEASE_EVIDENCE_RULE =
  '§二.2 每个可及的得分项都被尝试过，**或被判定不可及并记录原因**'

const RESULT_KINDS = new Set(['verified', 'profile'])
const INTEL_SCOPES = new Set(['unit', 'global'])
const INTEL_SENSITIVITY = new Set(['sensitive', 'generic'])
const APPROVAL_CLASSES = new Set(['destructive-shell', 'credential-spray', 'reverse-shell', 'code-audit', 'data-read', 'other'])
const APPROVAL_DECISIONS = new Set(['approved', 'denied'])

/** Sits between the harness approval (115) and delegation (120) contexts. */
const RULES_ORDER = 118

const nowIso = () => new Date().toISOString()
const newId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`
const approvalKey = (actionClass, target) => `${String(actionClass)}::${String(target)}`

/**
 * 把 `evidence` 那段自由文本拆成引用，并逐条判断它**在盘上是否存在**，顺便记下**哈希基线**。
 *
 * 存在的判定（满足其一即可）：
 *   · 绝对路径且存在；
 *   · `<root>/evidence/<ref>` 存在（`evidence_render` 的产物就落在这里）；
 *   · `<root>/findings/<ref>` 存在（引用另一张发现卡）。
 *
 * 其余一律 `resolved: false`，仍然记录 —— **不假装它们是证据，也不假装它们不存在**。
 * 拆分规则：换行 / 逗号 / 分号分隔；去掉 `file://` 前缀与成对引号。
 *
 * ★ 为什么顺手算 sha256（2026-11-06 v1.24）★
 * 只判"文件还在"能抓删除，抓不到**篡改** —— 把截图换一张、把响应体改两行，文件还在，
 * 结论却换了。写在卡上的哈希是一条**将来能对得上的基线**：`findings-evidence-check.mjs`
 * 会重算它，对不上就报 `tampered`，而不是和"一切正常"长得一模一样。
 * 这不阻止篡改（本机没人拦得住），但让篡改**留下痕迹**。
 */
async function resolveEvidenceRefs(baseDir, text) {
  const items = String(text ?? '')
    .split(/[\n,;]+/)
    .map((s) => s.trim().replace(/^file:\/\//i, '').replace(/^["'`]|["'`]$/g, '').trim())
    .filter((s) => s !== '')
  const out = []
  for (const ref of items) {
    const candidates = path.isAbsolute(ref)
      ? [ref]
      : [path.join(baseDir, 'evidence', ref), path.join(baseDir, 'findings', ref), path.join(baseDir, ref)]
    let hit = null
    for (const candidate of candidates) {
      try {
        if ((await fs.stat(candidate)).isFile()) { hit = candidate; break }
      } catch { /* 下一个候选 */ }
    }
    let sha256 = null
    if (hit !== null) {
      try {
        sha256 = createHash('sha256').update(await fs.readFile(hit)).digest('hex')
      } catch { /* 读不动就不给基线：宁可没有，也不要一个假基线 */ }
    }
    out.push({ ref, resolved: hit !== null, path: hit, sha256 })
  }
  return out
}

/* ──────────────────────── critical rules (compact-immune) ──────────────── */

const LEAD_RULES = `Hive board rules (always in effect — they override any general statement above that appears to contradict them):
- The board is the single source of truth, not your memory of this conversation. Read \`board_snapshot\` at the start of EVERY planning round, not only at onboarding. Other sessions may be working the same board in parallel, and claims decide ownership.
- You do not execute. No scanning, no requests, no probing, no verification, no exploit runs — not even when "one command would settle it". Dispatch instead. If you notice yourself about to run something, that is the signal to dispatch.
- Before dispatching onto an objective, check \`list_agents\` for the holder's liveness. Never dispatch a second worker onto an objective whose holder is still live or idle; continue that holder with \`send_message\` instead.
- One objective, one method per worker. Give each worker the objective id, the exact scope, and what "done" looks like.
- You see only a worker's reports, never its transcript. Reconcile every report onto the board, and close out any objective that has no terminal state. A closed objective with no record and no finding is a hole, not a result — the board refuses that close, so make the worker write the record.
- No evidence, no finding. An approval grant, a running command and exit code 0 are not results, and neither is a version-match guess.
- A confirmed result must be REGISTERED into the result ledger (\`board_result_entry\`) before more board work continues — the board enforces this against its author.
- Put credentials and target-specific data in UNIT intel (scope=unit, sensitivity=sensitive). Global intel is for generic technique only; the board refuses credentials there.
- Filing cards IS your job; executing is not. "You do not execute" forbids TECHNICAL actions — scanning, requesting, probing, verifying, exploit runs. It does NOT forbid board coordination. When a notice or a report hands you ready-made \`board_*\` parameters (for example a card that ought to exist but does not), creating that card via \`board_objective_add\` / \`board_asset_add\` is board maintenance, not execution. Those are two different things, and conflating them leaves real work permanently unrecorded.`

const WORKER_RULES = `Hive board rules (always in effect — they override any general statement above that appears to contradict them):
- CLAIM FIRST. Before any action that touches a target, the objective must be claimed by you via \`board_objective_claim\`. This is enforced in code: \`board_objective_record\` and \`board_finding_add\` are refused unless you hold the objective. A refusal means re-read the board — not retry the same call.
- If a claim is refused because another live session holds it, STOP and report the conflict to the lead. Never push through, even if the objective looks idle.
- Work only your assigned scope. Note out-of-scope finds in your report; do not chase them.
- NO EVIDENCE, NO FINDING. An approval grant, a running command and exit code 0 are not results. Put progress, failures and blockers on the objective with \`board_objective_record\`; a failed or blocked test does NOT mean the risk is absent.
- REGISTER IMMEDIATELY. The moment you write a \`verified\` finding, file it into the result ledger with \`board_result_entry\`. Until you do, the board blocks every other write you attempt — that is deliberate, because an unregistered confirmed result is a lost result.
- Every objective you finish needs a terminal state: a finding when something was confirmed, or status \`tested\` when the scope came back clean. ENFORCED: \`tested\`/\`closed\` are refused unless the objective already carries a record or a finding — write the record first (what you tested, what you saw, why it is clean). If you did nothing, hand it back with status \`open\`; that needs no evidence.
- Report with the \`report\` tool when you finish a slice and always before going idle. The lead sees only your reports, never this transcript.`

/* ───────────────────────────── storage ───────────────────────────── */

async function ensureDirs(root) {
  for (const kind of KINDS) await fs.mkdir(path.join(root, kind), { recursive: true })
}

async function writeCard(root, kind, card) {
  const file = path.join(root, kind, `${card.id}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(card, null, 2), 'utf8')
  await fs.rename(tmp, file) // atomic: a reader sees old or new, never partial
  return card
}

async function readCard(root, kind, id) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, kind, `${id}.json`), 'utf8'))
  } catch {
    return null
  }
}

async function listCards(root, kind) {
  let names = []
  try {
    names = await fs.readdir(path.join(root, kind))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(await fs.readFile(path.join(root, kind, name), 'utf8')))
    } catch {
      /* a half-written card is skipped, never fatal */
    }
  }
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
}

/* ───────────────────────────── claims ───────────────────────────── */

function claimIsLive(objective, at = Date.now()) {
  const beat = Date.parse(objective?.claim?.heartbeat_at ?? '')
  return Number.isFinite(beat) && at - beat < CLAIM_TTL_MS
}

function holderOf(objective, at = Date.now()) {
  // A RELEASED claim is not a held claim. Without this check, release() — which
  // refreshes the heartbeat as its last act — would leave the objective both
  // reported as a live claim AND blocked against re-claiming for a full TTL.
  if (objective?.claim?.released_at) return null
  return claimIsLive(objective, at) ? String(objective.claim.agent) : null
}

/** True when the claim was never released but its heartbeat has gone stale. */
function claimExpired(objective, at = Date.now()) {
  return Boolean(objective?.claim) && !objective.claim.released_at && !claimIsLive(objective, at)
}

/** 这个任务下产生的战果 —— 板面自带的、唯一的"干过活"证据。 */
async function findingsFor(root, objectiveId) {
  return (await listCards(root, 'findings')).filter((f) => f.objective_id === objectiveId)
}

/* ─────────────────────── the tool gate's patterns ─────────────────────── */

/** Shell tools the gate inspects. */
const GATED_TOOLS = new Set(['bash', 'pwsh'])

/**
 * Destructive patterns. Deliberately narrow: a gate that fires constantly stops
 * being read, and an operator who approves blindly is worse off than one who
 * has never seen a prompt.
 */
const DESTRUCTIVE_PATTERNS = [
  { label: 'recursive force delete', re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i },
  { label: 'filesystem format', re: /\bmkfs(\.[a-z0-9]+)?\b/i },
  { label: 'raw device write', re: /\bdd\b[^\n]*\bof=\/dev\//i },
  { label: 'fork bomb', re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { label: 'host power state change', re: /\b(shutdown|poweroff)\b|\breboot\b(?!\s*--?help)/i },
  { label: 'account or group deletion', re: /\b(userdel|groupdel)\b/i },
  { label: 'firewall flush or disable', re: /\biptables\s+-F\b|\bufw\s+disable\b|\bSet-NetFirewallProfile\b[^\n]*-Enabled\s+\$?false/i },
  { label: 'disk zeroing', re: /\bshred\b|\bwipefs\b/i },
]

/** Pull the command text out of whatever shape a shell tool was given. */
function commandTextOf(args) {
  if (typeof args === 'string') return args
  if (args && typeof args === 'object') {
    for (const key of ['command', 'cmd', 'script', 'input']) {
      const value = args[key]
      if (typeof value === 'string') return value
    }
  }
  return ''
}

/* ─────────────────────── the port guard ─────────────────────── */

/**
 * Literal ports in a command that cannot be ports.
 *
 * Not hypothetical tidiness: the Swarm presets carry an explicit rule —
 * "任何监听、连接、代理、回连或资产端口必须是 1–65535 的整数；93445 无效。不得把
 * 子智能体编号拼接成端口" — which means an agent fabricating a port by
 * concatenating an id onto a number is a failure observed in the field. A
 * pattern gate cannot know the intended port, but it can always know that
 * 93445 is not one.
 *
 * Deliberately narrow: only port-LIKE positions are inspected, and only values
 * outside `1..65535` are reported. `sleep 30` and `12:30` are not findings,
 * because a bare number is not a port claim.
 */
function invalidLiteralPort(command) {
  const consider = (raw, where) => {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { raw, label: where }
    return null
  }
  for (const m of command.matchAll(/(?:^|\s)-p\s*(\d{1,7})(?=[\s,;|&)\]]|$)/g)) {
    const bad = consider(m[1], '-p')
    if (bad) return bad
  }
  for (const m of command.matchAll(/--port[=\s]+(\d{1,7})(?=[\s,;|&)\]]|$)/g)) {
    const bad = consider(m[1], '--port')
    if (bad) return bad
  }
  // `host:port` (but not `scheme://`) — the shape a socket target actually takes.
  for (const m of command.matchAll(/[A-Za-z0-9._-]:(?!\/\/)(\d{1,7})(?=[/\s,;|&)\]]|$)/g)) {
    const bad = consider(m[1], 'host:port')
    if (bad) return bad
  }
  return null
}

/* ─────────────────── patrol: board-driven wake-up ─────────────────── */

/** One patrol fires this long after the first pending board change. */
const PATROL_DEBOUNCE_MS = 20_000
/** Minimum spacing between two patrol turns. */
const PATROL_MIN_INTERVAL_MS = 120_000
/** 巡检没能发出去（lead 正忙 / 还没有人露过面）时，隔多久再试一次。 */
const PATROL_BUSY_RETRY_MS = 30_000

/**
 * 待发新闻的**实体种类**上限。
 *
 * `patrol.pending` 的键是实体名（`ENTITY_OF_TOOL` 的像，至多十来个），所以
 * 生产上几乎到不了 50 —— 这道上限要解决的不是"正常情况"，而是**没有尽头的情况**：
 * 一个始终没有人在场的画板，如果 pending 既不清空也不封顶，它就是一个只涨不落的
 * 内存洞。超限时丢**最旧**的键（先到的新闻最先过时），丢掉的条数记进下一行
 * `patrol.jsonl` 的 `dropped_for_cap` —— 丢弃**有界且留痕**。
 */
const PATROL_MAX_PENDING = 50

/**
 * 待发新闻的最长持有时间。超龄就丢，但**先记一行 `dropped-age` 再丢**。
 *
 * 关键从来不是"要不要丢"：十分钟前的画板动态确实已经过时，攒着只会让主帅读到
 * 一份陈年旧账。关键是**丢这件事必须留痕** —— 本役的原错（见 findLead 的注释）
 * 正是"新闻被清掉，而日志里连一行都没有"，于是"什么都没发生"与"东西被销毁了"
 * 在事后完全无法区分，一藏就是三天。
 */
const PATROL_MAX_AGE_MS = 10 * 60_000

/**
 * Entities that are NOT worth a wake-up. A claim or a routine record is
 * progress; a COMPLETED RESULT is what a lead must reconcile. Waking on
 * everything would train the lead to ignore patrols, which is worse than not
 * having them — the same reason the destructive gate is kept narrow.
 *
 * ⚠ 2026-11-05 修正：`审批申请` 原来在这张忽略表里，这是一个**方向性错误**。
 *
 * 一张刚刚挂起的审批申请，是画板上**唯一**必须由人而不是由机器回答的东西：
 * 它卡住的是一条被判为不可逆的动作（口令爆破、持久化、横向），在拿到裁决之前
 * 整条线不能往前走。把它当"日常噪音"忽略掉，等于「最需要被看见的那一条永远
 * 不会唤醒任何人」——而且它的沉默看起来和"一切正常"完全一样。
 *
 * 反过来 `审批裁决`（决定已经做出）不需要唤醒：那是收尾，不是等待。
 * 这两条的取舍现在与经济学一致：**唤醒等待者，不唤醒已完成者。**
 */
const PATROL_IGNORED_ENTITIES = new Set(['认领', '测试记录'])

/**
 * The status prefixes a tool returns when its write did NOT land. Kept as one
 * named pattern because the patrol decision depends on it and a prefix added to
 * a tool without being added here would silently start waking the lead on
 * refusals.
 */
const NOT_LANDED = /^(ERROR|BLOCKED|PAUSED|REFUSED|EXISTING|ALREADY|NOT PAUSED|UNKNOWN)\b/

/** Tool name → the entity name a patrol summary reports. */
const ENTITY_OF_TOOL = {  board_asset_add: '资产卡',
  board_objective_add: '意图卡',
  board_objective_claim: '认领',
  board_objective_record: '测试记录',
  board_objective_release: '收口',
  board_finding_add: '成果卡',
  board_result_entry: '成果登记',
  board_intel_add: '情报块',
  board_approval_request: '审批申请',
  board_approval_decide: '审批裁决',
}

/* ══════════════════════════════════════════════════════════════════════════
 * 证据等级闸门（2026-11-09 ·「是就说是，不是就说不是」）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 缺的是什么：板面上「实证 / 推断 / 转述」这三态**从来没有被写下来的地方**。
 * 一条 record 里那句"没看到"，既可能是"测过、干净"（实证），也可能是
 * "我看的是别人的转述"（转述），而两种卡在盘上长得一模一样。
 * 事后没有人能分辨 ⇒ 「我没看到」被读成「没有」。这就是本役的原错
 * （三支分队"全灭"、inspect_evals"没装"、368"SUCCESS"）。
 *
 * 做法：写入路径**拒收没有等级标记的结论**。它只要求**声明**是哪一态，
 * 不要求有证据 —— 这正是它不会卡死任何流程的原因：写不出实证的人
 * 永远可以写 `[证据等级: 转述]`，那本来就是一句如实的"我没有盘上的东西"。
 *
 * 三条边界，都是划在这道墙上的：
 *   ① **只对新写入生效，不追溯旧记录。** 边界画在此刻，不回头改写历史卡。
 *   ② 这是**格式门槛，不是诚实门槛**。「实证」两个字是模型自己打的，
 *      它阻止不了敷衍；它只让**没说**变得不可能，并让"说成什么"留在卡上
 *      供人事后复查。别把它当成本体系第 5 条「NO EVIDENCE, NO FINDING」的替代 ——
 *      那条要求盘上有实物，这条只要求你说清是不是实物。
 *   ③ 拒收必须**说清怎么补**：三个等级名与格式原文写进拒绝理由，
 *      否则就是一道哑巴墙（哑巴墙只会训练人绕开它）。
 */

/** 三个等级。顺序即强弱：实证 > 推断 > 转述。 */
export const EVIDENCE_GRADES = ['实证', '推断', '转述']

/** 标记格式，全角/半角冒号都收，等级词必须精确。 */
export const EVIDENCE_GRADE_RE = /\[证据等级\s*[:：]\s*(实证|推断|转述)\]/

/** 各等级的语义（原样进拒绝文案，让模型知道该选哪个，而不是随便挑一个）。 */
export const EVIDENCE_GRADE_MEANING = {
  实证: '盘上有可复核的东西（截图 / 原始报文 / 命令输出 / 文件路径）',
  推断: '有旁证但没证死（间接现象、单次观察、推理）',
  转述: '只有他人口述或自述，盘上没有东西',
}

/**
 * 哪些写入工具必须带等级，以及等级可以出现在哪个字段里。
 *
 * ★ 这张表是**数据**，放宽或收紧它不需要改判定代码。
 * ★ 刻意**没有**列进来的（它们不是"结论"，列进来只会把正常流程卡死）：
 *   board_asset_add / board_objective_add / board_objective_claim /
 *   board_objective_release / board_approval_* / board_pause / board_resume /
 *   board_chain_open / 所有只读工具。
 *
 * ☆ 2026-11-09 指挥官裁定③：chain_hop / chain_close / result_entry **全部纳入**。
 *   理由一句话 —— **一个有旁路的门槛不是门槛**：只堵 record/finding/intel，
 *   人就会把结论写成 chain hop 或者走 result_entry 绕过去。
 *   ⇒ 一个任务从建卡到收口，六处说人话的地方都要说清是三态里的哪一态。
 *   `board_result_entry` 只有 action="add" 那支受门槛约束（list 是读，见调用点位置）。
 *
 * ☆ 2026-11-09 指挥官裁定④：`board_campaign_close` **也纳入**（第七处）。
 *   理由同样一句话 —— 它是这套纪律的**最后一道门**：过程全都守规矩、收口时却能
 *   不带等级随便写，那门槛就只是过程装饰。
 *   ⚠ 这个工具**不是本插件注册的**，它在 `plugins/lesson-gate/lib/index.js`
 *   （:277 的 defineTool），那里 `import { evidenceGradeRefusal }` 复用本文件的
 *   函数与这张表 —— 所以文案逐字一致是构造上成立的，不靠两份手抄。
 *   ⚠ `lesson` 字段里放标记会让 slug 解析不到卡（它必须能被 findLessonCard 命中），
 *   所以实践上标记写在 `summary` 或 `no_lesson` 里；三个字段是"任一带即放行"。
 */
export const GRADED_TOOLS = {
  board_objective_record: ['note'],
  board_finding_add: ['detail', 'summary'],
  board_intel_add: ['body'],
  board_chain_hop: ['evidence', 'missing'],
  board_chain_close: ['summary'],
  board_result_entry: ['title', 'impact'],
  board_campaign_close: ['summary', 'no_lesson', 'lesson'],
}

/**
 * 返回拒绝文案；带标记则返回 null。纯函数，不碰盘 —— 因此可被单测直接喂坏值。
 *
 * 坏值语义：`args` 为 null、字段缺失、字段不是字符串、字段是空串 —— 一律**拒收**
 * （不是放行，也不是抛错）。缺席不得被读成"带了吗？带了"。
 */
export function evidenceGradeRefusal(toolName, args) {
  const fields = GRADED_TOOLS[toolName]
  if (!fields) return null
  const bag = args && typeof args === 'object' ? args : {}
  for (const field of fields) {
    const value = bag[field]
    if (typeof value === 'string' && EVIDENCE_GRADE_RE.test(value)) return null
  }
  const lines = [
    `REFUSED: \`${toolName}\` 的正文里没有证据等级标记 —— 这个结论落在盘上之后，`,
    '读它的人分不出这是"测出来的"、"推出来的"还是"别人说的"。',
    '',
    `在 ${fields.map((f) => `\`${f}\``).join(' 或 ')} 里写下面三个标记之一，然后原样重发：`,
    ...EVIDENCE_GRADES.map((g) => `  [证据等级: ${g}]  —— ${EVIDENCE_GRADE_MEANING[g]}`),
    '',
    '例如：`[证据等级: 推断] 443 端口 banner 是 nginx/1.18，未取到首页 —— 可能是反代前置。`',
    '',
    '★ 这不是要求你有证据：写不出实证时写「转述」就是正确答案。',
    '   它要求的是**别让人替你说清**——三态里没有第四态，也没有"省略"。',
  ]
  return lines.join('\n')
}

/* ───────────────────────────── plugin ───────────────────────────── */

export const name = 'hive-board'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config) {
  // `root` is the canonical key, shared with the egress / vulndb / evidence
  // plugins so one composition cannot accidentally point them at different
  // directories. `boardRoot` was the original name and is still accepted, but
  // having two key names for one concept is a footgun: editing one row and not
  // the other splits the storage silently, and the only symptom is cards that
  // "went missing". Prefer `root`.
  const configuredRoot =
    typeof config?.root === 'string' && config.root
      ? config.root
      : typeof config?.boardRoot === 'string' && config.boardRoot
        ? config.boardRoot
        : null
  /* 兜底是**绝对路径**，且**刻意不是真板面** ——
   未配置 root 时写到 ~/.dsh/hive-board（隔离、可丢弃），而不是 cwd（换目录就丢 ✗）
   也不是 ~/.war（兜底绝不能静默污染生产数据 ✗）。
   生产上走不到这一支：两个预设都显式配了绝对 root。 */
  const root = () => configuredRoot ?? path.join(os.homedir(), '.dsh', 'hive-board')
  const role = String(config?.role ?? 'worker')

  // Patrol pacing. Configurable for one real reason: the defaults (20s debounce,
  // 2min spacing) are correct for a live engagement and untestable in a unit
  // test. Making them injectable means the patrol path is actually exercised
  // rather than assumed. Both are clamped to >= 0.
  const patrolDebounceMs = Math.max(0, Number(config?.patrolDebounceMs ?? PATROL_DEBOUNCE_MS) || 0)
  const patrolMinIntervalMs = Math.max(0, Number(config?.patrolMinIntervalMs ?? PATROL_MIN_INTERVAL_MS) || 0)
  /* 「等 lead 闲下来」的重排间隔也做成可注入的：no-engaged-lead 这条路径现在会
     重排而不是清空，若这一段不可调，那条路径就只能靠 30 秒一次的真实时钟去验，
     等于没验。 */
  const patrolBusyRetryMs = Math.max(0, Number(config?.patrolBusyRetryMs ?? PATROL_BUSY_RETRY_MS) || 0)
  /* 两个上限同样可注入，理由同上：有界丢弃必须能被测到，否则"有界"只是注释。
     `?? 0` 之后不能用 `||` 兜底 —— 0 在这里是**有意义的取值**（立即/立即过期），
     被 `||` 吃掉就变成了默认值。 */
  const patrolNumber = (raw, fallback, min) => {
    const n = Number(raw)
    return Number.isFinite(n) && n >= min ? n : fallback
  }
  const patrolMaxPending = patrolNumber(config?.patrolMaxPending, PATROL_MAX_PENDING, 1)
  const patrolMaxAgeMs = patrolNumber(config?.patrolMaxAgeMs, PATROL_MAX_AGE_MS, 0)

  // Both keys present with different values is never intentional, and its only
  // symptom would be cards quietly landing in a directory nobody reads. Say so
  // loudly instead of picking one in silence.
  if (
    config && typeof config === 'object'
    && 'root' in config && 'boardRoot' in config
    && config.root !== config.boardRoot
  ) {
    console.error(
      `[hive-board] config carries BOTH "root" (${String(config.root)}) and ` +
      `"boardRoot" (${String(config.boardRoot)}) with different values. Using "root". ` +
      'Both keys name the same directory — this is almost certainly a mistake.',
    )
  }

  /**
   * In-memory mirror of the two facts the synchronous guard needs. One plugin
   * instance serves every session of this preset, so the lead and all of its
   * workers share these maps.
   */
  const mirror = {
    /** agentId -> Set(findingId) of verified findings not yet in the ledger. */
    unregistered: new Map(),
    /** `${action_class}::${target}` -> status of the latest approval record. */
    approvals: new Map(),
    hydrated: false,
  }

  const trackPending = (agent, findingId) => {
    if (!agent) return
    if (!mirror.unregistered.has(agent)) mirror.unregistered.set(agent, new Set())
    mirror.unregistered.get(agent).add(findingId)
  }
  const clearPending = (agent, findingId) => {
    const set = mirror.unregistered.get(agent)
    if (!set) return
    set.delete(findingId)
    if (set.size === 0) mirror.unregistered.delete(agent)
  }
  const pendingOf = (agent) => [...(mirror.unregistered.get(agent) ?? [])]

  /* ── pause: a coordinated stop that PRESERVES ownership ─────────── */

  /**
   * Why a pause needs to exist at all: a claim is a 30-minute lease. An
   * engagement that stops for lunch or overnight would otherwise expire every
   * claim, and every worker would silently lose the objective it holds — then
   * find it re-claimable by anyone. `board_resume` shifts every active
   * heartbeat forward by the pause duration, so the lease measures WORKING
   * time rather than wall-clock time. That is the whole point.
   */
  const pauseState = { paused: false, since: null, reason: null }

  /* ── patrol: wake the lead when the board changes ──────────────── */

  const patrol = {
    pending: new Map(),
    timer: null,
    /** 已排下的发车时刻（ms）；没有排程时为 null。见 schedulePatrol。 */
    dueAt: null,
    lastFired: 0,
    /** pending 里**最旧**一条新闻入队的时刻（ms）。pending 空了就归零。 */
    since: null,
    /** 自上次写日志以来，因超过 PATROL_MAX_PENDING 丢掉的实体种类数。 */
    droppedForCap: 0,
  }

  /** Agents that have actually used the board. Never wake a stranger. */
  const engaged = new Set()

  /**
   * agent id → 最近一次使用画板的时刻（ms）。
   *
   * 与 `engaged` 同源、同时写入，但**不是它的替代品**：`engaged` 回答"来过没有"，
   * 这张 Map 回答"谁最近来过"。巡检目标必须按**后者**挑 —— 挑法见 findLead，
   * 那里记着按别的判据挑错过一次、代价是什么。
   */
  const engagedAt = new Map()

  /* ── idle gate: never inject into a lead that is mid-turn ─────────────
   *
   * 为什么要这道门（第 37 轮，有实测依据）：
   *
   * `lead.steer()` 走的是 next-step inbox —— 回合进行中到达的 steering 会在
   * **步骤之间被领取**，而 agent loop 没有回合预算，于是每一次领取都把当前回合
   * 再延长一步。实测：某个会话 229 个回合里 **131 个是子代理回报开的**，
   * 另一个会话 53 个回合里只有 18 个是用户开的（其余是巡检/对账/回报）。
   * 结果是回合首尾相接，用户自己发的消息排在 FIFO 里抢不到回合边界。
   *
   * 判据来源：宿主 `agent/status` 事件，payload 为 `idle` ⇄ `running`。
   * 不猜字段、不轮询，跟着宿主自己的状态走。
   *
   * 保守取向：拿不到状态时**不拦**（宁可多发一次，也不要让巡逻彻底停摆）。
   */
  const leadStatus = new Map()
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('agent/status', (payload) => {
        try {
          const id = String(payload?.agent?.id ?? '')
          const status = String(payload?.status ?? '')
          if (id !== '' && status !== '') leadStatus.set(id, status)
        } catch {
          /* 状态跟踪绝不许影响巡逻 */
        }
      })
    }
  } catch {
    /* ctx.on 不可用则退化为"永远不拦" */
  }

  /** true = lead 正在跑回合，此刻不该注入。 */
  function leadIsBusy(lead) {
    try {
      const direct = lead?.status ?? lead?.state
      if (typeof direct === 'string' && direct !== '') return direct === 'running'
    } catch {
      /* fall through to the tracked map */
    }
    return leadStatus.get(String(lead?.id)) === 'running'
  }

  /**
   * 排一次巡检于 delayMs 之后，并记下发车时刻。
   *
   * 为什么要记 `dueAt`：巡检有两种排法 —— "有新变化，debounce 之后发"和
   * "这次发不出去（lead 正忙 / 还没有人来过），隔一阵再试"。后者挂得远（默认 30 秒），
   * 如果它把后面的新新闻也一起挡住，一条刚写下的变化就得陪着等满 30 秒才发车 ——
   * 甚至更糟：把 30 秒的等待当成"已经有 tick 了"，从此不再安排，等下一个随机事件。
   * 所以 noteChange 允许一条新新闻把发车时刻**提前**。
   */
  function schedulePatrol(delayMs) {
    patrol.timer = setTimeout(() => {
      void firePatrol()
    }, delayMs)
    patrol.dueAt = Date.now() + delayMs
    if (typeof patrol.timer?.unref === 'function') patrol.timer.unref()
  }

  /** 等 lead 闲下来 / 等人来再发：保留 pending，默认 30 秒后重试（可注入）。 */
  function reschedulePatrol() {
    if (patrol.timer !== null) return
    schedulePatrol(patrolBusyRetryMs)
  }

  /**
   * 本进程里所有**根会话**（`origin !== 'subagent'`）的候选清单。
   *
   * 子会话靠**持久创建元数据**排除：`session.header.origin` 的类型声明只有
   * `'subagent'` 这一个取值，spawn / fork / continuable 都会盖这个戳。所以这是
   * 构造性排除，不是按 id 猜。取不到注册表时返回空数组 —— 空数组的语义是
   * "一个候选都没有"，调用方据此走"没有人在场"那条路，而不是随便编一个。
   */
  function rootCandidates() {
    if (typeof ctx.get !== 'function') return []
    let agents
    try {
      agents = ctx.get('agents')
    } catch {
      return []
    }
    if (!agents || typeof agents.list !== 'function') return []
    let list
    try {
      list = agents.list()
    } catch {
      return []
    }
    if (!Array.isArray(list)) return []
    return list.filter((a) => a && String(a?.session?.header?.origin ?? '') !== 'subagent')
  }

  /**
   * 巡检目标 = **来过画板的根会话里，最近来过的那个**。
   *
   * ⚠⚠ 改之前（本役原错，有实测，别再改回去）：
   *   旧实现只按 `origin !== 'subagent'` 过滤，再按 id `localeCompare` 取第一个。
   *   它**既不看会话属于哪个预设，也不看它用没用过画板**。于是同一个 DSH 进程里
   *   任何一个别的根会话都是候选，而多根并存时**字典序最小**的那个稳定获胜 ——
   *   当时获胜的是 `session-436ac226…`，一个**根本不跑本预设**的会话。
   *   后果不是"少唤醒一次"这么轻：firePatrol 选中它之后判定"它没 engage 过"，
   *   就把 `patrol.pending` **整批清掉**。实测：画板 11-11 写了 111 次、11-13 写了
   *   9 次，而 `[蜂群巡检]` 从 11-10（那天 47 条）之后**一条都没有**，broker 日志里
   *   连一个巡检批次都没有 —— 每一跳静默销毁一次积累，日志里一个字都没有。
   *
   * 现在的判据只有一条：**来过画板的根会话里，最近来过的那个**（同毫秒时按 id
   * 取小的，只为确定性 —— 不让两个 lead 交替收巡检）。
   *
   * 一个都没来过就返回 `undefined`。这是**合法状态**（确实还没有人在板上说过话），
   * 不是需要"随便挑一个"来粉饰的异常：挑错的代价是整批新闻，选"没有"的代价只是
   * 等一等 —— pending 保留、定时重试、超龄才记一行 `dropped-age` 再丢。
   */
  function findLead(candidates) {
    const roots = Array.isArray(candidates) ? candidates : rootCandidates()
    let best
    let bestAt = -Infinity
    for (const agent of roots) {
      const id = String(agent?.id ?? '')
      // 只有**真的用过画板**的根会话才算候选：注册表里的其它根会话（别的预设、
      // 别的战役）从来不是这道巡检的收件人。
      if (id === '' || !engaged.has(id)) continue
      const at = Number(engagedAt.get(id) ?? 0)
      if (
        best === undefined
        || at > bestAt
        || (at === bestAt && id < String(best.id))
      ) {
        best = agent
        bestAt = at
      }
    }
    return best
  }

  /**
   * 记一条画板变化，并为这一串变化最多安排一次唤醒。
   *
   * ★ 谁写的，决定它算不算新闻（这道判据本役换过，改的理由写在下面）：
   *
   *   · **子会话**（`origin === 'subagent'`）写入 ⇒ **新闻**。哪怕它的 id 恰好
   *     等于巡检目标的 id 也是（巡检目标按构造只可能是根会话）—— 旧实现用
   *     "写入者 == findLead() 的 id" 做比较，这条真实的分队回报会被误杀。
   *   · **根会话**（有会话元数据、没有 `origin` 字段）写入 ⇒ **不唤醒**。根会话
   *     自己写卡自己刚知道，叫醒它只是把自己的动作念回给自己听。
   *     ★ 注意判据是**元数据**（`origin !== 'subagent'`），不是身份相等：
   *     findLead() 现在挑的是"最近来过画板的根会话"，多根并存时它**不一定就是
   *     写信的这个根会话来过**。用身份比较就等于让这道抑制在多根情况下静默失效。
   *   · **exec 里根本没有会话元数据**（其它运行时不给 agent 挂 `session`，
   *     或测试夹具）⇒ 无从判定，退回身份比较：只有写入者正好是巡检目标才抑制。
   *     这个兜底**只会少发，不会销毁新闻**，而且它是既有测试夹具在用的形状。
   */
  function noteChange(toolName, byAgentId, exec) {
    // Never throws. This runs on the WRITE path, after the card has already
    // been persisted: an exception here would propagate to the outer catch and
    // report a successful write as ERROR, which is worse than a missed patrol.
    try {
      const entity = ENTITY_OF_TOOL[toolName]
      if (!entity) return
      if (PATROL_IGNORED_ENTITIES.has(entity)) return
      if (pauseState.paused) return
      /* 会话元数据在**这里**读，不在调用点读：读它本身也可能抛（敌意的
         getter / 半个代理对象），而这里有一层 catch —— 读在调用点就等于把
         "记一条新闻失败"升级成"一次成功的写入报成 ERROR"。 */
      const bySession = exec?.agent?.session
      const hasSessionMeta = bySession !== undefined && bySession !== null
      if (hasSessionMeta) {
        // 有元数据就照元数据判，engagement 与此无关：根会话写什么都不唤醒。
        if (String(bySession?.header?.origin ?? '') !== 'subagent') return
      } else {
        const lead = findLead()
        // 旧判据仅作为"元数据缺失"时的兜底保留（见上面的函数注释）。
        if (lead !== undefined && String(lead.id) === String(byAgentId)) return
      }
      // 上限：只在**新增一个键**时检查，超了就丢最旧的那个。丢弃必须留痕，
      // 条数挂到下一行 patrol.jsonl 的 dropped_for_cap 上。
      if (!patrol.pending.has(entity) && patrol.pending.size >= patrolMaxPending) {
        while (patrol.pending.size >= patrolMaxPending) {
          const oldest = patrol.pending.keys().next()
          if (oldest.done) break
          patrol.pending.delete(oldest.value)
          patrol.droppedForCap += 1
        }
      }
      patrol.pending.set(entity, (patrol.pending.get(entity) ?? 0) + 1)
      if (patrol.since === null) patrol.since = Date.now()
      const spacing = Math.max(0, patrolMinIntervalMs - (Date.now() - patrol.lastFired))
      const delay = Math.max(patrolDebounceMs, spacing)
      if (patrol.timer !== null) {
        // 已经排过一次：同一批就并进去（一次巡检报完整串）。但如果已排的是"等
        // lead 闲/等人来"的远重试、而这条新闻能更早发车，就让新新闻把它提前。
        if (patrol.dueAt !== null && patrol.dueAt - Date.now() <= delay) return
        clearTimeout(patrol.timer)
        patrol.timer = null
      }
      schedulePatrol(delay)
    } catch {
      /* a missed patrol, not a failed write */
    }
  }

  /**
   * 巡检日志：`<root>/_broker/patrol.jsonl`，**一行一次 firePatrol 返回**。
   *
   * 为什么要它：改之前 firePatrol 的**每一个**提前返回都没有日志，于是
   * "本来就没有事要报"和"新闻被清掉了"在事后长得一模一样 —— 本役的原错
   * （见 findLead 注释）就是在这个形状下藏了三天，只能靠"板面写了很多次、
   * 巡检通知是零"这种反推才看得出来。
   *
   * 契约与 noteChange 相同：**永不抛**。巡检日志写不进去，不该把板面写入搞挂；
   * 写坏一次之后就不再尝试（同 fanout-gate 的做法），免得每个 tick 都去撞同一堵墙。
   */
  let patrolLogBroken = false
  async function logPatrol(kind, pendingCount, lead, extra) {
    if (patrolLogBroken) return
    try {
      const entry = {
        at: nowIso(),
        kind,
        pending: pendingCount,
        candidates: rootCandidates().map((a) => String(a?.id ?? '')),
        engaged: [...engaged],
        lead: lead === undefined || lead === null ? null : String(lead.id),
      }
      // 上限丢弃的条数跟着下一行一起记：丢弃是有界的，但不能是无痕的。
      if (patrol.droppedForCap > 0) {
        entry.dropped_for_cap = patrol.droppedForCap
        patrol.droppedForCap = 0
      }
      if (extra !== undefined && extra !== null) Object.assign(entry, extra)
      const dir = path.join(root(), '_broker')
      await fs.mkdir(dir, { recursive: true })
      await fs.appendFile(path.join(dir, 'patrol.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      patrolLogBroken = true
    }
  }

  /** Best-effort by design: a patrol that breaks the board write path is worse than a missed patrol. */
  async function firePatrol() {
    patrol.timer = null
    patrol.dueAt = null
    const pendingCount = patrol.pending.size
    if (pauseState.paused) {
      /* 暂停期间不丢：pending 留着，board_resume 之后照常发。 */
      await logPatrol('paused', pendingCount)
      return
    }
    if (pendingCount === 0) {
      await logPatrol('no-pending', 0)
      return
    }
    /* 超龄门：先记账再丢。丢的是**过时的**动态（十分钟前的事已经没人要读了），
       记的是"丢了几种、攒了多久" —— 事故与正常在这里必须分得开。 */
    const ageMs = patrol.since === null ? 0 : Date.now() - patrol.since
    if (ageMs >= patrolMaxAgeMs) {
      const dropped = pendingCount
      patrol.pending.clear()
      patrol.since = null
      await logPatrol('dropped-age', dropped, null, { age_ms: ageMs })
      return
    }
    const candidates = rootCandidates()
    const lead = findLead(candidates)
    if (lead === undefined) {
      /* ★ 这里**不再清空** pending。没有根会话用过画板是**合法状态**：把它当成
         "没人要，扔了吧"，就等于每跳销毁一次整批新闻（这就是本役的原错）。
         保留、重排、等它闲/等人来；只有超龄才丢，而且丢要记 dropped-age。 */
      await logPatrol('no-engaged-lead', pendingCount, null, { held_ms: ageMs })
      reschedulePatrol()
      return
    }
    /* ★ 空闲门：lead 正在跑回合时不注入 —— 既不延长它的回合，也不让用户
       自己发的消息继续排在这个巡检后面。这一批变化留在 patrol.pending 里，
       默认 30 秒后重试，等它闲下来再一次性发出去。 */
    if (leadIsBusy(lead)) {
      await logPatrol('lead-busy', pendingCount, lead, { held_ms: ageMs })
      reschedulePatrol()
      return
    }
    const changes = [...patrol.pending.entries()]
    patrol.pending.clear()
    patrol.since = null
    patrol.lastFired = Date.now()
    try {
      const lines = [
        `[蜂群巡检] 画板有新动态：${changes.map(([k, n]) => `${k}×${n}`).join('，')}。`,
      ]
      const [objectives, findings] = await Promise.all([
        listCards(root(), 'objectives'),
        listCards(root(), 'findings'),
      ])
      const at = Date.now()
      const live = objectives.filter((o) => holderOf(o, at))
      const unfiled = findings.filter((f) => f.result_kind === 'verified' && !f.result)
      if (live.length > 0) {
        lines.push(`活跃认领 ${live.length} 个：${live.map((o) => `${o.id}`).join('，')}。`)
      }
      if (unfiled.length > 0) {
        lines.push(`注意：有 ${unfiled.length} 条已确认成果尚未登记成果清单：${unfiled.map((f) => f.id).join('，')}。`)
      }
      lines.push(
        '请用一轮做巡检：board_snapshot 核对新卡片是否规范（成果卡混入计划内容、或没关联来源意图的要纠正），' +
        '确认没有该派工而漏派的意图，然后决定下一步。一切正常就一两句话确认，不要重复派工。',
      )
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm/message')
      lead.steer(
        createUserMessage({
          content: [{ type: 'text', text: lines.join('\n') }],
          source: { kind: 'plugin:hive', form: 'notice', summary: '蜂群巡检唤醒' },
        }),
      )
    } catch {
      /* drop the tick */
    }
    /* 记在这一批**已经被消费掉**之后：即使注入本身失败，这批新闻也不会再发了，
       "fired" 记的是巡检真的走完了一次，不是"注入一定送达"。 */
    await logPatrol('fired', pendingCount, lead, {
      entities: changes.map(([k, n]) => `${k}×${n}`),
      held_ms: ageMs,
    })
  }

  /** Rebuild the mirror from disk. Fire-and-forget at mount; awaited on demand. */
  async function hydrate() {
    try {
      const [findings, approvals] = await Promise.all([
        listCards(root(), 'findings'),
        listCards(root(), 'approvals'),
        listCards(root(), 'chains'),
      ])
      mirror.unregistered.clear()
      for (const f of findings) {
        if (f.result_kind === 'verified' && !f.result) trackPending(f.created_by, f.id)
      }
      mirror.approvals.clear()
      for (const a of approvals) {
        mirror.approvals.set(approvalKey(a.action_class, a.target), a.status)
      }
    } catch {
      /* a missing board is an empty board */
    }
    mirror.hydrated = true
  }
  void hydrate()

  /* ── the compact-immune rule context ───────────────────────────── */

  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: 'hive:critical-rules',
        order: RULES_ORDER,
        // A dispatched child joins the lead's scope, so the lead's orchestration
        // rules must NOT reach it. `origin` is durable creation metadata the
        // in-process driver stamps on spawn/fork/continuable children alike.
        text: (context) => {
          const isChild = context?.agent?.session?.header?.origin === 'subagent'
          if (role === 'lead') return isChild ? WORKER_RULES : LEAD_RULES
          return WORKER_RULES
        },
      }),
    'systemPrompt.context(hive:critical-rules)',
  )

  /* ── the tool gate ─────────────────────────────────────────────── */

  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        const toolName = String(exec?.name ?? '')
        if (!GATED_TOOLS.has(toolName)) return undefined
        const command = commandTextOf(exec?.arguments)
        if (command === '') return undefined
        for (const rule of DESTRUCTIVE_PATTERNS) {
          if (!rule.re.test(command)) continue
          const target = toolName
          const status = mirror.approvals.get(approvalKey('destructive-shell', target))
          if (status === 'approved') return undefined
          const hint = status === 'pending'
            ? 'A request is already on file and is still PENDING.'
            : 'No request is on file for it yet.'
          return (
            `HIVE TOOL GATE: refused a "${rule.label}" pattern in \`${toolName}\`. ` +
            `${hint} File or resolve the record with ` +
            `board_approval_request(action_class="destructive-shell", target="${target}"), ` +
            `then re-issue the exact same call once it is approved.`
          )
        }
        return undefined
      }),
    'tools.guard(hive:destructive-shell)',
  )

  /**
   * A malformed port is the cheapest mistake in this whole workflow to make and
   * the most expensive to notice: `nmap -p 99999` scans nothing and returns
   * "0 hosts up", which reads exactly like "the port is closed". An operator
   * then files a NEGATIVE finding on a scan that never happened. Refusing the
   * invocation is the only place that failure can be caught cheaply.
   *
   * Deliberately narrow: only literal out-of-range numbers. A variable like
   * `$PORT` or a shell substitution is left to the caller — guessing at those
   * would block legitimate work.
   */
  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        const toolName = String(exec?.name ?? '')
        if (!GATED_TOOLS.has(toolName)) return undefined
        const command = commandTextOf(exec?.arguments)
        if (command === '') return undefined
        const bad = invalidLiteralPort(command)
        if (bad === null) return undefined
        return (
          `HIVE TOOL GATE: \`${toolName}\` was given the port ${bad.raw} (${bad.label}), ` +
          `which is outside the valid range 1-65535. A scan against an impossible port ` +
          `returns no results and looks exactly like a closed port, so a negative finding ` +
          `based on it would be false. Fix the port and re-issue the call.`
        )
      }),
    'tools.guard(hive:port-range)',
  )

  /* ── board tools ───────────────────────────────────────────────── */

  /**
   * The calling session's own identity, or null when the runtime did not supply
   * one.
   *
   * Returning a placeholder here would be DANGEROUS rather than safe: every
   * unidentified caller would collapse onto the SAME identity, so a claim made
   * by one session would be honoured for every other one and claim-first would
   * silently stop protecting anything — with no error anywhere. Fail closed.
   */
  const callerOf = (exec) => {
    const id = exec?.agent?.id
    return typeof id === 'string' && id.length > 0 ? id : null
  }

  const register = (spec) => {
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args, exec) {
          try {
            const caller = callerOf(exec)
            if (caller === null) {
              return 'ERROR: the runtime supplied no calling-session identity (exec.agent.id), so claim ownership cannot be decided. Refusing, rather than collapsing every session onto one anonymous identity.'
            }
            // Remember who actually used the board. Patrol only ever wakes an
            // agent that has been here: steering a session that never spoke
            // would open a turn with no context on what the board even is.
            engaged.add(caller)
            // …and WHEN. 「来过」只够筛掉陌生人，巡检目标还得按**最近来过**挑，
            // 否则多根会话并存时挑中的是字典序最小的那个（见 findLead）。
            engagedAt.set(caller, Date.now())
            await ensureDirs(root())

            // A paused board accepts no writes except the one that resumes it.
            // Reads stay open on purpose — pausing must never blind the team.
            if (spec.write && pauseState.paused && spec.name !== 'board_resume') {
              return (
                `PAUSED: the board was stopped at ${pauseState.since}` +
                (pauseState.reason ? ` (${pauseState.reason})` : '') +
                `. Writes are refused so nobody works against a moving picture. ` +
                `Reads still work. Call board_resume to continue — active claim leases ` +
                `are extended by the pause duration, so nobody loses an objective.`
              )
            }

            // Rule 3: an unregistered confirmed result blocks every other write.
            // `board_resume` is exempt: if it were blocked, a team that paused
            // with an unregistered result would be unable to restart at all —
            // the ledger rule would become a deadlock instead of a prompt.
            if (spec.write && spec.name !== 'board_resume') {
              const pending = pendingOf(caller)
              if (pending.length > 0) {
                return (
                  `BLOCKED: you have ${pending.length} confirmed result(s) not yet in the result ledger: ` +
                  `${pending.join(', ')}. Register them with ` +
                  `board_result_entry(action="add", finding_id="<id>", title="...") before any other board write. ` +
                  `An unregistered confirmed result is a lost result.`
                )
              }
            }
            /* `exec` 也交给 run：裁决审批需要「谁在调用」的**结构性**证据
               （session.header.origin），而不只是会话 id。见 board_approval_decide。 */
            const result = await spec.run(args, caller, exec)
            // Only a write that actually LANDED is news. A refused write returns a
            // status prefix and must not wake anyone: waking the lead to look at a
            // board nothing happened on is exactly how patrols get ignored.
            if (spec.write && !NOT_LANDED.test(String(result))) {
              /* exec 整块交过去，而不是只交一个 origin 字符串：
                 "有元数据但没有 origin"（生产上的根会话）与"根本没有元数据"
                 （测试夹具 / 别的运行时）是**两种**情况，noteChange 必须能分辨，
                 否则它要么误杀分队回报、要么让根会话自己写卡也叫醒自己。 */
              noteChange(spec.name, caller, exec)
            }
            return result
          } catch (error) {
            return `ERROR: ${error?.message ?? String(error)}`
          }
        },
      }),
    )
  }

  /* ── assets ─────────────────────────────────────────────────────── */

  register({
    name: 'board_asset_add',
    write: true,
    description:
      'Add a target asset card. The chain asset -> objective -> finding starts here, so create the card BEFORE assigning or working anything on it. Deduplicates on address+port and returns the existing card if present.',
    parameters: {
      address: { type: 'string', required: true, description: 'Host, IP or URL.' },
      port: { type: 'string', description: 'Port, if meaningful.' },
      service: { type: 'string', description: 'Service or product, if known.' },
      zone: { type: 'string', description: 'Network zone, e.g. internet / intranet.' },
      note: { type: 'string', description: 'Free-text note.' },
    },
    async run(args, caller) {
      const all = await listCards(root(), 'assets')
      const hit = all.find(
        (a) => a.address === args.address && String(a.port ?? '') === String(args.port ?? ''),
      )
      if (hit) return `EXISTING ${hit.id}\n${JSON.stringify(hit, null, 2)}`
      const card = {
        kind: 'asset',
        id: newId('asset'),
        address: String(args.address),
        port: args.port ? String(args.port) : null,
        service: args.service ? String(args.service) : null,
        zone: args.zone ? String(args.zone) : null,
        note: args.note ? String(args.note) : null,
        created_at: nowIso(),
        created_by: caller,
      }
      await writeCard(root(), 'assets', card)
      return `ADDED ${card.id}\n${JSON.stringify(card, null, 2)}`
    },
  })

  /* ── objectives ─────────────────────────────────────────────────── */

  register({
    name: 'board_objective_add',
    write: true,
    description:
      'Add an objective (intent) card: one testable question about one asset, or a derived follow-up when a finding opens new ground. Plans, guesses and next actions live here — never on a finding card.',
    parameters: {
      asset_id: { type: 'string', required: true, description: 'Owning asset card id.' },
      title: { type: 'string', required: true, description: 'One checkable statement of intent.' },
      parent_finding_id: {
        type: 'string',
        description: 'Set when this objective is DERIVED from a confirmed finding.',
      },
      method: { type: 'string', description: 'Intended method / hypothesis.' },
    },
    async run(args, caller) {
      const asset = await readCard(root(), 'assets', String(args.asset_id))
      if (!asset) return `ERROR: unknown asset_id ${args.asset_id}`
      if (args.parent_finding_id) {
        const parent = await readCard(root(), 'findings', String(args.parent_finding_id))
        if (!parent) return `ERROR: unknown parent_finding_id ${args.parent_finding_id}`
      }
      const card = {
        kind: 'objective',
        id: newId('obj'),
        asset_id: String(args.asset_id),
        parent_finding_id: args.parent_finding_id ? String(args.parent_finding_id) : null,
        title: String(args.title),
        method: args.method ? String(args.method) : null,
        status: 'open',
        claim: null,
        records: [],
        created_at: nowIso(),
        created_by: caller,
      }
      await writeCard(root(), 'objectives', card)
      return `ADDED ${card.id}\n${JSON.stringify(card, null, 2)}`
    },
  })

  register({
    name: 'board_objective_claim',
    write: true,
    description:
      'Claim an objective before doing ANY work on it. Fails when another live session holds it — a claim whose heartbeat is older than 30 minutes counts as expired, so a dead holder does not block the board. Re-calling refreshes your own heartbeat.',
    parameters: {
      objective_id: { type: 'string', required: true },
      checkpoint: { type: 'string', description: 'Where to resume from if interrupted.' },
    },
    async run(args, caller) {
      const card = await readCard(root(), 'objectives', String(args.objective_id))
      if (!card) return `ERROR: unknown objective_id ${args.objective_id}`
      const holder = holderOf(card)
      if (holder && holder !== caller) {
        return `REFUSED: objective ${card.id} is claimed by ${holder} (heartbeat ${card.claim.heartbeat_at}). Do not work it; report the conflict instead.`
      }
      card.claim = {
        agent: caller,
        claimed_at: card.claim?.agent === caller ? card.claim.claimed_at : nowIso(),
        heartbeat_at: nowIso(),
        checkpoint: args.checkpoint ? String(args.checkpoint) : (card.claim?.checkpoint ?? null),
      }
      card.status = 'claimed'
      await writeCard(root(), 'objectives', card)
      return `CLAIMED ${card.id} by ${caller}\ncheckpoint: ${card.claim.checkpoint ?? '(none)'}`
    },
  })

  register({
    name: 'board_objective_record',
    write: true,
    description:
      'Append a progress / failure / blocker record to an objective you hold. Use this INSTEAD of creating a finding when nothing is confirmed: a failed or blocked test does not mean the risk is absent, and it must not be recorded as a result. EVIDENCE GRADE (enforced): `note` must contain exactly one marker — [证据等级: 实证] (verifiable artifact on disk) / [证据等级: 推断] (corroborated but not proven) / [证据等级: 转述] (only hearsay or self-report). A record without one is REFUSED.',
    parameters: {
      objective_id: { type: 'string', required: true },
      note: { type: 'string', required: true, description: 'What was tried and what happened.' },
      checkpoint: { type: 'string', description: 'Updated resume point.' },
    },
    async run(args, caller) {
      const card = await readCard(root(), 'objectives', String(args.objective_id))
      if (!card) return `ERROR: unknown objective_id ${args.objective_id}`
      const holder = holderOf(card)
      if (holder !== caller) {
        return `REFUSED: you (${caller}) do not hold ${card.id}${holder ? ` (held by ${holder})` : ' (unclaimed)'}. Claim it first.`
      }
      /* 证据等级闸门（2026-11-09）：先判归属，再判有没有说清是哪一态。 */
      const ungraded = evidenceGradeRefusal('board_objective_record', args)
      if (ungraded !== null) return ungraded
      card.records.push({ at: nowIso(), by: caller, note: String(args.note) })
      card.claim.heartbeat_at = nowIso()
      if (args.checkpoint) card.claim.checkpoint = String(args.checkpoint)
      await writeCard(root(), 'objectives', card)
      return `RECORDED on ${card.id} (${card.records.length} records)`
    },
  })

  register({
    name: 'board_objective_release',
    write: true,
    description:
      'Release or close an objective. Every fully-tested objective needs a terminal state: `tested` when the scope turned out clean, `closed` when it is done. Pass a checkpoint so the next holder can resume. ' +
      'ENFORCED: a terminal state (tested | closed) is refused unless the objective carries at least one record or at least one finding — a conclusion needs a basis. The fix is board_objective_record (what you tested, what you saw, why it is clean) or board_finding_add. If you did nothing at all, hand it back with status="open" instead; that needs no evidence.',
    parameters: {
      objective_id: { type: 'string', required: true },
      status: {
        type: 'string',
        required: true,
        description: 'tested (clean) | closed (done) | open (hand back, still unfinished)',
      },
      checkpoint: { type: 'string' },
    },
    async run(args, caller) {
      const card = await readCard(root(), 'objectives', String(args.objective_id))
      if (!card) return `ERROR: unknown objective_id ${args.objective_id}`
      const holder = holderOf(card)
      if (holder !== caller) return `REFUSED: you (${caller}) do not hold ${card.id}.`
      const status = String(args.status)
      if (!OBJECTIVE_STATUS.has(status)) {
        return `ERROR: status must be one of ${[...OBJECTIVE_STATUS].join(' | ')}`
      }

      /* ── 证据门槛（2026-11-05 新增；宪章 B8）────────────────────────────────
       *
       * 为什么卡在这里，而不是靠 WORKER_RULES 里那句"每个任务都要有终结状态"：
       *
       *   那句话从写下第一天起就是真的**意图**，也一直是可选的**路径**。板面实测：
       *   8 个任务、4 个已关闭、0 个战果、3 个连一条记录都没有 —— 穷尽的分母在
       *   无声蒸发，而"认领 → 关闭 → 什么都不留"是所有路径里最省事的那条。
       *
       *   任务宪章 §二 第 2 条要求的是"尝试过，**或被判定不可及并记录原因**"。
       *   `tested` 的意思是"测过且干净"——那就必须有一句话说明测了什么。
       *   两者都没有的人不是"测干净了"，是"没测"，而"没测"的正确写法是
       *   status="open"（把活交回去）。它不需要证据，也不会污染 c2/c3。
       *
       * 形态照抄 CLAIM FIRST 与 verified finding：做不到就写不进去，并把正确的
       * 下一步写进拒绝理由里。
       */
      if (TERMINAL_STATUSES.has(status)) {
        const records = (card.records ?? []).length
        const findings = (await findingsFor(root(), card.id)).length
        if (records === 0 && findings === 0) {
          return [
            `REFUSED: ${card.id} 既没有记录也没有战果，不能判成 ${status}。`,
            `${status} 是结论，不是进度。${RELEASE_EVIDENCE_RULE}（任务宪章 §二.2）`,
            '',
            '二选一，二选一里没有"什么都不写"：',
            `  · 真的测过、什么都没打出来 → board_objective_record(objective_id="${card.id}", note="测了什么 / 看到什么 / 为什么判干净")`,
            '  · 打出了东西 → board_finding_add(...)（战果本身就是证据）',
            '',
            '如果这一轮什么都没做（换了人、战术放弃、人手不够），',
            `用 board_objective_release(objective_id="${card.id}", status="open") 交回板面 —— 交回不需要证据。`,
            '两个都不是的话，就说明这个任务还开着，别关它。',
          ].join('\n')
        }
      }

      card.status = status
      if (args.checkpoint) card.claim.checkpoint = String(args.checkpoint)
      card.claim.heartbeat_at = nowIso()
      if (status !== 'claimed') {
        card.claim = { ...card.claim, released_at: nowIso(), released_by: caller }
      }
      await writeCard(root(), 'objectives', card)
      return `RELEASED ${card.id} status=${status}`
    },
  })

  /* ── findings ───────────────────────────────────────────────────── */

  register({
    name: 'board_finding_add',
    write: true,
    description:
      'Record a confirmed result on an objective you hold. result_kind=verified requires a url and at least one evidence reference, and should carry the raw request/response or screenshot path in `detail`. result_kind=profile is a feature/inventory matrix and needs no screenshot. Approval, execution and exit code 0 are NOT evidence of a result. EVIDENCE GRADE (enforced): `detail` (or `summary`) must contain exactly one marker — [证据等级: 实证] / [证据等级: 推断] / [证据等级: 转述]; a finding without one is REFUSED. A verified finding must then be registered with board_result_entry before any other write will be accepted.',
    parameters: {
      objective_id: { type: 'string', required: true },
      result_kind: { type: 'string', required: true, description: 'verified | profile' },
      summary: { type: 'string', required: true, description: 'One-glance reusable handle.' },
      detail: { type: 'string', required: true, description: 'Full evidence and steps.' },
      url: { type: 'string', description: 'Affected URL (required for verified).' },
      evidence: {
        type: 'string',
        description: 'Evidence references, newline- or comma-separated (required for verified).',
      },
    },
    async run(args, caller) {
      const objective = await readCard(root(), 'objectives', String(args.objective_id))
      if (!objective) return `ERROR: unknown objective_id ${args.objective_id}`
      const holder = holderOf(objective)
      if (holder !== caller) {
        return `REFUSED: you (${caller}) do not hold ${objective.id}${holder ? ` (held by ${holder})` : ' (unclaimed)'}. A finding must be produced under your own claim.`
      }
      const resultKind = String(args.result_kind)
      if (!RESULT_KINDS.has(resultKind)) return `ERROR: result_kind must be verified | profile`
      let evidenceRefsForCard = null
      if (resultKind === 'verified') {
        const missing = []
        if (!args.url) missing.push('url')
        if (!args.evidence) missing.push('evidence')
        if (missing.length) {
          return `REFUSED: a verified finding needs ${missing.join(' and ')}. Without them this belongs on the objective as a record, not a finding.`
        }

        /* ── 证据引用必须至少有一条落在盘上（2026-11-06 收紧）─────────────
         *
         * 原来只查 `evidence` 是非空字符串：写 `evidence: "C:/evidence/admin.png"`
         * 就能落一张 verified 发现卡，而那个文件根本不存在。于是
         * `vdb_promote` 的证据门（v1.21）也一并失效 —— 它认的是"发现卡存在"，
         * 而发现卡的证据是自由文本。**门槛要能立住，这条链上每一环都得有实物。**
         *
         * 至少一条引用必须 resolve 到真实文件：绝对路径存在，或落在
         * `<root>/evidence/` 下。其余引用仍然记录，但标成未核实 —— 不假装它们也是证据。
         */
        const refs = await resolveEvidenceRefs(root(), String(args.evidence))
        evidenceRefsForCard = refs
        const resolved = refs.filter((r) => r.resolved)
        if (resolved.length === 0) {
          return (
            'REFUSED: verified 发现有 url 和 evidence 还是不够 —— 证据引用**一条都解析不到实物**。\n'
            + '  给出的引用：' + refs.map((r) => `"${r.ref}"`).join(', ') + '\n'
            + '要让它算数，至少一条必须指向真实文件：\n'
            + `  · 绝对路径（${path.join(root(), 'evidence')} 下也行）\n`
            + '  · 或先用 evidence_render 渲染截图/报告，再把文件名填进来\n'
            + '这不是形式：审批、执行、退出码 0 都不是战果，**盘上没有的东西也不是**。'
          )
        }
      }
      /* 证据等级闸门（2026-11-09）。位置是刻意的：放在 verified 证据门**之后** ——
         一条连实物都解析不到的 verified 应当先收到"证据不到位"那句话，
         而不是先被要求声明等级（先说的话决定人接下来去修什么）。 */
      const ungradedFinding = evidenceGradeRefusal('board_finding_add', args)
      if (ungradedFinding !== null) return ungradedFinding
      const card = {
        kind: 'finding',
        id: newId('find'),
        objective_id: objective.id,
        asset_id: objective.asset_id,
        parent_finding_id: objective.parent_finding_id ?? null,
        result_kind: resultKind,
        summary: String(args.summary),
        detail: String(args.detail),
        url: args.url ? String(args.url) : null,
        evidence: args.evidence ? String(args.evidence) : null,
        /* 证据引用逐条标注：哪条在盘上真的存在、哪条只是被写上去的。 */
        evidence_refs: args.evidence ? evidenceRefsForCard : null,
        result: null,
        created_at: nowIso(),
        created_by: caller,
      }
      await writeCard(root(), 'findings', card)
      objective.claim.heartbeat_at = nowIso()
      await writeCard(root(), 'objectives', objective)
      if (resultKind === 'verified') trackPending(caller, card.id)
      const tail =
        resultKind === 'verified'
          ? `\nNEXT: further board writes are blocked until you register this: board_result_entry(action="add", finding_id="${card.id}", title="...")`
          : ''
      return `ADDED ${card.id} on ${objective.id}\n${JSON.stringify(card, null, 2)}${tail}`
    },
  })

  /* ── result ledger ──────────────────────────────────────────────── */

  register({
    name: 'board_result_entry',
    description:
      'The result ledger, and the ONLY board write exempt from the registration block. A confirmed (verified) finding MUST be registered here before any other board write is accepted. Filing a finding is not the same as registering it: the finding is the evidence, this is the deliverable count. action="add" registers, action="list" reads the ledger. EVIDENCE GRADE (enforced on add): `title` or `impact` must contain exactly one marker — [证据等级: 实证] / [证据等级: 推断] / [证据等级: 转述]; a registration without one is REFUSED.',
    parameters: {
      action: { type: 'string', required: true, description: 'add | list' },
      finding_id: { type: 'string', description: 'The verified finding to register (add).' },
      title: { type: 'string', description: 'Deliverable title (add).' },
      category: { type: 'string', description: 'Category, e.g. auth / injection / privilege (add).' },
      severity: {
        type: 'string',
        description: 'critical | high | medium | low | info. Grade the result when you register it — a report cannot be graded later by someone who was not there.',
      },
      impact: { type: 'string', description: 'One-line impact for the report (add).' },
    },
    async run(args, caller) {
      const action = String(args.action)
      if (action === 'list') {
        const findings = await listCards(root(), 'findings')
        const registered = findings.filter((f) => f.result)
        const pending = findings.filter((f) => f.result_kind === 'verified' && !f.result)
        return JSON.stringify(
          {
            counts: { registered: registered.length, pending_registration: pending.length },
            registered: registered.map((f) => ({
              finding_id: f.id,
              title: f.result.title,
              category: f.result.category,
              severity: f.result.severity ?? null,
              registered_at: f.result.registered_at,
              registered_by: f.result.registered_by,
            })),
            pending_registration: pending.map((f) => ({
              finding_id: f.id,
              summary: f.summary,
              created_by: f.created_by,
            })),
          },
          null,
          2,
        )
      }
      if (action !== 'add') return 'ERROR: action must be add | list'
      const finding = await readCard(root(), 'findings', String(args.finding_id))
      if (!finding) return `ERROR: unknown finding_id ${args.finding_id}`
      if (finding.result_kind !== 'verified') {
        return `ERROR: only verified findings belong in the result ledger; ${finding.id} is ${finding.result_kind}. A profile/matrix card is info-level and is not a deliverable.`
      }
      if (finding.result) {
        return `ALREADY REGISTERED ${finding.id} at ${finding.result.registered_at}`
      }
      if (!args.title) return 'ERROR: title is required when registering a result'
      /* 证据等级闸门（2026-11-09）：只拦 add；list 是读，上面已经返回了。 */
      const ungradedResult = evidenceGradeRefusal('board_result_entry', args)
      if (ungradedResult !== null) return ungradedResult
      finding.result = {
        title: String(args.title),
        category: args.category ? String(args.category) : null,
        impact: args.impact ? String(args.impact) : null,
        registered_at: nowIso(),
        registered_by: caller,
      }
      await writeCard(root(), 'findings', finding)
      clearPending(finding.created_by, finding.id)
      const remaining = pendingOf(caller)
      return (
        `REGISTERED ${finding.id} as "${finding.result.title}"\n` +
        (remaining.length === 0
          ? 'No unregistered results remain; board writes are unblocked.'
          : `Still unregistered: ${remaining.join(', ')}`)
      )
    },
  })

  /* ── intel blocks ───────────────────────────────────────────────── */

  register({
    name: 'board_intel_add',
    write: true,
    description:
      'Share an intel block with the team. Credentials and target-specific data belong in UNIT scope with sensitivity=sensitive; GLOBAL scope is for generic technique only and the board REFUSES sensitive content there. Never put a password in a global block. EVIDENCE GRADE (enforced): `body` must contain exactly one marker — [证据等级: 实证] / [证据等级: 推断] / [证据等级: 转述]; a block without one is REFUSED.',
    parameters: {
      title: { type: 'string', required: true },
      body: { type: 'string', required: true },
      scope: { type: 'string', required: true, description: 'unit | global' },
      sensitivity: { type: 'string', required: true, description: 'sensitive | generic' },
      tags: { type: 'string', description: 'Comma-separated tags.' },
    },
    async run(args, caller) {
      const scope = String(args.scope)
      const sensitivity = String(args.sensitivity)
      if (!INTEL_SCOPES.has(scope)) return 'ERROR: scope must be unit | global'
      if (!INTEL_SENSITIVITY.has(sensitivity)) return 'ERROR: sensitivity must be sensitive | generic'
      if (scope === 'global' && sensitivity === 'sensitive') {
        return 'REFUSED: a global block may hold generic technique only. Credentials, tokens, customer data and target-specific values must be scope=unit, sensitivity=sensitive — a global block is visible outside this engagement.'
      }
      /* 证据等级闸门（2026-11-09）：情报块也是一条结论，同一条纪律。 */
      const ungradedIntel = evidenceGradeRefusal('board_intel_add', args)
      if (ungradedIntel !== null) return ungradedIntel
      const card = {
        kind: 'intel',
        id: newId('intel'),
        title: String(args.title),
        body: String(args.body),
        scope,
        sensitivity,
        tags: args.tags ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean) : [],
        created_at: nowIso(),
        created_by: caller,
      }
      await writeCard(root(), 'intel', card)
      return `ADDED ${card.id} (${scope}/${sensitivity})\n${JSON.stringify(card, null, 2)}`
    },
  })

  register({
    name: 'board_intel_list',
    description:
      'List intel block TITLES and metadata. Sensitive bodies are withheld here on purpose — use board_intel_get for the body of the one block you actually need, so a credential is not sprayed into the transcript on every planning round.',
    parameters: {
      scope: { type: 'string', description: 'Filter: unit | global' },
      query: { type: 'string', description: 'Substring match on title or tags.' },
    },
    async run(args) {
      const all = await listCards(root(), 'intel')
      const scope = args.scope ? String(args.scope) : null
      const query = args.query ? String(args.query).toLowerCase() : null
      const rows = all
        .filter((b) => (scope ? b.scope === scope : true))
        .filter((b) =>
          query
            ? b.title.toLowerCase().includes(query) || b.tags.some((t) => t.toLowerCase().includes(query))
            : true,
        )
        .map((b) => ({
          id: b.id,
          title: b.title,
          scope: b.scope,
          sensitivity: b.sensitivity,
          tags: b.tags,
          created_by: b.created_by,
          body: b.sensitivity === 'sensitive' ? '(withheld — use board_intel_get)' : b.body,
        }))
      return JSON.stringify({ count: rows.length, blocks: rows }, null, 2)
    },
  })

  register({
    name: 'board_intel_get',
    description: 'Read one intel block in full, including a sensitive body.',
    parameters: { id: { type: 'string', required: true } },
    async run(args) {
      const card = await readCard(root(), 'intel', String(args.id))
      if (!card) return `ERROR: unknown intel id ${args.id}`
      return JSON.stringify(card, null, 2)
    },
  })

  /* ── approval ledger ────────────────────────────────────────────── */

  register({
    name: 'board_approval_request',
    write: true,
    description:
      'File an approval record before a high-risk action so a trace exists. The tool gate refuses destructive shell patterns until a matching record is approved. Keep doing safe work while it pends — never idle-wait.',
    parameters: {
      action_class: {
        type: 'string',
        required: true,
        description: 'destructive-shell | credential-spray | reverse-shell | code-audit | data-read | other',
      },
      target: { type: 'string', required: true, description: 'The tool name or target the action applies to.' },
      detail: { type: 'string', description: 'What exactly you intend to do and why.' },
    },
    async run(args, caller) {
      const actionClass = String(args.action_class)
      if (!APPROVAL_CLASSES.has(actionClass)) {
        return `ERROR: action_class must be one of ${[...APPROVAL_CLASSES].join(' | ')}`
      }
      const card = {
        kind: 'approval',
        id: newId('appr'),
        action_class: actionClass,
        target: String(args.target),
        detail: args.detail ? String(args.detail) : null,
        status: 'pending',
        requested_at: nowIso(),
        requested_by: caller,
        decided_at: null,
        decided_by: null,
        reason: null,
      }
      await writeCard(root(), 'approvals', card)
      mirror.approvals.set(approvalKey(actionClass, card.target), 'pending')
      return `FILED ${card.id} status=pending (${actionClass} on ${card.target})\nThe tool gate will keep refusing the matching call until this is approved.`
    },
  })

  register({
    name: 'board_approval_check',
    description:
      'Check the approval ledger. With an id, report that record; without one, list pending and decided records. Call this after filing, and again before re-issuing a gated call.',
    parameters: {
      id: { type: 'string', description: 'A specific approval record id.' },
      action_class: { type: 'string', description: 'Filter by action class.' },
      target: { type: 'string', description: 'Filter by target.' },
    },
    async run(args) {
      const all = await listCards(root(), 'approvals')
      if (args.id) {
        const card = all.find((a) => a.id === String(args.id))
        if (!card) return `ERROR: unknown approval id ${args.id}`
        return JSON.stringify(card, null, 2)
      }
      const rows = all
        .filter((a) => (args.action_class ? a.action_class === String(args.action_class) : true))
        .filter((a) => (args.target ? a.target === String(args.target) : true))
        .map((a) => ({
          id: a.id,
          action_class: a.action_class,
          target: a.target,
          status: a.status,
          requested_at: a.requested_at,
          decided_at: a.decided_at,
        }))
      return JSON.stringify(
        {
          count: rows.length,
          pending: rows.filter((r) => r.status === 'pending'),
          decided: rows.filter((r) => r.status !== 'pending'),
        },
        null,
        2,
      )
    },
  })

  register({
    name: 'board_approval_decide',
    write: true,
    description:
      'Record a decision on an approval request. A decision is a RECORD of a human judgement, not a permission the agent grants itself — if nobody has authorised the action, do not approve your own request.',
    parameters: {
      id: { type: 'string', required: true },
      decision: { type: 'string', required: true, description: 'approved | denied' },
      reason: { type: 'string', description: 'Why, and by whom.' },
    },
    async run(args, caller, exec) {
      const decision = String(args.decision)
      if (!APPROVAL_DECISIONS.has(decision)) return 'ERROR: decision must be approved | denied'
      const card = await readCard(root(), 'approvals', String(args.id))
      if (!card) return `ERROR: unknown approval id ${args.id}`
      if (card.status !== 'pending') {
        return `ALREADY ${card.status.toUpperCase()} at ${card.decided_at} by ${card.decided_by}`
      }
      /* ── B8：批准是**人的判断**，不是代理给自己发的许可证 ──────────────
       *
       * 原来这条只写在 description 里（"do not approve your own request"）——
       * 那是提示词，不是约束：一个被派出去的分队完全可以在自己的回合里
       * 调 board_approval_decide 把待决的高危动作批了，然后继续干。
       *
       * 现在改成结构性拒绝，依据是**持久的创建元数据**：`session.header.origin`
       * 为 `'subagent'` 的会话是代理派生的子会话（spawn / fork / continuable 都会盖这个戳，
       * 与上面 critical-rules 用的是同一个字段）。子会话批准 = 代理自我授权。
       *
       * 边界（诚实）：这**不能**证明顶级会话里那次批准背后真的坐着一个人类 ——
       * 人类的话本来也是通过同一个会话传下来的，会话 id 分不出来。
       * 它掐掉的是**具体的**那条路：主将派 20 个分队，其中一个自己把待决请求批了。
       * 所以裁决时把 origin 一并写进卡片，让后来的审计看得见是谁批的。
       *
       * `denied` 不受限：拒绝是收力，任何身份都该能做（fail-safe）。 */
      const origin = exec?.agent?.session?.header?.origin ?? null
      if (decision === 'approved' && origin === 'subagent') {
        return (
          'REFUSED: a subagent cannot record an approval. ' +
          'An approval is a human judgement; letting a spawned child write it is the agent authorising itself. ' +
          `Leave the request PENDING (${card.id} on ${card.action_class} ${card.target}) and ask the lead/human to decide. ` +
          'Denying is not restricted — if the action is wrong, deny it.'
        )
      }
      card.status = decision
      card.decided_at = nowIso()
      card.decided_by = caller
      /* 记下裁决者的身份来源：能走到这里的会话**没有**子会话戳。
         ★ 查过类型声明：`origin?: 'subagent'` 是它唯一的取值 ——
         顶级（人类在场）会话是**没有这个字段**，不是 'user'。
         所以这里记 `null` 的意思是"调用方不带子会话标记"（这是事实），
         **不是**"已证明背后有人类"。别把 null 读成后者。 */
      card.decided_by_origin = origin
      card.reason = args.reason ? String(args.reason) : null
      await writeCard(root(), 'approvals', card)
      mirror.approvals.set(approvalKey(card.action_class, card.target), decision)
      return `DECIDED ${card.id} status=${decision} (${card.action_class} on ${card.target})`
    },
  })

  /* ── pause / resume ─────────────────────────────────────────────── */

  /**
   * Stop the team without losing anybody's objective.
   *
   * The problem this solves is not "how do I tell everyone to stop" — that is a
   * message. It is that a claim is a lease with a TTL, so an untended pause
   * expires every claim and the team comes back to a board where the work they
   * held is up for grabs and their own objectives look abandoned. Pause plus a
   * matching resume makes the lease measure WORKING time, which is what it was
   * always meant to measure.
   */
  register({
    name: 'board_pause',
    description:
      'Stop the board: refuse all writes until board_resume. Reads keep working. Use for a coordinated halt (break, scope change, waiting on approval, end of day) instead of telling everyone to idle — a claim lease keeps running otherwise and would expire. Active claim leases are extended by the pause duration on resume, so nobody loses an objective.',
    parameters: {
      reason: { type: 'string', description: 'Why the board is stopping, for the record.' },
    },
    async run(args) {
      if (pauseState.paused) {
        return `ALREADY PAUSED since ${pauseState.since}${pauseState.reason ? ` (${pauseState.reason})` : ''}`
      }
      pauseState.paused = true
      pauseState.since = nowIso()
      pauseState.reason = args.reason ? String(args.reason) : null
      // A pending patrol tick would wake the lead into a paused board.
      if (patrol.timer !== null) {
        clearTimeout(patrol.timer)
        patrol.timer = null
      }
      patrol.dueAt = null
      /* 暂停是**人下的命令**（命令本身就落在 pause 卡上），所以这里清 pending
         不算静默销毁；但 pending 的"最旧一条入队时刻"必须一起归零，否则恢复后
         的第一批新闻会带着暂停前的老年龄，一进来就判超龄。 */
      patrol.pending.clear()
      patrol.since = null
      const objectives = await listCards(root(), 'objectives')
      const live = objectives.filter((o) => holderOf(o))
      return (
        `PAUSED at ${pauseState.since}${pauseState.reason ? ` (${pauseState.reason})` : ''}.\n` +
        `Writes are refused; reads continue. ${live.length} active claim(s) are being held ` +
        `open and will be extended by the pause duration when you call board_resume.\n` +
        (live.length > 0 ? `Held: ${live.map((o) => `${o.id}(${o.claim.agent})`).join(', ')}` : 'No active claims.')
      )
    },
  })

  register({
    name: 'board_resume',
    write: true,
    description:
      'Resume a paused board and extend every active claim lease by the pause duration, so a break does not silently cost the team its objectives. Call this before workers resume.',
    parameters: {},
    async run() {
      if (!pauseState.paused) return 'NOT PAUSED — nothing to resume.'
      const since = pauseState.since
      const pausedMs = Math.max(0, Date.now() - Date.parse(since))
      const objectives = await listCards(root(), 'objectives')
      const extended = []
      for (const objective of objectives) {
        // Only claims that were live when the pause began are extended. A claim
        // that had already lapsed is not resurrected: the pause must not hand
        // anyone back an objective they had really lost.
        if (!objective?.claim || objective.claim.released_at) continue
        const beat = Date.parse(objective.claim.heartbeat_at ?? '')
        if (!Number.isFinite(beat)) continue
        if (Date.parse(since) - beat >= CLAIM_TTL_MS) continue
        objective.claim.heartbeat_at = new Date(beat + pausedMs).toISOString()
        objective.claim.paused_ms = (objective.claim.paused_ms ?? 0) + pausedMs
        await writeCard(root(), 'objectives', objective)
        extended.push(objective.id)
      }
      pauseState.paused = false
      pauseState.since = null
      pauseState.reason = null
      return (
        `RESUMED. Pause lasted ${Math.round(pausedMs / 1000)}s. ` +
        `Extended ${extended.length} claim lease(s) by that amount` +
        (extended.length > 0 ? `: ${extended.join(', ')}` : '') +
        '.\nWorkers may claim and write again. Patrol is live again.'
      )
    },
  })

  /* ── snapshot ───────────────────────────────────────────────────── */


  /* ── 链卡（2026-10-23 加）：让"深度"可计分 ────────────────────────
   *
   *  一条链 = 入口 → 原语 → 权限 → 数据。链本身是一张成果，各跳是子记录。
   *  这样"打到第 3 跳断了"也能被记下来并被看见，而不是变成一张 blocked 卡埋掉。
   */
  register({
    name: 'board_chain_open',
    write: true,
    description:
      'Open a CHAIN card: one exploitation path on one asset, with planned hops. ' +
      'A chain is a first-class result unit — an entry→primitive→privilege→data path counts as ONE result, ' +
      'with each hop recorded inside. Use this instead of filing one card per function point when you are ' +
      'going DEEP on a target. Each hop should be a short checkable goal, e.g. ' +
      '["read config via default key","crack admin password offline","upload php via chunk branch","container root"].',
    parameters: {
      asset_id: { type: 'string', required: true, description: 'Owning asset card id.' },
      entry: { type: 'string', required: true, description: 'The entry point: which interface/credential/foothold this chain starts from.' },
      hops: { type: 'string', required: true, description: 'JSON array of hop titles (planned), in order.' },
      note: { type: 'string', description: 'Why this chain is worth the depth budget.' },
    },
    async run(args, caller) {
      const asset = await readCard(root(), 'assets', String(args.asset_id))
      if (!asset) return `ERROR: unknown asset_id ${args.asset_id}`
      let hops = null
      try { hops = JSON.parse(String(args.hops)) } catch { return 'ERROR: hops must be a JSON array of strings' }
      if (!Array.isArray(hops) || hops.length === 0) return 'ERROR: hops must be a non-empty JSON array'
      const card = {
        kind: 'chain',
        id: newId('chn'),
        asset_id: String(args.asset_id),
        entry: String(args.entry),
        note: args.note ? String(args.note) : null,
        status: 'open',
        hops: hops.map((t, i) => ({ no: i + 1, title: String(t), state: 'pending', evidence: null, missing: null, at: null })),
        reached: 0,
        broken_at: null,
        missing: null,
        outcome: null,
        created_at: nowIso(),
        created_by: caller,
      }
      await writeCard(root(), 'chains', card)
      return `FILED ${card.id} (chain, ${card.hops.length} hops) on ${asset.address || asset.id}\n` +
        `Reached 0/${card.hops.length}. Record progress with board_chain_hop.`
    },
  })

  register({
    name: 'board_chain_hop',
    write: true,
    description:
      'Record ONE hop of a chain. state must be "done" (this hop succeeded — attach evidence) or ' +
      '"blocked" (this hop failed — you MUST say what was missing: tool / permission / authorization / window). ' +
      'A blocked hop does NOT close the chain by itself; it records where the depth stopped and why, ' +
      'which is exactly the information that is lost today when a deep attempt is filed as a bare blocked card. ' +
      'EVIDENCE GRADE (enforced): `evidence` (state=done) or `missing` (state=blocked) must contain exactly one marker — [证据等级: 实证] / [证据等级: 推断] / [证据等级: 转述]; a hop without one is REFUSED.',
    parameters: {
      chain_id: { type: 'string', required: true },
      hop: { type: 'number', required: true, description: '1-based hop number as opened.' },
      state: { type: 'string', required: true, description: 'done | blocked' },
      evidence: { type: 'string', description: 'What proves this hop succeeded (raw request/response snippet, command output). Required for done.' },
      missing: { type: 'string', description: 'What was missing: tool / permission / authorization / time window. Required for blocked.' },
    },
    async run(args, caller) {
      const card = await readCard(root(), 'chains', String(args.chain_id))
      if (!card) return `ERROR: unknown chain_id ${args.chain_id}`
      const st = String(args.state)
      if (st !== 'done' && st !== 'blocked') return 'ERROR: state must be done | blocked'
      const hop = Number(args.hop)
      const h = (card.hops || []).find((x) => x.no === hop)
      if (!h) return `ERROR: no hop ${args.hop} in this chain (it has ${(card.hops || []).length})`
      if (st === 'done' && !args.evidence) return 'ERROR: a done hop needs evidence — "跑了命令"不算证据，要能重放的原文'
      if (st === 'blocked' && !args.missing) return 'ERROR: a blocked hop must say what was missing (tool/permission/authorization/window)'
      /* 证据等级闸门（2026-11-09）：done 看 evidence、blocked 看 missing，两个字段任一带标记即放行。 */
      const ungradedHop = evidenceGradeRefusal('board_chain_hop', args)
      if (ungradedHop !== null) return ungradedHop
      h.state = st
      h.evidence = args.evidence ? String(args.evidence).slice(0, 2000) : null
      h.missing = args.missing ? String(args.missing).slice(0, 500) : null
      h.at = nowIso()
      card.reached = (card.hops || []).filter((x) => x.state === 'done').length
      if (st === 'blocked') { card.broken_at = hop; card.missing = h.missing; card.status = 'blocked' }
      else if (card.reached === card.hops.length) card.status = 'complete'
      else card.status = 'open'
      await writeCard(root(), 'chains', card)
      return `${card.id}: hop ${hop} = ${st} · reached ${card.reached}/${card.hops.length} · status ${card.status}` +
        (card.broken_at ? `\n断在第 ${card.broken_at} 跳：${card.missing}` : '')
    },
  })

  register({
    name: 'board_chain_close',
    write: true,
    description:
      'Close a chain with its OUTCOME. outcome: breached (got privileged access) | data (read business data) | ' +
      'broken (path stopped; broken_at/missing are already recorded by board_chain_hop) | abandoned (we chose to stop). ' +
      'Closing does not file a finding — file one separately if the chain produced a reportable result. ' +
      'EVIDENCE GRADE (enforced): `summary` must contain exactly one marker — [证据等级: 实证] / [证据等级: 推断] / [证据等级: 转述]; a close without one is REFUSED.',
    parameters: {
      chain_id: { type: 'string', required: true },
      outcome: { type: 'string', required: true, description: 'breached | data | broken | abandoned' },
      summary: { type: 'string', description: 'One line: what this chain proved, end to end.' },
    },
    async run(args, caller) {
      const card = await readCard(root(), 'chains', String(args.chain_id))
      if (!card) return `ERROR: unknown chain_id ${args.chain_id}`
      const oc = String(args.outcome)
      if (!['breached', 'data', 'broken', 'abandoned'].includes(oc)) return 'ERROR: outcome must be breached | data | broken | abandoned'
      /* 证据等级闸门（2026-11-09）：整条链的结局也是一条结论。 */
      const ungradedClose = evidenceGradeRefusal('board_chain_close', args)
      if (ungradedClose !== null) return ungradedClose
      card.outcome = oc
      card.summary = args.summary ? String(args.summary).slice(0, 800) : null
      card.status = 'closed'
      card.closed_at = nowIso()
      card.closed_by = caller
      await writeCard(root(), 'chains', card)
      return `CLOSED ${card.id} outcome=${oc} · reached ${card.reached}/${card.hops.length}` +
        (card.broken_at ? ` · 断在第 ${card.broken_at} 跳` : '')
    },
  })

  register({
    name: 'board_snapshot',
    description:
      'Read the whole board. Call this at the START of every planning round, not only at onboarding: the board is the single source of truth, and claims decide ownership. Reports live claims, expired claims, open objectives, finding counts, the result ledger and pending approvals. ' +
      'Also reports `waiting_on` — the DECISION view: every item blocked on a human ruling or on a new decision, with its age in minutes. The work view answers "what is there to do"; the decision view answers "what is stuck on someone". Read both before deciding what this round is for.',
    parameters: {
      verbose: { type: 'string', description: 'Set to "full" to include every card body.' },
    },
    async run(args, caller) {
      const [assets, objectives, findings, intel, approvals, chains] = await Promise.all([
        listCards(root(), 'assets'),
        listCards(root(), 'objectives'),
        listCards(root(), 'findings'),
        listCards(root(), 'intel'),
        listCards(root(), 'approvals'),
        listCards(root(), 'chains'),
      ])
      const at = Date.now()
      const verified = findings.filter((f) => f.result_kind === 'verified')
      const pendingForCaller = pendingOf(caller)

      /* ── 决策视图（原则三：每个输出先证明自己配得上注意力）────────────────
       *
       * 板面原来只回答「有哪些活」（工作视图）。指挥官真正要问的是另一个问题：
       * **「谁在等一个人，等了多久」**。这两件事在数据上完全不同 ——
       * 有活不等于有人被堵住，而没有人被堵住时再多的活也只是噪音。
       *
       * ★ 刻意**推导**而不**存储**：这里没有第二份状态，形态完全由卡片本身算出。
       *   存一份 stage 字段会多出一个真相来源，而两张卡之间的漂移正是本系统
       *   反复踩过的坑（见 CHANGELOG 里"两个真相各自漂"的六类问题）。
       */
      const findingsByObjective = new Map()
      for (const f of findings) {
        const list = findingsByObjective.get(f.objective_id) ?? []
        list.push(f)
        findingsByObjective.set(f.objective_id, list)
      }
      const ageMinutes = (iso) => {
        const t = Date.parse(String(iso ?? ''))
        return Number.isFinite(t) ? Math.round((at - t) / 60000) : null
      }
      const waitingOn = []
      for (const a of approvals.filter((x) => x.status === 'pending')) {
        waitingOn.push({
          kind: 'approval',
          id: a.id,
          action_class: a.action_class ?? null,
          target: a.target ?? null,
          requested_by: a.requested_by ?? null,
          age_minutes: ageMinutes(a.requested_at),
          ask: '由一个人类裁决：批准 / 拒绝。模型自己批自己等于没批（宪章 B8 未落，这里是唯一的替代品）。',
        })
      }
      for (const o of objectives) {
        const records = (o.records ?? []).length
        const produced = (findingsByObjective.get(o.id) ?? []).length
        if ((o.status === 'tested' || o.status === 'closed') && records === 0 && produced === 0) {
          waitingOn.push({
            kind: 'closed_without_evidence',
            id: o.id,
            age_minutes: ageMinutes(o.claim?.released_at ?? o.created_at),
            ask: '补一条记录说明当时测了什么、为什么判干净（board_objective_record），或重开（board_objective_claim）后真去测。',
          })
        }
        if (claimExpired(o, at)) {
          waitingOn.push({
            kind: 'orphaned_claim',
            id: o.id,
            last_holder: o.claim.agent,
            age_minutes: ageMinutes(o.claim.heartbeat_at),
            ask: '分队已失联：重新派兵接手，或交回板面（status="open"）。',
          })
        }
      }
      for (const f of verified.filter((x) => !x.result)) {
        waitingOn.push({
          kind: 'unregistered_result',
          id: f.id,
          objective_id: f.objective_id,
          age_minutes: ageMinutes(f.created_at),
          ask: 'board_result_entry 登记进成果清单。没登记的成果等于没有。',
        })
      }

      const summary = {
        root: root(),
        counts: {
          assets: assets.length,
          objectives: objectives.length,
          findings: findings.length,
          verified: verified.length,
          results_registered: verified.filter((f) => f.result).length,
          intel_blocks: intel.length,
          approvals_pending: approvals.filter((a) => a.status === 'pending').length,
          chains: chains.length,
          chains_open: chains.filter((x) => x.status !== 'closed').length,
        },
        your_unregistered_results: pendingForCaller,
        write_blocked: pendingForCaller.length > 0 || pauseState.paused,
        pause: pauseState.paused
          ? {
              paused: true,
              since: pauseState.since,
              reason: pauseState.reason,
              note: 'All writes are refused until board_resume. Reads continue. Claim leases will be extended by the pause duration.',
            }
          : { paused: false },
        open_objectives: objectives
          .filter((o) => o.status === 'open')
          .map((o) => ({ id: o.id, asset_id: o.asset_id, title: o.title })),
        live_claims: objectives
          .filter((o) => holderOf(o, at))
          .map((o) => ({ id: o.id, holder: o.claim.agent, heartbeat_at: o.claim.heartbeat_at })),
        expired_claims: objectives
          .filter((o) => claimExpired(o, at))
          .map((o) => ({ id: o.id, last_holder: o.claim.agent, heartbeat_at: o.claim.heartbeat_at })),
        released_not_delivered: objectives
          .filter((o) => o.claim?.released_at && o.status === 'tested')
          .map((o) => ({ id: o.id, released_by: o.claim.released_by, at: o.claim.released_at })),
        untested_assets: assets
          .filter((a) => !objectives.some((o) => o.asset_id === a.id))
          .map((a) => ({ id: a.id, address: a.address, port: a.port })),
        /* 决策视图：**谁在等一个人**。工作视图回答"有哪些活"，
           决策视图回答"离达成还差什么"。为空表示没人被堵住 ——
           与"没人在干活"是两件事，同时为空时问题在别处。 */
        waiting_on: waitingOn.slice(0, 12),
        waiting_on_counts: waitingOn.reduce((m, w) => {
          m[w.kind] = (m[w.kind] ?? 0) + 1
          return m
        }, {}),
        waiting_on_truncated: Math.max(0, waitingOn.length - 12),
        waiting_on_note: waitingOn.length === 0
          ? '没有人被堵住。若板面同时也没有战果，那缺的不是裁决而是执行 —— 去派兵。'
          : '这些是"必须有人回答或必须换个决定才动得了"的项。逐条处理，或明确说明为什么这一轮先不处理它。',
      }
      if (String(args.verbose ?? '') === 'full') {
        return JSON.stringify({ ...summary, assets, objectives, findings, intel, approvals }, null, 2)
      }
      return JSON.stringify(summary, null, 2)
    },
  })
}

export default { name, inject, apply }
