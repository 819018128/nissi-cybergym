/**
 * war-no-hands — 结构性剥夺：让主帅没有手。
 * ─────────────────────────────────────────────────────────────────────────
 * 这一行存在的理由只有一句：**「你不接敌」不能是一句提示词。**
 *
 * 实测依据（《Super-agent 底层逻辑拆解》§10.1 的消融实验）：
 *   中性提示下模型 5 次运行一次都没委派；加了「优先委派」的强提示后，
 *   仍有 1/5 判断工作「很小」而自己干了。**提示词只能改变概率，结构才能改变必然。**
 *
 * 而这个预设在此之前恰好是反例：persona 第 31 行与第 64 行把「你不接敌」写了两遍，
 * 第二遍还写着「这一条再重复一次，因为它是统帅最常破的一条」——一条需要在同一份
 * 人格里写两遍的规则，不是纪律，是愿望。
 *
 * 结构在哪
 * ─────────────────────────────────────────────────────────────────────────
 * dsh 提供两层，本插件两层都用，因为它们解决的不是同一个问题：
 *
 *   ① `tools.restrict({deny})` —— **从目录里拿走**。模型连 schema 都看不见，
 *      和「给了但拒绝」是两种不同的事实。这是论文里「不给它 Bash 工具」的等价物。
 *      只在 agent 作用域有效（`agent.ctx`），所以必须逐 agent 安装。
 *   ② `tools.guard(fn)` —— **运行时拒绝并说明原因**。悲观层：
 *      装配时机、`origin` 在 created 时刻是否可读、以及任何作用域内注册的旁路，
 *      都靠它兜住；同时它是唯一能把「这次为什么被拦」讲给人听的地方。
 *
 * 判据（可机械校验）
 * ─────────────────────────────────────────────────────────────────────────
 *   s7：主帅会话里 pwsh / bash / write / edit 的**放行次数 = 0**。
 *       观测口就是本插件的 status 文件（denials）与 `_xray` 的 tool 事件两头对照：
 *       放行 0 且工具不在目录里，才算剥夺成立；只把 denials 打到 0 而工具仍在目录里，
 *       说明关掉的是守卫而不是剥夺。
 *
 * 四条不变量（改动本文件前先读）
 * ─────────────────────────────────────────────────────────────────────────
 *   0. **只碰跑本预设的 agent**（2026-11-13 补）。preset 不是 war/hive 的会话，
 *      本插件一行都不许动 —— 剥夺和拒绝都算"动"。这不是礼貌，是事故：
 *      一个跑别的预设的会话曾整场没有手。判不出预设时也按"不归我管"处理，
 *      理由与不对称论证写在 install() 的预设闸门处（那一半由宿主平面兜底）。
 *   1. **判不出角色时不许动手**。`origin` 读不到 → 当 unknown，放行。
 *      把「读不到」默认成「这是主帅」会剥掉工人的手，那是把整支军团打瘫；
 *      默认成「放行」最多退化成旧的提示词状态。**两个错误不对称，选轻的那个。**
 *   2. **失败不抛**。任何记录/写入失败都被吞掉：观测者不能成为被观测系统的故障源。
 *   3. **有 kill switch**。`WAR_NO_HANDS=0` 让两层同时失效。剥夺写错的后果是
 *      战争模式根本不能干活，比「偶尔自己动手」严重得多。
 *
 * 为什么四个工具而不是全部
 * ─────────────────────────────────────────────────────────────────────────
 * 剥夺的对象是**能改变世界的动作**（执行、写入），不是**能看清世界的动作**。
 * `read` / `grep` / `glob` / `web_search` / `skill` 全部保留：主帅要读宪章、读板面、
 * 检索战法库，那是研判。把研判也拿走，换来的不是纪律而是瞎子——
 * 而一个瞎掉的统帅仍然会做决定，只是做得更差。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  computeAllowlist,
  allowlistUsable,
  LEAD_ALLOW_EXACT,
  LEAD_ALLOW_PREFIXES,
} from './allowlist.js'

export const name = 'war-no-hands'

/**
 * 只声明 `tools`（守卫要用）。
 *
 * `agents` 刻意**不**写进 inject：它是一个宿主服务，而本插件在 preset 作用域里挂载，
 * 服务解析路径与宿主组合不同。把它做成硬依赖会让整行在解析不到时**根本挂不上**——
 * 那是「为了一个可选能力，把必选能力一起弄死」。
 * 于是：能拿到就补装已存在的 agent，拿不到就完全靠 `agent/created` 与守卫自愈，
 * 功能不瘸（见 `agentsService()` 与文件头的三层设计）。
 */
export const inject = ['tools']

/** 主帅不该有的手：执行与写入。读与检索不在其列（见文件头）。 */
const DEFAULT_LEAD_DENY = ['pwsh', 'bash', 'write', 'edit']

/**
 * 工人不该有的嘴。
 *
 * 只放一条，是刻意的：`ask_user_question` 是**通往指挥官的第二条通道**。
 * 统帅存在的意义之一是"人只跟一个 agent 说话"，工人直接敲门会让这条不变量
 * 变成口头约定。工人有问题该走 `report` 的结构化字段，由统帅转达。
 *
 * `subagent` / `workflow` / `ralph` 没有默认剪掉，因为它们已经被 claim-first
 * 结构性挡住一半：孙子辈分队不持有认领，就记不了战果（board 会拒绝）。
 * 加进默认值会扩大爆炸半径而不增加多少安全 —— 需要时用 `workerDeny` 配置开。
 */
const DEFAULT_WORKER_DENY = ['ask_user_question']

/**
 * 本插件管**哪些预设** —— 默认 war / hive。
 *
 * 为什么目标集必须是**数据**而不是写死的判断：它会变（多一个作战预设、或临时把
 * hive 摘掉做对照），而"改一次目标集就得改一次 .js 文件"正是让人不敢改它的原因。
 * 与宿主平面那一支（`~/.dsh/war-plugins/dsh-war-no-hands` 的 `DEFAULTS.presets`）
 * 同形：`config.presets` 覆盖，**空数组按默认处理** —— "我什么都没配"不等于
 * "一个都不要管"，后者会让整支军团悄悄长回双手，而且没有任何一行会变红。
 */
const DEFAULT_PRESETS = ['war', 'hive']

const DENY_TEXT = {
  pwsh: '执行命令',
  bash: '执行命令',
  write: '写文件',
  edit: '改文件',
  ask_user_question: '直接向指挥官提问',
  subagent: '再派分队',
  subagent_fork: '再派分队',
  ralph: '自行循环迭代',
  workflow: '自行编排子代理',
}

function listOf(value, fallback) {
  if (value === undefined || value === null) return [...fallback]
  if (Array.isArray(value)) return value.map((x) => String(x)).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((x) => x.trim()).filter(Boolean)
  return [...fallback]
}

/** `WAR_NO_HANDS=0|off|false|no` → 关。未设置或其它值 → 开。 */
function killSwitchOn(raw) {
  if (raw === undefined || raw === null || raw === '') return true
  return !/^(0|off|false|no)$/i.test(String(raw).trim())
}

/**
 * 这个 agent 到底跑在哪个预设下 —— **最后一次选择赢**。
 *
 * ★ 这份实现是**故意从宿主平面那一支抄过来的**
 *   （`<HOME>/.dsh/war-plugins/dsh-war-no-hands/lib/index.js` 的 `presetOf`）。
 *   故意抄、不 import：两个插件分属两个平面、两条发布路径，跨目录 import 会让
 *   「改一处、坏两处」变成默认行为，还会让预设平面的插件去依赖一个不在自己
 *   node_modules 里的文件；而抄过来之后两份**可以直接 diff**，语义一旦漂移就能被看见。
 *   抄的时候逻辑一行都没改，所以 diff 里出现的差异都只能是**有意**改的。
 *
 * ⚠ 为什么不能只看会话头（实测，不是推演）：真机上的 war 会话，`header.agentPreset`
 *   写的是 `cordis` —— 会话是先建的，之后才切成 war。只看头就会把**真的 war 会话**
 *   当成别的预设放过 ⇒ 剥夺永远不装，而症状与「这不是 war 会话」长得一模一样
 *   （都是"什么都不发生、读数一片绿"）。⇒ 与 `dsh-agent-presets` 的
 *   `resolveSessionPreset` 同一口径：最后一次 `agent-preset/selected` 赢，
 *   没有该事件时才退回会话头。
 *
 * ⚠ 缓存是**增量**的（宿主那一版在这里踩过坑）：给「头就是目标预设」加快路径，
 *   会让「曾经是 war、后来切回 cordis」的会话永远被当成 war（那一版的自测反向对照
 *   当场抓到了）；而每次全量扫又太贵。事件只追加 ⇒ 只扫新追加的那一段：
 *   没有新事件时零扫描，有切换时一次就够。
 *
 * @param {any} agent
 * @returns {string|null} 预设 id；**读不到就是 null**（那不等于"不是我们的"，
 *          两者的处置在 install() 里分开记账，见那里的注释）
 */
