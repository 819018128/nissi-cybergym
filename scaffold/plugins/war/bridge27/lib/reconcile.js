/**
 * 闭环对账的**纯逻辑**：地图的命令 ↔ 板面的活。
 *
 * 这个文件不依赖 Cordis、不依赖任何插件上下文 —— 只有一个 `reconcile(deps)` 函数。
 * 这么拆的理由：对账是整套闭环里最容易出错的一环（判错就会报假落差、疯狂唤醒），
 * 而它混在插件里就只能靠 mock 整个运行时来测。抽出来之后可以直接拿真实板面测。
 *
 * 契约（两侧都必须遵守）
 * --------------------
 *   地图侧：`dispatch.entries[].readyToFile === true` 的命令，必须带 `orderKey`，
 *           并且把 `⟦<orderKey>⟧` 写进它要建的那张卡的 `title`（及 `method`）。
 *   板面侧：意图卡的 `title` / `method` / `note` 里出现 `⟦<orderKey>⟧` ⇒ 这条命令已落地。
 *
 * 判据为什么用编号而不是标题模糊匹配：标题是人读的自由文本，改一个字就失配；
 * 编号是机械标识，对账退化成一次子串查找。地图引擎 v17 起写入编号。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 命令编号的唯一格式。地图引擎与本文件靠这一行对齐，改格式必须两边同时改。 */
export function markOf(orderKey) {
  return '⟦' + orderKey + '⟧'
}

/**
 * 认领心跳的有效期。**必须与 board 插件的 CLAIM_TTL_MS 一致**（两边都是 30 分钟）。
 *
 * 为什么这里要抄一遍而不是从 board import：桥接与 board 是两个独立插件，
 * 互相 import 会让其中一方的挂载失败拖垮另一方。上一轮实测的数字是 30 分钟，
 * 与 `plugins/board2/lib/index.js` 里的常量相同；若那边改了，这里会不同步 ——
 * 所以 notify 的文案里**不写具体分钟数**，只说"心跳过期"，避免把一个会漂移的数字写死。
 */
const CLAIM_TTL_MS = 30 * 60 * 1000

/**
 * 板面证据：**心跳过期（可重新派工）的认领**。
 *
 * ★ 为什么桥接必须自己算这个（第 35 轮）
 * --------------------------------------
 * 引擎 `v14.host.js` L2068 把这一档注释成「`expired_claims` = 心跳过期（**可重新派工**）」，
 * 板面也把它暴露成 `board_snapshot` 的一个字段、UI 也画了出来 —— 但**闭环里没有任何
 * 自动组件去重新派工**。实测（`_expired_signal_consumers.mjs`，已排除未挂载的旧副本）：
 *   `plugins/bridge24/lib/index.js` 对 `expired` 的引用 = **0 次**。
 *
 * 于是长时运转下会出现一种静默失败：工蜂认领后中断（会话结束/上下文耗尽/被中断），
 * 卡停在 `claimed` —— 不是 `open`（新工蜂不会碰它），也不是 `unlanded`
 * （桥接不会报它）。它会一直躺着，直到有人自己打开 UI 看那个区块。
 * **这正是「可长时间自动运转」最典型的失败形态：不报错，只是活不动了。**
 *
 * 语义严格照抄 board 的 `claimExpired`（不自己发明口径）：
 *   `Boolean(claim) && !claim.released_at && !claimIsLive(objective, at)`
 *   而 `claimIsLive` = 心跳时间可解析 **且** `at - beat < CLAIM_TTL_MS`。
 */
export function readExpiredClaims(objectives, at = Date.now()) {
  const out = []
  for (const o of objectives || []) {
    if (!o || !o.claim) continue
    if (o.claim.released_at) continue
    const beat = Date.parse(o.claim.heartbeat_at ?? '')
    if (!Number.isFinite(beat)) continue          /* 没心跳 = 没认领，不是过期 */
    const ageMs = at - beat
    if (ageMs < CLAIM_TTL_MS) continue            /* 还在保鲜期 */
    out.push({
      id: String(o.id ?? ''),
      title: String(o.title ?? ''),
      agent: o.claim.agent ? String(o.claim.agent) : null,
      heartbeatAt: String(o.claim.heartbeat_at ?? ''),
      ageMin: Math.round(ageMs / 60000),
      assetId: o.asset_id ? String(o.asset_id) : null,
      parentFindingId: o.parent_finding_id ? String(o.parent_finding_id) : null,
    })
  }
  return out.sort((a, b) => b.ageMin - a.ageMin)
}

export function readJsonDir(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
    } catch {
      /* 半写状态的文件跳过：不要因为一张坏卡让整次对账失败 */
    }
  }
  return out
}

/** 把一张卡的全部自由文本拼起来用于查找编号：只看 title 不够，编号也可能只落在 method。 */
export function cardText(card) {
  return String(card.title || '') + '\n' + String(card.method || '') + '\n' + String(card.note || '')
}

