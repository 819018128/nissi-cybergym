/**
 * war-lesson-gate — 把「可进化」（P1）从自觉变成闸门。
 * ─────────────────────────────────────────────────────────────────────────
 * 系统宪章 §二 终点状态第 2 条已经写死了这件事：
 *
 *   「每一仗结束都有战法卡入库，或显式声明『本轮无可提炼』并留痕——两者必居其一。」
 *
 * 而 §八「当前已知缺口」把它记成：*战法卡靠自觉写 / 流程缺陷（缺强制）*。
 * 宪章自己知道它在靠自觉。本插件就是那句话的代码形态。
 *
 * 为什么不是再加一段提示
 * ─────────────────────────────────────────────────────────────────────────
 * persona 已经用整段篇幅讲战法库了（「没有这一步，每一仗都是从零开始的新兵」），
 * 而板面读数里 89 张卡最后更新停在 21 小时前。提示词管不住这件事，
 * 因为它的成本落在「这一仗已经打完了、人已经累了」的那个时刻——
 * 恰是最容易跳过的时刻。
 *
 * 对照 board 自己的四条规则（CLAIM-FIRST / NO EVIDENCE NO FINDING / REGISTER
 * BEFORE YOU CONTINUE / GATE THE DESTRUCTIVE CALL）：它们之所以有效，不是因为
 * 写得好，而是因为**做不到就写不进去**。本插件照抄这个形态。
 *
 * 两个落点
 * ─────────────────────────────────────────────────────────────────────────
 *   ① `board_campaign_close` —— 战役收口。**要么给出真实存在的战法卡，
 *      要么给出实质理由声明无可提炼**，二者必居其一；两者都空 → 工具拒绝，
 *      而不是写一条空记录。战法卡必须**在经验库里真的存在**：编一个 slug 不算。
 *   ② `tools.guard` —— 一条链拿到了真东西（outcome = breached | data）却要收口时，
 *      若这一仗还没有任何战役收口记录，拒绝一次并说明下一步。
 *      「有战果、没战法」正是宪章要防的那个失败面，所以它在**产生战果的那条路径上**
 *      拦截，而不是在某个人恰好想起来的时候。
 *
 * 边界（诚实声明）
 * ─────────────────────────────────────────────────────────────────────────
 *   · 本插件不判断战法卡写得好不好。"凑数卡"只有人看得出来，
 *     所以 `no_lesson` 声明与战法卡一样**留痕**，让人一眼能看见谁跳了、跳了几次。
 *   · 镜像（campaigns）有刷新延迟（默认 30s）。守卫是同步的、读不了磁盘，
 *     所以刚写完的收口可能对守卫还不可见——那是刻意的取舍：读盘不进守卫。
 *   · 本插件只**读**板面目录、只写自己的 `campaigns/`，与 bridge 同构。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
/* 证据等级闸门（2026-11-09 裁定④）——**复用 board2 的实现，不复制一份**。
 *
 * 为什么是 import 而不是抄：拒收文案必须与 board2 那六处**逐字一致**，
 * 而两份手抄的文本迟早会漂（本项目已经因为"两份拷贝各自漂"付过代价）。
 * 直接引用同一个函数与同一张字段表，一致性就是**构造上成立**的：
 * 改 board2 那一处 = 同时改七处。
 *
 * 依赖方向：lesson-gate → board2（两个预设里两个插件同目录并列，
 * 相对路径在 war 与 hive 下都成立）。board2 的模块顶层只有常量与 export，
 * 没有副作用，import 它不会触发挂载。
 *
 * 兜底：万一 GRADED_TOOLS 里没有 board_campaign_close 这一条（有人回退了表），
 * 闸门会**拒绝收口并指出要修哪张表** —— 而不是安静地放行（那才是假绿）。
 */
import { GRADED_TOOLS, evidenceGradeRefusal } from '../../board2/lib/index.js'

export const name = 'war-lesson-gate'
export const inject = ['tools']