const presetScan = new WeakMap() // session → { scanned, header, value }

export function presetOf(agent) {
  const session = agent?.session
  if (session === undefined || session === null) return null
  const header = typeof session.header?.agentPreset === 'string' && session.header.agentPreset !== ''
    ? session.header.agentPreset
    : null
  const events = session.events
  if (!Array.isArray(events)) return header

  let state = presetScan.get(session)
  /* 事件被重写（压缩会收缩日志）⇒ 缓存失效，从头再来一次 */
  if (state === undefined || state.scanned > events.length || state.header !== header) {
    state = { scanned: 0, header, value: header }
  }
  for (let i = state.scanned; i < events.length; i += 1) {
    const ev = events[i]
    if (ev?.type !== 'agent-preset/selected') continue
    const id = ev?.data?.agentPreset
    state.value = typeof id === 'string' && id !== '' ? id : null
  }
  state.scanned = events.length
  presetScan.set(session, state)
  return state.value
}

export function apply(ctx, config) {
  const enabled = killSwitchOn(process.env.WAR_NO_HANDS)
  const leadDeny = listOf(config?.leadDeny, DEFAULT_LEAD_DENY)
  const workerDeny = listOf(config?.workerDeny, DEFAULT_WORKER_DENY)
  /* 目标预设（数据，不是逻辑）：空数组按默认处理 —— 见 DEFAULT_PRESETS 处那句
     "我什么都没配" != "一个都不要管"。 */
  const configuredPresets = listOf(config?.presets, DEFAULT_PRESETS)
  const presets = configuredPresets.length > 0 ? configuredPresets : [...DEFAULT_PRESETS]
  const root =
    typeof config?.root === 'string' && config.root
      ? config.root
      : (process.env.WAR_ROOT || '<HOME>/.war')
  const statusPath = path.join(root, '_no-hands', 'status.json')

  const status = {
    mounted_at: new Date().toISOString(),
    enabled,
    leadDeny,
    workerDeny,
    presets,
    leads: 0,
    children: 0,
    restricted: 0,
    denied: 0,
    unclassified: 0,
    unknown_role_allowed: 0,
    /* ── 2026-11-13：只剥夺**真的在跑本预设**的 agent ──────────────────────
     *
     * 事故（真机，整整一场工作会话）：本插件对 `agents.list()` 里的**每一个** agent
     * 安装剥夺，只按 `session.header.origin === 'subagent'` 分主帅/工人，从不问这个
     * agent 跑的是哪个预设。于是一个跑**别的预设**的会话（cordis 模式的 creation 会话）
     * 的 pwsh / write / edit 被从工具目录里拿走 —— 那一整场它一条命令都跑不了。
     * 更坏的是读数：同一份 status.json 把那个无关会话算进了 `leads`
     * （"剥夺了 N 个主帅"这个数字从此不可信，而它是 s7 的全部依据）。
     *
     * 三格分开记，谁也不替谁顶账（一格问一件事）：
     *   · `skipped_not_preset` —— 预设读得到、但不归我管（正常，且应该是常态）；
     *   · `preset_unknown`     —— 连预设都读不到 ⇒ 同样跳过，但单独记；
     *   · `skipped_sample`     —— 被跳过的**是谁**（agent id + 检测到的预设，上限 20 条）。
     * 只看计数会得到一个无法回查的数字；只看样本又会丢掉"一共多少次"。
     *
     * `presets` 是**数据**，不是逻辑：目标集来自 `config.presets`（默认 war/hive），
     * 与宿主平面那一支（`~/.dsh/war-plugins/dsh-war-no-hands`，`presets:["war"]`）同形。
     * 写在 status 里，是为了让"这一场到底按哪份配置剥夺的"成为可读事实，
     * 而不是下一任读者去猜某个 .yml 里有没有被注释掉的一行。 */
    skipped_not_preset: 0,
    preset_unknown: 0,
    skipped_sample: [],
    /* ── 剥夺效果的**自证**（2026-11-05 新增）────────────────────────────
     * `restrict({deny})` 不返回任何东西：它既不说"拿走了哪几个"，也不说"有没有匹配上"。
     * 于是"我调用了剥夺"和"它真的没了"在日志里长得完全一样 —— 而这正是本插件的
     * 全部价值所在。工具一旦改名（或 deny 列表拼错一个字），restrict 会安静地
     * 什么都不拿走，主帅重新长出双手，而所有读数依旧一片绿。
     *
     * `tools.get(name)` 能回答其中一半的问题：这个名字**在全局目录里到底存不存在**。
     *   · deny_unmatched —— 目录里根本没有的名字（改名 / 拼错）⇒ 一定没生效；
     *   · deny_checked   —— 一共核对过几个名字（0 表示这条自证没跑起来）。
     *
     * ⚠ 诚实边界：`get(name)` 默认是**全局视图**，而剥夺是**按 scope** 的。所以本字段
     *   只能证明"名字存在"，不能证明"在这个 scope 里被拿走了"。后者由第二层
     *   （运行时 guard）兜底，并计入 denied。要证明前者需要 agent 的 scope key ——
     *   那不是一个该靠猜的白名单，所以这里如实留白，而不是写一个看起来green的断言。 */
    deny_checked: 0,
    deny_unmatched: [],
    /* ── 2026-11-06 真机实测之后的自证修正 ────────────────────────────────
     *
     * 第一次自证用 `scope.tools.get(name)`。真机跑下来：
     *   deny_checked=29、deny_unmatched=[pwsh,bash,write,edit,ask_user_question]
     *   —— **整张名单全"不在目录里"**。
     *
     * 可是同时 `restricted=17` 且 `last_error=null`。而 tools 的类型声明写着
     * `restrict()` 对 "unknown names" 会 **fail** —— 它没抛，说明这五个名字
     * **是**有效的。两个读数互相矛盾，矛盾点就在 `get` 上：agent scope 的 facade 上
     * 无 scope 参数的 `get(name)` 看不到继承下来的全局工具，于是它**永远**返回 undefined。
     * 我把一次"看不见"读成了"名单错了"。
     *
     * 所以真正的自证换成一条**可证的**：
     *   · `restrict_error` —— restrict 抛没抛。声明说未知名字会 fail，
     *     所以"没抛"就是"名单里的名字都有效"的机械证据；
     *   · `get_scope_blind` —— get 对**全部**名字都返回 undefined 时置真。
     *     这时 deny_unmatched 不代表拼错，只代表这半条自证在这里看不见。
     * 语义变了，字段名也写清楚，免得下一个人照旧读。 */
    get_scope_blind: false,
    restrict_error: null,
    /* ── 2026-11-11：同步剥夺（v1.18）────────────────────────────────────
     *
     * 线级证据（会话日志 request/header 的 data.header.tools[]，不是插件自报）：
     *   11-07 15:52 之后的主帅会话，**第 1 个请求起**表里就没有 pwsh/write/edit，
     *   但**第 0 个请求永远带着**（16 场主帅会话里 15 场如此，含一场 41 个请求的）。
     * ⇒ 剥夺本身有效，缺的是**时序**：`agent.ctx.inject()` 是插件 fiber，
     *   cordis 的 fiber 启动前必过 `await Promise.resolve()`
     *   （cordis/lib/index.js:1348-1355 `_reload`），所以回调最早在下一个微任务才跑；
     *   而 `agent/created` 是同步派发的（dsh-agent/lib/index.js:660-682），
     *   第一张工具表就在它之后同步装配出来。
     * 修法：不排 fiber，直接对 agent 的 scope 同步 restrict
     *   （layers.effect → ctx.effect 的 generator 体在 iter.next() 里同步跑到第一个 yield，
     *    cordis/lib/index.js:1145-1152）。
     *
     * 这两个字段让"走的是哪条路、名单被裁剪过没有"成为可读事实。 */
    install_path: null,
    /* ── 2026-11-13：install_path 只归主帅，工人另开一格 ─────────────────────
     *
     * 线级读数（`_no-hands/status.json`，不是推断）：同一份文件里同时写着
     *   install_path:  "sync"            ← 黑名单那条路
     *   allow_core_ok: 4                 ← 白名单核过的核心名字（4 个主帅）
     *   allow_kept:    [ ...70 个名字... ] ← 白名单的限制**确实**下发了
     * 三行合起来自相矛盾：白名单已经装上，路径却是"退回黑名单"。
     *
     * 根因不是判据写错，是**一格字段问了两件事**：`install()` 是逐 agent 跑的，
     * 四个主帅先装上白名单（'sync-allow'），随后十个工人走通用 deny 路径，
     * 每一次都把这个**全局**字段改成 'sync'。于是这一格描述的是
     * **最后装配的那个 agent**，而最后装配的恰好都是工人。
     *
     * 后果不只是难看：`test/_verify_allowlist.mjs` 判 `install_path === 'sync-allow'`，
     * 下一次重启它会对着一份**工作正常**的白名单报 FAIL —— 假红。
     * 而假红教会人忽略读数，比缺一条判据更坏（本项目已经为它付过两次账）。
     *
     * ⇒ 一格问一件事：
     *   · `install_path`        —— 主帅的路径："commander 的白名单装上没有"；
     *   · `install_path_worker` —— 工人走的是哪条路。工人默认就是 deny 路径，
     *                              所以这一格是 'sync' **才是正常的**，不构成失败。
     * 工人的安装**永远不许**覆盖主帅的读数：映射收敛在 `pathFieldFor()`。 */
    install_path_worker: null,
    last_trimmed: [],
    /* ── 2026-11-12：白名单的**枚举自证**（下一步第 1 条的全部读数）────────────
     *
     * 病：`allow_refused: "allowlist too small: 5/24"` —— 白名单只认下 5 个名字，
     * 因为枚举只看见 24 个。而**同一个 scope** 在**同一份文件**里由 restrict() 报出的
     * `known global tools` 是 97 个（见 `last_trim_evidence`）。差 73 个不是目录小，
     * 是**问错了表**。
     *
     * 根因（宿主源码，不是猜测）：`schemas(scope)` → `view(scope).visible`；
     * `view(undefined)` 里 `chainLayers(undefined)` 是空数组 ⇒ 只遍历 global 层；
     * `view(agent)` 才遍历 global + 这条 scope 链上的每个祖先层 —— 预设平面的
     * board_/graph_/intent_/xray_ 全在祖先层。旧代码调 `schemas()` 时**没给 scope**，
     * 于是永远只看见宿主组合那一层。agent 就是 scope key（dsh-agent：`scopeTarget(agent, agent)`，
     * 注释原文 "the subject agent and scope key"），所以 `schemas(agent)` 才是对的问题。
     *
     * 下面这几个字段就是"这次枚举走了哪条路、看见了多少"的可读事实：
     *   · enum_source       —— 'schemas(scope)' / 'schemas(global)' / null（没枚举成）
     *   · enum_total        —— 枚举看见的名字数（盲的时候明显偏小，一眼可辨）
     *   · enum_restrictable —— 交叉核对：能被 restrict 命名的名字全集（global+祖先层）
     *   · enum_missing_core —— 核心名字缺席清单（read/subagent）。非空 ⇒ 拒绝下刀
     *   · enum_error        —— 枚举时抛错的原因（null = 没抛）
     * ⚠ 诚实边界：`enum_total` 只是数量，**不是**"枚举正确"的证明。真正的判据是
     *   `enum_missing_core` 为空 **且** `install_path === 'sync-allow'`；
     *   任一不成立就是"没装上白名单"，不许读成"装上了但数字好看"。
     */
    enum_source: null,
    enum_total: 0,
    enum_restrictable: null,
    enum_missing_core: [],
    enum_error: null,
    enum_filtered: [],
    /* ── 白名单装完之后的自证：**不许砍残** ─────────────────────────────────
     * 白名单的语义是"只留这些"，写错一个前缀就会把主帅砍成残废 —— 而残废的形状是
     * **没有任何报错**：他只是忽然什么都不会了，日志一片绿。所以装完必须回到这个
     * agent 的视角核一次：核心名字（read/subagent）还看得见吗？看不见 ⇒ 立刻撤销
     * 白名单、退回黑名单（那至少是个熟悉的天花板），并把这件事记进 allow_amputated。
     * 这就是任务书那句"不提升就回滚"的**机器实现**，不是一句自觉。
     *
     * 两个读数必须分开读（同一个坑在本文件已出现两次）：
     *   · allow_amputated 非空    —— 真的砍残了（且**已经**回滚）
     *   · allow_core_blind = true —— get 在这个 scope 上**整体失明**：可能是砍残、
     *     也可能只是看不见。两种都不许断言，按"看不见"如实留白，不猜、不回滚。
     */
    allow_candidates: 0,
    allow_kept: null,
    allow_total: null,
    allow_error: null,
    allow_refused: null,
    allow_core_ok: 0,
    allow_core_verified_at: null,
    allow_core_blind: false,
    allow_amputated: [],
    allow_rollback_at: null,
    /* ── 2026-11-11：把「名单里有本机未注册的名字」从 error 降为 normal-and-recorded ──
     *
     * 病（真机实测，`_no-hands/status.json` 2026-11-11T12:50:21Z）：deny 名单是
     * **跨平台意图**（`bash` 给 Linux、`pwsh` 给 Windows），而注册表是**本机事实**。
     * 宿主对未注册的名字是整批拒绝 —— `restrict()` 在 append 之前就抛
     * `names unknown global tool "bash"`，于是**每一次正常安装都要先抛一次**。
     * 那条消息被写进 `last_error`，而 `last_error` 是**只写一次、不覆盖**的报警位
     * （原来的 :369 `if (status.last_error === null)`）⇒ 它一旦被这条**非故障**
     * 占住，就永久非 null：
     *
     *   restrict_error: null（裁剪后重试成功）
     *   install_path:   "sync"（同步剥夺已落地）
     *   restricted:     6      （六个 agent 都剥夺过）
     *   只有 last_error 非 null，而它报的那件事根本不是错。
     *
     * 这就是一张**永久红**。而永久红的后果不是"多一行噪音"：下一任读者只剩两条路 ——
     * 把判据改坏（"反正它永远红"），或把以后所有真红一起当噪声忽略。
     * 两条都比缺这条判据更坏（method-032 / method-066 的后果链）。
     *
     * 改法（**次选**：仍整批 restrict + 按报错收窄；选它而不用"先取注册表再相交"的理由
     * 写在 `restrictWith()` 的注释里）。把「未知名字」这一类从 `last_error` 里摘出来，
     * 只记在这三格：
     *   · `trimmed_unknown`        —— 被裁掉的名字。这是**事实**，不是故障；
     *   · `trimmed_unknown_events` —— 裁剪发生过几次。**累计量，只做展示**，
     *                                 不许拿它当状态判据（method-032）；
     *   · `last_trim_evidence`     —— 触发裁剪的那条 restrict 原始消息。
     *                                 「剥掉未知名字」这件事的证据不许丢，包括宿主那句
     *                                 `known global tools: …` 全量目录。
     *
     * ⚠ 诚实边界（别把它读成 green）：干净机器上 trim 掉一个平台名（`bash`）与
     *   把名单拼错一个字母，在这三格里**长得一样**。所以"被裁剪过"本身**不是**健康信号；
     *   本机期望值就是 `bash` 一个，出现别的名字要人去看一眼 —— 这是把判断交回给人，
     *   不是宣称没有问题。
     * ⚠ 这条降级**只覆盖名字类**：非名字类报错、以及裁剪后仍然抛错，照旧写 `last_error`。
     *   没有那一半，这次改动就是把报警器关掉 —— 那比现在这条永久红更坏。
     */
    trimmed_unknown: [],
    trimmed_unknown_events: 0,
    last_trim_evidence: null,
    /* 第二层自证：在某个真实 agent 的视线里，这些名字到底还在不在。
       `deny_absent` 就是 s7 要的那句话的证据；`deny_still_visible` 是警报。 */
    deny_absent: [],
    /* 「本来就不在这台机器上」的那一半；见 verifyDenialOnce 里的自证污染说明。 */
    deny_absent_unregistered: [],
    deny_absent_split: null,
    deny_still_visible: [],
    /* 只记主帅视角的结果：s7 说的是"主帅没有手"。工人名单可能落在工人自己那一层，
       而 restrict 按设计不过滤自己的层 —— 那是守卫兜底的正常形态，混进来会永久假红。 */
    lead_absent: [],
    worker_still_visible: [],
    deny_verified_agents: 0,
    deny_verified_at: null,
    last_verify: null,
    last_denial: null,
    last_error: null,
  }

  /* ── 角色判定 ────────────────────────────────────────────────────────────
   * `origin` 是 dsh 在 spawn/fork/continuable 三类子会话上都盖的**持久创建元数据**
   * （board2 的 LEAD_RULES/WORKER_RULES 分流用的就是同一判据）。
   *
   * 三种返回，不是一个布尔：'lead' / 'child' / 'unknown'。
   * unknown 的存在是为了让「读不到」不会被静默当成「这是主帅」——那个方向的
   * 误判会剥掉工人的手，见文件头不变量 1。
   */
  const roleCache = new Map()

  /**
   * 判角色：**纯函数**，只回答"它是什么"，不记账。
   *
   * 记账（leads/children）原本写在这里，2026-11-13 拆出去了，理由是那次事故的第二半：
   * 一个**不会**被本插件动手的会话，只要有人问过它的角色，就被算进了 `leads` ——
   * 于是 status 说"七个主帅"，真正被剥夺的只有六个，而 s7 的依据就是这个数。
   * ⇒ 「谁问过」和「我们管住了谁」是两件事，countRole 只在 install() 真的动手时写一次。
   */
  function classify(agent) {
    const id = String(agent?.id ?? '')
    if (id === '') return 'unknown'
    const cached = roleCache.get(id)
    if (cached !== undefined) return cached
    const session = agent?.session
    if (session === undefined || session === null) return 'unknown'
    const origin = session.header?.origin
    const role = origin === 'subagent' ? 'child' : 'lead'
    roleCache.set(id, role)
    return role
  }

  /** 被本插件**真的管住**的 agent 才进普查（每个 id 只算一次，重复装配不重复计）。 */
  const countedRoles = new Set()

  function countRole(id, role) {
    if (countedRoles.has(id)) return
    countedRoles.add(id)
    if (role === 'child') status.children += 1
    else status.leads += 1
  }

  /**
   * 跳过也要**可回查**：谁被跳过了、它跑的是哪个预设。
   *
   * 只记一个计数的话，下一个人看到 `skipped_not_preset: 7` 仍然不知道那七个是谁 ——
   * 而这件事恰恰需要能指认出具体会话（是不是我那个 creation 会话被误跳过了？）。
   * 上限 20 条、同 id 只记一次：这是观测口，不是流水账，它不该长成第二份会话日志。
   */
  function rememberSkip(id, preset) {
    if (status.skipped_sample.some((s) => s.agent === id)) return
    status.skipped_sample.push({ at: new Date().toISOString(), agent: id, preset })
    while (status.skipped_sample.length > 20) status.skipped_sample.shift()
  }

  /* ── 观测口（B4：不可观测的改进等于没改）───────────────────────────────── */

  /**
   * 观测文件的写者：**合并写 + 不丢更新**。
   *
   * 三段都是真的踩出来的，不是预防性设计：
   *
   * ① 非原子写会让读者看到半个 JSON。症状是 `Unexpected end of JSON input`，
   *    看起来像数据坏了，其实只是撞上了写入窗口；读到一半的判定会把人骗去查
   *    错误的方向。→ 改成 tmp + rename，读者只会看到旧的或新的。
   *
   * ② 光"排队时直接 return"会**丢更新**。第一版是
   *      if (writeQueued) return
   *    而正在飞的那次写在我改完计数之后才 stringify —— 于是它写出的还是旧值，
   *    而新值因为"已在排队"被丢弃。表现为 status.leads 随机少 1。
   *    → 改成脏标记：写期间任何新变更都会再触发一轮，直到没有新变更。
   *
   * ③ 每次写用**不同**的临时文件名。两次写共用同一 tmp 时，先完成的那次
   *    rename 会把后一次的临时文件搬走，后一次的 rename 于是 ENOENT ——
   *    内容未必错，但错误被吞掉，且顺序不再确定。
   */
  let writeQueued = false
  let dirty = false
  let writeSeq = 0
  /** 在飞的那次写。`flushStatus()` 等它，测试因此不需要猜时间。 */
  let inFlight = Promise.resolve()

  async function writeOnce() {
    await fs.mkdir(path.dirname(statusPath), { recursive: true })
    const tmp = `${statusPath}.${process.pid}.${writeSeq++}.tmp`
    await fs.writeFile(tmp, JSON.stringify(status, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, statusPath)
  }

  function kick() {
    writeQueued = true
    inFlight = (async () => {
      try {
        let rounds = 0
        while (dirty && rounds < 5) {
          dirty = false
          rounds += 1
          await writeOnce()
        }
      } catch (error) {
        // 不变量 2：观测失败不是系统故障，但必须留痕。
        status.last_error = error?.message ? String(error.message) : String(error)
      } finally {
        writeQueued = false
        // 写期间又脏了（含超过 5 轮上限的情况）：再排一轮，绝不静默丢弃。
        if (dirty) kick()
      }
    })()
    return inFlight
  }

  function noteStatus() {
    dirty = true
    if (!writeQueued) kick()
    return inFlight
  }

  /* ── ① 结构性剥夺：把工具从目录里拿走 ──────────────────────────────────── */

  const fibers = new Map()

  /**
   * 从 `tools.restrict()` 的报错里读出**这台机器不认识的名字**。
   *
   * `restrict()` 在 append 之前就校验名单，遇到一个不认识的名字整体抛错：
   *   tools.restrict() names unknown global tool "bash"; known global tools: ...
   * 于是"名单里有本机不存在的名字"会让**整张名单**作废 —— 一个名字都没被拿走，
   * 而 before/after 两格一模一样，读起来像"插件没生效"（宿主平面 2026-11-07 真事）。
   * 只在 "unknown global tool(s)" 这一段里、且只在 candidates 之内取名字；
   * 绝不去解析 `known global tools:` 那一长串（那是宿主全量目录，按它重算会把
   * "我只想拿走这四样"变成"按目录表删除"）。
   *
   * @param {string} message
   * @param {string[]} candidates
   * @returns {string[]}
   */
  function unknownNamesFrom(message, candidates) {
    const text = String(message ?? '')
    const marker = text.indexOf('unknown global tool')
    if (marker < 0) return []
    const head = text.slice(marker).split(';')[0]
    const found = []
    const re = /"([^"]+)"/g
    let m
    while ((m = re.exec(head)) !== null) {
      const n = m[1]
      if (candidates.includes(n) && !found.includes(n)) found.push(n)
    }
    return found
  }

  /**
   * 同步剥夺的**唯一实现**（同步路径与注入回退路径共用）。
   *
   * 两条路径唯一的差别是"什么时候跑"，不该有两份行为。所有读数照旧：
   *   · `deny_checked` / `deny_unmatched` / `get_scope_blind` —— get 的诚实边界；
   *   · `restrict_error` —— throw 的**精确**原因；
   *   · `last_trimmed` —— 名单被裁剪过就是一条可读事实；
   *   · `trimmed_unknown` / `last_trim_evidence` —— 同上，且**不是** error。
   *
   * ── 为什么是"事后按报错收窄"（次选），而不是"先取注册表再相交"（首选）───────
   *
   * 首选看起来更干净，但它依赖一个**在本文件里已经证明是瞎的**取数口：
   * `tools.get(name)` 不带 scope 时只看 global 层，而剥夺是**按 scope** 的 ——
   * 真机 status 里就摆着证据：`get_scope_blind: true`、
   * `deny_unmatched: [pwsh, bash, write, edit, ask_user_question]`，
   * 即 **get 对名单里每一个名字都返回 undefined**，而同一份文件里 `restricted: 6`
   * 说明这些名字其实**全都有效**（restrict 收下了它们）。
   * ⇒ 若真拿 `tools.get()` 去和名单求交，交集为空，`restrict` 一个名字都不发，
   *   剥夺当场变成**空操作**，而且所有读数一片绿（deny_absent 会因为"本来就没装"
   *   而看起来正常）。那会把一张永久红换成**整套剥夺的静默失效**，比现状坏得多。
   *
   * 另一条"取注册表"的现成来源是那条报错里的 `known global tools: …` 全量目录，
   * 而这正是本文件明令禁止的用法：按宿主目录重建名单，会把"我只想拿走这四样"
   * 变成"按目录表删除"，宿主加一个新工具就会被误删。
   *
   * 次选的分工恰好就是任务要的那一句：**deny 名单是意图，注册表是事实，两者相交** ——
   * 交集由宿主自己的校验算（它才知道这个 scope 的真实注册表），我们只负责读懂它的
   * 拒绝并收窄，然后把"收窄过"记成一条事实。名单里 `bash` 一个字都不动：
   * 那是给 Linux 的意图，在本机不成立不代表它在别的机器上不成立。
   *
   * @param {any} tools - 该 scope 视角下的 tools 服务（traceable：restrict 落在**这个** scope）
   * @param {string[]} deny
   * @returns {{applied: boolean, dispose?: () => void, error: string|null, trimmed: string[]}}
   */
  function restrictWith(tools, deny) {
    const result = { applied: false, dispose: undefined, error: null, trimmed: [] }
    if (!tools || typeof tools.restrict !== 'function') {
      result.error = 'tools service has no restrict()'
      return result
    }
    /* 剥夺**之前**先核对名字在不在（见 status 里 get 的诚实边界说明） */
    let checked = 0
    let misses = 0
    try {
      if (typeof tools.get === 'function') {
        for (const wanted of deny) {
          checked += 1
          status.deny_checked += 1
          if (tools.get(wanted) === undefined) {
            misses += 1
            if (!status.deny_unmatched.includes(wanted)) status.deny_unmatched.push(wanted)
          }
        }
      }
    } catch (error) {
      status.last_error = error?.message ? String(error.message) : String(error)
    }
    if (checked > 0 && misses === checked) status.get_scope_blind = true

    /* 名单必须能忍：见 unknownNamesFrom 的说明 */
    let pending = [...deny]
    for (let attempt = 0; attempt <= deny.length; attempt += 1) {
      if (pending.length === 0) break
      try {
        result.dispose = tools.restrict({ deny: pending })
        status.restrict_error = null
        status.last_trimmed = [...result.trimmed]
        result.applied = true
        return result
      } catch (error) {
        const message = error?.message ? String(error.message) : String(error)
        status.restrict_error = message
        result.error = message
        const unknown = unknownNamesFrom(message, pending)

        if (unknown.length === 0) {
          /* ── ① 这一类才是**真失败** ──────────────────────────────────────────
           * 报错里没有 `unknown global tool` ⇒ 不是"本机没有这个名字"，而是 restrict
           * 自己拒绝了这个请求：坏参数、不存在的 scope、服务坏了。
           * 只有这里写 `last_error` —— 只写一次，不覆盖更早的注入失败原因。
           * **这一半是本次改动的全部意义**：让 last_error 变 null 却顺手把真错误也
           * 变成静默，等于把报警器关掉，比原来那条永久红更坏。 */
          if (status.last_error === null) status.last_error = message
          return result            // 不是名字的错 ⇒ 不猜
        }

        /* ── ② 这一类**不是失败**，是「意图 ∩ 事实」的差值 ────────────────────
         * 名单是跨平台意图，注册表是本机事实；本机没有的名字本来就该被裁掉，
         * 裁掉之后重试成功是**正常路径**，不是异常。
         *   ⇒ 不进 `last_error`（否则每一次正常安装都把它永久占住，见 status 字段注释）
         *   ⇒ 但**必须留痕**：名字进 `trimmed_unknown`，原始消息进 `last_trim_evidence`。
         * 把"剥掉未知名字"这件事一起吞掉，是这次改动的**唯一禁止事项** ——
         * 那会把「名单被裁剪过」从一条可读事实变成无人知晓的静默变更。 */
        status.trimmed_unknown_events += 1
        status.last_trim_evidence = message
        for (const n of unknown) {
          if (!result.trimmed.includes(n)) result.trimmed.push(n)
          if (!status.trimmed_unknown.includes(n)) status.trimmed_unknown.push(n)
        }
        pending = pending.filter((n) => !result.trimmed.includes(n))
      }
    }
    status.last_trimmed = [...result.trimmed]
    return result
  }

  /* ── 目录级白名单（根治"主帅有手"）──────────────────────────────────────
     实测 2026-11-12：`harness.registerTool` 注册的动态工具是**全进程可见**的，
     我给自己建的 `waract`（能执行任意命令）出现在每一个会话的工具表里，而按名字拦的黑名单
     根本不认识它。同一份实测还暴露了更大的洞：主帅手里一直有 `kali_*`（nmap / nuclei /
     sqlmap / ffuf）、`rtwb_*`、`btwb_harden` —— 那些是**真能对靶标开火**的工具，
     黑名单时代一个都没拦住。按名字封堵永远追不上新名字，所以改成白名单：
     只保留研判/指挥/记账/图，其余连 schema 都不给。新工具默认不可见 = 失败关闭。 */

  /** 核心名字：主帅丢了这两个就不是"没有手"，是"不会动"。白名单错砍它们必须被抓住。 */
  const KEEP_CORE = ['read', 'subagent']

  /** `Code Mode` 的传输名：`restrict()` 明令不许命名它（会整批抛错）。 */
  const RESERVED_NAME = 'run_code'

  /**
   * 能被 `restrict()` 命名的名字全集（global + 祖先层，**未过 restrictions**）。
   *
   * 它是「这个名字在本机到底存不存在」的判据：不在其中 ⇒ 这台机器的目录里从来没有它。
   * 返回 null 表示**读不到**（没有 view / 没有 restrictableNames / 抛错），
   * 这和「读到了一个空集」必须分开：前者只能退回旧行为，后者才是"确实读到了，一个都没有"。
   *
   * @param {any} tools 该 agent 视角的 tools 服务（或插件自己那一侧的）
   * @param {any} agent scope key（dsh-agent 把 agent 本身当 scope key）
   * @returns {Set<string>|null}
   */
  function restrictableOf(tools, agent) {
    try {
      if (typeof tools?.view !== 'function') return null
      const names = tools.view(agent)?.restrictableNames
      if (names === undefined || names === null) return null
      if (typeof names[Symbol.iterator] !== 'function') return null
      return new Set([...names].map((n) => String(n)))
    } catch {
      return null
    }
  }

  /**
   * 枚举该 agent **看得见的**工具名 —— 按 scope，且把"走了哪条路"一起带回来。
   *
   * 旧的 `allowlistFor()` 调的是 `tools.schemas()`（**没给 scope**），于是永远只看见
   * global 层（本机 24 个），而模型真正拿到的是 97 个。白名单因此只认下 5 个名字，
   * 被守门逻辑拒绝，白名单从设计到上线一次都没生效过（`allow_refused: 5/24`）。
   *
   * 三个取数口，按可信度排序，且**每个都记下来**：
   *   ① `schemas(agent)` —— 首选。这正是模型请求里那张表的来源。
   *   ② `view(agent).restrictableNames` —— 交叉核对。它是**能被 restrict 命名**的
   *      名字全集（global + 祖先层，未过 restrictions）。allow 必须落在它里面：
   *      名字不在其中时宿主会**整批**抛 `unknown global tool`，一个都不拿走。
   *      它顺带把 `run_code` 排除掉（`run_code` 只进 visible，不进 restrictable）。
   *   ③ `schemas()` —— 最后兜底，但它是**盲的**。留着它只是为了不让"枚举整体失败"
   *      退化成"完全不下刀"；盲的时候 `missing_core` 一定会命中（见 install 的守门）。
   *
   * @param {any} tools 该 agent 视角的 tools 服务
   * @param {any} agent scope key（dsh-agent 把 agent 本身当 scope key）
   * @returns {{source: string|null, total: number, visible: string[], restrictable: string[]|null,
   *           candidates: string[], missingCore: string[], error: string|null}}
   */
  function enumerateFor(tools, agent) {
    const out = {
      source: null,
      total: 0,
      visible: [],
      restrictable: null,
      candidates: [],
      filtered: [],
      missingCore: [],
      error: null,
    }
    const asNames = (list) =>
      (Array.isArray(list) ? list : []).map((s) => String(s?.name ?? '')).filter((n) => n !== '')

    /* ① 按 scope 枚举（对的那个问法） */
    try {
      if (typeof tools?.schemas === 'function') {
        const scoped = asNames(tools.schemas(agent))
        if (scoped.length > 0) {
          out.source = 'schemas(scope)'
          out.visible = scoped
        }
      }
    } catch (error) {
      out.error = error?.message ? String(error.message) : String(error)
    }

    /* ② 交叉核对：能被 restrict 命名的名字全集（拿不到不是错误，只是少了这层核对） */
    const restrictable = restrictableOf(tools, agent)
    if (restrictable !== null) out.restrictable = [...restrictable]

    /* ③ 兜底：不带 scope 的全局视图（盲的，只为了避免"完全不下刀"） */
    if (out.source === null) {
      try {
        if (typeof tools?.schemas === 'function') {
          const global = asNames(tools.schemas())
          if (global.length > 0) {
            out.source = 'schemas(global)'
            out.visible = global
          }
        }
      } catch (error) {
        if (out.error === null) out.error = error?.message ? String(error.message) : String(error)
      }
    }

    /* 候选集：看得见 ∩ 能被命名。交集为空也照样返回 —— 守门会拒绝，绝不拿空名单下刀。 */
    const restrictableSet = out.restrictable === null ? null : new Set(out.restrictable)
    out.candidates = out.visible.filter(
      (n) => n !== RESERVED_NAME && (restrictableSet === null || restrictableSet.has(n)),
    )
    /* 可命名但不可见 = 在枚举那一刻就已经被上游挡掉的名字。
       2026-11-13 重启后实测 97 可命名 / 94 可见，差 3 个 —— 当时**说不出是哪三个**，
       因为读数只存了数量。存下名单，下一次重启就能直接指认，不用再猜。 */
    out.filtered =
      restrictable === null
        ? []
        : [...restrictable].filter((n) => !out.visible.includes(n) && n !== RESERVED_NAME)
    out.total = out.visible.length
    out.missingCore = KEEP_CORE.filter((n) => !out.visible.includes(n))
    return out
  }

  function restrictAllow(tools, allow) {
    const result = { applied: false, dispose: null, error: null }
    try {
      result.dispose = tools.restrict({ allow })
      result.applied = true
    } catch (error) {
      result.error = error?.message ? String(error.message) : String(error)
    }
    return result
  }

  /**
   * 角色 → 该写哪一个"安装路径"字段。
   *
   * 为什么要有这个函数，而不是在每处写一句 if：`install()` 里写路径的地方有**四处**
   * （同步剥夺 / 同步失败 / 注入回退），而工人与主帅走的是**同一段代码**。
   * 只要有一处漏判，工人就又能覆盖主帅的读数 —— 而漏判的形状是**不报错**：
   * status 里只是少了一格、多了一格，没有任何一行会变红。把映射收敛到一处，
   * 四处共用，改这里就是全改。
   *
   * 语义边界（读的时候不许混）：
   *   · install_path        —— "主帅的白名单装上没有"：'sync-allow' / 'sync-allow-rolled-back'；
   *   · install_path_worker —— 工人走的是哪条路。工人默认走通用 deny 路径 ⇒ 'sync' 是正常形态。
   */
  const pathFieldFor = (role) => (role === 'child' ? 'install_path_worker' : 'install_path')

  function install(agent) {
    if (!enabled) return
    const id = String(agent?.id ?? '')
    if (id === '') return
    /* ── ★ 预设闸门：只剥夺**真的在跑本预设**的 agent（2026-11-13）─────────────
     *
     * 这一段必须排在 classify() 与任何剥夺动作之前。理由不只是"少做无用功"：
     * 事故里那个跑别的预设的会话，被剥夺了 pwsh/write/edit，一整场一条命令都跑不了。
     *
     * ⚠ 判不出预设 ⇒ 当"不是我的会话"跳过，**不剥夺**。两个错误不对称：
     *   · 把一个**不是** war 的会话当 war ⇒ 它整场没有手（这已经不是假设了）；
     *   · 把一个**是** war 的会话放过 ⇒ 主帅多一双前手 —— 而这一半**不由这里兜底**：
     *     `~/.dsh/war-plugins/dsh-war-no-hands` 在**宿主平面**独立剥夺 war 主帅
     *     （`presets: ["war"]`，读数在 `_no-hands/host-plane.json`，实测 `installed: 3`）。
     *     它不依赖预设平面这一行的装载时序，正好接住这个洞。
     * ⇒ 选"放过"。上面那句"已经有人接住"是这段代码能这么写的前提，不是顺带一提：
     *   若宿主平面那一支不存在，这里就必须反过来选，代价也跟着反过来。
     */
    const preset = presetOf(agent)
    if (preset === null) {
      /* "读不到"不是"不归我管"：两者都跳过，但分开计数 —— 一格问一件事。
         读不到很多是坏事（插件早于会话装载、事件结构变了），它需要一个自己的数字，
         否则它会藏在 skipped_not_preset 里，读起来像"正常跳过"。 */
      status.preset_unknown += 1
      rememberSkip(id, null)
      noteStatus()
      return
    }
    if (!presets.includes(preset)) {
      status.skipped_not_preset += 1
      rememberSkip(id, preset)
      noteStatus()
      return
    }
    if (fibers.has(id)) return
    const role = classify(agent)
    if (role === 'unknown') return // 不变量 1
    /* 到这里才记账：这个 agent 归我们管，而且我们已经知道它是主帅还是工人。 */
    countRole(id, role)
    const deny = role === 'child' ? workerDeny : leadDeny
    if (deny.length === 0) return

    /* ★ 第一优先：**同步**剥夺（v1.18）。
       不排插件 fiber ⇒ 在 agent/created 这个同步派发里当场落地 ⇒ 第 0 个请求就看不见手。
       `agent.ctx.tools` 是 cordis 的 traceable 服务视图：方法里的 `this.ctx` 是**调用方**
       那个 ctx（cordis/lib/index.js:128 / 140-142），而 `ctx.extend()` 原型继承 kScope
       （cordis/lib/index.js:1703-1709），所以 restrict 正好落在这个 agent 的 scope 上。 */
    let toolsNow
    try {
      toolsNow = agent?.ctx?.tools
    } catch { toolsNow = undefined }
    /* 主帅优先走白名单：目录里只剩该有的东西，黑名单退化成第二层兜底。 */
    if (role === 'lead' && toolsNow !== undefined) {
      const cat = enumerateFor(toolsNow, agent)
      status.enum_source = cat.source
      status.enum_total = cat.total
      status.enum_restrictable = cat.restrictable === null ? null : cat.restrictable.length
      status.enum_missing_core = cat.missingCore
      status.enum_filtered = cat.filtered
      status.enum_error = cat.error
      const kept = computeAllowlist(cat.candidates, {
        exact: LEAD_ALLOW_EXACT,
        prefixes: LEAD_ALLOW_PREFIXES,
      })
      status.allow_candidates = cat.candidates.length
      /* 干跑自检：枚举结果必须"看起来是真的目录"才敢下刀。
         已知的盲区就是不带 scope 的 `schemas()`（只看 global 层）——盲了的时候
         board_ / subagent 会缺席，而 restrict({allow}) 会把它们一并拿掉，
         那不是剥夺，是把主帅砍成残废。宁可退回黑名单，也不冒险。
         现在判据是**具体缺席**而不是"数量够不够"：`missing_core` 非空就是不许下刀。 */
      const looksReal = cat.missingCore.length === 0 && cat.total >= 20
      if (looksReal && allowlistUsable(kept, cat.total)) {
        const r = restrictAllow(toolsNow, kept)
        if (r.applied) {
          /* 主帅专属：白名单路径只写 install_path（这一段外面有 role === 'lead' 守门，
             所以这里写的是"主帅的路径"，工人永远走不到这一行）。 */
          status.install_path = 'sync-allow'
          status.allow_kept = kept
          status.allow_total = cat.total
          status.allow_refused = null
          status.restricted += 1
          const dispose = r.dispose
          fibers.set(id, { dispose: () => { try { if (typeof dispose === 'function') dispose() } catch { /* 清理失败不该影响任何人 */ } } })
          noteStatus()
          armVerify(agent, deny, role)
          /* 白名单是"只留这些"：错砍的形状是**没有报错**，所以装完必须回头核一次核心名字。 */
          verifyAllowCore(agent, deny)
          return
        }
        status.allow_error = r.error ?? 'restrict(allow) not applied'
      } else {
        /* 拒绝也要说清是哪道门拦的 —— 否则下一个人只会看到一句"没装上"。 */
        status.allow_refused =
          cat.source === null
            ? 'enumeration unavailable' + (cat.error === null ? '' : ': ' + cat.error)
            : cat.missingCore.length > 0
              ? 'core tools missing from enumeration: ' + cat.missingCore.join(',') +
                ' (' + cat.source + ', ' + String(cat.total) + ' names)'
              : 'allowlist too small: ' + String(kept.length) + '/' + String(cat.total)
      }
      noteStatus()
    }

    if (toolsNow !== undefined) {
      const sync = restrictWith(toolsNow, deny)
      if (sync.applied) {
        /* 按角色分账：工人走通用 deny 路径时写 install_path_worker ——
           这一格**不许**覆盖主帅的白名单读数（否则就是本文件 2026-11-13 那条假红）。 */
        status[pathFieldFor(role)] = 'sync'
        status.restricted += 1
        const dispose = sync.dispose
        fibers.set(id, { dispose: () => { try { if (typeof dispose === 'function') dispose() } catch { /* 清理失败不该影响任何人 */ } } })
        noteStatus()
        armVerify(agent, deny, role)
        return
      }
      /* 同步走得通但名字一个都没收下（或工具还没挂到这条 scope 链上）⇒ 记下来，再试注入 */
      status[pathFieldFor(role)] = `sync-failed: ${sync.error ?? 'no names applied'}`
    }

    /* 第二优先：注入回退（原来的路径）。
       agent/created 时刻工具还没进这条 scope 链时，它会在服务可用后再跑一次 ——
       晚是晚，但不为 0。 */
    try {
      const fiber = agent.ctx.inject(['tools'], (scope) => {
        const late = restrictWith(scope.tools, deny)
        if (late.applied) {
          /* 「已经有 'sync' 就保留 'sync'」这条现成条件必须读**同一个角色**的那一格：
             若读主帅的字段却写工人的值，又是一次跨角色覆盖。 */
          const field = pathFieldFor(role)
          status[field] = status[field] === 'sync' ? 'sync' : 'inject'
          status.restricted += 1
          armVerify(agent, deny, role)
        }
        noteStatus()
      })
      const existing = fibers.get(id)
      fibers.set(id, {
        dispose: () => {
          try { existing?.dispose?.() } catch { /* 同上 */ }
          Promise.resolve().then(() => fiber.dispose?.()).catch(() => { /* 同上 */ })
        },
      })
      noteStatus()
    } catch (error) {
      status.last_error = error?.message ? String(error.message) : String(error)
      noteStatus()
    }
  }

  function forget(agent) {
    const id = String(agent?.id ?? '')
    if (id === '') return
    roleCache.delete(id)
    countedRoles.delete(id)
    const fiber = fibers.get(id)
    if (fiber === undefined) return
    fibers.delete(id)
    Promise.resolve()
      .then(() => fiber.dispose?.())
      .catch(() => { /* 清理失败不该影响任何人 */ })
  }

  /* ── ② 运行时兜底：拒绝并说明下一步 ────────────────────────────────────── */

  function denialText(toolName, role) {
    const what = DENY_TEXT[toolName] ? `（${DENY_TEXT[toolName]}）` : ''
    if (role === 'child') {
      return (
        `war-no-hands：工作模式里没有「${toolName}」${what}。\n` +
        '需要人决定的事，用 report 的结构化字段（waiting_on / blocked_reason）交给统帅转达——\n' +
        '指挥官只跟统帅说话，这是这套体系的一条不变量，不是对你的不信任。\n' +
        '其余动作照常：干活用的工具一个都没少。'
      )
    }
    return (
      `war-no-hands：统帅没有手——「${toolName}」${what}不在你的工具集里。\n` +
      '这不是权限问题，是编制问题：你的职责是研判、下令、督战、收编。\n' +
      '派兵：subagent（一个任务、一种战法、一名队员）；延续：send_message；卡死：interrupt_agent。\n' +
      '只是要看清局面？board_snapshot / opsmap_refresh / map_orders / read / skill 都在。\n' +
      '本次调用没有任何副作用，下一步照常谋划。'
    )
  }

  /* ── 剥夺的第二层自证：在这个 agent 的**视角**里，那些名字还看得见吗 ────────
   *
   * 第一层自证（上面 `restrict_error`）只证明「名字有效、restrict 收下了」。
   * 它证不到 s7 真正要的那句话——「主帅的工具集里没有 pwsh」。
   *
   * 第二层用的是 tools 服务的公开签名：
   *   `dsh-tools/lib/index.js:2879`  get(name, scope) → `this.view(scope).visible.get(name)`
   *   `dsh-tools/lib/index.js:2843`  view(scope) 把 `inherited`（global + 这条 scope 链上的
   *                                  每个祖先层，含 preset 平面）按该 scope 的 restrictions
   *                                  过滤，再把 scope **自己**那一层放回去。
   * 所以 `tools.get('pwsh', agent)` 返回 undefined，就是「这个名字在这个 agent 的可见面上没了」。
   *
   * 为什么现在才敢用：第一版用的是**不带 scope** 的 `get(name)`，而 `view(undefined)` 只看
   * global 层 —— 老的那些预设工具已经搬到 agent 平面（祖先层），于是永远看不见，
   * 被读成「名单拼错」（真机 5/5 全红，见 v1.17 记录）。带上 `exec.agent` 才是对的问法。
   *
   * 触发时机：守卫每次调用都会跑，就在任何一个**被允许**的调用上顺手核对一次，
   * 每个 agent 只核一次（`fibers.has(id)` 之后才核 —— 没装过就别急着判）。
   */
  /**
   * 主动自证：装完剥夺后立刻核一次，不等守卫被触发。
   *
   * WHY 必须主动（真机读数，`_no-hands/status.json` 2026-11-12）：`restricted: 3` 但
   * `deny_verified_agents: 0` / `deny_verified_at: null`。自证原本只挂在守卫里，而守卫
   * 只在**有人调用工具**时才跑 —— 主帅如果从不碰 pwsh/write/edit（这恰恰是剥夺成功的
   * 表现），自证就永远不发生。结果：剥夺可能有效也可能无效，**零线级证据**，判据 s7 只
   * 能一直红着。这是「验证挂在低频路径上」的同一个坑，本项目已第四次命中。
   *
   * 两拍：微任务先核一次（restrict 是同步的，通常这时已经生效），150ms 后再强制核一次，
   * 兜住工具表在别的时序上才稳定的情况。核不到的旧读数会被 verifyDenialOnce 自愈清掉。
   */
  function armVerify(agent, deny, role) {
    const fire = (force) => {
      try {
        verifyDenialOnce(agent, deny, role, force)
      } catch (error) {
        // 自证失败绝不能反过来影响剥夺本身。
        status.last_verify_error = error?.message ? String(error.message) : String(error)
      }
    }
    Promise.resolve().then(() => fire(false)).catch(() => {})
    try {
      setTimeout(() => fire(true), 150)
    } catch {
      fire(true)
    }
  }

  /** 本插件自己那一侧的 tools 服务；scope 在每次查询时单独带上，不在这里固化。 */
  function serviceTools() {
    try {
      const viaGet = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
      return viaGet ?? ctx.tools
    } catch {
      return ctx.tools
    }
  }

  const verifiedAgents = new Set()
  /** 已经判成"砍残"并回滚过的 agent：不再重复核，也不再重复回滚。 */
  const amputatedAgents = new Set()

  function verifyDenialOnce(agent, deny, role, force) {
    const id = String(agent?.id ?? '')
    if (id === '') return
    if (!force && verifiedAgents.has(id)) return
    if (!fibers.has(id)) return // 这个 agent 还没装过剥夺：核了也不算数
    const tools = serviceTools()
    /* 「看不见」有两种，混在一格就是自证污染：
         ① 它曾经在目录里、现在被拿走了 —— 这才叫剥夺成功；
         ② 它从来就不在这台机器的目录里 —— 那是跨平台意图（本机没有 bash），
            写进 deny_absent 就等于拿"它本来就不存在"去证"我把它拿掉了"。
       判据是 restrictableNames：不在其中 = 本机没有这个名字。读不到那份全集时**不猜**，
       退回旧行为并置 deny_absent_split=false。 */
    const restrictable = restrictableOf(tools, agent)
    status.deny_absent_split = restrictable !== null
    if (!tools || typeof tools.get !== 'function') return
    verifiedAgents.add(id)
    const stillVisible = []
    const absent = []
    for (const wanted of deny) {
      let visible
      try { visible = tools.get(wanted, agent) } catch { visible = undefined }
      if (visible === undefined) {
        const known = restrictable === null ? true : restrictable.has(wanted)
        if (known) {
          if (!status.deny_absent.includes(wanted)) status.deny_absent.push(wanted)
          absent.push(wanted)
        } else if (!status.deny_absent_unregistered.includes(wanted)) {
          status.deny_absent_unregistered.push(wanted)
        }
        /* 自愈：上一次自证可能判早了（restrict 尚未在该 scope 上生效），这里纠正。
           否则一条过期的"还看得见"会让 s7 永久假红 —— 而假红会被当成"剥夺失效"，
           于是有人去改一个其实没坏的东西。 */
        const staleLead = status.deny_still_visible.indexOf(wanted)
        if (staleLead >= 0) status.deny_still_visible.splice(staleLead, 1)
        const staleWorker = status.worker_still_visible.indexOf(wanted)
        if (staleWorker >= 0) status.worker_still_visible.splice(staleWorker, 1)
      } else {
        /* ★ 只有**主帅**的"还看得见"才算 s7 的失败信号。
           工人的名单是 workerDeny，它可能落在工人**自己那一层**（委派运行时把报告类工具
           注册在那里），而 restrict 按设计不过滤自己的层 —— 那属于"守卫兜底"的正常形态，
           不是"主帅还有手"。混在一起会让 s7 永久假红。 */
        if (role === 'lead') {
          if (!status.deny_still_visible.includes(wanted)) status.deny_still_visible.push(wanted)
        } else {
          if (!status.worker_still_visible.includes(wanted)) status.worker_still_visible.push(wanted)
        }
        stillVisible.push(wanted)
      }
    }
    if (role === 'lead') {
      for (const wanted of absent) {
        if (!status.lead_absent.includes(wanted)) status.lead_absent.push(wanted)
      }
    }
    status.deny_verified_agents += 1
    status.deny_verified_at = new Date().toISOString()
    status.last_verify = { agent: id, role, absent, still_visible: stillVisible }
    noteStatus()
  }

  /** 白名单后核过的 agent（按 agent 计一次，不按拍摄次数计 —— 别把"核了两拍"读成"核了两个"）。 */
  const coreVerifiedAgents = new Set()

  /**
   * 白名单装完之后的**反证**：核心名字还在不在。
   *
   * 为什么必须有：`restrict({allow})` 的失败模式是**静默**的。allow 名单错一个前缀，
   * 或者枚举到的是那份盲表（24 个），restrict 都会照收不误、`restrict_error` 照旧为 null，
   * 而主帅从此连 `read` 都没有了 —— 日志一片绿，人却不会动了。这是本项目第四次踩的
   * 「代码对、单测绿、运行时静默无效」里最坏的一种：它不是无效，是**反效果**。
   *
   * 判据（机械可校验）：装完之后 `tools.get(name, agent)` 对 `KEEP_CORE` 里每个名字都
   * 必须有值。缺失 ⇒ 撤销白名单、退回黑名单、记 `allow_amputated` 与 `allow_rollback_at`。
   * 这就是任务书"不提升就回滚"的机器实现 —— 不靠自觉，靠代码。
   *
   * ⚠ 诚实边界（不许把"看不见"读成"砍残了"）：`get` 在本文件 v1.17 记录里有过**整体失明**
   *   （不带 scope 时 5/5 全红）。所以先探一只"应该已经被拿走"的手当对照：若对照与核心
   *   **全都没值**，那更像 scope 解析失败而不是砍残 ⇒ 置 `allow_core_blind`、**不回滚**。
   *   拿一次"看不见"去撤销一次可能正确的剥夺，是用一次误判换一次真实失效，方向反了。
   */
  function verifyAllowCore(agent, deny) {
    const fire = () => {
      const id = String(agent?.id ?? '')
      if (id === '') return
      if (amputatedAgents.has(id)) return
      /* 取数口优先用 **agent 自己那条 scope 上的** tools：白名单就是落在它上面的，
         问它才是问对了对象。拿不到才退回插件自己那一侧（不变量 2：失败不抛）。 */
      let tools
      try { tools = agent?.ctx?.tools } catch { tools = undefined }
      if (!tools || typeof tools.get !== 'function') tools = serviceTools()
      if (!tools || typeof tools.get !== 'function') return
      const probe = (name) => {
        try { return tools.get(name, agent) } catch { return undefined }
      }
      /* 对照：名单里第一个"应该被拿走"的名字。它**有值**说明 get 在这个 scope 上能读。 */
      const control = Array.isArray(deny) && deny.length > 0 ? probe(deny[0]) : undefined
      const core = KEEP_CORE.map((n) => ({ name: n, visible: probe(n) }))
      if (control === undefined && core.every((c) => c.visible === undefined)) {
        status.allow_core_blind = true
        noteStatus()
        return
      }
      const missing = core.filter((c) => c.visible === undefined).map((c) => c.name)
      if (missing.length === 0) {
        status.allow_core_blind = false
        if (!coreVerifiedAgents.has(id)) {
          coreVerifiedAgents.add(id)
          status.allow_core_ok += 1
        }
        status.allow_core_verified_at = new Date().toISOString()
        noteStatus()
        return
      }

      /* ── 真的砍残了：立刻回滚，退回"按名字拿手"那个熟悉的天花板 ────────── */
      amputatedAgents.add(id)
      status.allow_amputated = missing
      const previous = fibers.get(id)
      fibers.delete(id)
      try { previous?.dispose?.() } catch { /* 撤销失败也要继续走黑名单 */ }
      verifiedAgents.delete(id) // 剥夺层变了，上一轮自证作废
      let toolsNow
      try { toolsNow = agent?.ctx?.tools } catch { toolsNow = undefined }
      if (toolsNow !== undefined) {
        const back = restrictWith(toolsNow, deny)
        if (back.applied) {
          status.install_path = 'sync-allow-rolled-back'
          status.allow_rollback_at = new Date().toISOString()
          status.restricted += 1
          const dispose = back.dispose
          fibers.set(id, { dispose: () => { try { if (typeof dispose === 'function') dispose() } catch { /* 清理失败不该影响任何人 */ } } })
          armVerify(agent, deny, 'lead')
        } else if (status.last_error === null) {
          status.last_error = back.error ?? 'rollback did not apply'
        }
      }
      noteStatus()
    }
    Promise.resolve().then(fire).catch(() => {})
    try {
      setTimeout(fire, 150)
    } catch {
      fire()
    }
  }

  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        if (!enabled) return undefined
        try {
          const toolName = String(exec?.name ?? '')
          const agent = exec?.agent
          const role = classify(agent)
          if (role === 'unknown') {
            status.unknown_role_allowed += 1
            return undefined // 不变量 1
          }
          /* ── ★ 预设闸门（与 install() 同源同判，2026-11-13）───────────────────
           *
           * 这一条**必须**同时守在"拒与不拒"之间，而不只是装配时生效：那一次事故里，
           * 无关会话不仅被装上了剥夺，它的每一次工具调用也被这里拒掉了（restrict 让
           * 它看不见，guard 让看见了也执行不了 —— 两层都在拒绝一个不属于本体系的会话）。
           * 判不出预设（null）同样放行：「读不到」不是「这是我的会话」（同 install()）。
           *
           * 位置在 classify **之后**、拒与不拒**之前**：角色判定是纯的（不记账），
           * 所以放在这里不会让无关会话污染 leads/children；而不变量 1 的
           * 「判不出角色 ⇒ 放行」仍然排在最前面，一字未改。 */
          const preset = presetOf(agent)
          if (preset === null || !presets.includes(preset)) return undefined
          const deny = role === 'child' ? workerDeny : leadDeny
          const mustDeny = deny.includes(toolName)
          if (mustDeny) {
            // 自愈：守卫第一次看到这个 agent 就补上剥夺。
            // 之所以会走到这里，正是说明 ① 还没生效（created 时刻 origin 不可读、
            // 或工具是作用域内注册的）——那就用这一次拒绝换制度，而不是永远靠守卫。
            install(agent)
            /* 走到"要拒绝"这一步本身就说明它还在某处可见 ⇒ 值得**重新核一次**
               （正常情况下每个 agent 只核一次；这里破例，因为情况变了）。 */
            verifiedAgents.delete(String(agent?.id ?? ''))
          }
          /* 先装、后核；被允许的调用也核 —— 那才是「在真实的一轮工作里顺手取证」。
             被拒的调用里同样核：这一次拒绝本身就说明它还在某处可见，值得记下来。 */
          verifyDenialOnce(agent, deny, role)
          if (!mustDeny) return undefined

          status.denied += 1
          status.last_denial = { at: new Date().toISOString(), tool: toolName, role }
          noteStatus()
          return denialText(toolName, role)
        } catch (error) {
          // 闸门自身出错时放行：一个坏掉的闸门把整支队伍堵住，比漏掉一次拦截更糟。
          status.last_error = error?.message ? String(error.message) : String(error)
          return undefined
        }
      }),
    'tools.guard(war:no-hands)',
  )

  /* ── 装配 ──────────────────────────────────────────────────────────────── */

  /** `agents` 是可选依赖：拿不到就只走事件与守卫自愈（见 inject 处的说明）。 */
  function agentsService() {
    try {
      const viaGet = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      if (viaGet !== undefined && viaGet !== null) return viaGet
    } catch { /* 解析不到不是错误，按可选处理 */ }
    return ctx.agents
  }

  const agents = agentsService()
  if (agents && typeof agents.list === 'function') {
    try {
      for (const agent of agents.list()) install(agent)
    } catch (error) {
      status.last_error = error?.message ? String(error.message) : String(error)
    }
  } else {
    status.agents_service = 'unavailable (只靠 agent/created 与守卫自愈)'
  }

  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => forget(agent))

  noteStatus()

  // 供测试与诊断读取：本插件不提供 service，只导出运行态快照的只读访问器。
  ctx.effect(() => () => {
    roleCache.clear()
    countedRoles.clear()
    fibers.clear()
  }, 'war-no-hands:cleanup')

  /**
   * 同步点：把当前快照落盘并**等它真的落完**。
   *
   * 为什么必须有这个口子：观测文件的写是异步合并的，测试若靠 `sleep(N)` 去猜
   * 写者写完没有，就会在慢盘上读到上一版快照 —— 而读到的旧值看起来完全合理
   * （leads=1 而不是 2），于是同一个套件会 15 次里红 1 次。那种"偶尔红"的
   * 测试最终会被当成噪音忽略，等于没有测试。
   *
   * 生产路径不调用它：运行时不关心某一份快照什么时候落盘，只看最终一致。
   */
  return {
    flushStatus: async () => {
      for (let i = 0; i < 8; i += 1) {
        await inFlight
        if (!dirty) return statusPath
        kick()
      }
      return statusPath
    },
  }
}

export default { name, inject, apply }