/** 地图一条命令里「要建的那张卡」的标题：单步看 call，两步看第 2 步。 */
export function objectiveTitleOf(entry) {
  if (entry.call && entry.call.args) return String(entry.call.args.title || '')
  const step2 = (entry.steps || []).find((s) => s.tool === 'board_objective_add')
  return step2 && step2.args ? String(step2.args.title || '') : ''
}

/** 与地图工具的 fs 依赖形状一致的对象（地图引擎要它读板面/军法）。 */
export function nodeFsAdapter() {
  return {
    async resolve(p) {
      const a = path.resolve(p)
      if (!fs.existsSync(a)) throw new Error('ENOENT: ' + a)
      return { targetKey: a, path: a }
    },
    async stat(t) {
      try {
        const s = fs.statSync(t.targetKey)
        return { isDirectory: () => s.isDirectory(), isFile: () => s.isFile(), size: s.size }
      } catch {
        return undefined
      }
    },
    async readText(t) {
      return fs.readFileSync(t.targetKey, 'utf8')
    },
    async listDir(t) {
      const a = t.targetKey
      return fs.readdirSync(a, { withFileTypes: true }).map((d) => {
        const child = path.join(a, d.name)
        return {
          name: d.name,
          type: d.isFile() ? 'file' : d.isDirectory() ? 'directory' : 'other',
          target: { targetKey: child, path: child },
        }
      })
    },
  }
}

/**
 * 扫描 preset 根下的 opsmap* 插件目录，**按版本号从新到旧**返回可用候选路径。
 *
 * 为什么不硬编码副本目录名（`opsmap19` / `opsmap20` …）：那个名字每次同步都会变
 * （loader 按路径缓存模块导入，所以每次同步必须换新目录），写死一个就会在下次
 * 同步后静默指向不存在的路径，而**对账会因此整片失效**。
 *
 * ★ 为什么必须按版本号排序，而不是按 readdir 的顺序：
 *   sync-to-hive.mjs 的既定行为是**只加新目录、不删旧目录**（因为原地覆盖会被
 *   loader 的模块缓存吃掉），所以 `plugins/` 下会长期堆着多个副本。
 *   而 readdir 的顺序是文件系统给的，不保证新的在前。实测：不加排序时它对账
 *   用的是 **opsmap19**（旧版、没有编号），于是报出「16 条命令全都没编号」。
 *   那次是版本漂移保护把它兜住了 —— 换成排序才是真的修对。
 *
 *   注意 `opsmap`（无数字后缀）等价于版本 1。
 *
 * ⚠ 命名换过代（2026-10-22 起）：现在是 `opsmap-<时间戳>`（如 `opsmap-1793867164181`），
 *   旧的 `opsmap19` / `opsmap20` 那套**已废弃** —— 下面的历史只回答"当年为什么那样"，别照抄。
 *   所以模式是 `/^opsmap-?(\d*)$/`，**连字符可选**。少了那个 `-?`，真实目录一个都
 *   匹配不上、候选为空，map_orders 只打「没找到任何 opsmap* 插件目录」而地图其实是好的。
 */
export function engineCandidates(presetRoot, override) {
  const out = []
  if (override) out.push(override)
  const pluginsRoot = path.join(presetRoot, 'plugins')
  let names = []
  try {
    names = fs.readdirSync(pluginsRoot)
  } catch {
    names = []
  }
  const found = []
  for (const n of names) {
    const m = /^opsmap-?(\d*)$/.exec(n)
    if (!m) continue
    const version = m[1] === '' ? 1 : Number(m[1])
    const entry = path.join(pluginsRoot, n, 'lib', 'index.js')
    if (fs.existsSync(entry)) found.push({ version, entry })
  }
  found.sort((a, b) => b.version - a.version)
  for (const f of found) out.push(f.entry)
  return out
}

/**
 * 对账。
 *
 * @param {object} deps
 * @param {object} deps.engine        地图引擎模块（需导出 refresh）
 * @param {string} deps.hiveRoot      板面根目录
 * @param {string} deps.doctrineRoot  军法根目录
 * @param {string} [deps.enginePath]  地图实际加载自哪个文件（诊断用）
 * @returns {Promise<object>} 对账报告
 */
