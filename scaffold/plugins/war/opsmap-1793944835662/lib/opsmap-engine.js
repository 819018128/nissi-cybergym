/* 作战地图引擎（磁盘模块）
 *
 * 本文件由 build/make-engine.mjs 从权威源码机械化生成，**不要手改**：
 *   源   : <WORK>/artifacts/opsmap/v14.host.js
 *   生成 : node build/make-engine.mjs
 *   版本 : opsmap-engine/35
 *
 * 生成做的事：去掉末尾的动态插件 apply 块；参数化四处根路径（hiveRoot / doctrineRoot /
 * charterRoot / targetsFile）；把顶层 function 与大写常量全部导出。其余一字未改。
 *
 * 为什么不手抄：手抄清单会漏。这个项目已经在「同一个字面量抄两遍」上栽过两次
 * （验证器把引擎版本号写死；验证器自己另建 payload 且字段表手抄），两次都表现为
 * 「报通过但验的是错东西」。所以导出清单是扫出来的，不是列出来的。
 */

/* 作战地图引擎 v14 — 决策层接进引擎（主攻方向）

   v13 遗留的半迁移状态：doctrine/decision.json 已写在磁盘上，但引擎没加载它；
   metrics.json 已是 v2（17 项指标），而 computeMetrics 只算 13 项，新增的 4 项
   （decisions / blockers / evidenceWindow / timeUnknown）被静默跳过。
   地图能正常跑、不报错，但决策层不在图上 —— 这正是用户问的
   「有什么去驱动进一步去接近目标呢？」没有答案的原因。

   v14 补上：
   ① loadDoctrine 加载 decision.json
   ② buildSchwerpunkt：把 8 类行动 kind 逐类扫板面，按四级规则排序
      （blocking desc → external_pending desc → distance asc → cost asc），
      分两条作战线（文书线 distance≤2 / 突击线 distance≥3）
   ③ computeMetrics 补上那 4 项，指标语义层 17/17 才算完整
   ④ payload 返回 schwerpunkt，客户端新增「主攻方向」页签

   纪律不变：引擎只排序、只给理由，不下决心。指挥权与参谋权分离。

   —— v13 的原始说明（指标语义层）——
   起因（用户原话）：「我看到了16个联网目标……战果41个？什么算作战果，是根据规则来说
   得分了吗？还是说仅仅是一条结论，这条战果又有什么价值呢？」

   诊断：这是【战场总览页的设计缺陷】，不是数据缺陷。地图堆了 7 个 Tile，每个都是简称，
   看的人不知道它是什么、怎么算的、对自己有什么用。「战果 41」尤其有害 —— 它让人以为
   有 41 份战果，实际只有 6 条是「取得的结果」。

   架构答案：数字语义层。每个指标必须回答四问（是什么/怎么算/有什么用/什么时候骗人），
   定义放军法层（doctrine/metrics.json）可进化，数值由引擎实测，答不上第四问的不许上地图。

   顺带修出两个真 bug：
   ① evCount 把「换行分隔的路径串」当成 1 个证据 —— 挂着 20 个证据文件的战果显示「证据 1」。
      实测：41 条里 9 条有证据，共 75 个路径，原来全被压成 1。
   ② 账本用 result_kind 一刀切，把「有实质证据但被判为画像」的 3 条静默归入不计分。
      其中 find-kpblk0 挂着 9 个证据文件、find-bs969x 挂着 5 个。新增 triage 桶显式列出。
*/

const HIVE_ROOT = '<HOME>/.hive'
const DOCTRINE_ROOT = '<HOME>/.dsh/doctrine'
const CHARTER_ROOT = '<HOME>/.dsh/charter'
const TARGETS_FILE = '<KB_PATH>'
const BOARD_DIRS = ['assets', 'objectives', 'findings', 'intel', 'approvals', 'egress']
const CLAIM_TTL_MS = 30 * 60 * 1000
const NEG_CHARS = /[不勿禁无未免别]/

function S(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (s === 'None' || s === 'null' || s === 'undefined' || s === 'nan') return ''
  return s
}

/** evidence 字段两种形状：null，或换行分隔的路径串（也可能是数组）。
 *  v12 用「非空即 1」，把 20 个证据文件压成 1 —— 证据是「不可伪造情报」的物质基础，
 *  这个数字不能错。 */
function evCount(v) {
  if (v === null || v === undefined) return 0
  if (Array.isArray(v)) return v.filter(function (x) { return S(x) }).length
  const s = String(v).trim()
  if (!s || s === 'null' || s === 'undefined') return 0
  return s.split(/\r?\n/).map(function (x) { return x.trim() }).filter(Boolean).length
}
function tsOf(s) { const t = Date.parse(S(s)); return isNaN(t) ? null : t }

function fnv1a32(text) {
  let t = text
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1)
  t = t.replace(/\r\n/g, '\n')
  let h = 0x811c9dc5
  for (const ch of t) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
  return 'fnv1a32:' + ('0000000' + h.toString(16)).slice(-8)
}

async function readText(fs, path) {
  try { const t = await fs.resolve(path); if (!(await fs.stat(t))) return null; return await fs.readText(t) } catch (e) { return null }
}
async function readJson(fs, path) {
  const t = await readText(fs, path)
  if (t === null) return { ok: false, reason: 'not-found' }
  try { return { ok: true, value: JSON.parse(t) } } catch (e) { return { ok: false, reason: String(e && e.message ? e.message : e) } }
}
function entryName(e) {
  if (!e) return ''
  const c = [e.name, e.path, e.fileName]
  for (let i = 0; i < c.length; i++) if (typeof c[i] === 'string' && c[i]) return c[i]
  if (e.target) { const t2 = [e.target.name, e.target.path, e.target.targetKey]; for (let i = 0; i < t2.length; i++) if (typeof t2[i] === 'string' && t2[i]) return t2[i] }
  return ''
}
function entryIsFile(e) {
  if (!e) return false
  if (e.isFile === true || e.type === 'file') return true
  if (e.isDirectory === true || e.type === 'dir' || e.type === 'directory') return false
  return true
}
function base(p) { const s = String(p || '').replace(/\\/g, '/'); const a = s.split('/'); return a[a.length - 1] || s }

async function listBoard(fs, dirName, diag, hiveRoot) {
  const out = []
  try {
    const t = await fs.resolve(hiveRoot + '/' + dirName)
    if (!(await fs.stat(t))) { diag.missing.push(dirName); diag.counts.push(dirName + '=缺'); return out }
    const ents = await fs.listDir(t)
    for (let i = 0; i < (ents || []).length; i++) {
      const e = ents[i]
      if (!entryIsFile(e)) continue
      const nm = entryName(e)
      if (!nm || !/\.json$/i.test(nm)) continue
      const r = await readJson(fs, hiveRoot + '/' + dirName + '/' + base(nm))
      if (r.ok && r.value) out.push(r.value)
      else if (!r.ok) diag.readErrors.push(dirName + '/' + nm + ': ' + r.reason)
    }
    diag.counts.push(dirName + '=' + out.length)
  } catch (e) {
    diag.readErrors.push(dirName + ': ' + String(e && e.message ? e.message : e))
    diag.counts.push(dirName + '=err')
  }
  return out
}

async function loadDoctrine(fs, diag, doctrineRoot) {
  /* ★ 'recon' 是「侦察法」—— 入口未知时该怎么找入口（M5 侦察回流的方法来源）。
         为什么要它：派工层原来只告诉执行者「第 1 步登记资产卡」，**没有任何一句说怎么找入口**，
         而这条命令的实质工作恰恰是侦察 —— 于是「侦察」这件事只存在于动词里，不在步骤里。
         方法写在军法里而不是引擎里，是因为军事思想要能进化、能迭代：
         改 recon.json 不需要碰引擎代码，也不需要动地图副本。
         引擎只负责「这条命令该用哪套方法」，方法本身由军法定义。 */
      const names = ['roe', 'scoring', 'strategy', 'tactics', 'score-table', 'intel-semantics', 'metrics', 'decision', 'identity', 'recon'], out = {}
  for (let i = 0; i < names.length; i++) {
    const r = await readJson(fs, doctrineRoot + '/' + names[i] + '.json')
    if (r.ok) out[names[i]] = r.value
    else { out[names[i]] = null; diag.doctrineMissing.push(names[i] + '.json(' + r.reason + ')') }
  }
  return out
}

function validateChangeLog(log) {
  const issues = []
  if (!Array.isArray(log)) return ['change_log 不是数组']
  for (let i = 0; i < log.length; i++) {
    const e = log[i], tag = 'change_log[' + i + ']'
    if (!S(e.reason)) issues.push(tag + ' 缺 reason')
    const im = e.impact || {}
    if (!im.abandons || !(Array.isArray(im.abandons) ? im.abandons.length : S(im.abandons))) issues.push(tag + ' 缺 impact.abandons')
    if (!S(im.cost)) issues.push(tag + ' 缺 impact.cost')
    if (!im.blocked || !(Array.isArray(im.blocked) ? im.blocked.length : S(im.blocked))) issues.push(tag + ' 缺 impact.blocked')
    if (e.from_version === undefined || e.to_version === undefined) issues.push(tag + ' 缺 from_version/to_version')
  }
  return issues
}

/* ── 宪章字段的双形状辅助（与 criteria 的兼容同一条理由）───────────────
 * 只做形状归一，**不臆造内容**：两侧都没有就如实给空。
 */
function asArr(v) { return Array.isArray(v) ? v : [] }
function asStrings(v) {
  return asArr(v).map(function (x) {
    if (typeof x === 'string') return x
    if (x && typeof x === 'object') return S(x.text || x.name || x.criterion || x.rule)   /* 对象项取它的可读文本 */
    return S(x)
  }).filter(Boolean)
}
/**
 * purpose 归一成**一段可读文本**。
 * 任务宪章：purpose 是字符串。
 * 系统宪章：purpose 是 [{id,name,criterion}, …] —— 原来直接 S() 会得到
 *   `"[object Object],[object Object],[object Object]"`：**一份看起来像数据的垃圾**，
 *   比空白更坏，因为它不会触发任何"缺字段"的判断。
 * @param brief - true 时只取第一条（用于从 purpose 推 objective）
 */
function purposeText(c, brief) {
  const p = c.purpose
  if (typeof p === 'string') return p
  const items = asArr(p).map(function (x) {
    if (typeof x === 'string') return x
    if (!x || typeof x !== 'object') return ''
    const name = S(x.name), crit = S(x.criterion || x.text)
    return name && crit ? name + '：' + crit : (name || crit)
  }).filter(Boolean)
  if (items.length === 0) return ''
  return brief ? items[0] : items.join('；')
}
function asBoundaries(v) {
  return asArr(v).map(function (x) {
    if (!x || typeof x !== 'object') return { rule: S(x), text: '', tier: 'amber', consequence: '' }
    return {
      rule: S(x.rule || x.id),
      /* 系统宪章用 why 承载说明，任务宪章用 text ⇒ 两种都认 */
      text: S(x.text || x.why || x.note),
      tier: S(x.tier) || 'amber',
      consequence: S(x.consequence || x.conseq || ''),
    }
  })
}

async function loadCharter(fs, diag, charterRoot, charterJsonFile) {
  /* ★ 投影文件名参数化（默认仍是 charter.json）。
   *
   *   由来：地图原来**硬编码**读 `charter.json`，而 charter-pin 那边已经改成
   *   「会话绑定哪个目标就读哪份宪章」（goals.json + bindings.json）。
   *   于是同一句话里出现两个目标：锚点说「你的目标是 A」，地图报的是 B 的判据，
   *   而且**没有任何地方会报错**。两个调用点各自漂移正是本项目反复踩的坑。
   *
   *   这里只参数化 JSON 文件名 —— 文档名（charter_doc）本来就从 JSON 里读，
   *   所以换一份投影进来，配对的文档会自动跟上。 */
  const jsonFile = S(charterJsonFile) || 'charter.json'
  const jr = await readJson(fs, charterRoot + '/' + jsonFile)
  if (!jr.ok) { diag.charterMissing.push(jsonFile + '(' + jr.reason + ')'); return { ok: false, error: jsonFile + ' ' + jr.reason } }
  const c = jr.value
  const docFile = S(c.charter_doc) || 'CHARTER.md'
  const docText = await readText(fs, charterRoot + '/' + (S(c.charter_doc) || 'CHARTER.md'))
  const actual = docText === null ? '(文档缺失)' : fnv1a32(docText)
  const expected = S(c.charter_doc_sha256)
  const hashMatch = docText !== null && expected !== '' && actual === expected
  /* ★★ 2026-11-09 加：**投影负载**（这份 JSON 自己）与基线比对。
   *
   *   缺陷：只拿 .md 的哈希去比 JSON 里记的值 —— 改 JSON 而 .md 不动时
   *   hashMatch 照旧 true，于是地图侧也把"投影被改过"读成"同源"。
   *   口径与 tools/verify-system.mjs 的 ④b 一致：fnv1a32 本身已归一化
   *   （BOM 剥离 + CRLF→LF，见本文件 :79-86）；基线 = ~/.dsh/tools/charter-payload.baseline.json
   *   由**人**跑 `node ~/.dsh/tools/verify-system.mjs --pin-charter-payload` 落盘，引擎不维护。
   *   ⚠ 只加这一处判定 + 一个返回字段，**不动地图生成的任何逻辑**。 */
  const baselinePath = String(charterRoot || '').replace(/[\\/]charter[\\/]?$/, '') + '/tools/charter-payload.baseline.json'
  const baselineJr = await readJson(fs, baselinePath)
  const baselineEntry = baselineJr.ok && baselineJr.value && baselineJr.value.files ? baselineJr.value.files[jsonFile] : null
  const projText = await readText(fs, charterRoot + '/' + jsonFile)
  const payloadActual = projText === null ? null : fnv1a32(projText)
  const payload = baselineEntry && typeof baselineEntry.fnv1a32 === 'string'
    ? { file: jsonFile, anchored: true, expected: baselineEntry.fnv1a32, actual: payloadActual, match: payloadActual === baselineEntry.fnv1a32 }
    : { file: jsonFile, anchored: false, expected: null, actual: payloadActual, match: null }
  const violations = validateChangeLog(c.change_log || [])
  const issues = []
  if (docText === null) issues.push(docFile + ' 缺失，无法校验文档与投影是否同步')
  else if (expected === '') issues.push(jsonFile + ' 未记录文档哈希')
  else if (!hashMatch) issues.push(docFile + ' 已变更但 ' + jsonFile + ' 未同步（实际 ' + actual + '，投影 ' + expected + '）')
  /* ★ 2026-11-09：投影负载被改也算一条校验问题。只在**有基线**时判 ——
     没锚定的环境不该凭空多出一条"问题"，那等于把"不知道"说成"坏了"。 */
  if (payload.anchored && payload.match === false) issues.push(jsonFile + ' 与负载基线不符（投影 JSON 被改过；基线 ' + payload.expected + ' · 实际 ' + payload.actual + '）')
  for (let i = 0; i < violations.length; i++) issues.push(violations[i])
  if ((c.change_log || []).length < c.version - 1) issues.push('版本号为 v' + c.version + ' 但 change_log 只有 ' + (c.change_log || []).length + ' 条')
  return {
    ok: true, version: c.version, locked: !!c.locked,
    /* ★★ 宪章字段：**两种形状都要认**（2026-10-22 修，与下面 criteria 同一条理由）
     *
     *   实测差异（不是假想）：
     *
     *     | 概念        | 任务宪章 charter.json          | 系统宪章 system-charter.json   |
     *     |-------------|--------------------------------|-------------------------------|
     *     | objective   | 字符串                          | **没有**（用 purpose[0] 表达）  |
     *     | purpose     | 字符串                          | **{id,name,criterion} 数组**    |
     *     | end_state   | 字符串数组                      | 没有（叫 knownGaps）            |
     *     | boundaries  | {rule,text,tier,consequence}   | **{id,rule,why}**              |
     *     | delegated   | 字符串数组                      | 叫 **delegable**                |
     *     | exit_*      | exit_conditions                | **exitConditions**（驼峰）      |
     *
     *   修前引擎对这些**静默返回空或垃圾** —— 最难看的是：
     *     purpose → `"[object Object],[object Object],[object Object]"`
     *   （因为 `S()` 把对象数组直接字符串化了）。一份**看起来像数据**的垃圾字符串，
     *   比空白更坏：它不会触发任何"缺字段"的判断。
     *
     *   charter-pin 的 normalizeCharter 早就为这些字段写了双形状兼容，
     *   这里照它办 —— 同一份数据、两处读者，两边都得容忍。
     *
     *   ⚠ 认两种形状，但**不臆造**：两侧都没有就如实给空，绝不编一个出来。 */
    objective: S(c.objective) || purposeText(c, true),
    purpose: purposeText(c, false),
    end_state: asStrings(c.end_state || c.endState),
    boundaries: asBoundaries(c.boundaries),
    delegated: asStrings(c.delegated || c.delegable),
    /* ★ 判据：**两种形状都要认**。
     *
     *   实测：两份宪章的 criteria 字段名不一样 ——
     *     任务宪章 charter.json        {id, text, source, checkable}
     *     系统宪章 system-charter.json {id, name, how, baseline20261021, target}
     *   原来这里只读 `x.text`，于是**系统宪章的判据全部解析成空字符串**：
     *   地图算得出 6 条，但每条都没有原文，页签画出来是六行空白 ——
     *   而没有任何地方报错。这正是「硬按一种形状解析会让另一份静默变空」。
     *
     *   charter-pin 的 normalizeCharter 早就为这件事写了双形状兼容
     *   （它的注释把这条陷阱写得很清楚）。这里照它办 —— 同一份数据、两处读者，
     *   两边都得容忍，否则"锚点能显示、地图显示空白"会长期存在且很难解释。
     *
     *   ⚠ 认两种形状，但**不臆造缺失的字段**：都没有就如实给空串，
     *     页签会显示"(判据无原文)"而不是编一个出来。 */
    criteria: (c.criteria || []).map(function (x) {
      return {
        id: S(x.id),
        text: S(x.text || x.name),
        source: S(x.source || x.how),
        checkable: x.checkable !== false,
        blocked_reason: S(x.blocked_reason),
        /* 系统宪章独有、但对读的人有用：判据的目标值。留着，不丢。 */
        target: S(x.target),
      }
    }),
    priority: (c.priority || []).map(S), immutable: (c.immutable || []).map(S),
    /* exit_*：任务宪章叫 exit_conditions，系统宪章叫 exitConditions ⇒ 两种都认 */
    exit_conditions: asArr(c.exit_conditions || c.exitConditions).map(function (x) { return { id: S(x.id), when: S(x.when), action: S(x.action) } }),
    exit_params: c.exit_params || null,
    alignment_metrics: (c.alignment_metrics || []).map(function (x) { return { id: S(x.id), name: S(x.name), use: S(x.use) } }),
    changeLog: { count: (c.change_log || []).length, violations: violations },
    hash: { expected: expected, actual: actual, match: hashMatch, algo: 'fnv1a32 @ unicode code points' },
    /* ★ 2026-11-09：投影负载（JSON 自身）与基线的比对结果，与 hash 并列 ——
       hash 管"文档 vs 投影记的指纹"，payload 管"投影本身有没有被改"。 */
    payload: payload,
    paths: { doc: charterRoot + '/' + (S(c.charter_doc) || 'CHARTER.md'), json: charterRoot + '/' + jsonFile, log: charterRoot + '/CHANGELOG.md' },
    validation: { passed: issues.length === 0, issues: issues, fallback: '不陈明损失就改不了目标 ── 校验不过时引擎退回上一版计算主攻方向' },
  }
}

async function loadTargets(fs, diag, targetsFile) {
  const t = await readText(fs, targetsFile)
  if (t === null) { diag.targets = 'missing'; return null }
  const lines = t.replace(/\r\n/g, '\n').split('\n').map(function (x) { return x.trim() }).filter(Boolean)
  const units = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const noPhishing = /禁止钓鱼/.test(raw)
    const text = raw.replace(/【禁止钓鱼】/g, '').replace(/^#?\s*\d+[.、)]\s*/, '').replace(/[-—–·]\s*$/g, '').trim()
    units.push({ no: i + 1, text: text, noPhishing: noPhishing })
  }
  diag.targets = units.length + ' 行'
  return units
}

function unitKey(text) {
  return S(text)
    .replace(/(应用系统|业务系统|管理系统|管理平台|自动化管理平台|公共服务查询平台|官网|系统|平台|默认|应用)+$/g, '')
    .replace(/[\s\-—–·、,，.。0-9]+$/g, '')
    .replace(/^[\s\-—–·]+/g, '')
    .trim()
}

/** 态势状态机。一家靶标从「不知道往哪打」到「有可计分成果」的五个阶段。 */
function unitStatus(u, chain, scorable) {
  if (!u.covered) return u.intelCovered ? { label: '板面漏登记', color: '#a371f7', rank: 2 } : { label: '零覆盖', color: '#f85149', rank: 0 }
  if (scorable > 0) return { label: '有可计分成果', color: '#3fb950', rank: 5 }
  if (!chain || !chain.objectives.length) return { label: '已登记未立项', color: '#d29922', rank: 3 }
  const hasVerified = chain.findings.some(function (f) { return f.resultKind === 'verified' && !f.dropped })
  if (hasVerified) return { label: '有结果待定档', color: '#d29922', rank: 4 }
  if (chain.findings.length) return { label: '仅画像无结果', color: '#8b949e', rank: 3 }
  return { label: '已交战无结果', color: '#8b949e', rank: 3 }
}

/* ════════ 身份层（归属推导） ════════

   为什么有这一层：归属原先不存在于任何地方，引擎每次加载都要从 service 的散文里
   现场猜。实测 oa.infoepoch.com 因此被判为「清单外资产」—— 同一家单位 #16 的三张卡
   被劈成「已匹配 1 张 + 清单外 2 张」，然后决策层拿这个匹配失败的产物，
   当成「归属未闭环」的事实报了出去。

   架构判词：身份必须是数据，不是散文。详见 doctrine/ADR-001-身份模型.md
   可调策略在 doctrine/identity.json —— 改别名表不需要改这段代码。

   三条不许破的规矩：
   ① 所有路径都跑，取并集。优先级只用来选「主路径」（给一个可读结论），
      绝不用来屏蔽别的路径 —— 正是「第一条路径赢了就跳过后面」造成了这个 bug。
   ② 冲突必须露面。不同路径给出不同单位号 -> 报冲突，不许静默选一个。
   ③ orphan 的含义收窄为「卡上没有任何归属线索」。卡上明写了组织名却归不进任何
      靶标的，进 unresolved。不许把「我没认出来」伪装成「它不属于任何靶标」。
*/

/* #N 锚点必须"贴紧"：贴在串首、或贴在空白之后，且 # 与数字之间不能有空格。
   为什么不能允许 '# 5'：已实测的排版假阳性里，'# 5 / 7x24cc.com' 是【行号】而不是单位号，
   把它当成单位号会导致该单位被重复计数。而真正写在卡上的锚点都是 '#16' 这种紧贴形式。
   实测：#9 / '  #12 ' / '#5' 命中；'# 5' / '--' / '--3' / '--15' 全部不命中。 */
