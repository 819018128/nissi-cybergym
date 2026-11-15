/**
 * hive-roe-gate — 交战规则闸门
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么是独立插件，而不是改 hive-board
 * ─────────────────────────────────────────────────────────────────────────
 * dsh 的 `tools.guard` 是【单调叠加】的（dsh-tools/lib/index.js）：
 *
 *     guards = new AnonymousEntries()
 *     guardReason(exec) { for (const guard of this.guards.values()) { ... } }
 *
 * 文档原文：「Any matching guard may deny by returning a reason, while no guard
 * can force-allow a call another guard has blocked.」
 *
 * 也就是说：新增一个 guard 可以【加限制】，永远无法【解除】board 已设的限制。
 * 于是合规闸门不需要碰到 board 的任何一行代码 —— 这是刻意的架构选择：
 *
 *   · 爆炸半径小：本插件坏掉，蜂群照常运行，只是失去合规闸门
 *   · dsh 升级可修复：耦合面只有下面 DEPENDS_ON 列出的那几项，改哪修哪
 *   · 与 board 无状态耦合：只【读】approvals 目录，从不写
 *
 * DEPENDS_ON（本插件对 dsh 的全部依赖，仅此四项）
 * ─────────────────────────────────────────────────────────────────────────
 *   1. `ctx.tools.guard(fn)`            —— 注册同步闸门，返回 disposer
 *   2. `ctx.systemPrompt.context({...})` —— 注册抗压缩上下文
 *   3. `inject = ['tools','systemPrompt']` —— 服务名
 *   4. `exec` 形状：{ name, arguments, agent: { id } }
 *
 * dsh 升级若破坏兼容，只会是这四项之一。自检函数 `selfCheck()` 会明确报出
 * 哪一项失配、失配后降级成什么行为 —— 这就是「可修复」的全部含义。
 *
 * 分级依据：可逆性，不是合规度
 * ─────────────────────────────────────────────────────────────────────────
 *   红 = 不可逆且后果为清零/终止资格 → 无人可授权，直接拒绝
 *   黄 = 不可逆但影响可控         → 须有对应的已批准记录才放行
 *   其余                          → 放行，不管
 *
 * 刻意保持窄：board 源码里那句话是对的 ——「a gate that fires constantly stops
 * being read」。本插件只拦【竞演规则明确点名】的东西，不拦通用渗透动作。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

export const name = 'hive-roe-gate'
export const inject = ['tools', 'systemPrompt']

/**
 * 匹配引擎与规则表对外导出，只为让测试跑【真实代码】而不是抄一份。
 * 抄一份的测试会随实现漂移，最终测的是副本而不是运行时行为。
 * 这些导出不注册任何服务，不影响组合规则。
 */
export { CORE_RED, CORE_AMBER, CORE_REMIND, APPROVAL_CLASSES, hits, matchRule, segments, stripPrefix }

/**
 * `CORE_REMIND` / `APPROVAL_CLASSES` 也导出，是为了让 **纪律同源检查**
 * （`test/conformance.test.mjs`）能对真实规则表断言，而不是抄一份副本。
 * 抄副本的一致性测试测的是副本，最终保护不了任何东西。
 */

/** 闸门只看这两种工具的文本参数。与 board 的 GATED_TOOLS 保持一致。 */
const GATED_TOOLS = new Set(['bash', 'pwsh'])

/** 与 hive-board 的 APPROVAL_CLASSES 对齐，不另立枚举。 */
const APPROVAL_CLASSES = new Set([
  'destructive-shell', 'credential-spray', 'reverse-shell', 'code-audit', 'data-read', 'other',
])

/* ═══════════════════════════════════════════════════════════════════════════
   Nissi 增补 A：无害探针白名单
   ═══════════════════════════════════════════════════════════════════════════

   为什么要有它：原来的「无害化验证能过」是**被动**的 —— 因为没命中任何规则所以顺带放过。
   一旦规则收紧，`id` 这种最标准的 PoC 就可能被拦。被动的通行不是保证，是运气。

   为什么必须显式枚举、不能语义判断：**「无害」不可机械校验**。
   让模型每次自证「我这个动作无害」等于把边界交给概率 —— 那是你们宪章里记过的失败形态
   （纪律写成提示词）。所以反向做：允许的探针写死成模式表，命中即放行并记数，
   不命中就回到正常判定。宁可漏放几个合法探针（人补一条规则），也不放过一个没被枚举的动作。

   ⚠ 边界（诚实）：白名单只解析命令位置，不解析多级解释器嵌套（bash -c / powershell -enc）。
   这和本插件原有的自述一致：闸门是提高代价的一道门，不是密封墙。
*/
const HARMLESS_PROBE_SPECS = [
  { id: 'probe-identity', pattern: 'id|whoami|hostname|uname', why: '身份回显：只读，不改目标状态' },
  { id: 'probe-nonce', pattern: 'echo', why: '随机串回显：证明命令执行，无副作用' },
  { id: 'probe-timing', pattern: 'sleep|ping', why: '时间盲探针：需限速，但本身无副作用' },
  { id: 'probe-dns', pattern: 'nslookup|dig|host', why: 'DNS 回连探针：证明可外带，仅在自身回收端' },
]