export async function reconcile(deps) {
  const { engine, hiveRoot, doctrineRoot, enginePath } = deps
  if (!engine || typeof engine.refresh !== 'function') {
    return { ok: false, reason: 'engine-unavailable', detail: '引擎模块没有 refresh' }
  }

  let payload
  try {
    payload = await engine.refresh(nodeFsAdapter(), { hiveRoot, doctrineRoot })
  } catch (e) {
    return { ok: false, reason: 'refresh-failed', detail: String((e && e.message) || e) }
  }

  const dispatch = payload && payload.dispatch
  const entries = (dispatch && dispatch.entries) || []
  /* ★★ 第 19 轮修的第二个缺陷：命令名单的口径必须与**引擎自己的 executable 一致**。
   *
   * 引擎（v14.host.js L1456）的定义：
   *     executable = entries.filter(e => e.readyToFile && !e.needsHuman)
   * 而引擎在 `dispatch.anchorNote` 里自己写明了 needsHuman 那批的语义：
   *     「N 条是流程级义务或需人裁定项，不属于任何目标资产，**不能直接建卡**：
   *       需先指定托管资产，或由人完成动作本身。」
   *
   * 桥接原来写的是 `entries.filter(e => e.readyToFile)` —— 少了 `&& !e.needsHuman`。
   * 后果：⟦op:6⟧（清单外资产的归属裁定）这类「机器别做」的条目被当成命令派下去，
   * 蜂群可能真的去「裁定归属」—— 那正是**伪造归因**，直接踩了本项目的硬纪律
   * （不可伪造情报：归属必须由人给出，引擎不替人决定 —— 这是引擎 blocked 字段的原话）。
   *
   * ⚠ 这是「两处各算一遍、谁也不报错」的第 N 次现身：
   *   引擎算了 executable，桥接自己又算了一个**更宽**的名单，两边不一致而无人报错。
   *   所以这里直接对齐引擎口径。 */
  const orders = entries.filter((e) => e.readyToFile && !e.needsHuman)

  /* ★★ 必须由人处理的那一批 —— 从**全部** entries 取，不看 readyToFile。
   *
   * 为什么不从 orders 取：引擎的 needsHuman 判定与 readyToFile 是**正交**的，
   * 而且实测恰好相反 —— 7 条 needsHuman 里有 6 条 readyToFile=false。
   * 从 orders 取就等于取空集（这正是第 19 轮修掉的缺陷）。
   *
   * 两条来源都认（`e.needsHuman` 与 `dispatch.needsHuman`），取并集：
   * 前者是条目自己的旗标，后者是引擎另外汇总的一份。
   * 只认一个的话，将来任何一边改了判定口径，这边都会静默漏掉 —— 又是同一类坑。
   *
   * ⚠ 去重键不能只用 orderKey：`Map.set(undefined, e)` 会把**所有**没编号的条目
   *   塌成一条（第一版就栽在这，7 条变 1 条）。所以没有 orderKey 时退回
   *   rank/kind/title 拼一个稳定键。 */
  const humanSet = new Map()
  const humanKeyOf = (e) =>
    e.orderKey || ('no-key:' + String(e.rank) + '|' + String(e.kind) + '|' + String(e.title).slice(0, 40))
  for (const e of entries) if (e && e.needsHuman) humanSet.set(humanKeyOf(e), e)
  for (const e of (dispatch && dispatch.needsHuman) || []) if (e) humanSet.set(humanKeyOf(e), e)
  const humanOrders = [...humanSet.values()]

  /* ★ 版本漂移保护（这条闸拦过两次真实事故）
   * 地图副本太旧时，`readyToFile` 存在但 `orderKey` 不存在。若不做判断，
   * 全部编号为 undefined，`⟦undefined⟧` 在板面上必然查不到 ——
   * 于是报出「全部命令未落地」的**假落差**，并据此疯狂唤醒 lead。
   * 正确行为是显式报版本问题，不产生任何命令落差。 */
  const withKey = orders.filter((e) => e && e.orderKey)
  if (orders.length > 0 && withKey.length === 0) {
    return {
      ok: false,
      reason: 'orders-without-keys',
      detail:
        '地图的 ' + orders.length + ' 条 readyToFile 命令都没有 ⟦op:N⟧ 编号 —— ' +
        '地图副本版本过旧，无法对账。用 build/sync-to-hive.mjs 同步地图后再试。' +
        (enginePath ? '（加载自 ' + enginePath + '）' : ''),
    }
  }

  const objectives = readJsonDir(path.join(hiveRoot, 'objectives'))
  const cardsText = objectives.map(cardText).join('\n')

  /* ── D3：成果递归衍生检测 ──
   *
   * 板面允许 objective.parent_finding_id 指向一条 finding，也就是「这条成果开了新地」。
   * swarm 的 parent_finding_id 递归衍生是它**唯一真正的长任务引擎**：成果生意图、
   * 意图生成果，链条自己往下长。hive 有这个字段，persona 也说了要这么用，
   * 但在此之前**没有任何地方在数它到底有没有发生**。
   *
   * 实测（第 10 轮，真实板面）：52 条成果里只有 6 条被当作 parent 引用过。
   * 其余躺在那儿没有开出任何后续 —— 这是「长时间复杂任务循环」具体的失败形态，
   * 而且它是**静默**的：不报错，只是循环不长。
   *
   * 口径说明（不许夸大）：profile 类成果是「特征/清单矩阵」，本来就不该衍生。
   * 所以真正值得看的是 verified 那一档，报告里分开算。
   *
   * ⚠ 本段必须放在**两个 early return 之前**（第 17 轮修）。
   *   原来它在 `orders.length === 0` 的 return 之后，于是那一支返回的对象
   *   根本没有 recursion 键 —— notify 的 D3 段和 map_orders 的成果行一起消失。
   *   而「一条命令都排不出来」恰恰是最需要看 D3 的时刻。
   *   同一个缺陷类在本文件里出现过两次：**分支把统计整个跳过了**。
   *
   * 优先用**引擎**算的那份：引擎同时算「成果→成果」和「成果→意图」两种引用，
   * 还给出链深；本地算法只认后者，口径更窄会算错（实测同一板面 7/45 vs 6/46）。
   * 引擎没给才退回本地，并显式标注 source=bridge-local，让「这是兜底」可见 ——
   * 否则兜底逻辑会把「引擎缺这个字段」伪装成正常，那正是本会话最难发现的缺陷类型。 */
  const findings = readJsonDir(path.join(hiveRoot, 'findings'))
  const usedAsParent = new Set(objectives.map((o) => o && o.parent_finding_id).filter(Boolean))
  const childless = findings.filter((f) => f && f.id && !usedAsParent.has(f.id))
  const engineRecursion = (payload && payload.recursion) || null
  const localRecursion = {
    findings: findings.length,
    usedAsParent: usedAsParent.size,
    childless: childless.length,
    childlessVerified: childless.filter((f) => f.result_kind === 'verified').length,
    sample: childless.slice(0, 8).map((f) => f.id),
    /* 本地算不出链深 —— 不编，直接留空，免得下游把 undefined 当 0 读 */
    maxDepth: null,
    derivedFindings: null,
    childlessVerifiedIds: childless.filter((f) => f.result_kind === 'verified').map((f) => f.id).slice(0, 20),
    source: 'bridge-local',
  }
  const recursion = engineRecursion
    ? Object.assign({}, localRecursion, engineRecursion, { source: 'engine' })
    : localRecursion

  /* ★ raw / counts.objectives 的**唯一**来源（2026-11-06）。
     两个分支都要它，而"两处各算一遍"正是本项目反复出现的经典缺陷
     （同一个东西算两遍、谁也不报错、后写的赢）。提到分支之前算一次之后，
     两个分支的 raw **形状与数值由构造保证一致** —— 想漂也漂不了。 */
  const raw = {
    objectives: objectives.length,
    findings: findings.length,
    assets: readJsonDir(path.join(hiveRoot, 'assets')).length,
  }

  /* 「一条命令都排不出来」是最需要看 D3 的时刻（板面有成果、却开不出任何后续），
     所以这一支也必须带上 recursion —— 详见上面那段注释。
     ★ 第 19 轮：这一支同样要带上 humanOrders。人工欠账与「排不排得出命令」无关，
     而且「连一条命令都排不出来、却堆着一堆等人处理的事」正是最该被看到的局面。 */
  if (orders.length === 0) {
    return {
      ok: true,
      empty: true,
      enginePath,
      /* ★ 2026-11-06：objectives 原来是**硬编码 0**，而板面真实有 133 张卡 ——
         外壳 `raw ? raw.objectives : counts.objectives` 一旦回落到这里，
         Δobjectives 就会报一个假跌幅（-133）。必须是真实计数。 */
      counts: { orders: 0, landed: 0, unlanded: 0, objectives: objectives.length, needsHuman: humanOrders.length },
      unlanded: [],
      landed: [],
      /* ★★ 2026-11-06：键集等价用例（test/bridge.test.mjs）当场抓到的**第四个**"分支少键"实例 ——
         第 28 轮加的三个 landed 拆分视图只在非空分支返回，这一支没有。
         今天外壳用 `Array.isArray(...)` 兜着，所以症状是"安静轮不显示拆分"而不是崩；
         但形状不一致正是这一整类缺陷的温床，键集断言就是为了逼它当场露出来。
         空名单下 landed 为空，三个视图天然是空数组（不是编的）。 */
      landedHumanFacing: [],
      landedExternalPending: [],
      landedByWorkers: [],
      assault: [],
      executable: [],
      /* ★ 2026-11-06：liveKeys 与 raw 必须与**非空分支同形**（那一支原来两个都有，
         这一支两个都没有）。下游是按字段取值的，形状不一致就会在别处静默出错。
         ⚠ `liveKeys: []` 在这里是**真值**（名单确实为空），但它**不是**「已消解」的证据：
           「本轮没有名单」与「名单里的都消解了」是两件事。判据由 `empty` 这个
           显式布尔交给调用方，**不**靠这个数组是否为空来推断（见 index.js __trackDestiny）。 */
      liveKeys: [],
      needsHuman: humanOrders,
      humanReady: humanOrders.filter((e) => e.readyToFile).map((e) => e.orderKey),
      humanNotReady: humanOrders.filter((e) => !e.readyToFile).map((e) => e.orderKey),
      signature: 'empty',
      recursion,
      raw,
      /* ★ 第 35 轮：这一支也必须带 expiredClaims。
         「一条命令都排不出来」恰恰是最需要看"有没有活被弃在半路"的时刻 ——
         与上面 recursion 那段注释记的是同一类缺陷：**分支把统计整个跳过了**。 */
      expiredClaims: readExpiredClaims(objectives),
    }
  }

  const unlanded = []
  const landed = []
  /* ★★ 第 28 轮：landed 里必须区分「蜂群真的干了活」与「lead 只是建了张卡」。
   *
   * 起因：端到端探针给 ⟦op:1⟧ 建了一张卡，landed 立刻 +1 —— 而 op:1 是
   *   kind=blocker-report / executor=**lead / 人** / verb=「在竞赛平台提交报备并跟踪审批」
   * 也就是**外部平台动作**：建卡只是把它记下来，报备本身还没提交。
   * 建卡 ≠ 外部动作完成。把两者记成同一个 landed，
   * 会让「命令落地率」同时表示两件不同的事 —— 而它正是判据 1 的数字来源。
   *
   * 所以 landed 条目上带 humanFacing / externalPending，并另给两个可分辨的视图。
   * ⚠ 没有改任何既有口径：landed 总数**仍然包含**这些条目（判据 1 的定义不变），
   *   只是多一层可分辨的视图，让"只见卡不见动作"这件事看得见。 */
  for (const e of withKey) {
    const mark = markOf(e.orderKey)
    const title = objectiveTitleOf(e)
    const byMark = cardsText.includes(mark)
    /* 二次判据：容忍有人把编号删了但保留了地图写的标题。
       收紧成「地图自己的署名前缀」——标题必须以 `[<rank>·` 开头（地图的格式），
       并且去掉编号后的前 40 字能在板面上找到。若不收紧，任意一段 40 字文本都可能
       偶然命中别的卡，把未落地误判成已落地。那比假落差更危险：
       假落差会被 lead 看见并纠正，**假落地会让落差静默消失、永远沉默**。 */
    const signed = title.startsWith('[' + e.rank + '·')
    const stripped = title.replace(mark, '').trim()
    const byTitle = signed && stripped.length >= 20 && cardsText.includes(stripped.slice(0, 40))
    if (byMark || byTitle) {
      /* 判据取自引擎下发到命令上的字段，不自己猜：
           executor 含「人」或「lead」 → 非工蜂
           externalPending === true   → 该动作依赖外部（平台审批等） */
      e.humanFacing = /人|lead/i.test(String(e.executor || ''))
      e.externalPending = e.externalPending === true
      landed.push(e)
    } else unlanded.push(e)
  }
  const landedHumanFacing = landed.filter((e) => e.humanFacing)
  const landedExternalPending = landed.filter((e) => e.externalPending)

  /* 签名带上已落地条数：lead 每落地一条签名就变一次，值得再提醒一回；
     而«什么都没做»的重复对账签名不变，被变化门挡住 —— 这就是防自激的核心。
     ★ 第 35 轮：签名必须**也带上僵死认领**。否则「有活被弃在半路」这件事
     在重复对账里永远不产生新签名 → 永远不唤醒 → 正是它要修的那个静默失败。
     带上的是**集合**而不是条数：条数不变而换了一张僵死卡时，也该再提醒一次。 */
  const expiredClaims = readExpiredClaims(objectives)
  const signature =
    unlanded.map((e) => e.orderKey).join(',') +
    '|' + landed.length +
    '|x' + expiredClaims.map((c) => c.id).sort().join(',')

  return {
    ok: true,
    empty: false,
    enginePath,
    counts: {
      orders: withKey.length,
      landed: landed.length,
      unlanded: unlanded.length,
      objectives: objectives.length,
      /* ★★ 第 19 轮新增：必须由人处理、蜂群永远不会动的那些。
         放进 counts 是为了让「有人工欠账」这件事在**任何**读 counts 的地方都看得见。 */
      needsHuman: humanOrders.length,
    },
    unlanded,
    landed,
    /* ★ 第 28 轮：landed 的两个可分辨视图（不改 landed 总数）。
       「建了卡」与「外部动作做完」是两件事；把它们混在一个数字里，
       会让判据 1 的分子失去意义。 */
    landedHumanFacing: landedHumanFacing.map((e) => e.orderKey),
    landedExternalPending: landedExternalPending.map((e) => e.orderKey),
    landedByWorkers: landed.filter((e) => !e.humanFacing).map((e) => e.orderKey),
    /* ★ 当前名单上的全部编号（本轮有过、orderKey 完整的）。
       给外壳用来算「上一轮有、这一轮没了」的那一批 —— 见 index.js 的 satisfied 逻辑。 */
    liveKeys: withKey.map((e) => e.orderKey),
    /* ★★ 第 19 轮修：这里原来是 `unlanded.filter((e) => e.needsHuman)`，
       而 `unlanded` 来自 `orders`（= entries.filter(e => e.readyToFile)）——
       而引擎判定 needsHuman 的条目**恰恰是 readyToFile=false 的那些**，
       所以那个数组**结构性地永远是空的**。7 条「归属裁定」「清单外资产报备」
       「军法未覆盖」的欠账因此在闭环里完全不可见：地图上有，但没有任何人会被告知。

       这与 §6.11 的 recursion 是同一类缺陷 —— **一个永远为空的字段让下游逻辑变成死代码**。

       修法：从**全部** entries 取，不看 readyToFile。
       不拿 needsHuman 过滤 unlanded 也不对：那会漏掉 op:6 / op:22 之外的一切，
       而且把「蜂群会做」和「蜂群不做」两种语义混成一个列表。 */
    needsHuman: humanOrders,
    /* 便于诊断：这 7 条里有多少参数已经齐了（人工可照抄执行），
       多少连参数都生成不出来（引擎明确说它不该由机器做）。 */
    humanReady: humanOrders.filter((e) => e.readyToFile).map((e) => e.orderKey),
    humanNotReady: humanOrders.filter((e) => !e.readyToFile).map((e) => e.orderKey),
    /* 板面原始条数，外壳要拿它算净增（Δobjectives 比比例更能说明「循环有没有在转」）。
       为什么另给一份：counts.objectives 是给人看的汇总，而外壳要做差分，
       差分要的是**原始数**，两者混用容易在改动 counts 时静默出错。
       ★ 2026-11-06：改为与 empty 分支共用同一次计算（见分支之前那个 `raw`），
         两个分支形状与数值由构造保证一致。 */
    raw,
    signature,
    recursion,
    /* ★ 第 35 轮新增：心跳过期（可重新派工）的认领。
       它**不参与**命令落差的计算（landed/unlanded 的定义一个字没改），
       而是一条独立观察项 —— 回答的是"有没有活被弃在半路"，
       与"命令有没有落地"是两个问题，不许混成一个数。 */
    expiredClaims,
    assault: unlanded.filter((e) => e.lane === 'assault'),
    executable: unlanded.filter((e) => !e.needsHuman),
    /* ⚠⚠ 这里原来还有一行 `needsHuman: unlanded.filter((e) => e.needsHuman)`，
       它是**同一个对象字面量里第二个 needsHuman 键**，会**静默覆盖**上面那个正确的
       `needsHuman: humanOrders`（JS 对象字面量重复键取最后一个，不报错）。
       实测症状：counts.needsHuman = 7（对）而 rep.needsHuman.length = 1（错）——
       两个字段自相矛盾，而唯一的报错来源只有我自己写的那条一致性断言。

       ★ 这本身就是本项目反复出现的那一类缺陷又一次现身：
         **同一个东西在两处各算一遍，谁也不报错，后写的赢。**
         我这一轮的任务是修「needsHuman 永远是空数组」，
         结果差点被同一类缺陷第二次骗过 —— 只改了其中一处。

       为什么删掉而不是留着当"兜底"：留着它就等于保留一个会覆盖正确答案的键。
       `executable` 保持从 unlanded 取是对的（它要的是「蜂群会做且还没做」），
       而 needsHuman 必须从全部 entries 取（人的事不在 unlanded 里）。 */
  }
}