function unitTagRe() { return /(?:^|\s)#(\d+)/g }

/* 可注册域。识别两段公共后缀，否则取后两段。IP 原样返回。 */
const TWO_PART_TLDS = ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'co.jp', 'co.uk', 'com.hk', 'com.tw']
function domainKey(addr) {
  const raw = S(addr).toLowerCase().replace(/:\d+$/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(raw)) return raw
  const parts = raw.split('.').filter(Boolean)
  if (parts.length < 2) return raw
  const last2 = parts.slice(-2).join('.')
  if (TWO_PART_TLDS.indexOf(last2) >= 0 && parts.length >= 3) return parts.slice(-3).join('.')
  return last2
}

/* 一行靶标文本里出现的所有 #N 锚点 */
function unitTagsOf(text) {
  const s = S(text), re = unitTagRe(), out = []
  let m
  while ((m = re.exec(s)) !== null) { out.push(Number(m[1])); if (out.length > 8) break }
  return out
}

/* note 里被提到的单位号 —— 【只做提示，绝不用于归属】
   为什么需要它：note 是【人写下的判断】。实测 bj.10086.cn 的 service 写着「#10 北京移动」，
   note 却写着「一期中标方为 #2 中盈优创」—— 而路径 2/3/4 只扫 address 与 service，
   note 里那句判断引擎根本读不到，等于不存在。这与 #N 锚点是同一类病：
   写在展示文本里、又被当作依据用。
   为什么只做提示：note 是散文，可以写「这不属于 #2」「疑似 #2 的供应链」。
   直接拿它归属会重演「第一条路径赢了就跳过后面」那种错误 —— 把人写的话当成确定事实。
   所以这里只产出「请裁定」的线索，不改任何归属数字。 */
function diagNoteMentions(note) {
  return unitTagsOf(note)
}

/* 资产卡上的显式归属字段。字段名允许若干写法，因为板面工具可能用其中任一个。 */
const UNIT_FIELDS = ['unit', 'unit_no', 'unitNo', 'defender', 'defender_no', 'org', 'org_id', 'target_no']
function explicitUnitsOf(asset) {
  const raw = []
  for (let i = 0; i < UNIT_FIELDS.length; i++) {
    const f = UNIT_FIELDS[i]
    if (asset && asset[f] !== undefined && asset[f] !== null && S(asset[f]) !== '') raw.push(asset[f])
  }
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const s = S(raw[i])
    const m = s.match(/(\d+)/)
    if (m) { const n = Number(m[1]); if (out.indexOf(n) < 0) out.push(n) }
  }
  return out
}

const IDENTITY_PATH_LABELS = {
  'explicit-field': '资产卡的显式归属字段',
  'service-unit-tag': 'service 的 #N 锚点',
  'registry': '人工声明的别名表',
  'unit-name': '名称子串匹配',
  'domain-anchor': '可注册域锚定',
}
const PATH_CONFIDENCE = {
  'explicit-field': 'deterministic', 'service-unit-tag': 'high', 'registry': 'high',
  'unit-name': 'medium', 'domain-anchor': 'medium',
}
const ORG_NAME_RE = /(有限公司|股份有限公司|集团|公司|中心|研究院|事业部)/

/* note 提示的分类标签。两种，含义完全不同，不能混为一谈：
   ① note-conflict  —— note 提到的单位，和引擎实际归属不一致（例如卡归 #10，note 却说 #2 是中标方）
   ② note-orphan    —— note 提到的单位，board 上没有任何一张卡归给它（可能是一家靶标的入口其实已在手里）
   两者都只是【请裁定】，不改任何归属数字。 */
const IDENTITY_NOTE_LABELS = { 'note-conflict': 'note 与实际归属不一致', 'note-orphan': 'note 提到的单位没人认领' }

function buildDomainGroups(chains) {
  const groups = {}
  for (let i = 0; i < chains.length; i++) {
    const a = chains[i].asset
    if (a.zone === 'local') continue
    const k = domainKey(a.address)
    if (!groups[k]) groups[k] = { key: k, addrs: [], anchors: [], dropped: false, seenNos: [] }
    groups[k].addrs.push(a.address)
    const nos = unitTagsOf(a.service)
    for (let j = 0; j < nos.length; j++) {
      groups[k].anchors.push({ addr: a.address, no: nos[j] })
      if (groups[k].seenNos.indexOf(nos[j]) < 0) groups[k].seenNos.push(nos[j])
    }
  }
  // 组内出现两个以上不同单位号 -> 该域不是一家独占，整体放弃锚定（宁可报 unresolved 也不误归属）
  for (const k in groups) if (groups[k].seenNos.length > 1) groups[k].dropped = true
  return groups
}

function collectAttribution(chains, units, idDoc) {
  const perAddr = {}
  const unresolved = [], conflicts = [], multiOwned = [], noteMentions = []
  // knownNos 必须在汇总循环之前就存在：note 盲区自检要用它判断「note 提到的单位号是不是真靶标」。
  const knownNos = {}
  for (let i = 0; i < units.length; i++) knownNos[units[i].no] = true
  const add = function (addr, path, no, evidence) {
    if (!perAddr[addr]) perAddr[addr] = { addr: addr, paths: [], units: [], implicit: [] }
    const rec = perAddr[addr]
    rec.paths.push({ path: path, no: no, evidence: evidence })
    if (rec.units.indexOf(no) < 0) rec.units.push(no)
    if (path !== 'explicit-field') rec.implicit.push(path)
  }

  // ── 路径 1：显式字段
  for (let i = 0; i < chains.length; i++) {
    const a = chains[i].asset
    if (a.zone === 'local') continue
    const nos = explicitUnitsOf(a.raw)
    for (let j = 0; j < nos.length; j++) add(a.address, 'explicit-field', nos[j], 'asset.unit=' + nos[j])
  }

  // ── 路径 2：service 的 #N 锚点（不再"先命中就跳过后面"）
  for (let i = 0; i < chains.length; i++) {
    const a = chains[i].asset
    if (a.zone === 'local') continue
    const nos = unitTagsOf(a.service)
    for (let j = 0; j < nos.length; j++) add(a.address, 'service-unit-tag', nos[j], '#N 锚点（位置合法）')
  }

  // ── 路径 3：人工声明的别名表（中文名 ↔ 域名/IP 段）
  const entries = (idDoc && idDoc.registry) || []
  for (let i = 0; i < chains.length; i++) {
    const a = chains[i].asset
    if (a.zone === 'local') continue
    const hay = a.address.toLowerCase() + '\n' + S(a.service).toLowerCase()
    for (let j = 0; j < entries.length; j++) {
      const e = entries[j]
      const no = Number(e.no)
      if (!no) continue
      let hit = null
      const al = e.alias || []
      for (let q = 0; q < al.length; q++) if (al[q] && hay.indexOf(S(al[q]).toLowerCase()) >= 0) { hit = '别名「' + al[q] + '」'; break }
      if (!hit) {
        const dm = e.domains || []
        for (let q = 0; q < dm.length; q++) {
          const d = S(dm[q]).toLowerCase()
          if (d && (a.address.toLowerCase() === d || a.address.toLowerCase().endsWith('.' + d))) { hit = '域名「' + d + '」'; break }
        }
      }
      if (!hit && e.ip_ranges) {
        for (let q = 0; q < e.ip_ranges.length; q++) {
          const pfx = S(e.ip_ranges[q])
          if (pfx && a.address.indexOf(pfx) === 0) { hit = 'IP 段「' + pfx + '」'; break }
        }
      }
      if (hit) add(a.address, 'registry', no, hit)
    }
  }

  // ── 路径 4：名称子串匹配（兜底）
  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    const key = unitKey(u.text)
    // key 含 '-' 时同时试前半段：unitKey('江苏新纪元…-oa系统') 会留下 '-oa'，与卡上的公司全名对不上
    const keys = [key]
    const dash = key.indexOf('-')
    if (dash > 0) keys.push(key.slice(0, dash))
    for (let q = 0; q < keys.length; q++) {
      const k = keys[q]
      if (k.length < 3) continue
      for (let j = 0; j < chains.length; j++) {
        const a = chains[j].asset
        if (a.zone === 'local') continue
        if (S(a.service).indexOf(k) >= 0 || S(a.address).indexOf(k) >= 0) add(a.address, 'unit-name', u.no, '子串「' + k + '」')
      }
    }
  }

  // ── 路径 5：可注册域锚定（同域已有锚点 -> 整组归该单位）
  const groups = buildDomainGroups(chains)
  for (const k in groups) {
    const g = groups[k]
    if (g.dropped) continue
    const anchorNos = []
    for (let i = 0; i < g.anchors.length; i++) if (anchorNos.indexOf(g.anchors[i].no) < 0) anchorNos.push(g.anchors[i].no)
    if (anchorNos.length !== 1) continue
    const no = anchorNos[0]
    for (let i = 0; i < g.addrs.length; i++) {
      const addr = g.addrs[i]
      const rec = perAddr[addr]
      if (rec && rec.paths.some(function (p) { return p.path === 'service-unit-tag' && p.no === no })) continue
      add(addr, 'domain-anchor', no, '同域 ' + k + ' 下 ' + g.anchors[0].addr + ' 带 #' + no + ' 锚点')
    }
  }

  // ── 汇总：主路径、冲突、多归属、无法定归属
  const chainByAddr = {}
  for (let i = 0; i < chains.length; i++) chainByAddr[chains[i].asset.address] = chains[i]
  const out = []
  for (let i = 0; i < chains.length; i++) {
    const a = chains[i].asset
    if (a.zone === 'local') continue
    const rec = perAddr[a.address]
    // note 里提到的单位号（只做提示，不算归属）—— 必须在下面的 continue 之前算，
    // 否则「note 里提到别的单位」的卡在别处漏掉时就查不出来了。
    const mentioned = diagNoteMentions(a.note)
    const mentionedUnknown = mentioned.filter(function (n) { return !knownNos[n] })
    if (mentioned.length) noteMentions.push({ addr: a.address, mentioned: mentioned.slice(), assigned: rec ? rec.units.slice() : [],
      unknown: mentionedUnknown, note: String(a.note).slice(0, 200) })
    if (!rec || !rec.units.length) { out.push({ addr: a.address, units: [], primary: null, implicit: true }); continue }
    if (rec.units.length > 1) {
      const hits = rec.paths.map(function (p) { return p.path + '→#' + p.no }).join('；')
      conflicts.push({ addr: a.address, units: rec.units.slice(), detail: '不同路径给出了不同单位号：' + hits,
        action: '归属冲突不自动裁定。请人工确认这张卡属于哪一家，或修正 identity.json 的别名表。' })
      multiOwned.push(a.address)
    }
    // 主路径：rank 最高的那条（explicit-field 最高），仅用于给一个可读结论
    const RANK = { 'explicit-field': 1, 'service-unit-tag': 2, 'registry': 3, 'unit-name': 4, 'domain-anchor': 5 }
    let best = rec.paths[0]
    for (let j = 1; j < rec.paths.length; j++) if (RANK[rec.paths[j].path] < RANK[best.path]) best = rec.paths[j]
    out.push({ addr: a.address, units: rec.units.slice(), primary: { path: best.path, no: best.no, evidence: best.evidence },
      confidence: PATH_CONFIDENCE[best.path] || 'medium',
      implicit: !rec.paths.some(function (p) { return p.path === 'explicit-field' }) })

    // 卡上明写了组织名、却归不进任何一家靶标 -> 无法定归属（不是 orphan）
    if (!knownNos[best.no]) {
      const hay = S(a.service) + ' ' + S(a.note)
      const om = hay.match(ORG_NAME_RE)
      unresolved.push({ addr: a.address, unitNo: best.no, orgGuess: om ? String(a.service).slice(0, 70) : '',
        detail: '推导出的单位号 #' + best.no + ' 不在靶标清单（' + units.length + ' 家）内。',
        action: '可能是清单外主体，也可能是身份推导错了。请核对归属，不要直接当成靶标成果。' })
    }
  }
  return { perAddr: perAddr, items: out, unresolved: unresolved, conflicts: conflicts,
    multiOwned: multiOwned, groups: groups, pathLabels: IDENTITY_PATH_LABELS, noteMentions: noteMentions }
}

function matchUnits(units, chains, sem, ledger, idDoc) {
  const attr = collectAttribution(chains, units, idDoc)
  const intelByNo = {}
  // note 盲区自检要用它判断「note 提到的单位号是不是真靶标」（collectAttribution 里的同名变量不在本作用域）
  const knownNos = {}
  for (let i = 0; i < units.length; i++) knownNos[units[i].no] = true
  const scopes = (sem && sem.scope_rulings) || []
  for (let i = 0; i < scopes.length; i++) {
    const r = scopes[i]
    if (r.ruling === 'in-scope' && r.unit) intelByNo[r.unit] = r
  }
  const scorableByAddr = {}
  if (ledger && ledger.ok) for (let i = 0; i < ledger.entries.length; i++) { const e = ledger.entries[i]; if (e.confident) scorableByAddr[e.asset] = (scorableByAddr[e.asset] || 0) + 1 }
  const chainByAddr = {}
  for (let i = 0; i < chains.length; i++) chainByAddr[chains[i].asset.address] = chains[i]

  // 按【所有路径的并集】把资产分给单位（这是根治点：不再由第一条路径决定谁被看见）
  const byUnit = {}
  for (let i = 0; i < attr.items.length; i++) {
    const it = attr.items[i]
    for (let j = 0; j < it.units.length; j++) {
      const n = it.units[j]
      if (!byUnit[n]) byUnit[n] = []
      if (byUnit[n].indexOf(it.addr) < 0) byUnit[n].push(it.addr)
    }
  }
  // 哪些单位号在 board 上【一张卡都没有】—— 供 note 盲区自检判断「没人认领」。
  // 判定必须基于 byUnit（归属并集），不能基于某一张卡的主路径。
  const assignedAnywhere = {}
  for (const k in byUnit) if (byUnit[k].length) assignedAnywhere[k] = true

  const out = [], usedAddr = {}
  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    const hit = (byUnit[u.no] || []).slice()
    for (let j = 0; j < hit.length; j++) usedAddr[hit[j]] = true
    // 每张卡是用哪条路径归进来的（可见性：无法审计的匹配等于没有匹配）
    const attribution = hit.map(function (addr) {
      const it = attr.items.filter(function (x) { return x.addr === addr })[0]
      return { addr: addr, path: it && it.primary ? it.primary.path : '', no: it && it.primary ? it.primary.no : null,
        evidence: it && it.primary ? it.primary.evidence : '', confidence: it ? it.confidence : '',
        implicit: it ? it.implicit : true }
    })
    const paths = []
    for (let j = 0; j < attribution.length; j++) if (attribution[j].path && paths.indexOf(attribution[j].path) < 0) paths.push(attribution[j].path)
    const how = paths.length
      ? paths.map(function (p) { return IDENTITY_PATH_LABELS[p] || p }).join(' + ')
      : ''
    const ir = intelByNo[u.no]
    const rec = { no: u.no, text: u.text, noPhishing: u.noPhishing, assets: hit, covered: hit.length > 0, matchedBy: how,
      paths: paths, attribution: attribution,
      explicit: attribution.filter(function (x) { return x.path === 'explicit-field' }).length,
      implicit: attribution.filter(function (x) { return x.implicit }).length,
      unresolved: attr.unresolved.filter(function (x) { return x.unitNo === u.no }).length,
      noteMentioned: attr.noteMentions.filter(function (x) { return x.mentioned.indexOf(u.no) >= 0 }).length,
      intelCovered: hit.length === 0 && !!ir, intelEntry: ir ? ir.label : '', intelClaim: ir ? ir.claim : '' }
    const ch = hit.length ? chainByAddr[hit[0]] : null
    rec.objCount = ch ? ch.objectives.length : 0
    rec.scorable = hit.reduce(function (n, a) { return n + (scorableByAddr[a] || 0) }, 0)
    rec.status = unitStatus(rec, ch, rec.scorable)
    out.push(rec)
  }

  // orphan 收窄：卡上无任何归属线索才叫清单外。多归属卡（冲突）不计入 orphan —— 它们是待裁定的，
  // 不是「不属于任何靶标」。这条正是为了让「我没认出来」在输出上与「它不属于任何靶标」区分开。
  const orphan = [], unassigned = []
  for (let i = 0; i < chains.length; i++) {
    const a = chains[i].asset
    if (a.zone === 'local') continue
    if (usedAddr[a.address]) continue
    const it = attr.items.filter(function (x) { return x.addr === a.address })[0]
    if (it && it.units.length) { unassigned.push(a.address); continue }
    orphan.push(a.address)
  }

  const byStatus = {}
  for (let i = 0; i < out.length; i++) byStatus[out[i].status.label] = (byStatus[out[i].status.label] || 0) + 1

  // 完整性自检：同域已有锚点，却仍有卡落在 orphan / unresolved —— 这正是 infoepoch 那个案子
  const checks = []
  const groups = attr.groups
  for (const k in groups) {
    const g = groups[k]
    if (g.dropped || !g.anchors.length) continue
    const lonely = g.addrs.filter(function (addr) {
      const it = attr.items.filter(function (x) { return x.addr === addr })[0]
      return !it || !it.units.length
    })
    if (lonely.length) checks.push({ id: 'domain-split', severity: 'high', domain: k,
      detail: '同域 ' + k + ' 下 ' + g.anchors[0].addr + ' 带 #' + g.anchors[0].no + ' 锚点，却有 ' + lonely.length + ' 张卡没有归属：' + lonely.join(', '),
      action: '同域内不该出现这种分裂。请确认这几张卡是否属于同一家，必要时补 identity.json 别名或补 service 锚点。' })
  }
  for (const k in groups) {
    const g = groups[k]
    if (!g.dropped) continue
    checks.push({ id: 'domain-ambiguous', severity: 'medium', domain: k,
      detail: '同域 ' + k + ' 下出现了多个不同单位号（#' + g.seenNos.join(', #') + '），该域已整体放弃锚定。',
      action: '这个域不是一家独占。请人工确认每张卡的归属。' })
  }
  const implicitTotal = out.reduce(function (n, x) { return n + x.implicit }, 0)
  if (implicitTotal) checks.push({ id: 'implicit-ownership', severity: 'medium', domain: '',
    detail: implicitTotal + ' 张卡的归属是推导出来的，不是声明出来的。',
    action: '这不是错误，是「身份还没成为数据」的度量。它的数量应当单调下降 —— 给资产卡补归属字段即可。' })

  // note 盲区自检：note 是人写下的判断，而路径 2/3/4 只扫 address+service，
  // note 里写了归属却没人读 —— 这与 #N 锚点是同一类病。这里只报，不改归属。
  const nmConflict = attr.noteMentions.filter(function (x) {
    return x.mentioned.some(function (n) { return knownNos[n] && x.assigned.indexOf(n) < 0 })
  })
  const nmOrphan = attr.noteMentions.filter(function (x) {
    return x.mentioned.some(function (n) { return knownNos[n] && !assignedAnywhere[n] })
  })
  const noteUnassignedTotal = nmOrphan.length
  if (nmConflict.length) checks.push({ id: 'note-mention-unread', severity: 'medium', domain: '',
    detail: nmConflict.length + ' 张卡的 note 里写着某个单位号，与实际归属不一致，而引擎的推导路径不读 note。',
    action: 'note 是人写的判断。请逐条裁定：是 note 写错了，还是引擎归错了？裁定结果应写回资产卡的 unit 字段，不要停在散文里。' })
  if (nmOrphan.length) checks.push({ id: 'note-mention-orphan', severity: 'high', domain: '',
    detail: nmOrphan.length + ' 张卡的 note 提到某个单位，而 board 上没有任何卡归给那个单位。',
    action: '这可能意味着一家靶标的入口其实已经在我们手里，而地图没把它算进去。请核对并补卡或补 unit 字段。' })

  return { units: out, orphan: orphan, unassigned: unassigned, byStatus: byStatus,
    covered: out.filter(function (x) { return x.covered }).length,
    missing: out.filter(function (x) { return !x.covered }),
    intelCovered: out.filter(function (x) { return x.intelCovered }),
    realGap: out.filter(function (x) { return !x.covered && !x.intelCovered }),
    // ── 身份层输出
    identity: {
      doctrineLoaded: !!(idDoc && idDoc.version), doctrineVersion: idDoc ? idDoc.version : null,
      registryEntries: ((idDoc && idDoc.registry) || []).length,
      paths: (idDoc && idDoc.paths) || [], pathLabels: IDENTITY_PATH_LABELS,
      items: attr.items, conflicts: attr.conflicts, multiOwned: attr.multiOwned,
      unresolved: attr.unresolved, checks: checks, domainGroups: groups,
      noteMentions: attr.noteMentions, noteMentionLabels: IDENTITY_NOTE_LABELS,
      counts: { resolved: attr.items.filter(function (x) { return x.units.length }).length,
        explicit: attr.items.filter(function (x) { return x.units.length && !x.implicit }).length,
        implicit: implicitTotal,
        unresolved: attr.unresolved.length, conflicts: attr.conflicts.length,
        noteMentions: attr.noteMentions.length, noteUnassigned: noteUnassignedTotal,
        orphan: orphan.length, unassigned: unassigned.length },
      discipline: idDoc ? idDoc.discipline : null,
      principle: idDoc ? idDoc.principle : '',
      orphanDefinition: idDoc ? idDoc.orphan_definition : null,
    } }
}

/* ★★ 第 25 轮：把 PERM_RE 拆成两个模式 —— 它们**不是一回事**。
 *
 * 修前只有一个 `PERM_RE`，里面同时装着两类完全不同的词：
 *   「无鉴权/无凭据/免认证/匿名可达」 ← **发现某端点没有防护**（absence）
 *   「登录成功/getshell/命令执行/写入成功」 ← **真的取得了权限**（obtained）
 *
 * 后果（实测，不是推测）：真实板面 7 条 verified 里有 4 条被判 confident，
 * **4 条的命中词全部是 absence 类**（免认证 / 无凭据 / 匿名可达 / 无鉴权），
 * 而其中一条自己的原文写着「零凭据可进入真实 Spring Controller 体（**未取到数据**）」。
 * 于是引擎报出 [20, 3000]、类别 important-system ——
 * 把「发现没锁门」记成了「取得了重要业务系统权限」。
 *
 * 而 score-table 的 projection.why 写得很清楚：
 *   「计分表计量的是【取得的权限】与【取得的数据】」
 * 所以这是**在计分层面把未证实的东西说成已证实** ——
 * 正是本项目那条硬纪律（不可伪造情报）的形态，只是发生在分数上而不是卡面上。
 *
 * 判据的分工（对齐 score-table 的档位定义）：
 *   · obtained_only → 有"取得"证据 → 才谈得上 important-system（3000/2000）
 *   · absence_only  → 只发现没防护 → 至少满足 general-web-normal 的 20 分档，
 *                     但**上界不给 3000**：没拿到权限就不该按权限计分
 *   · 两者都有      → 走 obtained
 *
 * ⚠ 关于下界：score-table 的 lower_rule 说「有一般 Web 级别证据时下界 20」。
 *   absence 类命中**确实**构成"一般 Web 级别证据"（零凭据可达一个 web 端点），
 *   所以下界 20 是有依据的、保留。改动的是**上界与 confident 判定**，
 *   也就是把"未被证实的部分"从"已确定"降回"待研判"。
 *   ⚠ 阈值 20 是从 score-table 的 general-web-normal.values.default 读的，
 *   不是我自己定的常量。
 *
 * ⚠ 「直连内部」「可进入真实」原来在 obtained 里，实测发现它们**只支持"可达"**：
 *   find-3hxzsd 的原文是「免认证访问：…反向代理前缀 /file-store 完全未挂」——
 *   那是"没挂鉴权过滤器"，不是"拿到了权限"。
 *   把可达类断言留在 obtained 里，等于让"能走到门口"冒充"进了屋"。
 *   要证明取得，需要的是「读取到 / 取到了 / 导出数据 / 写入成功 / 执行命令」
 *   这类**动作完成**词。 */