/**
 * 惰性构造探针正则。
 * 不能用模块级的 `const HARMLESS_PROBES = [...anchorI(...)]` —— `anchorI` 是
 * `const` 声明且在本段之后才初始化，顶层引用会抛
 * `Cannot access 'anchorI' before initialization`（实测，整个插件加载失败）。
 */
let harmlessProbeCache = null
function harmlessProbes() {
  if (harmlessProbeCache === null) {
    harmlessProbeCache = HARMLESS_PROBE_SPECS.map((spec) => ({
      id: spec.id,
      why: spec.why,
      re: anchorI(spec.pattern),
    }))
  }
  return harmlessProbeCache
}

/* ═══════════════════════════════════════════════════════════════════════════
   Nissi 增补 B：战役级统一授权
   ═══════════════════════════════════════════════════════════════════════════

   人的策略（2026-11-13 定）：
     · **无害化验证默认自动** —— 靠上面的白名单 + 黄级之外的放行；
     · **实战打进去要统一审批** —— 一场战役批一次，不是每个动作批一次；
     · **数据读取（data-read）不预授权** —— 遇到要提交战果时单独批，不写进战役卡。

   所以战役卡只覆盖"进去"这一类动作，`data-read` 被显式排除在可预授权集合之外。

   卡片落在 `<boardRoot>/approvals/` 里，形状：
     { kind: 'engagement', campaign, scope: [...], allow_classes: [...], expires_at, status: 'approved' }

   ⚠ 安全边界（必须说清）：卡片是文件，工人手里有 pwsh，理论上能自己写一张。
   本插件能提供的**不是**密码学保证，而是：卡片内容进审计、面板上"已批准实战"永远显眼、
   子会话（origin=subagent）不能调 board_approval_decide。要做结构性保证只能把授权态搬进
   宿主平面内存 + UI 按钮，那是另一个量级的改动。
*/
const ENGAGEMENT_KIND = 'engagement'
/** 可被战役卡预授权的动作类 —— 数据读取刻意不在其中。 */
const PREAUTHORIZABLE_CLASSES = new Set(['reverse-shell', 'destructive-shell', 'credential-spray', 'code-audit'])

/** 从命令文本里抠出 IPv4 字面量（用于战役卡的 scope 判定）。 */
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g
function hostsIn(command) {
  try {
    return [...new Set(String(command).match(IPV4_RE) ?? [])]
  } catch {
    return []
  }
}

/** 一条 IPv4 是否落在战役卡 scope 里（支持单 IP 与 /n CIDR）。 */
function ipInScope(ip, scope) {
  const toInt = (s) => s.split('.').reduce((acc, x) => (acc << 8) + Number(x), 0) >>> 0
  for (const entry of scope) {
    const text = String(entry).trim()
    if (text === ip) return true
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(text)
    if (m === null) continue
    const bits = Number(m[2])
    if (bits === 0 || bits > 32) continue
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    if ((toInt(ip) & mask) === (toInt(m[1]) & mask)) return true
  }
  return false
}


/* ───────────────────────── 命令位置判定 ─────────────────────────
   为什么不能直接对整条命令做子串匹配
   ────────────────────────────────────────────────────────────────
   最初版本用 `\b(passwd|...)\b` 直接匹配整条命令，实测 12/65 误报，
   而且拦住的是 `cat /etc/passwd` 这种最常见的只读动作。误报比漏报危险：
   一个总在响的闸门，操作员会学会绕过它，那时它拦不住任何东西。

   正确判据不是「这个字符串出现过」，而是「这个工具是否以命令身份被调用」。
   于是先按 shell 分隔符切段，每段只看命令位置。

   引号必须参与判定：`echo "a; hydra -l x"` 不能在 `;` 处切开。
   所以这里做一次引号感知的扫描 —— 不追求完整的 shell 解析，只保证
   「引号内的分隔符不算分隔符」这一条，它覆盖了现实里会遇到的写法。

   已知边界（此处诚实声明，不假装完备）：base64 编码、变量拼接、
   多级解释器嵌套可以绕过本闸门。闸门是提高代价的一道门，不是密封墙。
   ───────────────────────────────────────────────────────────────── */

/** 按未加引号的分隔符切段。返回 { seg, isQuotedCommand } 数组。 */
function segments(command) {
  const s = String(command)
  const out = []
  let buf = ''
  let quote = null // "'" | '"' | null
  let escaped = false

  const push = () => { out.push(buf); buf = '' }

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (escaped) { buf += c; escaped = false; continue }
    if (c === '\\') { buf += c; escaped = true; continue }
    if (quote !== null) {
      buf += c
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') { quote = c; buf += c; continue }
    // 未加引号的分隔符
    if (c === '\n' || c === ';') { push(); continue }
    if (c === '&' && s[i + 1] === '&') { push(); i++; continue }
    if (c === '|' && s[i + 1] === '|') { push(); i++; continue }
    if (c === '|') { push(); continue }
    buf += c
  }
  push()
  return out.filter((x) => x.trim() !== '')
}

/** 剥掉可能出现在命令前的修饰：前导空白 / sudo / env FOO=bar / time / command / 重定向。
 *  前导空白是必须剥的：被 `&&` `;` `|` 切开的第二段形如 `" hydra ..."`，
 *  不 trim 则所有 `^` 锚定的规则都会漏掉链式命令 —— 那等于闸门可被 `&&` 绕过。 */