const OUTCOMES = new Set(['complete', 'partial', 'abandoned'])
/** 只有「拿到真东西」的链条收口才欠一条经验。断链是情报，不是战法。 */
const RESULT_OUTCOMES = new Set(['breached', 'data'])
/** no_lesson 的理由下限：低于这个长度的是敷衍，不是声明。 */
const MIN_REASON = 20

/**
 * xray 采用率的**实测快照**（带日期，不假装是活读数）。
 *
 * 2026-11-06 量 `~/.war/_xray/*.jsonl` 全部 10 个文件：**8,040 条事件，
 * `self-call` 只有 2 条**，且两条都来自同一个会话（是我们自己验证工具时调的一次性
 * `xray_report` / `xray_hotspots`）—— 也就是说，**没有任何一场战役在收口时看过遥测**。
 *
 * 为什么写死而不是每次现算：闸门拒绝时要说清"为什么这是硬的"，它需要的是一个
 * **可复核的事实**，不是一次热路径上的全量扫描（那是当初让战前体检跑到 251 秒的做法）。
 * 数字会变，所以这里带日期：看到它的人知道该重新量一次，而不是把它当永远正确。
 */
const XRAY_ADOPTION_NOTE =
  'xray_* 采用率实测（2026-11-06）：8,040 条事件里只有 2 次调用，且那两次是我们自己的验证调用 —— '
  + '没有任何一场战役在收口时看过遥测'
/** slug 的最短长度：短于此的字符串能命中一堆卡，等于没指代。 */
const MIN_SLUG = 4
const DEFAULT_KB_ROOT = '<KB>'

function nowIso() {
  return new Date().toISOString()
}

function newId() {
  const stamp = nowIso().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `camp_${stamp}_${Math.random().toString(16).slice(2, 6)}`
}