const OBTAINED_RE = /越权|权限绕过|认证绕过|绕过认证|默认口令|弱口令|登录成功|成功登录|已登录|接管|getshell|命令执行|代码执行|反序列化|文件上传成功|写入成功|上传成功|任意文件读取|列目录|读取到|读出|uid=0|(?:取得|拿到|获得|即得|得到|登录得).{0,12}(?:权限|超级用户|管理员|root|admin|令牌|token|控制面|管理面|全量|flag)|取到了|导出.{0,4}数据|提权/i
/* ★★ 第 28 轮 B 组①：上面这一版比第 25 轮多了三种**真实成果里出现过、原正则却咬不住**的形态：
 *   · `读出`   —— 原词表只有「读取到」。「容器内 uid=0 **读出**宿主 /etc/passwd」是拿到了，
 *                 却因为少一个字被判 absence-only / 100。
 *   · `uid=0`  —— 「容器内 uid=0 写入标记文件」是宿主机上的 root 写原语，
 *                 原词表里没有任何一项能命中，于是整条落进 no-evidence / 0。
 *   · 「取得…X」—— 原式写死 `取得.{0,6}权限`，要求后面必须跟「权限」两个字。
 *                 实测「取得 role=admin 全量**令牌**」「取得本场 **FLAG**」「取得**管理面**」
 *                 「无口令即得 postgres **超级用户**」全都不匹配 —— 取得的东西不叫"权限"，
 *                 但它是取得。所以把目标词表化，而不是绑死一个"权限"。
 *   边界（写在这里防过度外推）：这不是"看到取得就加分" —— 每个命中点还要过下面的
 *   否定就近否决（negatedNear），否则「未接管账号」照样算取得（B 组③）。 */
const OBTAINED_ALL_RE = new RegExp(OBTAINED_RE.source, 'gi')
const ABSENCE_RE = /未授权|无凭据|无鉴权|未鉴权|无需鉴权|免认证|免登录|匿名可达|匿名访问|匿名注册|直连内部|可进入真实/i
/* ★★ 「成果自己声明没取到东西」时必须压过上面任何一个命中。
 *
 * 为什么必须单列：实测踩到 —— `find-r8lq0w` 的原文写着
 *   「零凭据可进入真实 Spring Controller 体（**未取到数据**）」
 * 里面既有 OBTAINED 类词「可进入真实」，又有明确的**自我否定**「未取到数据」。
 * 只按关键词命中就会判成 confident、上界 2000 —— 而成果自己在说"没拿到"。
 *
 * 这与本项目那条判据同形：**文本里出现某个词，和文本想表达的意思，不是一回事**。
 * 关键词匹配只能证"提到了某件事"，不能证"做到了某件事"；
 * 而当文本明确否认时，必须以否认优先 —— 宁可少报分，不可把没拿到的说成拿到了。 */
const NEGATED_RE = /未取到|未拿到|未获取到|未取得|未成功|没有取到|未能取到|未真正获取|未实际获取|未获得|未接管|未写入|未读出|未读取到|不成立|否证|仅证明.{0,8}可达|不等同于.{0,6}取得/i
/* ★★ 第 28 轮 B 组③：关键词无上下文，「未接管账号」照样命中「接管」。
 *
 * 修前只有 NEGATED_RE 这张**全句词表**兜底：一句里恰好还写着「未取得」才有救。
 * 换个否认措辞（「并未接管」「没能接管」「接管不成立」）就翻成 obtained / 2000。
 * 现在做**就近否决**：命中点前 14 字 / 后 10 字内出现否定标记，该命中点作废。
 *
 * ⚠ 这是就近判据，不是语义理解：**同句远处的否定不否决**（实测 find-gvh1n6 的
 *   「**未登录**的登录页源码里…及默认**口令**」若按整句判就会被误否决，
 *   而那是一条真取得了默认口令的成果）。把窗口写窄，是为了能解释每一次否决。
 * ⚠ 窗口里刻意**不含裸「无」和裸「不」**：「无口令即得 postgres 超级用户」里
 *   「无口令」是**正面**（无需凭据），把它当否定会把真成果压掉。 */
const NEG_NEAR_RE = /未|没|无法|未能|不能|不是|并非|不成立|否证|失败|无效/
/* ★★ 第 28 轮 B 组③之二：三种「上下文说的不是取得」的情形，逐条都是实测踩出来的假阳性，
 * 全部来自同一条纪律 —— **文本里出现某个词，和文本想表达的意思，不是一回事**。
 *
 * ① 紧邻否定（1 字）：`无越权`、`未接管`。裸「无/不」不能进 NEG_NEAR_RE 的宽窗口
 *    （「**无口令**即得 postgres 超级用户」里的"无口令"是正面：无需凭据），
 *    但它**紧贴在命中点前一个字**时确实是否定：「当前直连无中介，**无越权**（认证逐请求…）」。
 *    所以给它一个只认紧邻的窄规则，而不是把"无"扔进宽窗口。
 * ② 假设态：`口令**一旦被猜中**即直接取得宿主 uid=0`——18 发有界尝试未命中，
 *    这一役什么都没拿到。命中点前面 20 字里出现"一旦/若/如果/假如"的，
 *    那是**条件句**，不是战绩。②这条不修，整张账本会把"如果猜中就能拿"记成"拿到了"。
 * ③ 量纲名词尾：`账号**接管**成本被压到"枚举位数"级别`——"接管"在这里是成本的名词修饰，
 *    不是已发生的事。命中点后面紧跟"成本/难度/门槛/概率/风险"的一律不作取得证据。 */
const NEG_ADJ_RE = /[未没不非零无]$/
const HYPOTHESIS_RE = /一旦|若|如果|假如|倘若|设若|要想|需先|猜中/
const NOUN_TAIL_RE = /^(?:成本|难度|门槛|概率|风险|可能性)/
/** 判定 text 中 [at, at+len) 这个命中点的上下文是否在否定它（或让它不是"取得"） */
function negatedNear(text, at, len) {
  const s = String(text || '')
  const head = s.slice(Math.max(0, at - 20), at)
  const tail = s.slice(at + len, Math.min(s.length, at + len + 10))
  if (NEG_ADJ_RE.test(head)) return true                              /* ① 紧邻否定 */
  if (NEG_NEAR_RE.test(head) || NEG_NEAR_RE.test(tail)) return true   /* ② 就近否定窗口 */
  if (HYPOTHESIS_RE.test(head)) return true                           /* ③ 假设态 */
  if (NOUN_TAIL_RE.test(tail)) return true                            /* ④ 量纲名词尾 */
  return false
}
/* 兼容旧名：其他地方若引用 PERM_RE，语义仍是"任一类权限相关词" */
const PERM_RE = new RegExp(OBTAINED_RE.source + '|' + ABSENCE_RE.source, 'i')
const DATA_HINT_RE = /源码|源代码|数据库|个人敏感|身份证|手机号|用户信息|会话凭据|私钥|泄露了.*数据|数据泄露/i
/* ★ 第 26 轮：`data` 类目的识别与排除（对齐 score-table 的 categories[data].types / .excluded）。
   types 原文：「个人敏感数据 / 研发设计数据（代码行数÷10 后按数量计分）/ 生产运行数据 /
                安全保障数据 / 关键技术成果数据（上限 5000）」
   excluded 原文：「已在互联网或公开渠道公布的数据不计分」 */
const DATA_TYPE_RE = /个人敏感数据|研发设计数据|生产运行数据|安全保障数据|关键技术成果数据|源代码|源码|sourcemap|数据库|用户信息|个人信息|身份证|手机号/i
/* ★★ 第 26 轮：光有"类别词"不算数据成果 —— 必须**同时**有"取得/泄露"的表述。
 *
 * 为什么：第一版只用 DATA_TYPE_RE 判类别，实测立刻误判两条：
 *   · find-74b7fy「cc.icsoc.net **源码**硬编码凭据为 0」—— 它在说"我查过源码，没凭据"，
 *     那是**画像**，不是"取得了源码"
 *   · find-xg8u9o「cc.icsoc.net **前端源码**注入/RCE sink 面画像」—— 同上
 * 两条都只是在**描述目标**时提到了"源码"，并没有取得任何数据。
 * 这与 PERM_RE 那个坑同形：**词出现了 ≠ 那件事发生了**。
 *
 * 所以判据是两个条件的**合取**：类别词命中 **且** 取得/泄露表述命中。
 * 宁可漏报（profile 类本来就不计分），不可误加分。 */
const DATA_OBTAINED_RE = /泄露|泄漏|可读取|任意站点可|任意 Origin|可还原|可下载|未混淆|落盘|明文|可读|公开投递|跨域读取/i
const PUBLIC_DATA_RE = /已在互联网|公开渠道|已公开|公开数据|官网公开|互联网上已/i
/* ★ 第 27 轮：判断一条成果是否**自己声明了"没拿到东西"**（用于 triage 分桶）。
   比 NEGATED_RE 更宽：还包括"非业务数据 / 零副作用 / 早退分支 / 空响应 / 否证 / 不通"——
   这些都是**结论性**的否定表述，出现即说明这条成果的结论就是"没有取得结果"。 */
const TRIAGE_SELF_NEG_RE = /未取到|未拿到|未获取到|未取得|未成功|没有取到|未真正获取|未实际获取|非业务数据|零副作用|零账号|未执行|不通|不成立|否证|早退分支|空响应|空字节串|未回落|未实际注册/i

function buildLedger(chains, table, exclusions) {
  if (!table) return { ok: false, error: 'score-table.json 未加载' }
  const proj = table.projection || {}
  const scorable = proj.scorable_result_kinds || ['verified']
  const cats = {}
  for (let i = 0; i < (table.categories || []).length; i++) cats[table.categories[i].id] = table.categories[i]
  const impVals = (cats['important-system'] && cats['important-system'].values) || {}
  const othVals = (cats['other-business-system'] && cats['other-business-system'].values) || {}
  const CEIL_T = impVals.internet || 3000, CEIL_O = othVals.internet || 2000

  const entries = [], uncertainty = [], dropped = [], triage = [], triageNegated = []
  let confident = 0, needsJudgement = 0, unpriced = 0, ceiling = 0

  for (let i = 0; i < chains.length; i++) {
    const c = chains[i]
    if (c.asset.zone === 'local') continue
    const isTargetSystem = /#\d+/.test(S(c.asset.service))
    for (let j = 0; j < c.objectives.length; j++) {
      const o = c.objectives[j]
      for (let q = 0; q < o.findings.length; q++) {
        const f = o.findings[q]
        const ex = exclusions && exclusions[f.id]
        if (ex && ex.ruling === 'exclude') {
          dropped.push({ finding: f.id, asset: c.asset.address, cls: ex.class || '剔除', claim: ex.claim || '', by: ex.by || '', summary: String(f.summary).slice(0, 160) })
          continue
        }
        /* ★★ 第 28 轮 A 组：判档输入 = summary + result。
           修前这里是 `f.summary + ' ' + f.result`，而 normalize 把 result 压成了
           "[object Object]"（见 resultText 的注释）—— 等于只有 summary 一个字段参与判定，
           result.title / result.impact 从未被读。现在 result 已被摊平成同一条本文。 */
        const text = S(f.summary) + ' ' + S(f.result)
        /* ★★ 第 26 轮：`data`（数据成果）是**第二条独立的计分轴**，引擎从来没算过。
         *
         * score-table 的 data 类目和权限类目不是同一件事：
         *   · 权限类 = "拿到了什么级别的权限" → important-system 3000 起
         *   · data   = "取得了多少数据"       → values_by_count 按**条数**分 6 档：
         *              50-1000 → 100 / 1001-5000 → 300 / 5001-10000 → 500
         *              / 10001-30000 → 1000 / 30001-50000 → 1500 / 50001+ → 2000
         *   而且 types 里明确写了「研发设计数据（**代码行数÷10 后按数量计分**）」。
         *
         * 实测后果：`find-6ck2e3`（webpack sourcemap 泄露，**可还原 803,958 B 原始源码**）
         * 被判成 needsJudgement / 上界 3000 —— 那是**权限档**的数，
         * 而它真正的分应该在 data 轴上。引擎拿权限的尺子量数据成果，于是要么虚高要么漏报。
         *
         * ⚠ 边界：`excluded` 写着「已在互联网或公开渠道公布的数据不计分」。
         *   所以不能见到 "源码/数据库" 就加分 —— 必须**来源不是公开渠道**。
         *   判据取成果自己的措辞（有"公开""互联网""官网"等字样即视为公开）。
         *
         * ⚠ 为什么这次只标 `unknown` 而不给点估计：规格要的是**条数**，
         *   而成果里通常只有字节数（803,958 B）。字节→条数要假设平均行宽，
         *   那是我编的。所以规则允许"数量未知则待研判" —— **按规则来，不编数**。 */
        let dataScore = null
        {
          const typeHit = DATA_TYPE_RE.exec(String(f.summary || ''))
          const isPublic = PUBLIC_DATA_RE.test(String(f.summary || ''))
          /* ★ 合取：类别词 **且** 取得/泄露表述。只看类别词会误判画像类成果（见 DATA_OBTAINED_RE 注释）。 */
          const obtHit = DATA_OBTAINED_RE.exec(String(f.summary || ''))
          if (typeHit && obtHit && !isPublic) {
            const codeType = /代码行数|研发设计/.test(typeHit[0])
            /* 尽力从文本里抠一个**条数/行数**出来；抠不到就明确标 unknown */
            let n = null
            const lm = /(\d[\d,]{2,})\s*(?:行|lines?)/i.exec(String(f.detail || '') + ' ' + String(f.summary || ''))
            if (lm) n = Number(String(lm[1]).replace(/,/g, ''))
            const tbl = (cats['data'] && cats['data'].values_by_count) || null
            if (n === null && codeType) {
              /* 代码类：规则说"行数÷10 后按数量计分"。行数没有时，用"sources 数"也不行 ——
                 宁可 unknown。这里只在**确实抠到行数**时才用。 */
              dataScore = { type: typeHit[0], count: null, tier: null, value: null, needsCount: true,
                note: '识别为「' + typeHit[0] + '」，但**数量未知** —— 需要知道条数（代码类还要先除以 10）才能套档位表。不编数。' }
            } else if (n !== null && tbl) {
              let tier = null
              for (const t of tbl) {
                if (n >= t.min && (t.max === null || n <= t.max)) { tier = t; break }
              }
              dataScore = { type: typeHit[0], count: n, tier: tier ? (tier.min + '-' + (tier.max === null ? '+' : tier.max)) : null,
                value: tier ? tier.value : null, needsCount: !tier,
                note: tier ? ('按 data 档位表：' + n + ' 条落在 ' + tier.min + '-' + (tier.max === null ? '+' : tier.max) + ' 档 → ' + tier.value + ' 分')
                  : ('数量 ' + n + ' 不落在任何档位（最小档从 50 起）→ 待研判') }
            } else {
              dataScore = { type: typeHit[0], count: null, tier: null, value: null, needsCount: true,
                note: '识别为「' + typeHit[0] + '」，但**数量未知**，需人工给出条数才能套档位表。' }
            }
            dataScore.rule = 'doctrine/score-table.json 的 categories[data].values_by_count'
            dataScore.publicExcluded = false
          } else if (isPublic) {
            dataScore = { excluded: true, note: '疑似「已在互联网或公开渠道公布的数据」—— 按 score-table 的 excluded 规则**不计分**', rule: 'categories[data].excluded' }
          } else if (typeHit && !obtHit) {
            /* ★ 类别词命中但**没有**取得/泄露表述 → 明确记为"提到但没取得"。
               为什么要留这个记录而不是直接 null：下一个人看到"源码"两个字会以为漏算了，
               这条 note 就是答案 —— 而且它可被探针断言（防止有人把合取条件改回单条件）。 */
            dataScore = { excluded: true, reason: 'mentioned-not-obtained',
              note: '文本提到了「' + typeHit[0] + '」但**没有**取得/泄露的表述（如「源码硬编码凭据为 0」是画像）—— 不构成数据成果，不计分',
              rule: 'categories[data] + 本项目判据：类别词且取得表述，二者缺一不可' }
          }
        }
        const evN = f.evidenceCount || 0
        let lower = 0, upper = 0, cat = null, evidence = '', reason = '', ok = false, nj = false, tr = false
        /* ★ 第 27 轮：这条成果是否**自己声明了"没拿到东西"**。
           用于把 triage 桶里"已由证据本身结论为无"的条目分出去（见下面 triage.push 处）。 */
        let selfNeg = false
        /* 上界按哪条规则给的（obtained / self-negated / absence-only / no-evidence / not-scorable）。
           必须在外层声明 —— 第一版写在 else 分支里，而赋值行在分支外，直接 ReferenceError。
           （这类"作用域写错"在生成物里表现成整个 refresh 崩掉，比静默错更响，反而好抓。） */
        let pricing = 'not-scorable'
        if (scorable.indexOf(f.resultKind) < 0) {
          if (evN > 0) {
            tr = true
            /* ★ 第 27 轮：这条成果**自己声明了没拿到**吗？
               判据与 NEGATED_RE 同源，但这里判的是"整条成果的结论是负面的"，
               所以要额外覆盖"非业务数据 / 零副作用 / 早退分支 / 空响应 / 否证"这类措辞。
               命中的话它就不是"待研判"，而是**已由证据本身结论为无** —— 见 triageNegated。 */
            selfNeg = TRIAGE_SELF_NEG_RE.test(String(f.summary || '') + ' ' + String(f.detail || ''))
            reason = '有 ' + evN + ' 个证据文件（实测做过），但 result_kind=' + f.resultKind + ' 被判为画像 ── '
              + (selfNeg
                ? '**且成果自己声明了没拿到**（如"非业务数据""未取到任何真实业务数据""零副作用"）'
                  + ' → 已由证据本身结论为无，不列为待研判'
                : '须人工研判是否改判为 ' + scorable.join('/'))
          } else {
            reason = 'result_kind=' + f.resultKind + ' 且无证据文件 ── 既不是取得的结果，也不是实测证据，只是攻击面描述'
          }
          unpriced++
        } else {
          /* ★★ 第 25 轮：三类判定，不再把 absence 当 obtained。
             见上面 OBTAINED_RE / ABSENCE_RE 的注释 —— 修前 4 条 confident
             的命中词**全是 absence 类**，其中包括一条自称「未取到数据」的。
             现在：
               · obtained（真取得）→ confident，档位按 important/other-system
               · absence（只发现没防护）→ needsJudgement，下界保留 20（有依据，见注释），
                 **上界不给 3000** —— 没拿到权限就不按权限计分
               · 都没有 → needsJudgement，下界 0 */
          /* ★★ 第 28 轮 B 组：obtained 必须**逐命中点判上下文**，不能只看"整条文本里出现过这个词"。
             修前是 `const obt = text.match(OBTAINED_RE)` —— 一个位置无关的布尔量，
             否定与否全靠 NEGATED_RE 那张全句词表兜底（见 B 组③）。
             现在：obtHits = 全部命中点；posObt = 上下文里没有否定标记的那些。
             obt 取第一个未被否决的命中点；若命中点全被否决，obt 就是 null，
             走下面的 self-negated 分支（不给 confident、上界压到一般 Web 档）。 */
          const obtHits = []
          OBTAINED_ALL_RE.lastIndex = 0
          for (let h = OBTAINED_ALL_RE.exec(text); h; h = OBTAINED_ALL_RE.exec(text)) {
            obtHits.push(h)
            if (OBTAINED_ALL_RE.lastIndex === h.index) OBTAINED_ALL_RE.lastIndex++ /* 防零宽死循环 */
          }
          const posObt = obtHits.filter(function (h) { return !negatedNear(text, h.index, h[0].length) })
          const obt = posObt.length ? posObt[0] : null
          const abs = text.match(ABSENCE_RE)
          const neg = text.match(NEGATED_RE)
          const dm = text.match(DATA_HINT_RE)
          const WEB_NORMAL = (cats['general-web-normal'] && cats['general-web-normal'].values && cats['general-web-normal'].values.default) || 20
          /* 「一般 Web 管理员权限」档 —— 只发现没防护时上界取这里（见 absence 分支的注释） */
          const WEB_ADMIN = (cats['general-web-admin'] && cats['general-web-admin'].values && cats['general-web-admin'].values.default) || 100
          /* ★ 自我否认优先：成果自己说"没取到"，就不许按"取得了"计分。
             实测 find-r8lq0w 同时命中「可进入真实」（obtained）与「未取到数据」（negated）。 */
          /* ★★ 第 25 轮：上界按哪条规则给的，必须**记在条目上**，不能只写在 reason 文字里。
             理由：派工层、探针、人都要能机械判断"这个上界是依据什么给的"。
             只留中文句子，下一个读的人还得解析语义。
             取值：'obtained' / 'self-negated' / 'absence-only' / 'no-evidence' / 'not-scorable' */
          /* 修前这里是 `if (neg && obt)`：只要有任一命中点 + 任一否认词就压档。
             它有两个反向的洞：① 命中点被否定时没有逐点判断，靠的是整句词表；
             ② 反过来，一个真命中点会被同句里一句无关的否认词连坐。
             现在：命中点存在但**全被就近否决** ⇒ self-negated；有任一未被否决的命中点 ⇒ obtained。
             （`neg` 仍用于下面 absence/no-evidence 分支的理由文字，不再单独决定 obtained 的存废。） */
          if (obtHits.length && !obt) {
            pricing = 'self-negated'
            nj = true; needsJudgement++
            cat = isTargetSystem ? 'important-system' : 'other-business-system'
            lower = WEB_NORMAL
            upper = WEB_ADMIN
            ceiling += upper
            evidence = obtHits[0][0]
            reason = '文本里出现了「' + obtHits[0][0] + '」（像"取得"），但它的上下文在否定它'
              + (neg ? '（全句否认词：「' + neg[0] + '」）' : '（命中点前 20 字 / 后 10 字内有未/没有/无法/不成立等否定标记）')
              + ' —— 以否认优先，按一般 Web 权限档（' + upper
              + '）计，不按重要业务系统档（' + (isTargetSystem ? CEIL_T : CEIL_O)
              + '）。成果自己说没拿到，引擎就不许替它说拿到了。'
          } else if (obt) {
            pricing = 'obtained'
            ok = true; confident++
            cat = isTargetSystem ? 'important-system' : 'other-business-system'
            lower = WEB_NORMAL; upper = isTargetSystem ? CEIL_T : CEIL_O
            evidence = obt[0]
          } else if (abs) {
            /* 只发现"没有防护"。这是有价值的观察，但它**不是**"取得了权限"。
               下界保留（有一般 Web 级别的可达性证据），上界压到 general-web 档：
               "能零凭据到达一个 web 端点"最多支持到一般 Web 权限那一档。 */
            pricing = 'absence-only'
            nj = true; needsJudgement++
            cat = isTargetSystem ? 'important-system' : 'other-business-system'
            lower = WEB_NORMAL
            upper = WEB_ADMIN
            ceiling += upper
            evidence = abs[0]
            reason = '只命中「' + abs[0] + '」这类**"发现没有防护"**的词，没有"取得权限"的证据'
              + ' —— 所以上界按一般 Web 权限档（' + upper + '）而不是按重要业务系统档（'
              + (isTargetSystem ? CEIL_T : CEIL_O) + '）。'
              + '要按后者计分，必须补一条能证明**实际取得了权限**的证据。'
          } else {
            /* 连"权限相关词"都没命中：既没取得证据，也没发现没防护。
               上界仍给系统档（那是"可能的上限"），但 pricing 必须标 no-evidence ——
               它和 absence-only 是**不同**的档位依据，下游要能分辨。
               ⚠ 第一版这里忘了赋值，于是落到初始值 'not-scorable'，
                 而 not-scorable 的含义是"result_kind 被判为画像"—— 语义完全错位。
                 探针立刻抓到（6 项失败），这正是断言要"针对语义"的价值。 */
            pricing = 'no-evidence'
            nj = true; needsJudgement++; upper = isTargetSystem ? CEIL_T : CEIL_O; ceiling += upper
            reason = dm ? ('有数据类线索（' + dm[0] + '），但未识别到取得权限的证据；档位与条数均需人工判定') : '未识别到「取得权限」或「取得数据」的证据 ── 档位需人工判定'
            if (dm) evidence = dm[0]
          }
        }
        if (ok) ceiling += upper
        const rec = { findingId: f.id, asset: c.asset.address, service: c.asset.service, resultKind: f.resultKind,
          isTargetSystem: isTargetSystem, category: cat, lower: lower, upper: upper, evidence: evidence, reason: reason,
          pricing: (scorable.indexOf(f.resultKind) < 0) ? 'not-scorable' : pricing,
          /* ★ 第 26 轮：data 轴（独立于权限轴）。null = 这条成果没有数据成果属性。
             为什么放在条目上而不只放在 reason 里：下游（派工层、探针、人）要能
             **机械**判断"这条有没有数据分、套的是哪一档"，不能靠解析中文句子。 */
          dataScore: dataScore,
          confident: ok, needsJudgement: nj, triage: tr, evidenceCount: evN,
          flagged: ex ? (ex.class || '') : '', summary: String(f.summary).slice(0, 200), createdAt: f.createdAt }
        entries.push(rec)
        /* ★★ 第 27 轮：triage 必须**再分一层**。
         *
         * 原判据是「result_kind 不在 scorable 里（= profile）**且**有证据文件」→ 待研判。
         * 它隐含假设：**有证据 = 可能有取得的成果**。
         * 但实测 3 条全是**否证类**成果，原文自己就下了结论：
         *   find-bs969x「无凭据访问返回 200 空响应（**非业务数据**）」
         *   find-kpblk0「21/28 响应为空字节串，**未取到任何真实业务数据**」
         *   find-4kfd2g「**零副作用、零账号创建**」（注册开关=关，早退分支）
         * 它们的证据恰恰是用来**证明"没拿到"**的 —— 是本项目纪律
         * 「任何否定结论都要先喂一个已知能通的对照组」在成果层的体现。
         * 把这种条目列成"待研判能否改判"，等于让 lead 去做一件**成果自己已经回答完**的事 ——
         * 那是**空转**，而且会稀释真正需要研判的条目。
         *
         * 所以再分一层：`triage`（真待研判）与 `triageNegated`（已由证据本身结论为无）。
         * ⚠ 我不改判任何人 —— 改判是人的事。这里只是**不把已了结的事再派一遍**。 */
        if (tr) {
          if (selfNeg) triageNegated.push(rec)
          else triage.push(rec)
        }
      }
    }
  }

  const conf = entries.filter(function (e) { return e.confident })
  const byAsset = {}
  for (let i = 0; i < conf.length; i++) {
    const e = conf[i]
    if (!byAsset[e.asset]) byAsset[e.asset] = { asset: e.asset, service: e.service, low: 0, maxUp: 0, sumUp: 0, n: 0 }
    const b = byAsset[e.asset]
    b.low = Math.max(b.low, e.lower); b.maxUp = Math.max(b.maxUp, e.upper); b.sumUp += e.upper; b.n++
  }
  const perAsset = Object.keys(byAsset).map(function (k) { return byAsset[k] })
  const onceLow = perAsset.reduce(function (n, b) { return n + b.low }, 0)
  const onceUp = perAsset.reduce(function (n, b) { return n + b.maxUp }, 0)
  const sumUp = perAsset.reduce(function (n, b) { return n + b.sumUp }, 0)

  if (conf.length === 0) uncertainty.push('当前没有任何成果被判定为可直接计分 ── 这不等于没有价值，但与分数无关')
  if (triage.length) uncertainty.push('有 ' + triage.length + ' 条卡挂着实质证据但被判为画像 ── 列入待研判，未计入可计分。这是账本从「一刀切」改成的「显式列出」。')
  uncertainty.push('「重要业务系统」的定性权在裁判组；未取得定级备案信息，故上界按靶标点名系统 ' + CEIL_T + ' / 同主体其他系统 ' + CEIL_O + ' 取值')
  uncertainty.push('「突破网络边界每家只算一次」与「重要业务系统 3000/个」是否叠加，规则未明写 ── 故取每目标只算一次')
  uncertainty.push('首交独占（首个 100%、次个 50%）取决于递交顺序，board 不记录递交')
  uncertainty.push('G4 蜜罐核减：无法自判成果是否落在蜜罐上；但 P13/三(一) 有例外，沙盒逃逸/反控规避蜜罐的按获取权限正常判分')
  uncertainty.push('分类依据是 finding 的自然语言 summary。证据词命中不等于裁判认可，每条的命中词已列出以便推翻')

  return {
    ok: true, tableVersion: table.version, scorableKinds: scorable, dropped: dropped, triage: triage,
    /* ★ 第 27 轮：triage 分两层 —— 见 buildLedger 里 triage.push 处的注释。
       triageNegated = 有证据但**成果自己声明了没拿到** → 已由证据本身结论为无，
       不该再派"研判能否改判"（那会让 lead 做一件成果已经回答完的事 = 空转）。 */
    triageNegated: triageNegated,
    totals: { onceLow: onceLow, onceUp: onceUp, sumUp: sumUp, ceiling: ceiling },
    /* ★★ 第 26 轮：data 轴汇总 —— 它**独立于**权限轴，是两个不同的计量对象。
         · dataPriced    = 已能套上档位表、拿到具体分值的条数（这些分是**算得出来的**）
         · dataNeedsCount= 识别出有数据成果、但条数未知 → 需人工给数（**不给点估计**）
         · dataSum       = 已定价数据分之和（下界性质：只含能算出来的）
       为什么独立汇总而不并进 onceLow/onceUp：权限分与数据分是两笔账，
       合并会把"拿到权限"和"拿到数据"混成一个数，而它们的档位规则完全不同。
       指挥员需要看到两笔各是多少，才能判断该往哪投。 */
    dataTotals: (function () {
      const priced = entries.filter(function (e) { return e.dataScore && e.dataScore.value !== null && e.dataScore.value !== undefined })
      const need = entries.filter(function (e) { return e.dataScore && e.dataScore.needsCount })
      const excluded = entries.filter(function (e) { return e.dataScore && e.dataScore.excluded })
      return {
        dataPriced: priced.length,
        dataNeedsCount: need.length,
        dataExcludedPublic: excluded.length,
        dataSum: priced.reduce(function (n, e) { return n + e.dataScore.value }, 0),
        needCountIds: need.map(function (e) { return e.findingId }),
        pricedDetail: priced.map(function (e) { return { findingId: e.findingId, type: e.dataScore.type, count: e.dataScore.count, tier: e.dataScore.tier, value: e.dataScore.value } }),
        note: '数据成果按「条数」套档位表（50-1000→100 … 50001+→2000）；'
          + '代码类按「行数÷10」计。条数未知的一律**不给点估计**，列进 dataNeedsCount 等人工给数 —— '
          + '编一个条数出来的分就是伪造情报。',
        rule: 'doctrine/score-table.json 的 categories[data]（values_by_count / types / excluded）',
      }
    })(),
    counts: { findings: entries.length, confident: confident, needsJudgement: needsJudgement, unpriced: unpriced, triage: triage.length, assets: perAsset.length, dropped: dropped.length },
    byAsset: perAsset.sort(function (a, b) { return b.maxUp - a.maxUp }),
    atCeiling: entries.filter(function (e) { return e.needsJudgement }).sort(function (a, b) { return b.upper - a.upper }),
    entries: entries.sort(function (a, b) { return b.upper - a.upper }),
    caps: table.caps || {}, principles: table.principles || [], uncertainty: uncertainty,
  }
}