function stripPrefix(seg) {
  let rest = String(seg).replace(/^\s+/, '')
  rest = rest.replace(
    /^(?:sudo\s+(?:-u\s+\S+\s+)?|env\s+(?:\S+=\S*\s+)*|time\s+|command\s+|nice\s+|doas\s+)+/,
    '',
  )
  rest = rest.replace(/^\s*/, '').replace(/^\d*>&?\d*\s*/, '') // 重定向
  return rest
}

/** 解释器前缀；`bash -c "..."` 这种要额外把引号里的内容当命令看。 */
const INTERP = /^(?:\/[^\s]*\/)?(?:bash|sh|zsh|dash|ksh|python3?|perl|ruby|node|php)\s+/
const INTERP_C = /^(?:\/[^\s]*\/)?(?:bash|sh|zsh|dash|ksh|python3?|perl|ruby|node|php)\s+(?:-[a-zA-Z]*c\b|-e\b)/

/** 取第一段引号内容（`bash -c "..."` 的内层命令）。 */
function quotedPayload(seg) {
  const m = seg.match(/["']([^"']{1,2000})["']/)
  return m ? m[1] : ''
}

/**
 * 该模式是否命中。`anchored` 的模式只在命令位置匹配；
 * `anywhere` 的模式（如 --flood 这种不可能出现在别处的开关）全文匹配。
 */
function hits(pattern, command) {
  if (pattern.anywhere) return pattern.re.test(command)
  for (const raw of segments(command)) {
    const seg = stripPrefix(raw)
    if (pattern.re.test(seg)) return true
    // `bash -c "hydra ..."` / `python3 -c "..."`：把引号内的内容也当命令看一次
    if (INTERP_C.test(seg)) {
      const inner = quotedPayload(seg)
      if (inner !== '') {
        for (const innerSeg of segments(inner)) {
          if (pattern.re.test(stripPrefix(innerSeg))) return true
        }
      }
    }
  }
  return false
}

/**
 * 一条规则是否命中。`re` 走命令位置判定，`re2` 是同一规则的第二形态
 * （多为 PowerShell cmdlet，它天然就在命令位置，直接全文匹配即可）。
 */
function matchRule(rule, command) {
  if (rule.re && hits(rule, command)) return true
  if (rule.re2 && rule.re2.test(command)) return true
  return false
}

/** 命令位置锚点：段首，或段首的绝对路径。刻意不用 `.*\/`——那会让
 *  `cat /etc/passwd` 的 `passwd` 也被当成命令，正是最初的误报来源。 */
const CMD = /^(?:\/[^\s]*\/)?/
/** 段首锚点 + 允许一层解释器前缀（`python3 mhddos.py`）。 */
const CMDI = /^(?:\/[^\s]*\/)?(?:(?:bash|sh|zsh|dash|python3?|perl|ruby|node|php)\s+(?:\/[^\s]*\/)?)?/

const anchor = (alts) => new RegExp(CMD.source + '(?:' + alts + ')\\b', 'i')
const anchorI = (alts) => new RegExp(CMDI.source + '(?:' + alts + ')\\b', 'i')

/* ═══════════════════════════════════════════════════════════════════════════
   红线：写死在代码里，不依赖任何文件加载
   ─────────────────────────────────────────────────────────────────────────
   这四条来自《攻击规则》，后果是【终止参赛资格】或【核减 100% 成果】，
   不是扣分。所以它们不读配置、不可降级、无人可授权。
   ═══════════════════════════════════════════════════════════════════════════ */

const CORE_RED = [
  {
    id: 'G3-flood-tools',
    label: 'DDoS / 流量压测工具',
    rule: 'G3',
    re: anchorI('hping3?|slowloris\\w*|goldeneye|mhddos\\w*|ddosify|vegeta|xerxes|hulk|loic|hoic|t50'),
    why: 'G3：对目标发起 DDoS/流量型压测 → 扣除最低 4000 分、上不封顶 + 全行业通报',
  },
  {
    id: 'G3-flood-flags',
    label: 'flood / 伪造源地址开关',
    rule: 'G3',
    re: /--flood\b|--rand-source\b/,
    anywhere: true, // 这两个开关不会出现在别处，全文匹配不会误伤
    why: 'G3：flood 模式即流量型压测',
  },
  {
    id: 'G3-loadtest-tools',
    label: '压测工具',
    rule: 'G3',
    re: anchorI('siege|locust|jmeter|wrk|ab'),
    why: 'G3：对防守方系统施加负载会妨碍正常业务，属禁止项',
  },
  {
    id: 'G3-nmap-dos-script',
    label: 'nmap DoS 脚本',
    rule: 'G3',
    // `http-slowloris` 是攻击脚本，`http-slowloris-check` 是只读检测脚本 —— 放行后者
    re: /--script[= ]\S*http-slowloris\b(?!-check)/,
    anywhere: true,
    why: 'G3：nmap 的 http-slowloris 脚本会对目标发起慢速连接耗尽攻击',
  },
]