/**
 * 渲染一条命令的**可执行形态**。lead 应当照抄参数，不要重新规划。
 * 抽成纯函数是为了让测试能直接断言渲染结果里必须出现编号与 tool 名。
 */
export function renderOrder(e, index) {
  const lines = []
  lines.push(
    '  ' +
      (index + 1) +
      '. ' +
      markOf(e.orderKey) +
      '　' +
      (e.lane === 'assault' ? '【突击线·新增分数来源】' : '【文书线】') +
      (e.needsHuman ? '【需人】' : '') +
      '　执行者=' +
      (e.executor || '?'),
  )
  lines.push(
    '     排名 ' + e.rank + '　类型 ' + (e.kindName || e.kind) + '　距离 ' + e.distance + ' 成本 ' + e.cost,
  )
  lines.push('     要做的动作：' + (e.verb || ''))
  if (e.blocked) lines.push('     ⚠ 阻塞：' + e.blocked)
  /* 地址可信度必须在**参数之前**就看见，不能藏在注释里 ——
     第 10 轮发现过引擎把公司名当 address 登记的伪造情报级错误，
     所以「这个地址是不是真的」这件事要在 lead 读到参数之前就摆明。 */
  if (e.derivedAddress) {
    lines.push('     ⚠⚠ 入口地址未知：第 1 步登记的是占位值（不是真实域名/IP）。这条命令的实质工作就是把它解析出来。')
  } else if (e.addressSource) {
    lines.push('     ✓ 入口地址来源：' + e.addressSource)
  }

  if (e.steps && e.steps.length) {
    lines.push('     分 ' + e.steps.length + ' 步（按顺序执行，第 2 步用第 1 步返回的 id）：')
    for (const s of e.steps) {
      lines.push('       步' + s.n + ' ' + s.tool)
      lines.push('         ' + JSON.stringify(s.args))
    }
  } else if (e.call) {
    lines.push('     直接调用（照抄，不要改写参数）：')
    lines.push('       ' + e.call.tool)
    lines.push('       ' + JSON.stringify(e.call.args))
  } else {
    lines.push('     （这条没有现成参数：' + (e.blocked || '需人工判断') + '）')
  }

  /* 派工包（M3）：地图已经把 objective_id / asset_id / parent_finding_id 固化成一段
     可以直接粘进 subagent 的 prompt。有就原样给出 ——
     dsh 的 subagent 工具只收 {description, prompt}，没有字段能承载这些标识，
     lead 手写就会漏；漏了 asset_id，工蜂就不知道成果该记到谁头上（归属错）。 */
  if (e.dispatchPrompt) {
    lines.push('     ── 派工包（可整段粘进 subagent 的 prompt）──')
    for (const l of String(e.dispatchPrompt).split('\n')) lines.push('     ' + l)
  }

  return lines.join('\n')
}