/* ════════ 情报驱动层 ════════ */

function buildExclusions(sem) {
  const ex = {}
  const list = (sem && sem.finding_rulings) || []
  for (let i = 0; i < list.length; i++) ex[S(list[i].finding)] = list[i]
  return ex
}

function matchTokensOf(rule) {
  const declared = rule && rule.match_tokens
  if (Array.isArray(declared) && declared.length) return { tokens: declared.map(S).filter(Boolean), source: 'declared' }
  const ascii = (S(rule && rule.label).match(/[a-z0-9_][a-z0-9_.\-\/]{4,}/gi) || [])
  const uniq = ascii.filter(function (x, i, a) { return a.indexOf(x) === i })
  return { tokens: uniq.slice(0, 6), source: uniq.length ? 'derived-ascii' : 'none' }
}
function findTokenHit(hay, tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    let from = 0
    for (;;) {
      const idx = hay.indexOf(t, from)
      if (idx < 0) break
      const pre = hay.slice(Math.max(0, idx - 12), idx)
      if (!NEG_CHARS.test(pre)) return { token: t, index: idx }
      from = idx + 1
    }
  }
  return null
}

function evaluateIntel(model, sem, board) {
  if (!sem) return { ok: false, error: 'intel-semantics.json 未加载' }
  const assertions = [], violations = [], pendingRulings = [], prohibitions = [], notes = [], excluded = []
  const intelById = {}
  const allIntel = board.intel || []
  for (let i = 0; i < allIntel.length; i++) intelById[S(allIntel[i].id)] = allIntel[i]
  const intelTime = function (id) { const r = intelById[id]; return r ? tsOf(r.created_at || r.createdAt) : null }

  const fr = sem.finding_rulings || []
  const findById = {}
  for (let i = 0; i < model.chains.length; i++) for (let j = 0; j < model.chains[i].findings.length; j++) findById[model.chains[i].findings[j].id] = model.chains[i].findings[j]
  for (let i = 0; i < fr.length; i++) {
    const r = fr[i], f = findById[S(r.finding)]
    const exists = !!f
    if (r.ruling === 'exclude') excluded.push({ finding: S(r.finding), cls: S(r.class), claim: S(r.claim), by: S(r.by), summary: f ? String(f.summary).slice(0, 200) : '(板面上未找到该卡)' })
    assertions.push({ kind: 'finding', id: S(r.finding), state: exists ? 'consistent' : 'violated', label: S(r.finding),
      claim: S(r.claim), actual: exists ? '板面存在该卡' : '板面上找不到该卡', by: S(r.by) })
  }

  const scopes = sem.scope_rulings || []
  const T = model.targets
  for (let i = 0; i < scopes.length; i++) {
    const r = scopes[i], by = S(r.by)
    if (r.ruling === 'in-scope') {
      const u = T ? T.units.filter(function (z) { return z.no === r.unit })[0] : null
      const boardHas = u ? u.covered : false
      if (boardHas) assertions.push({ kind: 'scope', id: S(r.id), state: 'consistent', label: S(r.label), claim: S(r.claim), actual: '板面已建卡', by: by })
      else violations.push({ kind: '范围', state: 'violated', label: '# ' + r.unit + ' / ' + S(r.label), claim: S(r.claim), by: by,
        actual: '靶标层判「零卡片」── board 上没有任何指向该单位的资产卡',
        action: '这是板面漏登记，不是零覆盖。权威清单（scope_rulings）已给出入口，应把该入口登记为 asset 卡。' })
    } else if (r.ruling === 'out-of-scope-decided' || r.ruling === 'out-of-scope-supply-chain') {
      const label = S(r.label)
      const hitAssets = model.chains.filter(function (c) { return S(c.asset.address).indexOf(label) >= 0 || S(c.asset.service).indexOf(label) >= 0 })
      assertions.push({ kind: 'scope', id: S(r.id), state: hitAssets.length ? 'violated' : 'consistent', label: label,
        claim: S(r.claim), actual: hitAssets.length ? ('板面有 ' + hitAssets.length + ' 张卡指向该标识') : '板面无卡指向该标识', by: by })
      if (hitAssets.length) violations.push({ kind: '范围', state: 'violated', label: label, claim: S(r.claim), by: by,
        actual: '板面有 ' + hitAssets.length + ' 张卡指向它：' + hitAssets.map(function (c) { return c.asset.address }).join(', '),
        action: '境外成果不得计入覆盖面得分，也不得出现在最终报告与成果台账里。' })
    } else {
      pendingRulings.push({ label: S(r.label), cls: r.ruling === 'disputed' ? '争议未决' : ((r.ruling === 'pending-r5' || r.ruling === 'pending-r5-attribution') ? '待报备' : '待裁定'), claim: S(r.claim), by: by,
        r5: S(r.r5_group), caveat: S(r.caveat) })
    }
  }

  const apprs = board.approvals || []
  const ri = sem.report_items || []
  for (let i = 0; i < ri.length; i++) {
    const r = ri[i]
    const hit = apprs.filter(function (a) { const hay = S(a.action_class) + ' ' + S(a.target) + ' ' + S(a.detail); return hay.indexOf(S(r.label).slice(0, 8)) >= 0 || hay.indexOf(S(r.group)) >= 0 })
    if (!hit.length) violations.push({ kind: '报备', state: 'violated', label: S(r.group) + ' ' + S(r.label), claim: '须在平台「攻击申请」模块填报并审批通过后才可执行', by: S(r.by),
      actual: 'approvals 目录共 ' + apprs.length + ' 条记录，没有一条对应本组',
      action: '报备闭环未建立。审批时长手册未规定，须提前留足时间。' })
    else assertions.push({ kind: 'report', id: S(r.group), state: 'consistent', label: S(r.label), claim: '须报备', actual: '已落 ' + hit.length + ' 条记录', by: S(r.by) })
  }

  const ph = sem.standing_prohibitions || []
  for (let i = 0; i < ph.length; i++) {
    const r = ph[i], mt = matchTokensOf(r), t0 = intelTime(r.by)
    const hits = [], covered = []
    for (let j = 0; j < model.chains.length; j++) {
      const c = model.chains[j]
      for (let q = 0; q < c.objectives.length; q++) {
        const o = c.objectives[q], hay = S(o.objective.title) + ' ' + S(o.objective.method)
        const h = findTokenHit(hay, mt.tokens)
        if (!h) continue
        const ct = tsOf(o.objective.createdAt)
        const after = t0 !== null && ct !== null && ct > t0
        if (after) hits.push({ title: String(o.objective.title).slice(0, 110), createdAt: S(o.objective.createdAt), matched: h.token, asset: c.asset.address })
        else covered.push({ title: String(o.objective.title).slice(0, 80), createdAt: S(o.objective.createdAt) })
      }
    }
    prohibitions.push({ id: S(r.id), label: S(r.label), severity: S(r.severity) || 'amber', claim: S(r.claim), by: S(r.by),
      tokens: mt.tokens, tokenSource: mt.source, tokenNote: S(r.token_note),
      intelTime: r.by ? (intelById[S(r.by)] ? S(intelById[S(r.by)].created_at) : '') : '', hits: hits, coveredCount: covered.length, covered: covered.slice(0, 6) })
    if (hits.length) violations.push({ kind: '禁令', state: 'violated', label: S(r.label), claim: S(r.claim), by: S(r.by),
      actual: hits.length + ' 个意图创建于禁令之后且命中匹配词：' + hits.map(function (h) { return h.matched }).join(', '),
      action: '禁令约束的是新动作。逐个看一眼：是复探，还是确有新理由？' })
  }

  const cf = (sem.conflicts || []).map(function (x) { return { id: S(x.id), topic: S(x.topic), a: { by: S((x.a || {}).by), claim: S((x.a || {}).claim) }, b: { by: S((x.b || {}).by), claim: S((x.b || {}).claim) }, status: S(x.status) || 'open', engineDuty: S(x.engine_duty) } })

  const un = sem.unverifiable_notes || []
  for (let i = 0; i < un.length; i++) notes.push({ by: S(un[i].by), note: S(un[i].note) })

  const counts = { consistent: assertions.filter(function (x) { return x.state === 'consistent' }).length, violated: violations.length,
    pending: pendingRulings.length, unverifiable: notes.length }

  return { ok: true, intro: '这里把情报变成动作。每条情报对板面的断言被机械校验，不自洽就报警。引擎只报「是否自洽」，不替人裁定；两条情报互相矛盾时并列展示，禁止单方采信。',
    counts: counts, assertions: assertions, violations: violations, pendingRulings: pendingRulings,
    prohibitions: prohibitions, conflicts: cf, notes: notes, excluded: excluded, semanticsVersion: sem.version }
}

/* ════════ 决策层（主攻方向） ════════

   v13 的地图能描述态势，却不能驱动行动 —— 用户的原话是「有什么去驱动进一步去接近
   目标呢？」。决策层回答的是「现在打哪里、按什么顺序」。

   纪律（写在 decision.json 的 discipline 里）：引擎只【排序】和【说明理由】，
   不代替指挥员下决心。引擎不发出任何动作，不给伪造 ETA，不给分数承诺。
   指挥权与参谋权分离。 */

const SCHWERPUNKT_LABELS = {
  'blocker-ledger': '出口台账缺口',
  'blocker-report': '报备欠账',
  'cash-in-verified': '已验证未定档',
  'cash-in-triage': '有证据被判画像',
  'register-gap': '板面漏登记',
  'open-front': '真正零覆盖',
  'repair-doctrine': '军法缺口',
  'repair-boundary': '归属未闭环',
}
const SCHWERPUNKT_SHORT = {
  'blocker-ledger': '缺台账',
  'blocker-report': '缺报备',
  'cash-in-verified': '未定档',
  'cash-in-triage': '待研判',
  'register-gap': '漏登记',
  'open-front': '零覆盖',
  'repair-doctrine': '军法',
  'repair-boundary': '归属',
}

function evidenceWindowOf(findings) {
  let min = null, max = null
  for (let i = 0; i < (findings || []).length; i++) {
    const t = tsOf(findings[i].createdAt)
    if (t === null) continue
    if (min === null || t < min) min = t
    if (max === null || t > max) max = t
  }
  if (min === null || max === null) return { first: '', last: '', hours: 0 }
  return { first: new Date(min).toISOString(), last: new Date(max).toISOString(),
    hours: Math.round(((max - min) / 3600000) * 10) / 10 }
}