/* ═══════════════════════════════════════════════════════════════════════════
   黄级：不可逆但影响可控 —— 有对应的已批准记录即放行
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── 提醒线（2026-10-23 按指挥官裁定从红线降级）──────────────────────
 *
 * 指挥官的底线只有一条：**不做破坏业务的行为**。
 * 近源/无线/二层攻击**不破坏业务** —— 它违反的是**比赛规则 G2**（「任何形式的近源攻击一律禁止」），
 * 后果是**取消资格**。既然指挥官是结果负责人、且明说「不要抬杠」，
 * 这里从"直接拒绝"降为"**放行 + 记一条 + 下次看提示时告诉他**"。
 *
 * ⚠ 只提醒一次，之后照办。
 */
const CORE_REMIND = [
  {
    id: 'G2-near-source',
    label: '近源 / 无线 / 二层攻击工具',
    rule: 'G2',
    re: anchor('aircrack-ng|aireplay-ng|mdk3|mdk4|yersinia|macof|arpspoof|dnsspoof|ettercap|responder'),
    why: 'G2：比赛规则明令禁止任何形式的近源攻击（物理/无线/二层）⇒ 做了是**取消资格**，不是业务受损。按指挥官的底线（不破坏业务）本条**不拦**，仅提醒。',
  },
]

const CORE_AMBER = [
  {
    id: 'R4-phishing',
    label: '钓鱼 / 社工发信工具',
    actionClass: 'other',
    re: anchorI('swaks|gophish|evilginx|setoolkit|msmtp|sendmail|mailx'),
    // Send-MailMessage 是 cmdlet，出现在命令位置即可
    re2: /^(?:Send-Mail\w*|New-Object\s+Net\.Mail)/i,
    why: 'R4：社会工程学攻击（含钓鱼邮件、水坑、社交沟通）须在平台报备后方可进行',
  },
  {
    id: 'R1-account-change',
    label: '修改账号 / 口令',
    actionClass: 'other',
    // 只看命令位置：`cat /etc/passwd` 是只读，不能拦
    re: anchorI('passwd|chpasswd|usermod|useradd|groupadd|userdel|groupdel|vipw'),
    re2: /^(?:net\s+(?:user|localgroup)\s|Set-LocalUser|New-LocalUser|Set-ADAccountPassword)/i,
    why: 'R1：修改防守方应用系统或操作系统账号密码须报备',
  },
  {
    id: 'R2-persistence',
    label: '持久化 / 计划任务 / 配置变更',
    actionClass: 'other',
    // 必须锚定命令位置：否则 `grep -r crontab /etc/` 也会命中。
    // `crontab -l`（只读列举）放行；该段里出现 -l 即视为只读。
    re: new RegExp(CMD.source + 'crontab\\s+(?![^\\n]*-l\\b)', 'i'),
    re2: /^(?:systemctl\s+enable|at\s+now|schtasks\s+\/create|New-ScheduledTask|reg\s+add\b[^\n]*\\Run)/i,
    why: 'R2：修改防守方应用系统相关内容或配置（含留后门建计划任务）须报备',
  },
  {
    id: 'R3-lateral-tunnel',
    label: '内网横向 / 隧道工具',
    actionClass: 'reverse-shell',
    // 尾部不用 \b：工具名常带版本后缀（proxychains4 的 \bproxychains\b 不成立）
    re: anchorI('chisel|ligolo|frpc?|proxychains\\w*|ncat|socat'),
    re2: /^ssh\s+-[DLR]\s/i,
    why: 'R3：在防守方内网开展内网渗透或横向攻击须报备',
  },
  {
    id: 'credential-spray',
    label: '口令爆破 / 喷洒',
    actionClass: 'credential-spray',
    re: anchorI('hydra|medusa|ncrack|patator|kerbrute|sprayhound'),
    re2: /^(?:nxc|cme|crackmapexec)\s+[^\n]*\s-(p|P|u|U)\s/i,
    why: '口令字典爆破在 ROE 中列为不可逆动作（可能锁号），须报备后执行',
  },
]

/* ───────────────────────── 工具形状适配（契约点 4）───────────────────────── */

/** 与 hive-board 逐字一致，保证两个闸门看到同一个输入。 */
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

/** 与 hive-board 的 approvalKey 逐字一致：`${actionClass}::${target}` */
function approvalKey(actionClass, target) {
  return `${String(actionClass)}::${String(target)}`
}

function compileSafe(re, id, issues) {
  if (re instanceof RegExp) return re
  if (typeof re === 'string') {
    try {
      return new RegExp(re, 'i')
    } catch (e) {
      issues.push(`模式 ${id} 不是合法正则，已跳过`)
      return null
    }
  }
  issues.push(`模式 ${id} 既不是 RegExp 也不是字符串，已跳过`)
  return null
}

/* ═════════════════════════════════ 插件 ═════════════════════════════════ */

export function apply(ctx, config) {
  // 绝不抛异常：一行插件挂载失败会连累整个 preset。
  try {
    boot(ctx, config)
  } catch (e) {
    // 最后的兜底。到这里说明契约已经变了 —— 把话说明白，不要静默。
    try {
      console.error(
        '[hive-roe-gate] 挂载失败，本插件已停用，蜂群不受影响。' +
        '这通常是 dsh 升级改变了 DEPENDS_ON 中的某一项。\n' +
        '文件: plugins/roe-gate/lib/index.js\n' +
        '错误: ' + (e && e.stack ? e.stack : String(e)),
      )
    } catch { /* 连 console 都没有就只能放弃 */ }
  }
}