/* ══════════════════════════════════════════════════════════════════════════
   自动派工（第 36 轮）—— 「通知没人接的时候，自己造一个指挥席去接」
   ══════════════════════════════════════════════════════════════════════════

   起因（指挥员原话）：「不好用的工具等于没用」。

   实测（381 个会话日志，非推理）：
     · 桥接 5 天发出 11 条对账通知，巡检 15 条 —— **通知通道是通的**
     · 但 board_objective_add 全场只有 31 次，而未落地命令长期停在 15 条左右
     · hive 预设 128 个会话**全部 origin=subagent**，根 0 个；
       调过板面/地图的 8 个「指挥会话」全是 **cordis** 预设
     · 同窗口（今日 6 小时）：board_snapshot 84 次、opsmap_refresh 9 次、map_orders 2 次

   ⇒ 结论不是「通道断了」，是**通道的收件人不在场**。
     门控要求「lead 开口过」才唤醒（设计意图是对的：人没开口不开第一轮），
     而蜂群里根本没有常驻 lead —— 指挥员坐在蜂群外面。
     于是通知全部停在 `lead-not-engaged`：**提醒到了空气里**。

   修法：通知失败且确实有可机械执行的未落地命令时，**由桥接创建一个值班指挥会话**
   （hive 预设），把命令连同现成的 board 调用参数交给它，由它用 board_* 落地 ——
   板面要求 exec.agent.id 溯源，所以必须是**真会话**去写，桥接自己不写板面。

   ★ 本函数只判断，不碰任何东西：所有状态从 state 参数进来。
     这样「该不该派」能被单元测试的正反例钉死，而不是靠读代码相信。
   ────────────────────────────────────────────────────────────────────────── */