function buildSchwerpunkt(model, ledger, intelDrive, targets, decision) {
  const dc = decision || {}
  const time = dc.time || { known: [], unknown: [] }
  const rule = dc.ranking || {}
  const lanesDoc = dc.lanes || []
  const empty = { ok: false, error: dc && dc.version ? null : 'decision.json 未加载',
    items: [], paper: [], assault: [], counts: { total: 0, blockers: 0, externalPending: 0, paper: 0, assault: 0 },
    lanes: lanesDoc, time: { known: time.known || [], unknown: time.unknown || [], window: { first: '', last: '', hours: 0 } },
    discipline: dc.discipline || null, principle: dc.principle || '', ranking: rule, kinds: [] }
  if (!dc || !dc.version) return empty

  const L = ledger && ledger.ok ? ledger : null
  const T = targets || null
  const I = intelDrive && intelDrive.ok ? intelDrive : null
  const violations = (I && I.violations) || []
  const pendings = (I && I.pendingRulings) || []
  const F = model.allFindings || []

  /* ★★ 排序规则**从军法读**，不再硬编码（第 21 轮）。
   *
   * 修前这里是写死的四级：
   *   (b.blocking-a.blocking) || (b.externalPending-a.externalPending) ||
   *   (a.distance-b.distance) || (a.cost-b.cost) || compareId
   *
   * 而 `decision.json` 的 `ranking.levels`（4 条带 order/field/direction/name/rationale
   * 的记录）在引擎里**零引用** —— 典型 B 类字段：写在军法里、长得像配置、
   * 改了完全不生效。更糟的是客户端 UI 上写着「排序规则（写在 doctrine/decision.json，
   * **可被推翻**）」—— 那是一句**面向指挥员的、不兑现的承诺**。
   * （研读笔记 §16.3 缺陷三点名了这一点。）
   *
   * 为什么现在能安全地改成读军法：`kinds[]` 早就是"从 doctrine 读属性"的成熟先例
   * （`kd.blocking` / `kd.distance` … 见下面那个循环），比较规则只是同一条路的下一步。
   *
   * 字段名映射：军法里写字段名用的是蛇形（`external_pending`），
   * 而条目上的属性是驼峰（`externalPending`）。映射必须在**这里**做一次，
   * 否则军法改了字段名而引擎读不到，又会退化成一个新的静默 B 类字段。
   *
   * 兜底：军法缺失或 levels 为空时，退回原来那套硬编码四级。
   * 但**不是静默**退回 —— 会在下面的 selectedLevels 里打标，由排序结果之外的地方可见。
   * 理由：静默兜底正是本项目反复踩的那一类（§6.11「兜底逻辑把缺失伪装成正常」）。 */
  const LEVEL_FIELD = {
    blocking: 'blocking',
    external_pending: 'externalPending',
    externalPending: 'externalPending',
    distance: 'distance',
    cost: 'cost',
    lane: 'lane',
    kind: 'kind',
  }
  const RAW_LEVELS = (dc.ranking && Array.isArray(dc.ranking.levels)) ? dc.ranking.levels : []
  const levels = RAW_LEVELS
    .filter(function (l) { return l && LEVEL_FIELD[String(l.field)] })
    .slice()
    .sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0) })
    .map(function (l) {
      return { key: LEVEL_FIELD[String(l.field)], dir: l.direction === 'desc' ? -1 : 1, name: l.name || l.field }
    })
  /* 军法里出现但引擎不认识的字段名 —— 这是新的 B 类风险点，必须能看见 */
  const rankingUnknown = RAW_LEVELS
    .filter(function (l) { return l && l.field && !LEVEL_FIELD[String(l.field)] })
    .map(function (l) { return String(l.field) })

  const cmpField = function (a, b, lv) {
    const av = a[lv.key]
    const bv = b[lv.key]
    /* 缺值的项一律排在后面，且不参与方向 —— 否则方向一改，
       "没有这个属性"会被当成最小/最大值，把无关条目顶到最前。 */
    if (av === undefined || av === null || av === '') return (bv === undefined || bv === null || bv === '') ? 0 : 1
    if (bv === undefined || bv === null || bv === '') return -1
    if (typeof av === 'boolean' || typeof bv === 'boolean') {
      const an = av === true ? 1 : 0
      const bn = bv === true ? 1 : 0
      return (an - bn) * lv.dir
    }
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * lv.dir
    const as = String(av)
    const bs = String(bv)
    const r = as < bs ? -1 : (as > bs ? 1 : 0)
    return r * lv.dir
  }
  const cmp = function (a, b) {
    for (let i = 0; i < levels.length; i++) {
      const r = cmpField(a, b, levels[i])
      if (r) return r
    }
    return String(a.id).localeCompare(String(b.id))
  }

  const kinds = []
  const all = []

  for (let i = 0; i < (dc.kinds || []).length; i++) {
    const kd = dc.kinds[i], kid = S(kd.id), rec = []
    const push = function (title, detail, extra) {
      const e = extra || {}
      rec.push({ kind: kid, kindName: S(kd.name) || SCHWERPUNKT_LABELS[kid] || kid,
        title: title, detail: detail, blocking: kd.blocking === true, externalPending: kd.external_pending === true,
        distance: kd.distance, cost: kd.cost, lane: (kd.distance <= 2) ? 'paper' : 'assault',
        action: S(kd.action), why: S(kd.why), blockingOn: S(e.blockingOn), yield: S(e.yield) })
    }

    if (kid === 'blocker-ledger') {
      const n = model.counts.egress
      if (n === 0) push('出口台账为空',
        'egress 目录 0 条记录。没有出发记录，就无法自证任何一次行动在授权范围内；被溯源时按 G7 可核减 100%/50%。',
        { blockingOn: '每一次行动的授权自证', yield: '不产分，但决定别的分是否算数' })
    } else if (kid === 'blocker-report') {
      const rs = violations.filter(function (v) { return v.kind === '报备' })
      for (let j = 0; j < rs.length; j++) {
        push(rs[j].label, rs[j].actual + '。' + rs[j].action + ' —— 审批时长手册未规定，是唯一不可压缩的前置时间。',
          { blockingOn: 'R5 组动作的执行许可', yield: '不产分，但决定相关动作能否递交' })
      }
    } else if (kid === 'register-gap') {
      // ⚠ 两个数据来源必须合并，否则同一家单位会被算两次：
      //   ① 情报裁定 in-scope 但靶标层判「零卡片」的违规项 —— 标签形如 `# 5 / 7x24cc.com`
      //   ② 靶标层的 intelCovered —— key 形如 `#5　北京亿捷云…-呼叫中心应用系统`
      // 实证：这两条说的都是 #5 亿捷云，但标签形状不同（`# 5 /` vs `#5　`），
      // 所以【不能按标题去重】，必须先抽出单位号，按单位号去重。
      const seen = {}
      const unitNo = function (s) { const m = String(s).match(/#\s*(\d+)/); return m ? m[1] : String(s) }
      const rs = violations.filter(function (v) { return v.kind === '范围' && S(v.actual).indexOf('零卡片') >= 0 })
      const ic = (T && T.intelCovered) || []
      const icBy = {}
      for (let j = 0; j < ic.length; j++) icBy[String(ic[j].no)] = ic[j]
      for (let j = 0; j < rs.length; j++) {
        const no = unitNo(rs[j].label)
        if (seen[no]) continue
        seen[no] = 1
        const u = icBy[no]
        push(rs[j].label, rs[j].actual + (u ? '。权威清单给出的入口是「' + S(u.intelEntry) + '」。' : '') + rs[j].action,
          { yield: '登记后即从「零覆盖」变为「可行动」——单位成本最低的一类' })
      }
      for (let j = 0; j < ic.length; j++) {
        const u = ic[j], no = String(u.no)
        if (seen[no]) continue
        seen[no] = 1
        push('#' + u.no + '　' + u.text, '权威清单已确认入口「' + S(u.intelEntry) + '」，board 上没有对应资产卡。',
          { yield: '登记后即从「零覆盖」变为「可行动」——单位成本最低的一类' })
      }
    } else if (kid === 'cash-in-verified') {
      const es = (L && L.atCeiling) || []
      for (let j = 0; j < es.length; j++) {
        /* ★★ 第 28 轮 A 组：任务书摘录原为 110 字。实测长成果的关键动作词常在 110 字之后
           （"…容器内 uid=0 读出宿主 /etc/passwd"这类），截断后派工方看不到证据，
           于是"这条为什么算取得"要靠人再翻一次卡。放宽到 260 字，并把**命中的证据词**
           显式写出来 —— 派工方要知道引擎凭哪个词判的，才能自己复核（或推翻）。 */
        push(S(es[j].findingId) + '　' + S(es[j].asset), '已跨过「有结果」这道门，只差一条能证明权限级别的证据。' + S(es[j].reason) + '（任务书：' + S(es[j].summary).slice(0, 260) + '）'
          + (S(es[j].evidence) ? '（引擎命中的证据词：「' + S(es[j].evidence) + '」）' : ''),
          { yield: '上界 ' + es[j].upper + '（自算区间，非承诺分值）' })
      }
    } else if (kid === 'cash-in-triage') {
      const ts = (L && L.triage) || []
      for (let j = 0; j < ts.length; j++) {
        push(S(ts[j].findingId) + '　' + S(ts[j].asset), S(ts[j].evidenceCount) + ' 个证据文件（' + S(ts[j].resultKind) + '）。' + S(ts[j].reason),
          { yield: '逐条研判，能证明取得权限的可改判为 verified' })
      }
    } else if (kid === 'open-front') {
      const rg = (T && T.realGap) || []
      for (let j = 0; j < rg.length; j++) {
        push('#' + rg[j].no + '　' + rg[j].text, '既无资产卡，也无情报入口。' + (rg[j].noPhishing ? '⚠ 该单位带【禁止钓鱼】标记（只禁社工，不锁技术面）。' : ''),
          { yield: '新增分数的唯一来源' })
      }
    } else if (kid === 'repair-doctrine') {
      const n = model.doctrineCoverage.uncoveredTotal
      if (n > 0) push('军法未覆盖 ' + n + ' 个联网资产',
        'tactics.json 的 detect 规则没匹配到这些资产，后续动作没有可依据的打法条目，工蜂到那一步会停下来问。',
        { yield: '让后面的动作能自动匹配打法条目' })
    } else if (kid === 'repair-boundary') {
      const orph = (T && T.orphan) || []
      for (let j = 0; j < orph.length; j++) {
        push('清单外资产　' + orph[j], '在 board 上但不属于任何一家靶标。按 G9 越界成果不计分，直接打可能触发扣分。',
          { yield: '归属闭环后才敢用' })
      }
      for (let j = 0; j < pendings.length; j++) {
        if (S(pendings[j].cls).indexOf('待') < 0 && S(pendings[j].cls).indexOf('争') < 0) continue
        push(S(pendings[j].label) + '（' + S(pendings[j].cls) + '）', S(pendings[j].claim) + (pendings[j].caveat ? '　[' + S(pendings[j].caveat) + ']' : ''),
          { yield: '裁定后方可行动' })
      }
    }

    // 每项补上排序键与可读标签
    for (let j = 0; j < rec.length; j++) {
      rec[j].sortKey = [rec[j].blocking ? 1 : 0, rec[j].externalPending ? 1 : 0,
        -rec[j].distance, -rec[j].cost].join('|')
      rec[j].short = SCHWERPUNKT_SHORT[kid] || kid
    }
    rec.sort(cmp)
    for (let j = 0; j < rec.length; j++) rec[j].rank = all.length + j + 1
    // 逐类扫描顺序与 decision.json 的 kinds 顺序一致；最终排名再按全局排序重排
    for (let j = 0; j < rec.length; j++) all.push(rec[j])
    kinds.push({ id: kid, name: S(kd.name) || SCHWERPUNKT_LABELS[kid] || kid, blocking: kd.blocking === true,
      externalPending: kd.external_pending === true, distance: kd.distance, cost: kd.cost,
      lane: (kd.distance <= 2) ? 'paper' : 'assault', count: rec.length, why: S(kd.why), action: S(kd.action) })
  }

  all.sort(cmp)
  for (let i = 0; i < all.length; i++) all[i].rank = i + 1

  const paper = all.filter(function (x) { return x.lane === 'paper' })
  const assault = all.filter(function (x) { return x.lane === 'assault' })
  const blockers = all.filter(function (x) { return x.blocking })
  const ext = all.filter(function (x) { return x.externalPending })

  return {
    ok: true, version: dc.version, principle: S(dc.principle), whyThisIsAFile: S(dc.why_this_is_a_file),
    ranking: rule, kinds: kinds, lanes: lanesDoc, discipline: dc.discipline || null,
    /* ★ 第 21 轮新增：把**实际生效**的排序级别与原样返回。
       为什么必须回传：`ranking.levels` 以前是 B 类字段（写了不生效），
       现在改成真读之后，指挥员在界面上需要能看见"引擎到底按什么在排"，
       否则改军法成了盲改。`rankingUnknown` 专门暴露**军法里写了但引擎不认识**的字段名 ——
       那正是下一个 B 类缺陷的入口，必须让它可见而不是静默忽略。 */
    rankingLevels: levels.map(function (l) {
      return { key: l.key, direction: l.dir === -1 ? 'desc' : 'asc', name: l.name }
    }),
    rankingUnknown: rankingUnknown,
    rankingSource: levels.length ? 'doctrine/decision.json 的 ranking.levels' : '引擎兜底（军法里没有可用的 levels）',
    items: all, paper: paper, assault: assault,
    counts: { total: all.length, blockers: blockers.length, externalPending: ext.length,
      paper: paper.length, assault: assault.length },
    time: { known: time.known || [], unknown: time.unknown || [], window: evidenceWindowOf(F) },
  }
}

/* ════════ 派工层（把「建议」变成「蜂群能执行的 board 调用」） ════════

   为什么需要这一层（第四轮实测，见 HANDOFF §D）：

   地图算出「主攻方向 21 条」，而蜂群唯一能看见态势的地方是 board_snapshot，
   它只列 status === "open" 的 objective。实测当时全 board 49 条 objective 里
   【只有 1 条 open】，蜂群合计能看见 4 条可干的活，且没有一条来自地图的建议。
   更深的断层：地图的建议项【不是卡片】，而蜂群按协议「claim the objective,
   not the asset」—— 没有卡就不能动。所以地图的头号建议在蜂群的纪律下不可执行。

   这一层把每条建议翻译成蜂群【真的能执行】的 board 工具调用参数：
     · register-gap：目标单位一张卡都没有 -> 必须两步（先 board_asset_add 再 board_objective_add）
     · cash-in-*  ：有 finding -> 带 parent_finding_id 派生，并把 asset_id 一并给出
     · blocker-*  ：流程级义务，不属于任何目标资产 -> 需先指定一张托管资产

   纪律（不许破）：
   ① 引擎【不写板面】。只产出参数，由 lead 用现有工具执行 —— 写权限一旦开给地图，
      四个不变量（exec.agent.id 溯源、认领心跳租约、不登记就锁死写入、审批门禁）全部作废。
   ② 排序只能靠 board_objective_add 承载的字段表达（title / method 自由文本）。
      板面意图卡【没有 priority 字段】，所以不许假装有 —— 排序写在标题里，理由写在 method 里。
   ③ 每条都带「这一步为什么排在这」，因为蜂群看不到引擎的排序规则，只能看到卡上的字。
*/

/* 目标单位名 -> 可注册地址的兜底。只在没有更好别名时用，且必须标明这是待人工确认的。 */
function unitGapAddr(text) {
  return S(text).replace(/[（(].*?[)）]/g, '').split('-')[0].trim()
}

/**
 * 这串东西像不像一个真正的网络标识（域名 / IP / host:port）？
 *
 * 为什么必须有这个判据 —— 这是一个**真被踩到的伪造情报级 bug**（第 10 轮发现）：
 *
 * 目标清单里各单位写成「公司名-系统名」，例如「腾讯云-腾讯云官网」。
 * `unitGapAddr` 按第一个 `-` 取前缀，本意是「取域名那一段」，但中文清单里
 * 前缀其实是**公司名**。于是送进 board_asset_add 的 address 变成了
 * 「腾讯云」「北京亿捷云信息技术有限公司」—— 而 address 在板面上是
 * 归属与计分的基础（asset -> objective -> finding 那条链的根）。
 *
 * 更讽刺的是 ⟦op:18⟧：它的情报块里明明有真入口 `7x24cc.com`，
 * 却因为 address 取了公司名而**没用上**，真入口被塞进了 service 字段。
 *
 * 引擎自己写着「不猜域名对应关系，也不编造入口」，却在同一行里把公司名
 * 当网络地址登记了。所以这里加一道判据：不像网络标识就不许当 address 用。
 */
function looksLikeNetworkId(s) {
  const v = S(s).trim()
  if (v === '') return false
  if (v === 'localhost') return true
  // IPv4（允许 :port 后缀）
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(v)) return true
  // 域名（至少一个点，TLD 是字母）：去端口后再判
  const host = v.replace(/:\d+$/, '')
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) {
    // 必须至少有一个字母 TLD，否则 "1.2.3.4" 之外的数字点串会被误判
    return /\.[a-z]{2,}$/i.test(host)
  }
  return false
}

/**
 * 从一段自由文本里抽出**真正的**网络标识（域名 / IP）。
 * 用于「该单位无资产卡，但情报块里写了入口」这一情形 ——
 * 情报写的是「已证入口」，那就该拿它当 address，而不是拿公司名。
 * 抽不到就返回空串：宁可没有地址，也不许编一个。
 */