function boot(ctx, config) {
  const configuredRoot =
    typeof config?.doctrineRoot === 'string' && config.doctrineRoot
      ? config.doctrineRoot
      : typeof config?.root === 'string' && config.root
        ? config.root
        : '<HOME>/.dsh/doctrine'

  const configuredBoardRoot =
    typeof config?.boardRoot === 'string' && config.boardRoot
      ? config.boardRoot
      : '<HOME>/.hive'

  /* ── 判定台账（Nissi 增补）─────────────────────────────────────────────── *
   * 为什么必须落盘：闸门原来只把判定记进内存计数器（state.blocks / probes /
   * engagementHits），进程一退就没了。于是事后只能回答「规则在代码里」，
   * 回答不了「这场战役它到底拦下过什么、放行过什么」。后者才是可评估的部分。
   *
   * 台账刻意只记**受管工具**（GATED_TOOLS）且命令非空的调用 ——
   * 否则 read/grep 会把这张表淹掉，噪声一多就没人看了。
   *
   * 分类不靠猜文案：判定前后各取一次计数器快照，用差值区分
   *   deny（blocks 增）/ probe-pass / engagement-pass / reminder-pass / allow
   * 这样即使以后改提示文案，台账也不受影响。
   * ─────────────────────────────────────────────────────────────────────── */
  const decisionDir = path.join(configuredBoardRoot, '_decisions')
  const decisionFile = path.join(decisionDir, 'roe.jsonl')
  let decisionLogBroken = false

  function noteDecision(exec, decision, before, after) {
    if (decisionLogBroken) return
    const tool = String(exec?.name ?? '')
    if (!GATED_TOOLS.has(tool)) return
    let command = ''
    try {
      command = commandTextOf(exec?.arguments)
    } catch {
      command = ''
    }
    if (command === '') return

    let kind = 'allow'
    let rule = ''
    if (decision !== undefined) {
      kind = 'deny'
      const head = String(decision)
      // 文案只是辅助；分类的权威依据仍是计数器差值
      rule = /红线/.test(head) ? 'red' : /交战授权/.test(head) ? 'engagement' : /须报备|拦截/.test(head) ? 'amber' : 'gated'
    } else if (after.probes > before.probes) {
      kind = 'probe-pass'
    } else if (after.engagements > before.engagements) {
      kind = 'engagement-pass'
    } else if (after.reminders > before.reminders) {
      kind = 'reminder-pass'
    }

    let hosts = []
    try {
      hosts = hostsIn(command)
    } catch {
      hosts = []
    }

    const entry = {
      at: new Date().toISOString(),
      gate: 'roe',
      kind,
      rule,
      tool,
      command: command.slice(0, 240),
      hosts,
      reason: decision === undefined ? '' : String(decision).split('\n')[0].slice(0, 200),
    }
    void fs
      .mkdir(decisionDir, { recursive: true })
      .then(() => fs.appendFile(decisionFile, JSON.stringify(entry) + '\n', 'utf8'))
      .catch(() => {
        decisionLogBroken = true
      })
  }

  /* ── 运行态 ─────────────────────────────────────────────────────────── */
  const state = {
    hydrated: false,
    configLoaded: false,
    settings: null,
    red: [...CORE_RED],
    amber: [...CORE_AMBER],
    /* 提醒线：放行但记一条（近源/无线/二层按指挥官裁定降级而来） */
    remind: [...CORE_REMIND],
    reminderHits: [],
    /** `${actionClass}::${toolName}` → 'approved' | 'pending' | 'denied' */
    approvals: new Map(),
    /** Nissi 增补：战役级授权卡（kind=engagement），按 campaign 索引。 */
    engagements: new Map(),
    /** Nissi 增补：命中无害探针白名单的次数（观测用，不打扰模型）。 */
    probes: 0,
    issues: [],
    blocks: 0,
    stopped: false,
    lastError: null,
  }

  /* ── 契约自检（这就是「可修复」的全部含义）────────────────────────── */

  function selfCheck() {
    const missing = []
    const tools = ctx.get ? ctx.get('tools') : ctx.tools
    const sp = ctx.get ? ctx.get('systemPrompt') : ctx.systemPrompt
    if (tools === undefined || tools === null) missing.push('ctx.tools')
    else if (typeof tools.guard !== 'function') missing.push('ctx.tools.guard')
    if (sp === undefined || sp === null) missing.push('ctx.systemPrompt')
    else if (typeof sp.context !== 'function') missing.push('ctx.systemPrompt.context')
    return missing
  }

  const missing = selfCheck()
  if (missing.length > 0) {
    state.issues.push(
      `dsh 契约失配：缺 ${missing.join(', ')}。` +
      '闸门与规则注入均未生效（蜂群不受影响）。修复方式：对照 DEPENDS_ON 四项检查 dsh 版本。',
    )
    console.error('[hive-roe-gate] ' + state.issues[state.issues.length - 1])
    return
  }

  /* ── 配置加载（失败则保留写死的红线）─────────────────────────────── */

  async function loadConfig() {
    try {
      const p = path.join(configuredRoot, 'gate.json')
      const raw = await fs.readFile(p, 'utf8')
      const cfg = JSON.parse(raw)
      const issues = []

      // 契约：非对象一律视为无效，退回核心规则
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error('gate.json 顶层不是对象')
      }

      const settings = { ...(cfg.settings || {}) }
      state.settings = settings

      // 追加红线：只能加，不能减
      const extraRed = Array.isArray(cfg.extraRed) ? cfg.extraRed : []
      for (const r of extraRed) {
        if (!r || typeof r !== 'object') { issues.push('extraRed 条目不是对象，已跳过'); continue }
        const re = compileSafe(r.re, String(r.id || r.label || 'extraRed'), issues)
        if (!re) continue
        state.red.push({
          id: String(r.id || r.label || 'extra-red'),
          label: String(r.label || r.id || '追加红线'),
          rule: String(r.rule || 'custom'),
          re,
          why: String(r.note || ''),
        })
      }

      // 追加黄级
      const extraAmber = Array.isArray(cfg.extraAmber) ? cfg.extraAmber : []
      for (const a of extraAmber) {
        if (!a || typeof a !== 'object') { issues.push('extraAmber 条目不是对象，已跳过'); continue }
        const re = compileSafe(a.re, String(a.id || a.label || 'extraAmber'), issues)
        if (!re) continue
        const ac = String(a.actionClass || 'other')
        if (!APPROVAL_CLASSES.has(ac)) {
          issues.push(`extraAmber ${a.id || a.label} 的 actionClass「${ac}」不在 board 枚举内，已按 other 处理`)
        }
        state.amber.push({
          id: String(a.id || a.label || 'extra-amber'),
          label: String(a.label || a.id || '追加黄级'),
          actionClass: APPROVAL_CLASSES.has(ac) ? ac : 'other',
          re,
          why: String(a.note || ''),
        })
      }

      // 降级：只能降黄级，红线不可降
      const downgrade = (cfg.downgrade && Array.isArray(cfg.downgrade.amberIds)) ? cfg.downgrade.amberIds : []
      if (downgrade.length > 0) {
        const drop = new Set(downgrade.map(String))
        const before = state.amber.length
        state.amber = state.amber.filter((a) => !drop.has(a.id))
        const removed = before - state.amber.length
        if (removed > 0) issues.push(`按配置降级了 ${removed} 条黄级规则为绿级（红线不受影响）`)
        for (const id of drop) {
          if (CORE_RED.some((r) => r.id === id)) {
            issues.push(`拒绝降级红线「${id}」—— 红线不可降，这是刻意的`)
          }
        }
      }

      state.configLoaded = true
      state.issues.push(...issues)
    } catch (e) {
      // 关键：读不到配置不是失败，是降级。写死的红线照样生效。
      state.configLoaded = false
      state.issues.push(
        `gate.json 未加载（${e && e.code ? e.code : (e && e.message ? e.message : String(e))}），` +
        `已降级为「仅核心红线」模式：${state.red.length} 条红线仍生效，可配置层不可用。`,
      )
    }
  }

  /* ── 审批镜像 ───────────────────────────────────────────────────────────
     guard 是同步的，读不了磁盘。镜像在挂载时水合一次，之后按
     settings.mirrorRefreshMs 定时刷新。与 board 的 mirror 同一思路。
     ─────────────────────────────────────────────────────────────────────── */

  async function refreshApprovals() {
    try {
      const dir = path.join(configuredBoardRoot, 'approvals')
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (e) {
        // 目录不存在是正常状态（还没人报备过），不是错误
        state.approvals.clear()
        return
      }
      const next = new Map()
      const nextEngagements = new Map()
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith('.json')) continue
        try {
          const card = JSON.parse(await fs.readFile(path.join(dir, ent.name), 'utf8'))
          /* Nissi 增补：战役级授权卡单独收一张表。
           * 只认 status=approved 且未过期的；过期/待决的一律不进 —— fail-closed。 */
          if (String(card?.kind ?? '') === ENGAGEMENT_KIND) {
            if (String(card?.status ?? '') !== 'approved') continue
            const expires = Date.parse(String(card?.expires_at ?? ''))
            if (!Number.isFinite(expires) || expires <= Date.now()) continue
            const classes = Array.isArray(card?.allow_classes) ? card.allow_classes.map(String) : []
            const scope = Array.isArray(card?.scope) ? card.scope.map(String) : []
            nextEngagements.set(String(card?.campaign ?? card?.id ?? ent.name), {
              classes: new Set(classes.filter((c) => PREAUTHORIZABLE_CLASSES.has(c))),
              scope,
              expiresAt: expires,
            })
            continue
          }
          const cls = String(card?.action_class ?? '')
          const tgt = String(card?.target ?? '')
          const status = String(card?.status ?? '')
          if (cls === '' || tgt === '') continue
          next.set(approvalKey(cls, tgt), status)
        } catch { /* 单张卡坏掉不影响其余 */ }
      }
      state.approvals = next
      state.engagements = nextEngagements
      state.hydrated = true
    } catch (e) {
      state.lastError = e && e.message ? e.message : String(e)
      // 镜像刷新失败 → 保持上一次镜像，不清空。清空会把已批准的记录误判为未批准。
    }
  }

  /* ── 注册：闸门 ──────────────────────────────────────────────────────── */

  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        // 判定 → 记账 → 返回。判定主体原样保留在 evaluate() 里，一个字不改；
        // 这一层只做两件事：把判定结果落盘、把计数器差值翻译成人能读的分类。
        const before = {
          blocks: state.blocks,
          probes: state.probes || 0,
          engagements: state.engagementHits || 0,
          reminders: state.reminderHits.length,
        }
        const decision = evaluate(exec)
        try {
          noteDecision(exec, decision, before, {
            blocks: state.blocks,
            probes: state.probes || 0,
            engagements: state.engagementHits || 0,
            reminders: state.reminderHits.length,
          })
        } catch {
          /* 记账失败绝不影响判定：台账是观测，不是闸门 */
        }
        return decision
      }),
    'tools.guard(hive:roe-gate)',
  )

  /** roe-gate 的判定主体（原样搬入，逻辑未改）。 */
  function evaluate(exec) {
        try {
          if (state.stopped) return undefined
          const toolName = String(exec?.name ?? '')
          if (!GATED_TOOLS.has(toolName)) return undefined
          const command = commandTextOf(exec?.arguments)
          if (command === '') return undefined

          // ① 红线：直接拒绝，无补救路径 —— 无人可授权
          for (const r of state.red) {
            if (!matchRule(r, command)) continue
            state.blocks += 1
            return (
              `HIVE 交战中规则闸门：拒绝「${r.label}」（${r.rule}）。\n` +
              `${r.why}\n` +
              `这一条是红线：不可报备、不可授权、无人可批准。它换来的是整个队伍的\n` +
              `参赛资格与全部成果，不是几分。请改换手段；若你认为此判定有误，\n` +
              `报告给指挥官由人处理，不要试图绕过。`
            )
          }

          // ①.5 提醒线：**放行**，但记一条（下次看提示时会看到）
          for (const r of state.remind || []) {
            if (!matchRule(r, command)) continue
            state.reminderHits.push({ id: r.id, label: r.label, rule: r.rule, why: r.why, at: nowIso() })
            if (state.reminderHits.length > 20) state.reminderHits.shift()
            return undefined // 放行 —— 提醒只提醒，不拦
          }

          // ①.6 无害探针：**主动**放行并记数（不是"没命中规则所以顺带放过"）
          //      这是「无害化验证默认自动」那一半策略的落点。
          for (const p of harmlessProbes()) {
            if (!matchRule(p, command)) continue
            state.probes = (state.probes || 0) + 1
            return undefined
          }

          // ② 黄级：有对应的已批准记录即放行
          const requireApproval = state.settings?.amberRequiresApproval !== false
          if (!requireApproval) return undefined
          for (const a of state.amber) {
            if (!matchRule(a, command)) continue
            /* Nissi 增补：战役卡优先判定 —— 这是「实战打进去统一审批」的落点。
             * 条件三条全满足才算覆盖：类在可预授权集合内 · 目标全在 scope 内 · 未过期。
             * data-read 永远不走这条路（PREAUTHORIZABLE_CLASSES 里没有它）。 */
            if (PREAUTHORIZABLE_CLASSES.has(a.actionClass) && state.engagements.size > 0) {
              const hosts = hostsIn(command)
              for (const eng of state.engagements.values()) {
                if (!eng.classes.has(a.actionClass)) continue
                if (hosts.length === 0) {
                  // 解析不出目标 IP ⇒ 无法校验范围 ⇒ fail-closed。
                  // 宁可让模型把命令写成显式 IP，也不放过一次无法核范围的利用动作。
                  state.blocks += 1
                  return (
                    `Nissi 交战授权：这一条属于可预授权类（${a.actionClass}），但命令里解析不到目标 IPv4，无法校验范围。\n` +
                    `把目标写成显式 IP（不要只用域名/变量），闸门才能核对它是否在战役授权范围内。`
                  )
                }
                const outside = hosts.filter((h) => !ipInScope(h, eng.scope))
                if (outside.length > 0) {
                  state.blocks += 1
                  return (
                    `Nissi 交战授权：拒绝 —— 目标 ${outside.join(', ')} 不在本战役授权范围内。\n` +
                    `授权范围：${eng.scope.join(', ') || '(空)'}\n` +
                    `越界不是"多批一次"能解决的：需要扩权就先向人申请新的战役卡，不要自己改范围。`
                  )
                }
                state.engagementHits = (state.engagementHits || 0) + 1
                return undefined
              }
            }
            const key = approvalKey(a.actionClass, toolName)
            const status = state.approvals.get(key)
            if (status === 'approved') return undefined
            state.blocks += 1
            const hint =
              status === 'pending'
                ? '已有一条报备记录，但仍是 PENDING（未批准）。'
                : status === 'denied'
                  ? '对应的报备记录已被 DENIED。'
                  : '尚无对应的报备记录。'
            return (
              `HIVE 交战中规则闸门：拦截「${a.label}」（须报备）。\n` +
              `${a.why}\n` +
              `${hint}\n` +
              `补救：先 file 一条记录，等它被批准后原样重发这条命令 ——\n` +
              `  board_approval_request(action_class="${a.actionClass}", target="${toolName}")\n` +
              `  board_approval_decide(<id>, decision="approved", reason="谁批准的、为什么")\n` +
              `不要自己批准自己的申请：决定记录的是人的判断，不是你可以自授的许可。`
            )
          }

          return undefined
        } catch (e) {
          // 闸门自身出错时【放行】而不是全部拦死：
          // 一个坏掉的闸门把整个队伍堵住，比漏掉一次拦截更糟。
          state.lastError = e && e.message ? e.message : String(e)
          return undefined
        }
  }

  /* ── 注册：抗压缩规则注入 ──────────────────────────────────────────── */

  const CONTEXT_ORDER = Number(state.settings?.order) || 119

  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: 'hive:roe-gate',
        order: CONTEXT_ORDER,
        text: () => {
          const hits = (state.reminderHits || []).slice(-5)
          return (
            '交战中规则（2026-10-23 指挥官裁定；与 board 规则同时生效，冲突时以更严格者为准）：\n' +
            '- **唯一底线：不破坏业务。**\n' +
            `- 红线 ${(state.red || []).length} 条，直接拒绝、无人可授权：` +
            (state.red || []).map((r) => r.label).join(' · ') +
            '。它们会让防守方业务受损，后果是【终止参赛资格】或【核减全部成果】。\n' +
            `- 无害化验证默认自动：${harmlessProbes().map((p) => p.id.replace('probe-', '')).join(' / ')} 这类探针直接放行并记数。\n` +
            '- 数据读取（data-read）**不预授权**：要提交战果需要取数据时，单独申请，不写进战役卡。\n' +
            '- **近源/无线/二层(G2)：不拦。** 它不破坏业务，但违反比赛规则 —— 做了的后果是取消资格。' +
            '系统只提醒，不阻止。\n' +
            (state.settings?.amberRequiresApproval !== false
              ? '- **黄级（改账号口令 / 持久化 / 内网横向 / 钓鱼 / 口令爆破）：需已批准记录才能做。**' +
                (state.engagements && state.engagements.size > 0
                  ? `本战役已有 ${state.engagements.size} 张统一授权（覆盖 ${[...new Set([...state.engagements.values()].flatMap((e) => [...e.classes]))].join(' / ')}），范围内目标自动放行、越界立即拒绝。`
                  : '本战役**尚无统一授权** —— 要"打进去"须先向人提交作战计划、请其批准后落成战役卡。') + '\n'
              : '- **黄级：当前配置为直接做（amberRequiresApproval=false）。**\n') +
            '- 放开 ≠ 不记账：写进去的东西要能被自己追到（谁、何时、怎么撤）。这是指挥官要的"穷尽"，' +
            '不是"无声"。\n' +
            '- 闸门只看得到命令文本；AI 来源、物理近源、钓鱼文案内容它看不见 —— 那部分靠你自己守。\n' +
            '- 报告须过三性自检（详尽非以图代字 / 逻辑自洽 / 已明确攻击方式），否则不予评分并退回。' +
            (hits.length
              ? '\n- 最近触发过的提醒：' + hits.map((h) => h.label + '(' + h.at + ')').join(' · ')
              : '')
          )
        },
      }),
    'systemPrompt.context(hive:roe-gate)',
  )

  /* ── 生命周期：水合 + 定时刷新 ─────────────────────────────────────── */

  let timer = null

  ctx.effect(() => {
    // 挂载时异步水合，绝不阻塞、绝不抛出
    void loadConfig().then(() => refreshApprovals()).catch((e) => {
      state.lastError = e && e.message ? e.message : String(e)
    })

    const ms = Math.max(1000, Number(state.settings?.mirrorRefreshMs) || 5000)
    try {
      timer = setInterval(() => { void refreshApprovals() }, ms)
      if (typeof timer?.unref === 'function') timer.unref()
    } catch {
      state.issues.push('定时器不可用：审批镜像只在挂载时水合一次，报备后需重启 host 才生效。')
    }

    return () => {
      try { if (timer !== null) clearInterval(timer) } catch { /* 忽略 */ }
      state.stopped = true
      timer = null
    }
  }, 'hive-roe-gate(lifecycle)')

  /* ── 状态出口：只用 console，绝不发布 service ────────────────────────
     组合规则：本行与 board/egress/vulndb/evidence 一样【不发布 SERVICE】。
     一个 `ctx.provide()` 会把服务落到进程全局 realm，第二个会话挂载同一
     preset 时直接冲突被拒 —— 那会让整个蜂群挂不上。诊断走日志，不走服务。
     ─────────────────────────────────────────────────────────────────────── */

  const status = {
    version: '1.0.0',
    redCount: state.red.length,
    amberCount: state.amber.length,
    coreRedCount: CORE_RED.length,
    coreAmberCount: CORE_AMBER.length,
    configLoaded: state.configLoaded,
    approvalsHydrated: state.hydrated,
    approvalCount: state.approvals.size,
    /**
     * Nissi 增补：战役授权与无害探针的读数。
     * 为什么必须报出来 —— 看不见的东西不报，就等于不存在。
     * 授权生效几张、白名单放行几次，是"自治是否真的在授权范围内跑"的唯一机械证据。
     */
    engagementCount: state.engagements ? state.engagements.size : 0,
    engagementHits: state.engagementHits || 0,
    probePasses: state.probes || 0,
    blocks: state.blocks,
    issues: state.issues,
    lastError: state.lastError,
  }
  Object.defineProperty(ctx, 'roeGateStatus', {
    value: status,
    enumerable: false,
    configurable: true,
  })

  if (state.issues.length > 0) {
    for (const i of state.issues) console.error('[hive-roe-gate] ' + i)
  }
}