export const AUTODISPATCH_DEFAULTS = {
  /* 两次自动派工至少隔 20 分钟 —— 比巡检的 5 分钟慢，
     因为派工要花真金白银（会拉起一个会话）。 */
  minIntervalMs: 20 * 60 * 1000,
  windowMs: 60 * 60 * 1000,
  /* 每窗口最多 3 次。上限存在的意义不是省钱，是**防止失控循环**：
     派工 → 工蜂写板面 → 对账发现新落差 → 再派工。 */
  maxPerWindow: 3,
  /* 一次最多交 5 条。一口气交 15 条会让值班指挥原地转圈。 */
  maxOrdersPerBrief: 5,
}

/**
 * 要不要自动派工、派哪几条。
 *
 * @param rep   reconcile() 的结果
 * @param state { off, leadEngaged, now, lastDispatchAt, recent[] }
 * @param opts  覆盖 AUTODISPATCH_DEFAULTS
 * @returns { go:false, why } 或 { go:true, orders, total, withheld, skipped }
 *
 * why 的取值都是**可分辨**的（这是本项目反复强调的纪律：
 * 「不该说」和「没话说」必须在诊断里分得开）：
 *   kill-switch        人放了开关文件，明确叫停
 *   lead-engaged       有指挥员在场上，走通知那条路，不抢它的活
 *   nothing-executable 没有可机械执行的未落地命令
 *   cooldown / budget  节流与预算
 */