function extractNetworkIds(s) {
  const v = S(s)
  if (v === '') return []
  const out = []
  const re = /[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+/gi
  const m = v.match(re) || []
  for (let i = 0; i < m.length; i++) {
    const t = m[i].replace(/\.$/, '')
    if (!looksLikeNetworkId(t)) continue
    if (out.indexOf(t) < 0) out.push(t)
  }
  return out
}

const DISPATCH_KINDS = {
  'blocker-ledger': { verb: '建立并持续维护出发台账（egress）', executor: 'lead' },
  'blocker-report': { verb: '在竞赛平台「攻击申请」模块提交报备并跟踪审批', executor: 'lead / 人' },
  'cash-in-verified': { verb: '补齐能证明权限级别的证据，把档位钉死', executor: '工蜂' },
  'cash-in-triage': { verb: '逐条研判：能否从 profile 改判为 verified', executor: '工蜂' },
  'register-gap': { verb: '把权威清单已证入口登记为资产卡，让该单位从零覆盖变为可行动', executor: '工蜂' },
  'open-front': { verb: '从零开始侦察入口', executor: '工蜂' },
  'repair-doctrine': { verb: '给未覆盖资产补 tactics.json 的 detect 规则', executor: 'lead' },
  'repair-boundary': { verb: '裁定归属 / 处置清单外资产', executor: '人' },
}

/**
 * ★ 成果「衍生」有两条边，必须分开数、分开命名（2026-11-11 修 derive-metric）
 *
 * 修掉的是什么（实证）：
 *   本函数原来想把「成果→成果」与「成果→意图」两条边的引用取并集，于是写了
 *       objsAll.push(objs[j])
 *       const p = String((objsAll[i] && objsAll[i].parentFindingId) || '')
 *   但 buildModel 造出来的 chains[].objectives[] 每一项都是**包装对象**：
 *       { objective:{...}, claim, recordCount, records, findings }
 *   parentFindingId 在 entry.objective.parentFindingId 上，包装层**没有**这个键。
 *   实测：Object.keys(wrapper) = ["objective","claim","recordCount","records","findings"]，
 *   wrapper.parentFindingId === undefined ⇒ 那条边**恒为 0**，且不报错。
 *   后果：地图报「64 条成果里 51 条没有衍生出任何后续意图（verified 31）」——
 *   数的是成果↔成果；而 51 里有 17 条其实**已派出子意图、只是子意图还没出成果**，
 *   它们是「在跑的活」，被算成了欠账。越在推进，越像欠账。
 *
 * 现在的三条读数互不合并（合成一个数就没人能判断那 17 条是在跑还是没人管）：
 *   · derived_tasks      成果→任务  objectives[].parent_finding_id（宪章口径）
 *   · derived_findings   成果→成果  findings[].parent_finding_id（保留，不许合并）
 *   · unlanded_children  有子意图、但没有任何子意图到终态 —— 让「在跑」可见
 *
 * 兼容：顶层 usedAsParent / childless / childlessVerified / childlessVerifiedIds
 * 是**成果→任务**这条边的别名，因为桥接层（bridge27 的 map_orders 与 notify 段）
 * 只读这几个键名。改语义、不改键名 —— 否则「引擎改了但那行读数不动」，
 * 又是一处假绿。成果→成果那个数在 derived_findings 里单独给，绝不回填到别名。
 *
 * shape.wrapperShaped / shape.bareShaped 是自检：包装层形状一旦变了，
 * 这里立刻非零，读数不会再次静默归零。
 */
function computeRecursion(model, ledger, table) {
  const all = []
  const chains = (model && model.chains) || []
  for (let i = 0; i < chains.length; i++) {
    const objs = chains[i].objectives || []
    for (let j = 0; j < objs.length; j++) {
      const fnds = objs[j].findings || []
      for (let q = 0; q < fnds.length; q++) all.push(fnds[q])
    }
  }
  const scorable = ((table || {}).projection || {}).scorable_result_kinds || ['verified']
  const isScorable = function (f) { return scorable.indexOf(f.resultKind) >= 0 }
  const idsOf = function (arr) { return arr.map(function (f) { return f.id }).slice(0, 20) }
  const TERMINAL = { closed: true, tested: true, released: true }

  /* ── 边 1：成果→成果（findings[].parent_finding_id）── */
  const parentOf = {}
  for (let i = 0; i < all.length; i++) parentOf[all[i].id] = all[i].parentFindingId || ''
  const referencedByFindings = {}
  for (let i = 0; i < all.length; i++) {
    const p = String(parentOf[all[i].id] || '')
    if (p) referencedByFindings[p] = true
  }

  /* ── 边 2：成果→任务（objectives[].parent_finding_id）──
     ★ 关键修正：从包装对象里取 objective。直接读包装层永远拿不到 parentFindingId。 */
  const objsAll = []
  let wrapperShaped = 0, bareShaped = 0
  for (let i = 0; i < chains.length; i++) {
    const objs = chains[i].objectives || []
    for (let j = 0; j < objs.length; j++) {
      const e = objs[j] || {}
      const o = (e.objective && typeof e.objective === 'object') ? e.objective : e
      if (o !== e) wrapperShaped++; else bareShaped++
      objsAll.push(o)
    }
  }
  const referencedByTasks = {}
  const childObjsOf = {}
  for (let i = 0; i < objsAll.length; i++) {
    const p = String((objsAll[i] && objsAll[i].parentFindingId) || '')
    if (!p) continue
    referencedByTasks[p] = true
    if (!childObjsOf[p]) childObjsOf[p] = []
    childObjsOf[p].push(objsAll[i])
  }

  const childlessTasks = all.filter(function (f) { return !referencedByTasks[f.id] })
  const childlessFindingsEdge = all.filter(function (f) { return !referencedByFindings[f.id] })
  const derivedFindingsSelf = all.filter(function (f) { return !!parentOf[f.id] }).length

  /* ── 在跑 / 未落地：有子意图，但没有任何子意图到达终态（终态 = closed/tested/released）── */
  const parentKeys = Object.keys(childObjsOf)
  let unlanded = 0, landed = 0, anyChildOpen = 0
  const unlandedIds = []
  for (let i = 0; i < parentKeys.length; i++) {
    const kids = childObjsOf[parentKeys[i]] || []
    let anyTerminal = false, anyOpen = false
    for (let j = 0; j < kids.length; j++) {
      if (TERMINAL[String(kids[j].status)]) anyTerminal = true
      else anyOpen = true
    }
    if (anyOpen) anyChildOpen++
    if (!anyTerminal) { unlanded++; if (unlandedIds.length < 20) unlandedIds.push(parentKeys[i]) }
    else landed++
  }

  /* ── 链深：只数「成果→成果」（父子成果替换）。这是唯一能判「循环在往下长」的边 ── */
  let maxDepth = 0, deepest = '', cycles = 0
  for (let i = 0; i < all.length; i++) {
    let d = 0, cur = all[i].id
    const seenD = {}
    while (cur && d <= all.length) {
      if (seenD[cur]) { cycles++; break }
      seenD[cur] = true
      const p = parentOf[cur]
      if (!p) break
      d++; cur = p
    }
    if (d > maxDepth) { maxDepth = d; deepest = all[i].id }
  }

  return {
    /* ── 总盘 ── */
    findings: all.length,
    objectives: objsAll.length,
    scorableKinds: scorable,
    /* ── 边 1：成果→任务（宪章要求的那条边）── */
    derived_tasks: {
      edge: 'objective→finding',
      parentField: 'objectives[].parent_finding_id',
      usedAsParent: Object.keys(referencedByTasks).length,
      childless: childlessTasks.length,
      childlessVerified: childlessTasks.filter(isScorable).length,
      childlessVerifiedIds: idsOf(childlessTasks.filter(isScorable)),
    },
    /* ── 边 2：成果→成果（保留，单独命名，不许合并）── */
    derived_findings: {
      edge: 'finding→finding',
      parentField: 'findings[].parent_finding_id',
      usedAsParent: Object.keys(referencedByFindings).length,
      childless: childlessFindingsEdge.length,
      childlessVerified: childlessFindingsEdge.filter(isScorable).length,
      childlessVerifiedIds: idsOf(childlessFindingsEdge.filter(isScorable)),
    },
    /* ── 在跑：有子意图但子意图未到终态 ⇒ 不是欠账，要让"在跑"可见 ── */
    unlanded_children: unlanded,
    unlanded_children_ids: unlandedIds,
    unlanded_children_detail: {
      parentField: 'objectives[].parent_finding_id',
      definition: '有子意图、且没有任何子意图到达终态（closed/tested/released）',
      findingsWithChildObjectives: parentKeys.length,
      unlanded: unlanded,
      landed: landed,
      anyChildOpen: anyChildOpen,
    },
    /* ── 兼容别名：桥接层只读这几个键名。语义 = 成果→任务。── */
    usedAsParent: Object.keys(referencedByTasks).length,
    childless: childlessTasks.length,
    childlessVerified: childlessTasks.filter(isScorable).length,
    childlessVerifiedIds: idsOf(childlessTasks.filter(isScorable)),
    /* ── 旧字段保留（有测试与消费方按名取值）── */
    derivedFindings: derivedFindingsSelf,
    maxDepth: maxDepth,
    deepest: deepest,
    selfReferential: cycles,
    /* ── 自检 ── */
    shape: { wrapperShaped: wrapperShaped, bareShaped: bareShaped },
  }
}

function buildDispatch(model, ledger, intelDrive, targets, schwerpunkt, decision, doctrine) {
  const dc = decision || {}
  /* 侦察法单（军法提供）。缺失时**不静默**：派工时明确写「方法单缺失」，
     让「引擎没读到方法」这件事在执行者眼前可见 —— 这正是本会话反复踩的坑。 */
  const reconDoc = (doctrine && doctrine.recon) || null
  const anchorDoc = (dc.dispatch && dc.dispatch.anchor_assets) || {}
  /* ★★ 「哪一类必须由人处理」也从军法读（第 21 轮）。
     修前是硬编码 `x.kind === 'repair-boundary'`，而 decision.json 的
     `dispatch.needs_human_kinds` 里明明写着 ["repair-boundary"] 却零引用 ——
     往数组里加新 kind 不生效，而且没有任何地方会报出来。

     兜底策略：军法缺失时退回 ['repair-boundary']（保持现有行为不变），
     但**来源必须可查** —— needsHumanKindsSource 会透到 payload，
     免得"兜底把缺失伪装成正常"（§6.11 那次事故的形态）。 */
  const declaredNeedsHuman = (dc.dispatch && Array.isArray(dc.dispatch.needs_human_kinds))
    ? dc.dispatch.needs_human_kinds.map(String).filter(function (x) { return x !== '' })
    : []
  const needsHumanKindsSource = declaredNeedsHuman.length
    ? 'doctrine/decision.json 的 dispatch.needs_human_kinds（' + declaredNeedsHuman.join(', ') + '）'
    : '引擎兜底 [' + 'repair-boundary' + ']（军法里没有声明 needs_human_kinds）'
  const needsHumanKinds = new Set(declaredNeedsHuman.length ? declaredNeedsHuman : ['repair-boundary'])
  const SP = schwerpunkt && schwerpunkt.ok ? schwerpunkt : null
  if (!SP) return { ok: false, error: '决策层未加载，无法派工', entries: [], executable: [], twoStep: [], needsHuman: [],
    counts: { total: 0, executable: 0, twoStep: 0, needsHuman: 0 } }

  // finding -> 资产地址 反查（cash-in-* 要带 parent_finding_id）
  const findingAsset = {}
  for (let i = 0; i < model.chains.length; i++) {
    const c = model.chains[i]
    for (let j = 0; j < c.findings.length; j++) findingAsset[S(c.findings[j].id)] = c.asset.address
  }
  const assetByAddr = {}
  for (let i = 0; i < model.chains.length; i++) assetByAddr[model.chains[i].asset.address] = model.chains[i].asset.id
  /* ★ 第 22 轮：finding id -> 账本条目 的反查表。
     用途是把引擎**已经算好的**分数区间挂到派工命令上（见 cash-in-* 那一段）。

     为什么用反查表而不是在命令里重算：重算就是"两处各算一遍"，
     而这个项目已经因此栽过至少三次（§6.12.3 两源漂移、§6.15 B 类字段）。
     账本条目是本轮唯一的分数口径来源，命令只是**引用**它。

     账本条目字段名是 `findingId`（驼峰），而这里查的 key 来自
     命令标题里那段 `find-xxxx`（短横线 id），所以查表时统一按字符串比。 */
  const ledgerByFinding = {}
  const ledgerEntries = (ledger && Array.isArray(ledger.entries)) ? ledger.entries : []
  for (let i = 0; i < ledgerEntries.length; i++) {
    const fidKey = S(ledgerEntries[i].findingId)
    if (fidKey) ledgerByFinding[fidKey] = ledgerEntries[i]
  }
  const ledgerEntryOf = function (fid) { return fid ? (ledgerByFinding[S(fid)] || null) : null }
  // 托管资产用 asset id 指定（写 address 也行 —— 两种都认，避免军法写错格式就静默失效）
  const anchorResolve = function (spec) {
    const s = S(spec)
    if (!s) return null
    for (let i = 0; i < model.chains.length; i++) {
      const a = model.chains[i].asset
      if (a.id === s) return { id: a.id, how: 'asset id ' + s }
    }
    if (assetByAddr[s]) return { id: assetByAddr[s], how: 'address ' + s }
    return null
  }
  const unitByNo = {}
  if (targets) for (let i = 0; i < targets.units.length; i++) unitByNo[targets.units[i].no] = targets.units[i]

  const entries = []
  const items = SP.items
  for (let i = 0; i < items.length; i++) {
    const x = items[i]
    const kd = DISPATCH_KINDS[x.kind] || { verb: x.action || '（未定义动作）', executor: '工蜂' }
    const e = {
      rank: x.rank, kind: x.kind, kindName: x.kindName, short: x.short,
      title: x.title, detail: x.detail, why: x.why,
      blocking: !!x.blocking, externalPending: !!x.externalPending,
      distance: x.distance, cost: x.cost, lane: x.lane,
      blockingOn: x.blockingOn || '', yield: x.yield || '',
      verb: kd.verb, executor: kd.executor,
      assetId: null, assetIdSource: '', parentFindingId: null,
      steps: [], blocked: '', needsHuman: false, twoStep: false, call: null, readyToFile: false,
      /**
       * 命令编号 —— 闭环对账用的稳定标识符。
       *
       * 为什么需要它：地图算出「打哪里」，但没有任何机械办法判断这条命令
       * 到底有没有变成板面上的活。靠标题模糊匹配不行（标题是人读的自由文本，
       * 改一个字就失配）。所以给每条命令一个编号，并把它【写进卡片的标题】。
       *
       * 于是对账退化成一次子串查找：
       *   板面上存在含 ⟦op:<rank>⟧ 的意图卡  ⇔  这条命令已落地
       *
       * 桥接层（bridge 插件）依赖这个标记做对账，不要改动格式。
       */
      orderKey: 'op:' + x.rank,
    }

    if (x.kind === 'cash-in-verified' || x.kind === 'cash-in-triage') {
      const fid = String(x.title).split('　')[0].trim()
      const addr = findingAsset[fid]
      if (addr && assetByAddr[addr]) { e.assetId = assetByAddr[addr]; e.assetIdSource = '该 finding 所属资产卡 ' + addr }
      else { e.needsHuman = true; e.blocked = '找不到该 finding 对应的资产卡，需人工指定 asset_id' }
      if (fid) e.parentFindingId = fid

      /* ★★ 第 22 轮：把「这条命令值多少分」带给执行者。
       *
       * 为什么必须做 —— 这是指挥员最初的诉求原话：
       *   「按照给出的作战手册进行分析 看看哪些是拿分项」
       * 而在此之前，派工条目上的分数信息是**零**：实测 op:1..op:22 的字段表里
       * 没有任何 score/lower/upper。引擎其实**早就把分算准了**
       * （ledger.totals = onceLow 40 / onceUp 5000，且已按 same_system_dedup 去重），
       * 只是这个数字从来没被送到命令上。
       *
       * 指挥员的处境因此是：能看见「先做哪条」，看不见「这条值多少分」。
       * 而"哪些是拿分项"这个问题的答案，恰恰就是后者。
       *
       * 数据来自引擎自己的账本条目（buildLedger 产出，已含
       * lower/upper/category/isTargetSystem/confident/needsJudgement）——
       * 不新算一遍，**不许另立口径**（本项目反复栽在"两处各算一遍"上：
       * §6.12.3 两源漂移、§6.15 B 类字段）。
       *
       * 口径照抄 score-table.json 的 projection，不是我自己定的：
       *   · interval_required: true —— 一律给区间，不给点估计
       *   · why_interval：「重要业务系统」的定性权在裁判组，我们无法自判。
       *     任何点估计都会**伪装成已知**
       */
      const le = ledgerEntryOf(fid)
      if (le) {
        /* 三类条目的分数语义**不同**，措辞必须分开，否则指挥员会误读：
         *   · confident      → 有"已取得权限"证据，下界>0，是**可直接兑现**的分
         *   · needsJudgement → 上界可取但定性在裁判组，下界 0；是"做完工作才能拿到的分"
         *   · triage         → result_kind 被判为画像，区间恒 [0,0]；是"**可能改判**出来的分"
         *
         * ⚠ 我第一版把三类当成一类写（一律说"上界可取"），
         *   结果 triage 条目打出 [0,0] 却配着"上界可取"的解释 —— **自相矛盾**。
         *   同一个坑的第 N 次：把一段措辞套在语义不同的东西上。 */
        const span = le.confident ? 'confident' : (le.needsJudgement ? 'needsJudgement' : 'triage')
        e.score = {
          lower: le.lower,
          upper: le.upper,
          interval: '[' + le.lower + ', ' + le.upper + ']',
          span: span,
          /* ★ 第 25 轮：上界按哪条规则给的，透给下游 —— 见 buildLedger 里 pricing 的注释。
             下游要能机械判断，不能靠解析 reason 的中文句子。 */
          pricing: le.pricing || 'unknown',
          /* ★★ 第 26 轮：data 轴（数据成果）也透到命令上。
             它是**独立于权限**的第二笔账：权限分问"拿到什么级别的权限"，
             data 分问"取得了多少数据"，档位规则完全不同（按条数分 6 档，代码类行数÷10）。
             指挥员必须同时看到两笔，才能判断该往哪投。 */
          dataScore: le.dataScore || null,
          category: le.category || null,
          isTargetSystem: le.isTargetSystem === true,
          confident: le.confident === true,
          needsJudgement: le.needsJudgement === true,
          basis: span === 'confident'
            ? '成果文本匹配到权限关键词（有"已取得权限"的证据），下界就是已可兑现的部分'
            : (span === 'needsJudgement'
              ? (le.pricing === 'absence-only'
                ? '只发现「没有防护」，没有"取得权限"的证据 —— 上界按一般 Web 权限档给；'
                  + '要按重要业务系统档计分，必须补一条能证明**实际取得了权限**的证据'
                : (le.pricing === 'self-negated'
                  ? '成果**自己声明**没有取到东西 —— 以否认优先，上界按一般 Web 权限档给，不按重要业务系统档'
                  : '未识别到「取得权限」的证据 —— 上界是"可能的上限"而非已确定的档位，需人工判定'))
              : 'result_kind 被判为画像（不算"取得的结果"），所以区间是 [0, 0]。'
                + '这条命令的价值不在已得分数，而在**研判能否改判**：'
                + '若改判为 verified，它的上界会是 ' + (le.isTargetSystem ? '3000' : '2000')
                + '，所以它是"可能开出来的分"，不是"已经拿到的分"。'),
          source: 'doctrine/score-table.json 的 projection',
          dedupNote: '同一资产的成果按一个【系统】计一次，不是每条 finding 计一次',
        }
      }
    } else if (x.kind === 'register-gap' || x.kind === 'open-front') {
      // 以目标单位为单位的条目，board 上【一张卡都没有】—— 必须两步：
      // 先 board_asset_add 建资产卡，再 board_objective_add 挂意图。
      // 这正是蜂群建不了卡的根因：意图卡必须挂在资产卡下。
      const m = String(x.title).match(/#\s*(\d+)/)
      const no = m ? Number(m[1]) : null
      const u = no !== null ? unitByNo[no] : null
      const unitText = u ? u.text : String(x.title)
      const entry = u && u.intelEntry ? String(u.intelEntry).trim() : ''
      const entryIds = extractNetworkIds(entry)

      /* ★ address 只能取**真正的网络标识**，取不到就必须承认不知道。
       *
       * 原实现是 `unitGapAddr(u.text)` —— 对英文清单（域名-系统名）是对的，
       * 对中文清单（公司名-系统名）就会把公司名当地址登记。见 looksLikeNetworkId
       * 上面那段注释：这是伪造情报级错误，会污染 asset -> objective -> finding 的根。
       *
       * 优先级：
       *   1. 权威清单已证入口（`intel-semantics.json` 的 `scope_rulings`，见下方 addrSource 处的核实注释）
       *   2. 单位文本里能抽出的网络标识（第二种写法：域名写在前面）
       *   3. 都没有 → 用 `unresolved-<no>` 占位并**显式标注待解析**
       *
       * 为什么第 3 种仍然建卡而不是不建：建卡这个动作本身不是情报，它是**登记一条待办**。
       * 板面把 address+port 作为唯一键，用 `unresolved-<no>` 既保证唯一、又能被一眼认出。
       * 侦察任务（本来就是这条命令的实质）完成后把它改成真地址即可。
       * 关键是：卡上写清楚了「地址未知」，而不是编一个看起来像情报的东西。 */
      const guessed = unitGapAddr(unitText)
      /* ★ 第 23 轮：入口的真实出处必须**如实取得**（`entry` 就是 `scope_rulings[i].label`）。
       *
       * 原实现硬编码 `addrSource = '情报块已证入口'`（改前 L1724）、
       * `note` 里拼 `'入口来源：情报块已证 ' + entry`（改前 L1741）。
       * 该措辞**不成立**：
       *   · `entry` 的取值链是 `rec.intelEntry = ir.label`（本文件 L519），
       *     而 `ir` 来自 `matchUnits()` 的 `intelByNo`，`intelByNo` 只由
       *     `sem.scope_rulings`（`ruling === 'in-scope'`）填充（本文件 L470-L473）
       *     ⇒ 真实来源是军法文件 `doctrine/intel-semantics.json` 的 `scope_rulings`，
       *       **不是**板面任何「情报块」；该文件通篇零处读取 board.intel 作为入口来源。
       *   · 已实测：`scope-entrypoint-14-aspirecn` / `scope-entrypoint-18-tencent-cloud`
       *     的 `by` 都是 `recon-2026-10-14-entrypoints`；其同级 `unverifiable_notes`
       *     自述证据为「实测 2026-10-14（本机 DNS lookup + 公网首页 title）」。
       *   · 典型反例：`cloud.tencent.com`（#18）以 `tencent` 为关键词在板面 grep 情报块
       *     **零命中** —— 而原措辞会让这张卡写「情报块已证 cloud.tencent.com」。
       *     后果：lead 按对账纪律原样建卡 ⇒ 一条没有支撑的出处断言被写进卡标题，
       *     一路传进对外报告。
       * ⇒ 措施：去掉「情报块」这个不成立的限定词，改称「权威清单」，
       *    并把 `scope_rulings[i].by`（真实出处标识）拼进 note，使其可复核。
       *    谁若想改回「情报块已证」，请先自证板面存在对应情报块。 */
      // 入口的真实出处（scope_rulings 的写入者标识）。取不到就退化为清单名并明说它是哪一种权威清单。
      const entryOrigin = (function () {
        const et = S(entry)
        if (!et) return ''
        const sr = (doctrine && doctrine['intel-semantics'] && doctrine['intel-semantics'].scope_rulings) || []
        for (let i = 0; i < sr.length; i++) if (S(sr[i].label) === et) return S(sr[i].by).slice(0, 40)
        return ''
      })()
      let addr = ''
      let addrSource = ''
      if (entryIds.length > 0) { addr = entryIds[0]; addrSource = '权威清单（scope_rulings）已证入口' }
      else {
        const fromText = extractNetworkIds(unitText)
        if (fromText.length > 0) { addr = fromText[0]; addrSource = '单位文本内的网络标识' }
      }
      const addrUnresolved = addr === ''
      if (addrUnresolved) { addr = 'unresolved-' + (no !== null ? no : 'x'); addrSource = '占位：地址未知，待侦察解析' }

      e.twoStep = true
      e.derivedAddress = addrUnresolved
      e.addressSource = addrSource
      e.addressGuessed = addrUnresolved ? '' : guessed

      e.steps.push({ n: 1, tool: 'board_asset_add',
        args: { address: addr, port: null,
          service: unitText + (entry ? '（权威清单入口：' + entry + '）' : '（入口未知，待侦察）'), zone: 'internet',
          note: '由作战地图 v17 派工生成。⟦op:' + x.rank + '⟧ ' +
            (entry ? '入口来源：权威清单已证（`doctrine/intel-semantics.json` 的 scope_rulings' + (entryOrigin ? '，来源标识 ' + entryOrigin : '') + '）；' + entry + '。这是**军法清单**里的入口裁定，**不是板面情报块**。' : '该单位目前无任何已知入口。') +
            /* ★ 把「怎么找入口」直接写在建卡这一步的 note 里（M5）。
              为什么写在这里而不是单开一步：侦察不是板面写入动作，硬塞成一个 step
              会让 n/dependsOnStep 的编号语义变脏，还要重排后面的步骤。
              而 note 本来就跟着这张卡走 —— 执行者建卡时必然读到它，
              卡建好之后 note 也留在板面上，下一个人翻到这张卡同样看得到。
              方法条数封顶 4 条：note 是要被读的，不是要被供起来的。

              标点：方法列表和口径都自带句读，所以这里**只在结尾补一个句号**，
              而且补在整段之后而不是拼在字符串中间 —— 否则会出现「。。」。

              ★★ 第 20 轮补：纪律必须一起下发（`_discipline`）。
              实测发现 `recon.json` 只被消费了一半 —— `_entry_unknown.methods` 与方法
              都进了 note，但 `_discipline`（5 条铁律）在引擎代码里**零引用**。
              这与笔记 §16.2 说的 B 类缺陷同形：**声明写在军法里，引擎不读它。**

              为什么这条比"少发一段文字"严重：纪律那 5 条正是**防止伪造情报**的规则
              （不许拿公司名当地址 / 查不到就写未知不许编 / 归属要有可复核证据 /
              同名域名要排除 / 「站点可达」≠「系统已定位」）。只发方法不发纪律，
              等于告诉执行者"怎么找"，却不告诉他"什么算找到了、什么不算" ——
              而后者才是本项目那条硬纪律（不可伪造情报）的落点。
              所以纪律必须与方法同时出现在 note 里，并且**排在方法之前**：
              先立规矩，再给手段。 */
            (addrUnresolved
              ? '【侦察纪律·先读】' + (reconDoc && Array.isArray(reconDoc._discipline) && reconDoc._discipline.length
                  ? reconDoc._discipline.map(function (x, i) { return (i + 1) + '. ' + S(x) }).join(' ')
                  : '⚠ 侦察纪律未加载（doctrine/recon.json 的 _discipline 缺失）—— 引擎不替你编纪律，请先补军法')
                + '。【怎么找入口】' + (reconDoc && reconDoc._entry_unknown && Array.isArray(reconDoc._entry_unknown.methods)
                  ? reconDoc._entry_unknown.methods.slice(0, 4).join('；')
                  : '⚠ 侦察法单未加载（doctrine/recon.json 缺失或格式不对）—— 引擎不把战术写死在自己肚子里，所以这里没有兜底方法可给，请先补上军法')
                + (S(reconDoc && reconDoc._caveat_required) ? '。【填报口径】' + S(reconDoc._caveat_required) : '')
                + '。'
              /* ★ 第 20 轮补：地址**已解析出来**时，`_entry_known` 一直没被用。
                 这个场景是：引擎从权威清单（`scope_rulings`）里拿到了一个入口地址，但那只是"字符串长得像地址"，
                 **并不等于它属于这家单位**。实测踩过：裸 `unitechs.com` 解析失败（要用 www），
                 `aspirecn.com` 与 `zhuowang.com.cn` 都出现过"同名巧合"的坑。
                 所以这个场景的方法单（验证归属）比"找入口"更需要下发 ——
                 因为**地址已经填好，执行者最容易被诱导直接当真**。
                 漏发它的后果不是"少做一步"，而是把未验证的入口当成已确证事实记进板面。 */
              : (reconDoc && reconDoc._entry_known && Array.isArray(reconDoc._entry_known.methods) && reconDoc._entry_known.methods.length
                  ? '【入口已给，先验归属】' + reconDoc._entry_known.methods.slice(0, 3).join('；') + '。'
                    + (Array.isArray(reconDoc._discipline) && reconDoc._discipline.length
                      ? '【纪律】' + reconDoc._discipline.slice(0, 2).map(S).join(' ')
                      : '')
                    + (S(reconDoc._caveat_required) ? '【填报口径】' + S(reconDoc._caveat_required) + '。' : '')
                  : '')) +
            (addrUnresolved
              ? '⚠ address 是占位值 unresolved-' + (no !== null ? no : 'x') + '，**不是真实地址** —— '
                + '清单里只给了公司名与系统名，引擎不拿公司名冒充网络地址。'
                + '这条命令的实质工作就是侦察出真实入口，拿到后请把本卡 address 改成真值。'
              : 'address 取自' + addrSource + '（' + addr + '）。'),
        },
        why: '该单位在靶标清单里，但 board 上一张资产卡都没有。没有资产卡，意图卡无处可挂，蜂群也就看不见这条活。' })
      e.steps.push({ n: 2, tool: 'board_objective_add', dependsOnStep: 1,
        args: { asset_id: '（用第 1 步返回的 asset id）',
          title: '[' + x.rank + '·' + x.short + ']⟦op:' + x.rank + '⟧ #' + (no || '?') + ' ' + (entry ? '的入口定位与验证：权威清单已证入口 ' + entry : '的入口侦察：目前无任何已知入口'),
          method: '' },
        why: '登记之后这张卡才会出现在 board_snapshot 的 untested_assets 里，被蜂群看见并认领。' })
      e.assetIdSource = '（尚不存在，需第 1 步创建）'
      if (!entry) e.yield = e.yield || '新增分数的唯一来源'
    } else if (needsHumanKinds.has(String(x.kind))) {
      /* ★★ 第 21 轮：这一支以前是硬编码的 `x.kind === 'repair-boundary'`，
         而 `decision.json` 的 `dispatch.needs_human_kinds` 里**明明白白写着** `["repair-boundary"]`
         —— 那个字段在引擎里零引用。所以往数组里加一个新 kind **完全不生效**。
         （研读笔记 §16.3 §16.4 点名了这条；`kinds[]` 的 blocking/distance 是真读的，
           而"哪一类需要人"却写死在代码里，两处真相不一致而无人报错。）

         现在改成读军法。fallback 见上面 needsHumanKinds 的构造：
         军法缺失时退回 ['repair-boundary']，并置 needsHumanKindsSource 标出来源，
         由 payload 透出 —— **不静默兜底**（§6.11 的教训）。 */
      e.needsHuman = true
      e.blocked = '归属裁定是人的动作，引擎不替人决定'
      e.needsHumanBecause = 'decision.json 的 dispatch.needs_human_kinds 声明 kind=' + x.kind + ' 必须由人处理'
      /* repair-boundary 专属：它标题里带一个「清单外资产」地址，若能对上已有资产卡就挂上去。
         这段**不是** kind 判定的一部分，只是该 kind 的取址细节，所以留在分支内并显式点名，
         避免下次有人误以为"needs_human 的 kind 都长这样"。 */
      if (String(x.kind) === 'repair-boundary') {
        const addr = String(x.title).replace('清单外资产　', '').trim()
        if (assetByAddr[addr]) { e.assetId = assetByAddr[addr]; e.assetIdSource = '清单外资产卡 ' + addr }
      }
    } else {
      // blocker-* / open-front / repair-doctrine：流程级或全局项，用军法声明的托管资产
      const hit = anchorResolve(anchorDoc[x.kind])
      if (hit) { e.assetId = hit.id; e.assetIdSource = 'decision.json dispatch.anchor_assets 指定的托管资产（' + hit.how + '）' }
      else if (anchorDoc[x.kind]) { e.needsHuman = true; e.blocked = 'decision.json 的 dispatch.anchor_assets 指向了 ' + S(anchorDoc[x.kind]) + '，但 board 上找不到这张资产卡 —— 托管资产失效了' }
      else if (x.blocking) { e.needsHuman = true; e.blocked = '这是流程级义务（阻断项），不属于任何目标资产。需在 decision.json 的 dispatch.anchor_assets 里指定托管资产卡，否则蜂群建不了卡、这条建议永远落不了地' }
      else { e.needsHuman = true; e.blocked = '全局项，不属于任何目标资产；需指定托管资产或由人处理' }
    }

    // 可直接执行的调用（没有分步的条目才有）
    if (!e.steps.length) {
      e.call = { tool: 'board_objective_add',
        args: { asset_id: e.assetId || '（待指定）', title: '', method: '', parent_finding_id: e.parentFindingId || undefined } }
    }
    const rationale = [
      '【为什么排在这】distance=' + x.distance + ' cost=' + x.cost +
        (x.blocking ? ' blocking=是' : '') + (x.externalPending ? ' external_pending=是' : '') +
        '　车道=' + (x.lane === 'paper' ? '文书线（不占攻击工时）' : '突击线（新增分数来源）'),
      '【它挡住什么】' + (x.blockingOn || '不阻断其他事项'),
      '【收益口径】' + (x.yield || '未声明'),
      /* ★ 第 22 轮：这一行直接回答指挥员最初的问题「哪些是拿分项」。
         写在 method 里（而不是只放在 payload 里），是因为：
         ① 卡片是**持久**的 —— 命令落地后这段文字留在板面上，下一轮/下一个人还看得见；
         ② 它是**给执行者看的**，而执行者看不到引擎的 payload；
         ③ 口径全部照抄 score-table 的 projection，不新增任何自己的算法。 */
      (e.score
        ? '【值多少分】' + e.score.interval + ' —— ' + e.score.basis +
          (e.score.isTargetSystem ? '；这是靶标点名系统（上界 3000）' : '；这是同主体的其他系统（上界 2000）') +
          '。' + e.score.dedupNote + '。区间不是保守，是规则要求：'
          + '「重要业务系统」的定性权在裁判组，我们无法自判，给点估计就是伪装成已知。'
        : ''),
      '【要做的动作】' + kd.verb,
      '【执行者】' + kd.executor,
      '【上下文】' + x.detail,
      // 编号也进 method：便于人按编号在板上反查，且让对账多一条冗余判据。
      '【命令编号】⟦' + e.orderKey + '⟧',
    ].filter(Boolean).join('\n')
    // 排序只能写在自由文本里：意图卡没有 priority 字段
    // ⟦op:N⟧ 是闭环对账锚点：桥接层靠它判断这条命令是否已落成板面上的活。
    const titled = '[' + x.rank + '·' + x.short + ']⟦' + e.orderKey + '⟧ ' + x.title
    if (e.call) { e.call.args.title = titled; e.call.args.method = rationale }
    for (let q = 0; q < e.steps.length; q++) if (e.steps[q].n === 2) e.steps[q].args.method = rationale

    e.readyToFile = (!!e.call && !!e.assetId) || e.steps.length > 0
    if (e.needsHuman && !e.steps.length && !e.call) e.readyToFile = false

    /**
     * 派工包（M3）—— 给 lead **可以直接粘进 subagent 的 prompt** 的结构化上下文。
     *
     * 为什么要有这一项：dsh 的 subagent 工具只收 {description, prompt, run_in_background}，
     * 没有任何字段能承载 objective_id / asset_id / parent_finding_id。swarm 的
     * SwarmDispatch 是带结构上下文的，我们这边一直是「lead 手写 prompt」——
     * 手写就会漂移：漏掉 asset_id，工蜂就不知道成果该记到谁头上（G9 归属错）。
     *
     * 所以在**决策层**把它生成好。这不是替 lead 做判断，是把已经算出来的
     * 客观字段（哪张卡、哪个资产、谁的子成果）固化成一段话，避免转述失真。
     * 注意分寸：派工包里【只放客观标识与交付要求】，不写「应该先打哪个」之类的
     * 战术判断 —— 那要 lead 自己按当前态势决定。
     */
    const ctxLines = []
    if (e.assetId) ctxLines.push('- asset_id: ' + e.assetId)
    if (e.parentFindingId) ctxLines.push('- parent_finding_id（本意图是由这条成果衍生的）: ' + e.parentFindingId)
    if (e.steps.length) {
      ctxLines.push('- 本意图在板面上还不存在，需要先建卡：先 board_asset_add，再 board_objective_add（参数见下）')
      /* ★ 串接必须说清楚，否则会被照抄成一个坏参数。
         step2 的参数里 asset_id 写的是占位字符串「（用第 1 步返回的 asset id）」——
         它是给人看的，不是能直接传的值。必须明确要求用第 1 步**返回的** id 替换它。 */
      ctxLines.push('- ⚠ 第 2 步的 asset_id 是占位符，**必须替换成第 1 步返回的真实 id**（形如 asset-xxxxxx）。不要把占位符原样传进去。')
    } else if (e.call && e.call.args && e.call.args.objective_id) {
      ctxLines.push('- objective_id: ' + e.call.args.objective_id)
    }
    /* 地址可信度必须进派工包：工蜂据此决定「直接侦察」还是「先确认地址」。
       不可信数据不许被当成已知事实往下传。 */
    if (e.addressSource) {
      ctxLines.push(
        e.derivedAddress
          ? '- ⚠ 入口地址未知：板面登记的是占位值，不是真实入口。**先解析出真实域名/IP 再动手**，别对占位值发包。'
          : '- 入口地址来源：' + e.addressSource + '（' + (e.steps[0] && e.steps[0].args ? e.steps[0].args.address : '') + '）',
      )
    }
    /* ── 纪律段：必须**按命令形态生成**，不能一句话套所有条 ──
     *
     * ★ 这里原来是一段写死的三行，套在全部 16 条上。审计（第 13 轮）发现它对两类命令是错的：
     *
     * ① 两步命令（⟦op:18⟧ ⟦op:20⟧ ⟦op:21⟧ ⟦op:22⟧）—— 卡**还不存在**（第 1 步才建）。
     *    写死的「动手前先 board_objective_claim 认领这张意图卡」让它去认领一张不存在的卡。
     *    它要么卡住，要么随便找一张卡认领 —— 后者的后果是**成果挂到别人的意图下**。
     *    正确顺序是：建卡 → 认领新卡 → 做 → 落卡。
     *
     * ② needsHuman 的命令（⟦op:6⟧ 归属裁定）—— 这类命令的正文就是「这不是机器该决定的事」，
     *    而写死的纪律却在催它 `board_finding_add` 落成果。
     *    如果它照做，就会对一个**清单外资产**产出成果 —— 按 G9 越界成果不计分、还可能扣分。
     *    也就是说：纪律段在推着它违反 doctrine。
     *
     * 教训：纪律不能是常量。它必须由「这条命令是什么形态」推出来，
     * 否则「照做」和「做对」会分叉，而分叉的方向恰好是丢分。
     */
    const discipline = []
    if (e.twoStep) {
      discipline.push('- 这张意图卡在板面上**还不存在**：先按第 1、2 步把它建出来，再把第 2 步返回的 obj-xxxxxx 认领（board_objective_claim），然后才动手。')
      discipline.push('- ⚠ 别去认领别的卡：成果会因此挂到**别人的意图**下，溯源就断了。')
    } else if (e.needsHuman) {
      discipline.push('- ★ 这条命令**不是给蜂群执行的**：它的正文就是「这一步需要人裁定」。不要把「裁定」当成技术动作去做。')
      discipline.push('- 你需要的是把它**交给人**并记录：用 board_objective_record 写下你建议怎么裁、依据是什么。**不要写成 finding** —— 裁定结论不是渗透成果，写进 finding 会污染成果面。')
      discipline.push('- ⚠ 在裁定之前**不要对这张卡对应的资产动手**：清单外/归属未定的资产，按 G9 越界成果不计分，直接打还可能触发扣分。')
    } else {
      discipline.push('- 动手前先 board_objective_claim 认领这张意图卡；成果必须以自己的身份写入（板面强制）。')
    }
    discipline.push('- 无证据不算成果：审批通过、命令跑完、退出码 0 都不是证据。没有证据就写成 record，不要写成 finding。')
    discipline.push(
      e.needsHuman
        ? '- 只处理这一条。做完用 board_objective_record 写下裁定建议（**不要用 board_finding_add**），并在回复里报回编号 ⟦' + e.orderKey + '⟧。'
        : '- 只做这一条意图。做完用 board_finding_add 或 board_objective_record 落卡，并在回复里报回编号 ⟦' + e.orderKey + '⟧。',
    )

    e.dispatchPrompt = [
      '【目标】' + x.title,
      '【命令编号】⟦' + e.orderKey + '⟧（回复里必须原样带上，它是唯一的对账锚点）',
      '【要做的动作】' + kd.verb,
      /* ★ 第 23 轮：派工包是工蜂**唯一**会读的东西，所以分数必须进这里。
         第 22 轮我已经把分数挂到了条目上、也写进了卡面 method —— 但实测发现
         工蜂看不到那两处：dispatchPrompt 才是被粘进 subagent 的正文。
         一份"指定给执行者"的信息没出现在执行者实际读的文本里，等于没送。
         （这与 §6.13.1「只发方法不发纪律」是同一类错：**通道选错了**。） */
      (e.score
        ? '【值多少分】' + e.score.interval + ' —— ' + e.score.basis +
          '。' + e.score.dedupNote + '。这个区间来自 ' + e.score.source +
          '，不是估计值：给点估计就是伪装成已知。'
        : ''),
      /* ★ 第 26 轮：数据成果分是**另一笔账**，单独一行说清楚 ——
         而且必须明确"数量未知时需要人工给数"，否则执行者会以为没这回事。 */
      (e.score && e.score.dataScore && !e.score.dataScore.excluded
        ? '【另有数据成果分】' + e.score.dataScore.note
          + '　口径：' + e.score.dataScore.rule + '。'
          + '注意这是**独立于权限**的第二笔分，不要与上一行的权限区间相加后当成一个数。'
        : ''),
      '【当前态势】' + x.detail,
      '【上下文标识】',
      ctxLines.length ? ctxLines.join('\n') : '- （本条无现成卡，需按下面的调用建卡）',
      '【纪律】',
      discipline.join('\n'),
    ].filter(Boolean).join('\n')

    entries.push(e)
  }

  const executable = entries.filter(function (e) { return e.readyToFile && !e.needsHuman })
  const twoStep = entries.filter(function (e) { return e.twoStep })
  const needsHuman = entries.filter(function (e) { return e.needsHuman })
  return {
    ok: true, version: 'dispatch/1',
    intro: '这一页把【建议】翻译成【蜂群真的能执行的 board 调用】。蜂群按协议「claim the objective, not the asset」—— 没有意图卡就不能动，所以地图的建议必须变成卡，否则它只是给人看的。引擎在这里只产出参数、不写板面：写权限一旦开给地图，溯源、心跳租约、写屏障、审批门禁四个不变量全部作废。',
    discipline: '排序信息写在 title / method 的自由文本里 —— 因为板面的意图卡【没有 priority 字段】。不许假装有。',
    executeHint: '执行：带两步的条目先 board_asset_add 建资产卡，再 board_objective_add 挂意图（asset_id 用第 1 步返回值）；其余条目直接 board_objective_add。建完卡，蜂群才会在 board_snapshot 里看见它。',
    anchorNote: needsHuman.length ? (needsHuman.length + ' 条是流程级义务或需人裁定项，不属于任何目标资产，不能直接建卡：需先指定托管资产（decision.json 的 dispatch.anchor_assets），或由人完成动作本身。') : '',
    entries: entries, executable: executable, twoStep: twoStep, needsHuman: needsHuman,
    counts: { total: entries.length, executable: executable.length, twoStep: twoStep.length, needsHuman: needsHuman.length },
    /* ★ 第 21 轮：把两条**本该是军法配置、以前却写死在代码里**的口径透出来。
       透出来的理由不是好看，而是"改了要能看见生效" ——
       B 类字段（写了不生效）之所以危险，正因为从文件本身看不出它是死的。
       现在指挥员改完 decision.json，能在 payload 里直接核到引擎读了什么。 */
    needsHumanKindsSource: needsHumanKindsSource,
    needsHumanKinds: [...needsHumanKinds],
    /* ★★ 第 25 轮补：`achievable` 与 `scorePotential` 回答的是**两个不同问题**。
       实测教训：confident = 0 时 scorePotential 显示 "[0, 0]"，
       指挥员会以为"这轮没分可拿"；而实际上 6 条 cash-in 命令各自带着
       [0,3000] / [20,100] 的区间。两者都是真的，但只说 [0,0] 是**误导**。
         · scorePotential = 现在**已经确认**拿到多少（只统计 confident）
         · achievable     = 这一轮把活干完**能拿到**多少（每条命令区间加总，按资产去重） */
    achievable: (function () {
      const credited = entries.filter(function (e) { return e.score && e.score.span !== 'triage' })
      const byAsset = {}
      for (const e of credited) {
        const k = e.assetId || e.orderKey
        if (!byAsset[k] || byAsset[k].upper < e.score.upper) byAsset[k] = e.score
      }
      let dlo = 0, dhi = 0
      for (const k of Object.keys(byAsset)) { dlo += byAsset[k].lower; dhi += byAsset[k].upper }
      const rawLo = credited.reduce(function (n, e) { return n + e.score.lower }, 0)
      const rawHi = credited.reduce(function (n, e) { return n + e.score.upper }, 0)
      return {
        interval: '[' + dlo + ', ' + dhi + ']',
        lower: dlo,
        upper: dhi,
        beforeDedup: '[' + rawLo + ', ' + rawHi + ']',
        orders: credited.length,
        excludedTriage: entries.filter(function (e) { return e.score && e.score.span === 'triage' }).length,
        note: '把每一条 cash-in 命令自己的区间加总（已按资产去重）。它回答「这一轮把活干完能拿到什么」。',
        why: '未去重会虚增：' + rawLo + '/' + rawHi + ' → 去重后 ' + dlo + '/' + dhi + '（同一系统只计一次）。',
      }
    })(),
    scorePotential: (ledger && ledger.totals) ? {
      lower: ledger.totals.onceLow,
      upper: ledger.totals.onceUp,
      interval: '[' + ledger.totals.onceLow + ', ' + ledger.totals.onceUp + ']',
      upperBeforeDedup: ledger.totals.sumUp,
      note: '**已经确认**能兑现的区间（只统计 confident 条目，按 asset 去重）。'
        + '它低于 achievable 是正常的 —— 那说明这些分还在「要去做」而不是「已经拿到」的状态。'
        + '未去重上界 ' + ledger.totals.sumUp + ' —— 与去重值之差就是「重复登记同一系统」会造成的虚增。',
      source: 'doctrine/score-table.json 的 projection',
      howToRead: '下界 = 已有「已取得权限」证据、可直接兑现的部分；上界 = 还需裁判组定性才能拿到的部分。',
    } : null,
  }
}

/* ════════ 蜂群视野（工蜂此刻看得见什么） ════════

   这一层是【对照】：地图建议什么 vs 蜂群唯一能看见态势的 board_snapshot 递给他们什么。
   价值不是好看，而是让「地图 21 条 / 蜂群 4 条」这种断层在界面上直接可见 ——
   在此之前，没有任何一处能看到这个落差。

   口径严格按 hive preset 的 board 插件源码（board 插件的 board_snapshot）：
   ⚠ 这里原来写死了 `plugins/board/lib/index.js`。第 36 轮我给 board 加了一条 lead 纪律，
     按本项目的铁律（loader 按解析路径缓存模块，原地改永不重新加载）必须换到新目录
     `plugins/board2/` 部署，于是这个写死的路径**指向了一份不再生效的副本** ——
     注释里的路径也是一种"两处真相"，它会静默过期。
     所以改成不写版本化路径：**要读哪个副本，去组合里看 board 那一行现在指向哪。**
     open_objectives = status === 'open'
     live_claims     = 心跳未过期
     expired_claims  = 心跳过期（可重新派工）
     untested_assets = 一张 objective 都没有的资产
   注意：board_snapshot 带 verbose="full" 时返回全部原始卡（那时 note 在），
   默认摘要里没有 note。这一点必须说准，不许夸大成硬缺口。
*/
function buildSwarmView(model, targets, dispatch) {
  const objs = []
  for (let i = 0; i < model.chains.length; i++) for (let j = 0; j < model.chains[i].objectives.length; j++) objs.push(model.chains[i].objectives[j])
  const now = Date.now()
  const open = [], live = [], expired = [], byStatus = {}
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i].objective, cl = objs[i].claim
    const st = S(o.status) || '?'
    byStatus[st] = (byStatus[st] || 0) + 1
    if (st === 'open') open.push({ id: o.id, title: o.title, createdAt: o.createdAt })
    if (cl && !cl.releasedAt && cl.heartbeatAt) {
      const t = Date.parse(cl.heartbeatAt)
      if (!isNaN(t)) {
        if (now - t > CLAIM_TTL_MS) expired.push({ id: o.id, holder: cl.agent, heartbeatAt: cl.heartbeatAt, ageMin: Math.round((now - t) / 60000) })
        else live.push({ id: o.id, holder: cl.agent, heartbeatAt: cl.heartbeatAt })
      }
    }
  }
  const untested = (model.gaps.untestedTargets || []).map(function (a) { return { id: a.id, address: a.address } })
  const visible = open.length + expired.length + untested.length
  const dx = dispatch && dispatch.ok ? dispatch : { counts: { total: 0, executable: 0, twoStep: 0, needsHuman: 0 } }
  return {
    ok: true,
    question: '蜂群唯一能看见态势的地方是 board_snapshot 工具。这一块把它递出去的东西，和地图的建议放在一起对照。',
    entryPoint: 'board_snapshot（hive preset 的 board 插件）',
    objectivesTotal: objs.length, byStatus: byStatus,
    open: open, live: live, expired: expired, untested: untested,
    visibleCount: visible, hiddenCount: objs.length - open.length - expired.length,
    mapTotal: dx.counts.total, gap: dx.counts.total - visible,
    noteOnNote: 'board_snapshot 默认摘要不返回 note 字段（只返回 id/address/port 与 id/title），带 verbose="full" 时才返回全部原始卡、那时 note 在。准确说法是：默认快照里看不见 note。但【排序信息无论 verbose 与否都不存在】—— 意图卡上没有 priority 字段。',
    drivingGap: [
      '① 蜂群的快照不含任何优先级、distance、cost、时间窗 —— 全在引擎里，一条也没下发。',
      '② 地图的建议项原先不是卡片，而蜂群按协议不能动没有卡的活。',
      '③ 有些建议（文件 R5 报备）蜂群的 16 个工具里没有任何一个能做 —— 那是平台侧动作，只能由人或 lead 去做。',
    ],
  }
}