async function listDir(dir) {
  try {
    return await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 在经验库里找一张战法卡。
 *
 * 判据是**文件名主干包含**（不含 `.md`），不是相等：卡片的命名约定是
 * `method-024-<slug>.md`，让人记住前缀没有意义，记住 slug 才有。
 *
 * ══ 2026-11-06 修掉两个"能写进去但其实什么都没证明"的口子 ══
 *
 * ① **绝对路径没有边界**：原来 `path.isAbsolute(needle)` 直接 `stat` 一下就认，
 *    \`lesson: "C:/Windows/win.ini"\` 也能通过 —— 而工具描述里写着"必须落在经验库内"。
 *    现在路径形态必须 resolve 到 `kbRoot` **里面**，越界一律拒绝。
 * ② **子串太松**：原来只要文件名 `includes(needle)`，于是 \`lesson: "md"\`
 *    能匹配到**任何一张卡**（每个文件名都含 `.md`），\`lesson: "a"\` 同理。
 *    现在 slug 至少 {@link MIN_SLUG} 个字符，且只跟**主干**比（不含扩展名）。
 * ③ 顺带把**歧义**变成拒绝：命中多张卡时不静默取第一张（那等于替指挥官猜他指的是哪张），
 *    而是列出候选让他说清楚。
 *
 * @returns {{ok: true, path: string, rel: string} | {ok: false, why: string, [k: string]: any}}
 */
async function findLessonCard(kbRoot, wanted) {
  const needle = String(wanted).trim()
  if (needle === '') return { ok: false, why: 'empty' }

  /* ① 看着像路径的：只接受经验库内部的路径 */
  if (path.isAbsolute(needle) || needle.includes('/') || needle.includes('\\')) {
    const abs = path.resolve(kbRoot, needle)
    const rel = path.relative(kbRoot, abs)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, why: 'outside-kb', abs }
    }
    try {
      const st = await fs.stat(abs)
      if (!st.isFile()) return { ok: false, why: 'not-file', abs }
      return { ok: true, path: abs, rel }
    } catch {
      return { ok: false, why: 'not-found', abs }
    }
  }

  /* ② slug：太短就当没写（"md" / "a" 这种能匹配到任何东西） */
  if (needle.length < MIN_SLUG) return { ok: false, why: 'too-short', needle }

  const lower = needle.toLowerCase()
  const hits = []
  const walk = async (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.name.toLowerCase().endsWith('.md')) continue
      /* 只跟**主干**比：这样 "md" 永远不可能因为扩展名而命中 */
      const stem = entry.name.slice(0, -3).toLowerCase()
      if (stem.includes(lower)) hits.push(full)
      if (hits.length > 8) return // 够了：歧义就是歧义，不必扫完
    }
  }
  await walk(path.join(kbRoot, 'cards'), 0)

  if (hits.length === 0) return { ok: false, why: 'no-card' }
  if (hits.length > 1) {
    return {
      ok: false,
      why: 'ambiguous',
      candidates: hits.map((p) => path.relative(kbRoot, p)),
    }
  }
  return { ok: true, path: hits[0], rel: path.relative(kbRoot, hits[0]) }
}

export function apply(ctx, config) {
  const root =
    typeof config?.root === 'string' && config.root
      ? config.root
      : (process.env.WAR_ROOT || '<HOME>/.war')
  const kbRoot =
    typeof config?.kbRoot === 'string' && config.kbRoot
      ? config.kbRoot
      : (process.env.WAR_KB_ROOT || DEFAULT_KB_ROOT)
  const campaignsDir = path.join(root, 'campaigns')
  const refreshMs = Math.max(0, Number(config?.mirrorRefreshMs ?? 30000) || 30000)

  /** 同步守卫只能看内存：这里镜像「已经收过口的战役」。 */
  const mirror = { campaigns: [], hydrated: false, lastError: null }

  /**
   * 本会话里**主帅**看过遥测没有（xray_* 调用）。
   *
   * ══ 为什么收口要管这件事（2026-11-06）══
   *
   * xray 的四个工具（`xray_report` / `xray_hotspots` / `xray_compare` /
   * `xray_structure`）从上线到实测 5,214 条事件里被调用 **0 次**。
   * 而"0 次"与"没人用"此前无法区分 —— 正是这一类"可计数却无人使用的通道"。
   *
   * 0 次的原因不是工具坏，是**没有任何东西需要它**：preset 的正文一次都没提过它们。
   * 于是它成了纯装饰。对一个"一次战役结束时写复盘"的军团来说，收口前不看
   * 「时间花在哪、卡在哪、有没有空转」，写出来的经验多半只是印象。
   *
   * 处置与「无战法不收口」同一形态、同一纪律：两者必居其一 ——
   *   ① 真的看过遥测（本会话调用过 xray_*）⇒ 自动放行，并把看过哪些记进卡；
   *   ② 或显式声明为什么不看（`telemetry_reason`，下限与 no_lesson 相同）。
   * 两者都空 ⇒ 拒。**声明会留痕**，不是免票。
   *
   * 实测口径见 `XRAY_ADOPTION_NOTE`：8,040 条事件里 self-call 只有 2 条，且那两次
   * 是我们自己验证工具时调的 —— 所以这不是"可能有人忘了用"，而是**从来没人需要过它**。
   *
   * 口径精确：只认主帅自己的调用。工人看遥测不算主帅看过 —— 与 s7 只认
   * 主帅视角是同一条理由：证据要指向「那个负责拍板的人」。
   */
  const telemetry = { seen: new Set(), byAgent: new Map() }
  const leadKeyOf = (agent) => {
    const origin = agent?.session?.header?.origin
    if (origin === 'subagent') return null // 工人不算主帐
    const id = agent?.id
    return typeof id === 'string' && id !== '' ? id : 'unknown-lead'
  }
  const noteTelemetry = (exec) => {
    const toolName = String(exec?.name ?? '')
    if (!toolName.startsWith('xray_')) return
    const key = leadKeyOf(exec?.agent)
    if (key === null) return
    const prev = telemetry.byAgent.get(key) ?? []
    if (!prev.includes(toolName)) telemetry.byAgent.set(key, [...prev, toolName])
  }
  const telemetryFor = (exec) => {
    const key = leadKeyOf(exec?.agent)
    if (key === null) return []
    return telemetry.byAgent.get(key) ?? []
  }

  async function refresh() {
    try {
      const names = (await listDir(campaignsDir)).filter((n) => n.endsWith('.json'))
      const next = []
      for (const n of names) {
        const card = await readJson(path.join(campaignsDir, n))
        if (card && typeof card === 'object') next.push(card)
      }
      mirror.campaigns = next
      mirror.hydrated = true
    } catch (error) {
      mirror.lastError = error?.message ? String(error.message) : String(error)
      // 刷新失败保留上一次镜像：清空会把「已收口」误判成「没写经验」。
    }
  }

  void refresh()
  if (refreshMs > 0) {
    const timer = setInterval(() => { void refresh() }, refreshMs)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'war-lesson-gate:mirror-timer')
  }

  async function writeCard(card) {
    await fs.mkdir(campaignsDir, { recursive: true })
    const file = path.join(campaignsDir, `${card.id}.json`)
    /* 原子写（tmp + rename）：判据量测脚本与镜像刷新都会读这些文件，
       直接 writeFile 会让读者有机会看到半个 JSON。与 board2 的 writeCard 同法。 */
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(card, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, file)
    mirror.campaigns = [...mirror.campaigns, card]
    mirror.hydrated = true
    return file
  }

  /* ── ① 战役收口：战法卡或无可提炼声明，必居其一 ─────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'board_campaign_close',
      description:
        'Close an ENGAGEMENT (a whole 战役), not a task. Requires exactly one of: ' +
        'lesson (a card that ACTUALLY EXISTS in the experience library) or no_lesson (a substantive reason, ' +
        `${MIN_REASON}+ chars). Neither → refused. ALSO requires that the battle\'s own telemetry was looked at: ` +
        'call xray_report() first (or xray_hotspots / xray_compare / xray_structure), or pass telemetry_reason ' +
        `(${MIN_REASON}+ chars) saying why not. This is the code form of the charter end-state ` +
        '"每一仗结束都有战法卡入库，或显式声明本轮无可提炼并留痕". Do this BEFORE closing the chains ' +
        'that produced results — that is what the guard enforces. ' +
        'EVIDENCE GRADE (enforced, same function and same wording as board2\'s six gates): `summary` (or `no_lesson`) ' +
        'must contain exactly one marker — [证据等级: 实证] / [证据等级: 推断] / [证据等级: 转述]; a close without one is REFUSED. ' +
        'Putting the marker inside `lesson` defeats slug resolution, so put it in `summary` or `no_lesson`.',
      parameters: {
        engagement: {
          type: 'string',
          required: true,
          description: 'Which engagement this closes (target / round / campaign label).',
        },
        outcome: {
          type: 'string',
          required: true,
          description: 'complete | partial | abandoned',
        },
        summary: {
          type: 'string',
          description: 'One or two lines: what this battle proved end to end.',
        },
        lesson: {
          type: 'string',
          description: 'Slug or path of the method card you filed (e.g. "method-024-grep-by-meaning"). Must resolve inside the experience library.',
        },
        no_lesson: {
          type: 'string',
          description: `Why there is genuinely nothing to extract (${MIN_REASON}+ chars). This is recorded and visible, not a free pass.`,
        },
        telemetry_reason: {
          type: 'string',
          description: `Required ONLY when this session never called an xray_* tool: why the battle's own telemetry was not consulted (${MIN_REASON}+ chars). Calling xray_report() / xray_hotspots() before closing satisfies this automatically and the card records which ones.`,
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        try {
          const engagement = String(args?.engagement ?? '').trim()
          const outcome = String(args?.outcome ?? '').trim()
          if (engagement === '') return 'ERROR: engagement is required — which 战役 is this?'
          if (!OUTCOMES.has(outcome)) return `ERROR: outcome must be one of ${[...OUTCOMES].join(' | ')}`

          const lesson = String(args?.lesson ?? '').trim()
          const noLesson = String(args?.no_lesson ?? '').trim()

          /* ── 遥测：看过，或声明为什么没看（2026-11-06）──────────────────
           *
           * 见 telemetry 的注释：xray_* 五个多月 0 次调用，而"没人用"与"0 次"同形。
           * 这里的处置与 lesson 完全同构：**两者必居其一**。 */
          const telemetryTools = telemetryFor(exec)
          const telemetryReason = String(args?.telemetry_reason ?? '').trim()
          if (telemetryTools.length === 0 && telemetryReason === '') {
            return (
              'REFUSED: 收口之前没看过这一仗的遥测。\n' +
              '  · 看一眼时间去哪了 → xray_report()（耗时分解 + 堵点 TOP + 空转检测）\n' +
              '  · 想看这套体系有没有变好 → xray_hotspots()\n' +
              '  · 这一仗确实没什么可看（刚开局 / 只有一步）→ telemetry_reason="<为什么>"（' + MIN_REASON + ' 字以上）\n' +
              '为什么这是硬的：' + XRAY_ADOPTION_NOTE + '。' +
              '「写了但没有任何东西需要它」和「坏了」在读数上长得一模一样；收口是它唯一的天然用武之地。'
            )
          }
          if (telemetryReason !== '' && telemetryTools.length === 0 && telemetryReason.length < MIN_REASON) {
            return (
              `ERROR: telemetry_reason is ${telemetryReason.length} chars; the floor is ${MIN_REASON}. ` +
              '不看遥测可以，但要说得让人能复核 —— 和 no_lesson 同一个下限，同一个理由。'
            )
          }

          if (lesson === '' && noLesson === '') {
            return (
              'REFUSED: a campaign close needs EITHER a lesson card OR an explicit no_lesson reason.\n' +
              '  · 有可复用的判断 → 写一张战法卡，然后 lesson="<slug>"\n' +
              '  · 真的没有 → no_lesson="<为什么这一仗提炼不出任何东西>"（' + MIN_REASON + ' 字以上）\n' +
              '这不是形式主义：宪章 §二 终点状态第 2 条的原文就是「两者必居其一」。' +
              '跳过它，下一仗就是从零开始的新兵。'
            )
          }
          if (lesson !== '' && noLesson !== '') {
            return 'ERROR: give lesson OR no_lesson, not both — which one happened?'
          }
          if (noLesson !== '' && noLesson.length < MIN_REASON) {
            return (
              `ERROR: no_lesson is ${noLesson.length} chars; the floor is ${MIN_REASON}. ` +
              'A declaration of absence is still a claim and it gets read by a human later — say why.'
            )
          }

          let lessonPath = null
          let lessonRel = null
          if (lesson !== '') {
            const found = await findLessonCard(kbRoot, lesson)
            if (!found.ok) {
              /* 每一种拒绝都有自己的话：含糊的"卡没找到"会让人以为只是路径问题。
                 ★ 用 switch 而不是对象字面量：对象字面量会**急切**求值每一项，
                 于是 why === 'no-card' 时 `found.candidates.length` 会先炸掉。 */
              switch (found.why) {
                case 'outside-kb':
                  return `REFUSED: "${lesson}" 指向经验库**外面**（${found.abs}）。\n`
                    + '战法卡必须真的落在经验库里——拿一个系统文件的路径来"证明留痕"，不叫留痕。'
                case 'not-file':
                  return `ERROR: "${lesson}" 不是一个文件（${found.abs}）。`
                case 'not-found':
                  return `ERROR: 经验库里没有 ${found.abs}。`
                case 'too-short':
                  return `REFUSED: "${lesson}" 太短（少于 ${MIN_SLUG} 个字符），指代不了一张具体的卡。\n`
                    + '随便两个字母能命中一大堆文件——那不是指代一张卡，那是碰运气。'
                case 'ambiguous':
                  return `REFUSED: "${lesson}" 命中 ${found.candidates.length} 张卡，不知道该算哪一张：\n`
                    + found.candidates.map((c) => '  · ' + c).join('\n')
                    + '\n说清楚是你的活；我不会替你猜。'
                case 'no-card':
                default:
                  return `ERROR: no card matching "${lesson}" under ${path.join(kbRoot, 'cards')}.\n`
                    + '战法卡必须真的存在——编一个 slug 不算留痕。\n'
                    + '先把它写进经验库（method / technique / pitfall / decision 四类，且必须有「反例」章节），再回来收口。'
              }
            }
            lessonPath = found.path
            lessonRel = found.rel
          }

          /* ── 证据等级闸门（2026-11-09 裁定④）· 与上面两条判据**同时**生效 ────
           *
           * 位置是刻意的：放在**一切纯校验之后、唯一那次 writeCard 之前**。
           *   · 纯校验（遥测 / lesson 与 no_lesson 必居其一 / no_lesson 下限 /
           *     战法卡真的存在）都对盘零写入，所以放在它们后面**不会**让"更具体的
           *     错"被这道门槛抢先说话；lesson 指向不存在的卡时，人先看到的是那句
           *     "编一个 slug 不算留痕"，而不是"你缺等级标记"。
           *   · 放在 writeCard 之前 ⇒ **被拒是原子的**：campaigns/ 下不会多出半个战役。
           *
           * 缺任一即拒：不带等级 ⇒ 这里拒；带等级但 lesson 不存在 / no_lesson 太短
           * ⇒ 上面那几条拒。两条判据互不替代。
           */
          if (!Array.isArray(GRADED_TOOLS.board_campaign_close)) {
            return (
              'REFUSED: 等级门槛没接上 —— board2 的 GRADED_TOOLS 里没有 board_campaign_close 这一条。\n'
              + '  这不是"可以不写等级"：收口是全体系最后一道门，宁可不收，也不让它静默放行。\n'
              + '  修法：在 plugins/board2/lib/index.js 的 GRADED_TOOLS 补上\n'
              + "  board_campaign_close: ['summary', 'no_lesson', 'lesson'],"
            )
          }
          const ungradedClose = evidenceGradeRefusal('board_campaign_close', args)
          if (ungradedClose !== null) return ungradedClose

          const card = {
            kind: 'campaign',
            id: newId(),
            engagement,
            outcome,
            summary: String(args?.summary ?? '').slice(0, 1200) || null,
            lesson: lessonPath,
            lesson_slug: lesson || null,
            /* 相对经验库的路径：审计时一眼看出它到底落在哪张卡上，
               不必再去比对 kb_root 前缀（那也是"读起来像证据、实际没信息"的字段）。 */
            lesson_rel: lessonRel,
            no_lesson: noLesson || null,
            /* 遥测口径：看过哪些 xray 工具，或为什么没看。两者必居其一（见 telemetry 注释）。 */
            telemetry: telemetryTools.length > 0
              ? { used: true, tools: telemetryTools, reason: null }
              : { used: false, tools: [], reason: telemetryReason },
            closed_at: nowIso(),
            kb_root: kbRoot,
          }
          const file = await writeCard(card)

          const tail =
            lessonPath !== null
              ? `战法卡：${lessonPath}`
              : `无可提炼（${noLesson.length} 字）：${noLesson}`
          const telemetryTail = telemetryTools.length > 0
            ? `遥测：${telemetryTools.join(' / ')}`
            : `遥测：未看（${telemetryReason.length} 字声明）`
          return (
            `CLOSED ${card.id} engagement="${engagement}" outcome=${outcome}\n` +
            `${tail}\n` +
            `${telemetryTail}\n` +
            `存证：${file}\n` +
            '这一仗现在算打完了。'
          )
        } catch (error) {
          return `ERROR: ${error?.message ?? String(error)}`
        }
      },
    }),
  )

  /* ── ② 战役与战法的记账视图 ──────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'campaign_status',
      description:
        'Read the campaign ledger: which engagements were closed, whether each left a lesson or a no-lesson ' +
        'declaration, and the count of chain-closing still owed a lesson. Call it when you think the battle ' +
        'is over — the ledger, not your memory, says whether it was properly closed.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        try {
          await refresh()
          const rows = mirror.campaigns.map((c) => ({
            id: c.id,
            engagement: c.engagement,
            outcome: c.outcome,
            closed_at: c.closed_at,
            lesson: c.lesson_slug || null,
            no_lesson: c.no_lesson ? String(c.no_lesson).slice(0, 60) : null,
            /* 遥测一格：看过哪些 xray 工具，或"没看 + 理由"。老卡没有这个字段 ⇒ null
               （读不到 ≠ 没看），不要把它当成"没看"。 */
            telemetry: c.telemetry
              ? (c.telemetry.used ? { used: true, tools: c.telemetry.tools ?? [] } : { used: false, reason: String(c.telemetry.reason ?? '').slice(0, 60) })
              : null,
          }))
          const withLesson = rows.filter((r) => r.lesson !== null).length
          const withDecl = rows.filter((r) => r.no_lesson !== null).length
          const withTelemetry = rows.filter((r) => r.telemetry && r.telemetry.used).length
          const telemetryUnseenNoDecl = rows.filter((r) => r.telemetry === null).length
          return JSON.stringify(
            {
              root,
              kb_root: kbRoot,
              campaigns: rows,
              counts: {
                campaigns: rows.length,
                with_lesson: withLesson,
                with_no_lesson: withDecl,
                /** 战法卡与无可提炼声明的比例——这是 P1 最该被看的一格。 */
                lesson_ratio: rows.length === 0 ? null : Number((withLesson / rows.length).toFixed(2)),
                /** 收口时看过遥测的战役数。xray 采用率的账就在这里。 */
                with_telemetry: withTelemetry,
                /** 老卡（判据升级前收的口）—— 读不到 ≠ 没看。 */
                legacy_without_telemetry: telemetryUnseenNoDecl,
              },
              note:
                rows.length === 0
                  ? '还没有任何战役收口。有战果的链条收口会被守卫拦一次，直到这里出现一条记录。'
                  : '收口记录是存证，不是配额：「无可提炼」的声明同样会被人看见。',
            },
            null,
            2,
          )
        } catch (error) {
          return `ERROR: ${error?.message ?? String(error)}`
        }
      },
    }),
  )

  /* ── ③ 守卫：有战果的链条收口之前，必须先留下经验 ─────────────────────── */

  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        try {
          /* 先记遥测（xray_* 调用），再判其它 —— 观察必须发生在放行之前，
             否则"看过遥测"这件事永远晚一拍。 */
          noteTelemetry(exec)
          if (String(exec?.name ?? '') !== 'board_chain_close') return undefined
          const outcome = String(exec?.arguments?.outcome ?? '').toLowerCase()
          if (!RESULT_OUTCOMES.has(outcome)) return undefined // 断链/放弃不欠经验
          if (!mirror.hydrated) return undefined // 还没水合就不拦：宁可漏一次，不要误拦
          if (mirror.campaigns.length > 0) return undefined
          return (
            `war-lesson-gate：这条链拿到了真东西（outcome=${outcome}），而这一仗还没有任何收口记录。\n` +
            '先收口战役，再收口链条：\n' +
            '  board_campaign_close(engagement="…", outcome="complete|partial", lesson="<战法卡 slug>")\n' +
            '  或者 —— 如果这一仗真的没有可复用的判断 ——\n' +
            '  board_campaign_close(engagement="…", outcome="…", no_lesson="<为什么提炼不出>")\n' +
            `战法卡必须在 ${path.join(kbRoot, 'cards')} 里真的存在。\n` +
            '宪章 §二 终点状态第 2 条：两者必居其一，跳过它下一仗就是新兵。'
          )
        } catch {
          return undefined // 闸门自身出错时放行
        }
      }),
    'tools.guard(war:lesson-gate)',
  )
}

export default { name, inject, apply }