export function autoDispatchPlan(rep, state, opts) {
  const o = Object.assign({}, AUTODISPATCH_DEFAULTS, opts || {})
  const st = state || {}
  const now = Number(st.now) || 0

  if (st.off === true) return { go: false, why: 'kill-switch' }
  if (st.leadEngaged === true) return { go: false, why: 'lead-engaged' }

  /* 只挑**真正能直接落地**的：有编号、有现成调用、且没被阻塞。
     三个都数出来 —— 如果候选全被过滤光，要能看出是被哪一条过滤的。
   *
   * ⚠ 次序有语义，不是随手排的（第 36 轮被测试抓出来）：
   *   先 `blocked` 后 `noCall`。写反的话，一条既被地图标为 blocked、
   *   又没有 call 的条目会被计成 `noCall`，于是 `skipped.blocked` **永远是 0** ——
   *   而 blocked 恰恰是最该被看见的那一类（地图自己说它走不通）。
   *   症状是诊断里"一条都没被阻塞"，与事实相反。 */
  const ex = rep && Array.isArray(rep.executable) ? rep.executable : []
  const todo = []
  const skipped = { noKey: 0, blocked: 0, noCall: 0 }
  for (const e of ex) {
    if (!e || !e.orderKey) { skipped.noKey++; continue }
    if (e.blocked) { skipped.blocked++; continue }
    if (!e.call || !e.call.tool) { skipped.noCall++; continue }
    todo.push(e)
  }
  if (todo.length === 0) {
    return { go: false, why: 'nothing-executable', skipped, sawExecutable: ex.length }
  }

  const last = Number(st.lastDispatchAt) || 0
  if (last > 0 && now - last < o.minIntervalMs) {
    return { go: false, why: 'cooldown', candidates: todo.length, waitMs: o.minIntervalMs - (now - last) }
  }

  const recent = (Array.isArray(st.recent) ? st.recent : [])
    .map(Number).filter((t) => Number.isFinite(t) && now - t < o.windowMs)
  if (recent.length >= o.maxPerWindow) {
    return { go: false, why: 'budget', candidates: todo.length, inWindow: recent.length, max: o.maxPerWindow }
  }

  const picked = todo.slice(0, o.maxOrdersPerBrief)
  return {
    go: true, why: 'ok',
    orders: picked, total: todo.length, withheld: todo.length - picked.length, skipped,
  }
}