/* ════════ 指标语义层 ════════ */

function computeMetrics(model, ledger, intelDrive, targets, metricsDoc, decision, schwerpunkt, dispatch, swarmView) {
  if (!metricsDoc) return { ok: false, error: 'metrics.json 未加载' }
  const defs = {}
  for (let i = 0; i < (metricsDoc.metrics || []).length; i++) defs[metricsDoc.metrics[i].id] = metricsDoc.metrics[i]
  const F = model.allFindings || []
  const byKind = {}, byEv = { '有证据': 0, '无证据': 0 }
  for (let i = 0; i < F.length; i++) { byKind[F[i].resultKind] = (byKind[F[i].resultKind] || 0) + 1; if ((F[i].evidenceCount || 0) > 0) byEv['有证据']++; else byEv['无证据']++ }
  const byStatus = {}
  for (let i = 0; i < model.chains.length; i++) for (let j = 0; j < model.chains[i].objectives.length; j++) { const s = S(model.chains[i].objectives[j].objective.status) || '?'; byStatus[s] = (byStatus[s] || 0) + 1 }
  const intelScope = {}
  for (let i = 0; i < model.intel.length; i++) { const s = S(model.intel[i].scope) || '?'; intelScope[s] = (intelScope[s] || 0) + 1 }
  const L = ledger && ledger.ok ? ledger : { counts: {}, totals: {}, triage: [], byAsset: [] }
  const T = targets
  const SP = (schwerpunkt && schwerpunkt.ok) ? schwerpunkt
    : { ok: false, counts: { total: 0, blockers: 0, externalPending: 0, paper: 0, assault: 0 }, items: [], time: { known: [], unknown: [], window: { first: '', last: '', hours: 0 } } }
  const bd = function (obj) { return Object.keys(obj).map(function (k) { return { k: k, v: obj[k] } }) }
  const vals = {
    targets: { value: T ? T.units.length : 0, breakdown: T ? (T.units.filter(function (u) { return u.noPhishing }).length ? [{ k: '禁止钓鱼', v: T.units.filter(function (u) { return u.noPhishing }).length }] : []) : [] },
    covered: { value: T ? T.covered : 0, breakdown: T ? bd(T.byStatus || {}) : [] },
    realGap: { value: T ? T.realGap.length : 0, warn: !!(T && T.realGap.length), breakdown: T ? T.realGap.map(function (u) { return { k: '#' + u.no, v: u.text.slice(0, 16) } }) : [] },
    intelEntry: { value: T ? T.intelCovered.length : 0, warn: !!(T && T.intelCovered.length), breakdown: T ? T.intelCovered.map(function (u) { return { k: '#' + u.no, v: u.intelEntry } }) : [] },
    orphan: { value: T ? T.orphan.length : 0, warn: !!(T && T.orphan.length), breakdown: T ? T.orphan.map(function (a) { return { k: a, v: '' } }) : [] },
    // v15：身份层。这两个数不产分，但决定别的数是否可信 —— 归属错了，成果就算到别人头上（G9）。
    identityConflicts: T && T.identity ? { value: T.identity.counts.conflicts + T.identity.counts.unresolved, warn: !!(T.identity.counts.conflicts + T.identity.counts.unresolved),
      breakdown: (T.identity.conflicts.length ? [{ k: '归属冲突', v: T.identity.conflicts.length }] : []).concat(T.identity.unresolved.length ? [{ k: '无法定归属', v: T.identity.unresolved.length }] : []) } : { value: 0, warn: true, breakdown: [] },
    implicitOwnership: T && T.identity ? { value: T.identity.counts.implicit, warn: false,
      breakdown: (T.identity.paths || []).filter(function (p) { return p.id !== 'explicit-field' }).map(function (p) {
        return { k: IDENTITY_PATH_LABELS[p.id] || p.id, v: T.units.reduce(function (n, u) { return n + u.attribution.filter(function (x) { return x.path === p.id }).length }, 0) }
      }) } : { value: 0, warn: false, breakdown: [] },
    // v16：note 盲区。note 是人写的判断，而推导路径只扫 address+service —— 只报线索，不参与归属。
    noteMentions: T && T.identity ? { value: T.identity.counts.noteMentions || 0, warn: !!(T.identity.counts.noteMentions),
      breakdown: (T.identity.noteMentions || []).map(function (x) {
        const bad = x.mentioned.filter(function (n) { return (x.assigned || []).indexOf(n) < 0 })
        return { k: x.addr, v: 'note 提到 #' + x.mentioned.join(',#') + (bad.length ? ' ≠ 实际 #' + (x.assigned.join(',#') || '无') : ' ✓') }
      }) } : { value: 0, warn: false, breakdown: [] },
    conclusions: { value: model.counts.findings, breakdown: bd(byKind).concat(bd(byEv)) },
    scorable: { value: L.counts.confident || 0, good: !!(L.counts.confident), warn: !L.counts.confident, breakdown: (L.byAsset || []).map(function (b) { return { k: b.asset, v: b.maxUp } }) },
    triage: { value: L.counts.triage || 0, warn: !!(L.counts.triage), breakdown: (L.triage || []).map(function (e) { return { k: e.findingId, v: e.evidenceCount + ' 证据' } }) },
    needsJudgement: { value: L.counts.needsJudgement || 0, warn: !!(L.counts.needsJudgement), breakdown: [] },
    objectives: { value: model.counts.objectives, breakdown: bd(byStatus) },
    intel: { value: model.counts.intel, breakdown: bd(intelScope) },
    egress: { value: model.counts.egress, warn: model.counts.egress === 0, breakdown: [] },
    local: { value: model.counts.local, breakdown: model.chains.filter(function (c) { return c.asset.zone === 'local' }).map(function (c) { return { k: c.asset.address.slice(0, 26), v: '' } }) },
    // v14 新增四项：决策层上了地图，指标语义层才算完整（metrics.json v2 定义了 17 项，v13 只算了 13 项）
    decisions: SP.ok ? { value: SP.counts.total, warn: SP.counts.total === 0, breakdown: SP.counts.total ? [
      { k: '阻断', v: SP.counts.blockers }, { k: '文书线', v: SP.counts.paper }, { k: '突击线', v: SP.counts.assault }] : [] } : { value: 0, warn: true, breakdown: [] },
    blockers: SP.ok ? { value: SP.counts.blockers, warn: SP.counts.blockers > 0, breakdown: SP.items.filter(function (x) { return x.blocking }).map(function (x) { return { k: x.short, v: x.title.slice(0, 22) } }) } : { value: 0, warn: true, breakdown: [] },
    evidenceWindow: { value: SP.time.window.hours, breakdown: SP.time.window.first ? [{ k: '首条', v: SP.time.window.first.slice(0, 16) }, { k: '末条', v: SP.time.window.last.slice(0, 16) }] : [] },
    timeUnknown: { value: SP.time.unknown.length, warn: SP.time.unknown.length > 0, breakdown: SP.time.unknown.map(function (x) { return { k: S(x.id), v: String(S(x.what)).slice(0, 18) } }) },
    // v17：派工层与蜂群视野。这两个数不产分，但它们回答的是
    // 「地图算出来的东西，到底有没有变成蜂群能执行的活」。缺口越大越说明地图空转。
    dispatchable: (function () {
      const D = dispatch && dispatch.ok ? dispatch : { counts: { total: 0, executable: 0, twoStep: 0, needsHuman: 0 }, entries: [] }
      return { value: D.counts.executable, warn: D.counts.total > 0 && D.counts.executable === 0,
        breakdown: [{ k: '可直接建卡', v: D.counts.executable }, { k: '需两步（先建资产卡）', v: D.counts.twoStep },
          { k: '需人或先指定托管资产', v: D.counts.needsHuman }] }
    })(),
    swarmGap: (function () {
      const SW = swarmView || null
      if (!SW) return { value: 0, warn: true, breakdown: [] }
      return { value: SW.gap, warn: SW.gap > 0,
        breakdown: [{ k: '地图建议', v: SW.mapTotal }, { k: '蜂群可见', v: SW.visibleCount },
          { k: '蜂群看不见的 objective', v: SW.hiddenCount }] }
    })(),
  }

  const groups = []
  const order = (metricsDoc.display && metricsDoc.display.group_orders) || []
  for (let i = 0; i < order.length; i++) {
    const g = order[i], items = []
    for (let j = 0; j < (g.ids || []).length; j++) {
      const id = g.ids[j], d = defs[id], v = vals[id]
      if (!d || !v) continue
      items.push({ id: id, label: d.label, unit: d.unit, what: d.what, how: d.how, valueToGoal: d.value_to_goal, pitfall: d.pitfall,
        value: v.value, breakdown: v.breakdown, warn: !!v.warn, good: !!v.good })
    }
    if (items.length) groups.push({ group: g.group, items: items })
  }

  return { ok: true, version: metricsDoc.version, groups: groups,
    headline: { scorable: vals.scorable.value, realGap: vals.realGap.value, triage: vals.triage.value, blockers: vals.blockers.value, decisions: vals.decisions.value },
    schwerpunktOk: SP.ok, hardLessons: metricsDoc.hard_lessons || [], rule: metricsDoc.rule || '' }
}