/** 把「为什么没派」翻成一句人话，用于诊断与地图对账。 */
export function autoDispatchWhy(plan) {
  const p = plan || {}
  switch (p.why) {
    case 'kill-switch': return '自动派工已被人为关闭（存在开关文件）'
    case 'lead-engaged': return '场上已有指挥员会话，走通知那条路'
    case 'nothing-executable': return '没有可直接落地的命令' + (p.sawExecutable ? '（' + p.sawExecutable + ' 条候选里，' + JSON.stringify(p.skipped) + '）' : '')
    case 'cooldown': return '冷却中，还需 ' + Math.ceil((p.waitMs || 0) / 60000) + ' 分钟'
    case 'budget': return '本窗口已派 ' + p.inWindow + '/' + p.max + ' 次'
    default: return String(p.why || '未知')
  }
}

/**
 * 值班指挥收到的简令。
 *
 * ★ 措辞纪律（三条都是本项目踩出来的）：
 *   ① 说清「你被自动拉起来的原因」，否则它会以为自己被误唤醒而空转；
 *   ② 给**现成参数**，不许它自己编 —— 参数是地图算的，它只是执行；
 *   ③ 明确**不许做什么**（攻击、审批、为消落差建空卡），
 *      因为自动拉起的会话没有人在旁边纠偏。
 */
export function renderDutyBrief(plan, rep, trigger) {
  const L = []
  L.push('【值班指挥席 · 你被自动拉起】')
  L.push('')
  L.push('触发：' + trigger + '。地图对账判定「有 ' + plan.total + ' 条命令无人落地，且场上没有指挥员会话」。')
  L.push('你就是这轮的值班指挥。你的活**只有一件**：把下面这些命令落成板面上的意图卡。')
  L.push('')

  for (let i = 0; i < plan.orders.length; i++) {
    L.push('── ' + (i + 1) + '/' + plan.orders.length + ' ──')
    L.push(renderOrder(plan.orders[i], i))
    L.push('')
  }
  if (plan.withheld > 0) {
    L.push('（另有 ' + plan.withheld + ' 条本轮未交给你 —— 一次不交太多，怕你原地转圈。')
    L.push('  它们还在名单上，等你把这批落完，对账会再派。）')
    L.push('')
  }

  L.push('══ 纪律（这几条不是套话，是自动会话最容易犯的错）══')
  L.push('1. **照抄参数**。每条命令都带好了可直接执行的 board_* 调用与参数；')
  L.push('   不要自己改写、不要臆造 asset_id 或 objective_id。参数是地图算的，你只是执行。')
  L.push('2. **只落卡，不攻击**。你的职责到「板面上有这张卡」为止。')
  L.push('   任何对目标的实际动作都必须走 ROE 门禁，由认领该卡的工蜂去做。')
  L.push('3. **不许为了消掉落差建空卡**。某条不该落地（例如归属待裁定），')
  L.push('   就在对应意图卡的 record 里写清原因，然后放过它 —— 那才是正确处置。')
  L.push('4. **不要求人审批**，也不要替人做判断。碰到需要人裁定的，记一条 record 说明「需人」，停在那里。')
  L.push('5. 落完就结束这一轮。**不要顺手扩活**：不在下面名单里的事，这轮不做。')
  L.push('')
  L.push('✋ 落地后不需要回复本条消息 —— 对账会自动复核，落差消了就不会再叫你。')

  return L.join('\n')
}