function safeRe(s) { if (!s) return null; try { return new RegExp(String(s), 'i') } catch (e) { return null } }
function matchTactics(doc, asset) {
  const list = (doc.tactics && doc.tactics.tactics) || []
  const hay = [asset.address, asset.service, asset.note].map(S).join(' ')
  const port = asset.port === null || asset.port === undefined ? '' : String(asset.port)
  const server = S(asset.server), hits = []
  for (let i = 0; i < list.length; i++) {
    const tp = list[i], d = tp.detect || {}
    let why = null
    if (!why && d.host_regex) { const re = safeRe(d.host_regex); if (re && re.test(S(asset.address))) why = 'host' }
    if (!why && d.title_regex) { const re = safeRe(d.title_regex); if (re && re.test(hay)) why = 'title' }
    if (!why && d.server_regex) { const re = safeRe(d.server_regex); if (re && re.test(S(server))) why = 'server' }
    if (!why && d.port_in && port) { for (let j = 0; j < d.port_in.length; j++) if (String(d.port_in[j]) === port) { why = 'port'; break } }
    if (why) hits.push({ id: tp.id, name: tp.name, category: tp.category, matchedBy: why, stepCount: (tp.tactics || []).length })
  }
  return hits
}

/* ★★ 第 28 轮 A 组：board 的 finding.result 是**对象**（{title, category, impact, …}），
 * 而这里原来写的是 S(f.result) —— S(v) 就是 String(v)，对对象恒等于字面量 "[object Object]"。
 * 后果：判档的输入只剩 summary 一个字段，result.title / result.impact 从未被读过 ——
 * 而它们是成果卡上人写的最凝练的那两句话（"容器内 root 读出宿主文件系统"这种），却被静默吞掉。
 * 现在把对象里的字符串字段摊平成本文；非对象仍走 S()。
 * ⚠ 只摊平字符串，不摊平元数据：registered_at / registered_by 是"谁在何时登记的"，
 *   不是取得证据，混进判档文本会让"登记时间里的数字"被当成证据。 */
function resultText(v, depth) {
  const d = depth || 0
  if (d > 3) return ''
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return S(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(function (x) { return resultText(x, d + 1) }).filter(Boolean).join(' ')
  if (typeof v === 'object') {
    const SKIP = { registered_at: 1, registered_by: 1, created_at: 1, updated_at: 1, id: 1 }
    const keys = Object.keys(v), out = []
    for (let i = 0; i < keys.length; i++) {
      if (SKIP[keys[i]]) continue
      const t = resultText(v[keys[i]], d + 1)
      if (t && t !== '[object Object]') out.push(t)
    }
    return out.join(' ')
  }
  return S(v)
}

function buildModel(board, doc, exclusions) {
  const assets = board.assets || [], objectives = board.objectives || []
  const findings = board.findings || [], intel = board.intel || [], approvals = board.approvals || []
  const now = Date.now()
  const objByAsset = {}, findByAsset = {}
  function normFinding(f) {
    const id = S(f.id)
    return { id: id, objectiveId: S(f.objective_id), assetId: S(f.asset_id), parentFindingId: S(f.parent_finding_id),
      resultKind: S(f.result_kind) || '?', summary: S(f.summary), url: S(f.url),
      evidenceCount: evCount(f.evidence), result: resultText(f.result),
      createdAt: S(f.created_at), dropped: !!(exclusions && exclusions[id] && exclusions[id].ruling === 'exclude') }
  }
  for (let i = 0; i < objectives.length; i++) { const o = objectives[i], k = S(o.asset_id) || '(none)'; if (!objByAsset[k]) objByAsset[k] = []; objByAsset[k].push(o) }
  for (let i = 0; i < findings.length; i++) { const f = findings[i], k = S(f.asset_id) || '(none)'; if (!findByAsset[k]) findByAsset[k] = []; findByAsset[k].push(normFinding(f)) }
  const findByObjective = {}
  for (let i = 0; i < findings.length; i++) { const f = findings[i], k = S(f.objective_id); if (!k) continue; if (!findByObjective[k]) findByObjective[k] = []; findByObjective[k].push(normFinding(f)) }

  const INTEL = intel.map(function (x) {
    let tags = []
    const raw = x.tags
    if (Array.isArray(raw)) tags = raw.map(S).filter(Boolean)
    else { const s = S(raw); if (s) tags = s.replace(/[\[\]']/g, '').split(',').map(function (z) { return z.trim() }).filter(Boolean) }
    return { id: S(x.id), title: S(x.title), body: String(S(x.body)).slice(0, 600), scope: S(x.scope), sensitivity: S(x.sensitivity), tags: tags.slice(0, 12), createdAt: S(x.created_at) }
  })

  const chains = []
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i], objs = objByAsset[S(a.id)] || [], links = []
    for (let j = 0; j < objs.length; j++) {
      const o = objs[j], cl = o.claim || null
      let stale = false, hb = ''
      if (cl) { hb = S(cl.heartbeat_at); if (hb) stale = (now - Date.parse(hb)) > CLAIM_TTL_MS }
      links.push({ objective: { id: S(o.id), title: S(o.title), status: S(o.status), method: String(S(o.method)).slice(0, 500), parentFindingId: S(o.parent_finding_id), createdBy: S(o.created_by), createdAt: S(o.created_at) },
        claim: cl ? { agent: S(cl.agent), claimedAt: S(cl.claimed_at), heartbeatAt: hb, checkpoint: String(S(cl.checkpoint)).slice(0, 320), releasedAt: S(cl.released_at), stale: stale } : null,
        recordCount: (o.records || []).length,
        records: (o.records || []).slice(-2).map(function (r) { return { at: S(r.at), by: S(r.by), note: String(S(r.note)).slice(0, 350) } }),
        findings: findByObjective[S(o.id)] || [] })
    }
    const addr = S(a.address)
    const relIntel = INTEL.filter(function (x) {
      if (addr && (x.title.indexOf(addr) >= 0 || x.body.indexOf(addr) >= 0)) return true
      const dom = addr.split('.').slice(-2).join('.')
      if (dom && dom.length > 4) { for (let q = 0; q < x.tags.length; q++) if (x.tags[q].indexOf(dom) >= 0) return true }
      return false
    })
    // raw 保留整张原始卡：身份层要读显式归属字段（asset.unit 等），而字段名可能不止一个。
    // 不在这里列举字段，是因为「哪些字段能表达归属」属于身份军法，不属于本函数。
    chains.push({ asset: { id: S(a.id), address: addr, port: a.port === null || a.port === undefined ? null : S(a.port), service: S(a.service), zone: S(a.zone) || 'unknown', note: String(S(a.note)).slice(0, 400), createdBy: S(a.created_by), raw: a },
      objectives: links, findings: findByAsset[S(a.id)] || [], intel: relIntel, tactics: matchTactics(doc, a) })
  }

  const gaps = { untested: [], untestedTargets: [], noResult: [], stale: [], unclaimed: [], closedClean: [], closedWithResult: [] }
  for (let i = 0; i < chains.length; i++) {
    const c = chains[i]
    if (!c.objectives.length) {
      const rec = { id: c.asset.id, address: c.asset.address, service: c.asset.service, zone: c.asset.zone, note: c.asset.note }
      gaps.untested.push(rec)
      if (c.asset.zone !== 'local') gaps.untestedTargets.push(rec)
    }
  }
  for (let i = 0; i < objectives.length; i++) {
    const o = objectives[i], cl = o.claim || null
    const terminal = o.status === 'closed' || o.status === 'tested' || o.status === 'released'
    const gotFindings = (findByObjective[S(o.id)] || [])
    if (cl && S(cl.heartbeat_at) && !S(cl.released_at)) { const age = now - Date.parse(S(cl.heartbeat_at)); if (age > CLAIM_TTL_MS) gaps.stale.push({ id: S(o.id), title: S(o.title), agent: S(cl.agent), ageMin: Math.round(age / 60000), assetId: S(o.asset_id) }) }
    if (!cl && !terminal) gaps.unclaimed.push({ id: S(o.id), title: S(o.title), status: S(o.status), assetId: S(o.asset_id) })
    if (terminal && !gotFindings.length) { gaps.noResult.push({ id: S(o.id), title: S(o.title), status: S(o.status), assetId: S(o.asset_id) }); gaps.closedClean.push({ id: S(o.id), title: S(o.title) }) }
    if (terminal && gotFindings.length) gaps.closedWithResult.push({ id: S(o.id), title: S(o.title), findings: gotFindings.length })
  }

  const tpList = (doc.tactics && doc.tactics.tactics) || []
  const usedIds = {}
  let matchedAssets = 0, internet = 0, local = 0
  for (let i = 0; i < chains.length; i++) {
    if (chains[i].asset.zone === 'local') local++; else internet++
    if (chains[i].tactics.length) matchedAssets++
    for (let j = 0; j < chains[i].tactics.length; j++) usedIds[chains[i].tactics[j].id] = (usedIds[chains[i].tactics[j].id] || 0) + 1
  }
  const dormant = []
  for (let i = 0; i < tpList.length; i++) if (!usedIds[tpList[i].id]) dormant.push({ id: tpList[i].id, name: tpList[i].name, category: tpList[i].category })
  const uncovered = chains.filter(function (c) { return c.tactics.length === 0 && c.asset.zone !== 'local' }).map(function (c) { return { address: c.asset.address, service: c.asset.service, note: c.asset.note } })

  const byStatus = {}, byZone = {}
  for (let i = 0; i < objectives.length; i++) { const s = S(objectives[i].status) || 'unknown'; byStatus[s] = (byStatus[s] || 0) + 1 }
  for (let i = 0; i < assets.length; i++) { const z = S(assets[i].zone) || 'unknown'; byZone[z] = (byZone[z] || 0) + 1 }
  const roeArr = (doc.roe && doc.roe.tiers) || [], roeCount = {}
  for (let i = 0; i < roeArr.length; i++) roeCount[roeArr[i].id] = 0
  for (let i = 0; i < tpList.length; i++) for (let j = 0; j < (tpList[i].tactics || []).length; j++) { const r = tpList[i].tactics[j].roe || tpList[i].default_roe || 'amber'; roeCount[r] = (roeCount[r] || 0) + 1 }

  const recent = findings.map(normFinding).sort(function (x, y) { return (y.createdAt || '').localeCompare(x.createdAt || '') })

  return {
    counts: { assets: assets.length, internet: internet, local: local, objectives: objectives.length, findings: findings.length, intel: intel.length, approvals: approvals.length, egress: (board.egress || []).length },
    byStatus: byStatus, byZone: byZone, chains: chains, gaps: gaps,
    recentFindings: recent.slice(0, 20), allFindings: recent, intel: INTEL, targets: null,
    approvals: approvals.map(function (x) { return { id: S(x.id), actionClass: S(x.action_class), target: S(x.target), status: S(x.status), decidedBy: S(x.decided_by), detail: String(S(x.detail)).slice(0, 300), reason: String(S(x.reason)).slice(0, 300) } }),
    doctrineCoverage: { tacticEntries: tpList.length, tacticSteps: tpList.reduce(function (n, t) { return n + ((t.tactics || []).length) }, 0),
      roeBreakdown: roeCount, matchedAssets: matchedAssets, used: Object.keys(usedIds).map(function (k) { return { id: k, hits: usedIds[k] } }),
      dormant: dormant, uncovered: uncovered.slice(0, 25), uncoveredTotal: uncovered.length },
  }
}

function criteriaStatus(model, ledger) {
  const map = {}
  map.c1 = { id: 'c1', value: model.gaps.untestedTargets.length, status: model.gaps.untestedTargets.length === 0 ? 'ok' : 'warn', detail: '联网资产已登记但无作战意图的数量' }
  map.c2 = { id: 'c2', value: null, status: 'na', detail: '需要研判层（assessments/）：逐资产判定「规则里哪一档得分适用、是否可及」。' }
  const nj = ledger && ledger.ok ? ledger.counts.needsJudgement : null
  map.c3 = { id: 'c3', value: nj, status: nj === null ? 'na' : (nj === 0 ? 'ok' : 'warn'),
    detail: ledger && ledger.ok ? ('已折算 ' + ledger.counts.findings + ' 条；可计分 ' + ledger.counts.confident + ' 条，待研判 ' + ledger.counts.triage + ' 条，档位待定 ' + nj + ' 条' + (ledger.counts.dropped ? '；按情报裁定剔除 ' + ledger.counts.dropped + ' 条' : '')) : '账本未加载' }
  map.c4 = { id: 'c4', value: null, status: 'na', detail: '出口台账为空，无法做差集' }
  map.c5 = { id: 'c5', value: null, status: 'na', detail: '防守方清单尚未取得' }
  return map
}



/* ══ 战法库匹配（2026-10-22 加）════════════════════════════════════════
 *
 * 为什么要有它 —— 这是对宪章判据 s4 的**结构性回答**。
 *
 *   实测：宪章给 s4 写的目标是「>= 80% of war sessions 加载 personal-kb」，
 *   而实际只有 6%（13/210）。persona 里明明白白写着「开工前先检索战法库」——
 *   提示词层的约束只拿到了 37%（war），其余会话一次都没检索。
 *
 *   宪章自己写着「结构性 > 提示性」。所以正确的做法不是把提示词写得更响，
 *   而是**让战法自己流到统帅眼前**：地图每轮刷新时，把与当前主攻方向相关的
 *   战法卡直接列出来。于是"检索战法库"不再是一个需要被记住的独立步骤 ——
 *   它成了刷新地图的副产品。
 *
 * 判据边界（不吹）：
 *   · 这里只做**词面匹配**（frontmatter 的 vuln/tags/platform + 标题正文关键词），
 *     不做语义检索。所以它给的是"可能相关"，不是"一定相关"。
 *   · 匹配不到就如实说"没有相关战法"，不凑数。
 */
function parseKbCard(file, text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const meta = {}
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim())
      if (!m) continue
      let v = m[2].trim()
      if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      else v = v.replace(/^["']|["']$/g, '')
      meta[m[1]] = v
    }
  }
  const h1 = /^#\s+(.+)$/m.exec(text)
  const title = h1 ? h1[1].trim() : (file.split(/[\\/]/).pop() || '').replace(/\.md$/, '')
  /* 一句话结论：用作摘要（没有就留空，不编） */
  const brief = /^##\s*一句话结论\s*\n+([^\n]+)/m.exec(text)
  return {
    id: S(meta.id) || (file.split(/[\\/]/).pop() || '').replace(/\.md$/, ''),
    type: S(meta.type),
    vuln: S(meta.vuln),
    platform: Array.isArray(meta.platform) ? meta.platform : (meta.platform ? [meta.platform] : []),
    tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
    confidence: S(meta.confidence),
    title: title,
    brief: brief ? brief[1].replace(/[*`]/g, '').trim().slice(0, 120) : '',
    file: file,
  }
}

/** 列出经验库里全部战法卡（只读 .md，带 frontmatter 解析）。 */
function loadKbCards(kbRoot, readFn) {
  const out = []
  const step = (d, depth) => {
    if (depth > 4) return
    let ent = []
    try { ent = readFn.readdir(d) } catch (err) {
      /* ⚠ 不静默吞：读不到目录与"目录里没有卡"是两件事，
         前者必须报出来。实测踩到：传入的 readFn 少了 readdirSync，
         这里静默 return，上层就报成"经验库里没读到卡"——**报错了原因**。 */
      if (readFn.onError) readFn.onError(d, err)
      return
    }
    for (const e of ent) {
      const p = d + '/' + e.name
      if (e.isDirectory()) { step(p, depth + 1); continue }
      if (!e.name.endsWith('.md')) continue
      const t = readFn.file(p)
      if (t === null) continue
      out.push(parseKbCard(p, t))
    }
  }
  step(kbRoot, 0)
  return out
}

/**
 * 把"当前在打什么"与战法卡做词面匹配。
 * @param queries 词表（靶标名 / 地址 / 动作词 / 服务名）
 * @returns { cards: 命中的卡（按命中数排序）, total, terms }
 */
/**
 * 把板面术语翻译成**卡片的技法词**。
 *
 * 为什么必须是共享函数：生产（index.js 算查词）与测试（test-kb-vocab.mjs）
 * 都要做这件事。各写一份就是两个真相 —— 而测试会因此测不到生产真正走的那条路
 * （实测踩到：测试直接拿板面术语去查 ⇒ 命中不了；而生产因为多并了一次技法词 ⇒ 命中 6 张）。
 *
 * @param boardTerms 板面术语（来自 dispatch/schwerpunkt 等）
 * @param vocab      kb-vocab.json 的 cardVulnToBoardTerms
 * @returns 展开后的查词集合：原板面术语 + 命中的那些技法值
 */
function translateBoardTermsToVulns(boardTerms, vocab) {
  const out = []
  for (const x of boardTerms || []) { if (String(x || '').trim()) out.push(String(x).trim()) }
  const map = (vocab && vocab.cardVulnToBoardTerms) || null
  if (!map) return { queries: out, matchedVulns: [], mapped: false }
  const matchedVulns = []
  for (const [vuln, spec] of Object.entries(map)) {
    for (const term of spec.board || []) {
      const t = String(term).toLowerCase()
      const on = out.some((q) => {
        const qq = String(q).toLowerCase()
        return qq.includes(t) || t.includes(qq)
      })
      if (on) { matchedVulns.push(vuln); out.push(vuln); break }
    }
  }
  return { queries: [...new Set(out)], matchedVulns, mapped: true }
}

function matchKbCards(cards, queries) {
  const terms = []
  for (const q of queries || []) {
    const t = S(q).toLowerCase().trim()
    /* 太短的词（<3 字符）不参与 —— 会命中一切，等于没匹配 */
    if (t.length >= 3) terms.push(t)
  }
  const uniq = [...new Set(terms)]
  if (!uniq.length) return { cards: [], total: cards.length, terms: [] }

  const hits = []
  for (const card of cards) {
    /* ★ haystack 只含**结构化字段**（vuln / type / tags / platform）+ 标题。
     *
     *   原来把 brief（结论正文）也算进去 ⇒ **串味**：查 nacos 会命中一张
     *   internal-recon 的卡，只因为它的正文里提到了 Nacos。
     *   实测出来的（test-kb-vocab.mjs 第 3 节），不是假想。
     *   正文是给**人读**的，不该参与匹配 —— 匹配该只看人家显式打的标签。 */
    const hay = [card.vuln, card.type, card.title, (card.tags || []).join(' '), (card.platform || []).join(' ')]
      .join(' ').toLowerCase()
    const matched = uniq.filter((t) => hay.includes(t))
    if (matched.length) hits.push({ ...card, matchedBy: matched.slice(0, 4) })
  }
  hits.sort((a, b) => b.matchedBy.length - a.matchedBy.length || String(a.id).localeCompare(String(b.id)))
  return { cards: hits, total: cards.length, terms: uniq }
}

 export { S, evCount, tsOf, fnv1a32, loadKbCards, matchKbCards, translateBoardTermsToVulns, parseKbCard, entryName, entryIsFile, base, validateChangeLog, unitKey, unitStatus, unitTagRe, domainKey, unitTagsOf, diagNoteMentions, explicitUnitsOf, buildDomainGroups, collectAttribution, matchUnits, buildLedger, buildExclusions, matchTokensOf, findTokenHit, evaluateIntel, evidenceWindowOf, buildSchwerpunkt, unitGapAddr, looksLikeNetworkId, extractNetworkIds, computeRecursion, buildDispatch, buildSwarmView, computeMetrics, safeRe, matchTactics, buildModel, criteriaStatus, readText, readJson, listBoard, loadDoctrine, loadCharter, loadTargets, HIVE_ROOT, DOCTRINE_ROOT, CHARTER_ROOT, TARGETS_FILE, BOARD_DIRS, CLAIM_TTL_MS, NEG_CHARS, TWO_PART_TLDS, UNIT_FIELDS, IDENTITY_PATH_LABELS, PATH_CONFIDENCE, ORG_NAME_RE, IDENTITY_NOTE_LABELS, OBTAINED_RE, ABSENCE_RE, NEGATED_RE, PERM_RE, DATA_HINT_RE, DATA_TYPE_RE, DATA_OBTAINED_RE, PUBLIC_DATA_RE, TRIAGE_SELF_NEG_RE, SCHWERPUNKT_LABELS, SCHWERPUNKT_SHORT, DISPATCH_KINDS }

