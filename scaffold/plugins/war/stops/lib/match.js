/**
 * 破坏性动作匹配器（无人值守的刹车片）。
 *
 * WHY 需要它：这套东西越自主，越依赖"没人看着也不会出事"。授权边界（rt_config /
 * blue_config 的 fail-closed 闸门）管的是**目标范围**，管不到**动作强度**：
 * `rm -rf /`、`format C:`、`DROP DATABASE`、`shutdown` 即使打在授权目标上也照样毁灭。
 * ARTEX 敢无人跑是因为有 guard / intercept / task_scope 三件套；战争模式到这一行才算补上。
 *
 * ★ 诚实说明它的边界：**黑名单天然失败开放**。没列到的危险动作拦不住，换个写法也可能绕开。
 *   它不是"安全保证"，是"把已知的自毁动作挡在门外，并把每次拦截留痕"。
 *   真正的防呆靠三件事叠加：授权边界（已有，fail-closed）+ 预算上限（待建）+ 动作黑名单（本条）。
 *
 * 设计原则：
 *   - 只拦**不可逆且伤及宿主/数据**的动作，不拦测试本身需要的破坏
 *     （`rm -rf /tmp/x`、`DROP TABLE test_db.tmp` 属于测试；`rm -rf /`、`DROP DATABASE prod` 不是）。
 *   - 规则是数据不是代码里的 if：改名单不用改逻辑，也方便单测逐条钉。
 */

/** 高危命令模式。每条 {id, re, why}；re 对命令文本做不区分大小写匹配。 */
export const COMMAND_RULES = [
  // ★ rm 的危险性无法用单条正则可靠判定（第一版写成 /\brm\s+(?=[^\n]*-[a-z]*r)/，
  //   结果把 `rm -rf /home/user/build` 这种正常清理也拦了）。改用组合判定：见 dangerousRm()。
  {
    id: 'windows-delete-root',
    re: /remove-item\s+(?:-[a-z]+\s+)*["']?(?:[a-z]:\\?|c:\\\\)(?:["']|\s|$|\*)/i,
    why: '递归删除整个盘符',
  },
  {
    id: 'format-disk',
    re: /\bformat\s+[a-z]:|\bmkfs(?:\.\w+)?\s+\/dev\/|\bdiskpart\b|\bdisk\s+erase\b/i,
    why: '格式化/擦除磁盘',
  },
  {
    id: 'dd-to-device',
    re: /\bdd\s+[^\n]*of=\/dev\/(?:sd|nvme|hd|vd|disk)/i,
    why: '直接写块设备',
  },
  {
    id: 'db-wipe',
    re: /\bdrop\s+(?:database|schema)\b(?!\s+\w*(?:test|tmp|scratch|sandbox))|\btruncate\s+table\b/i,
    why: '整库/整表删除',
  },
  {
    id: 'host-shutdown',
    re: /\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b|\brestart-computer\b|\bstop-computer\b/i,
    why: '关停宿主',
  },
  {
    id: 'firewall-flush',
    re: /\biptables\s+-F\b|\bnft\s+flush\s+ruleset\b|\bnetsh\s+advfirewall\s+(?:reset|set\s+\w+\s+state\s+off)/i,
    why: '清空防火墙规则，等于拆掉自己的隔离与取证',
  },
  {
    id: 'hive-wipe',
    re: /(?:rm|del|remove-item)\s+[^\n]*\.war\b|(?:rm|del|remove-item)\s+[^\n]*\.dsh\b/i,
    why: '删战争模式自己的账本/证据/预设',
  },
]

/** 例外：命中就先放行（测试常需要造破坏，不能一律拦死）。 */
export const ALLOW_RULES = [
  { id: 'temp-scope', re: /(?:^|\s|\/)(?:\/tmp\/|\/var\/tmp\/|\.\/tmp\/|%TEMP%|%TMP%|\$env:TEMP\b|\$env:TMP\b|[a-z]:\\temp\\)/i },
  { id: 'explicit-test-db', re: /\b(?:test|tmp|scratch|sandbox)\w*\b/i },
]

function firstMatch(rules, text) {
  for (const rule of rules) if (rule.re.test(text)) return rule
  return null
}

/** 关键顶层目录：删掉它们本身就是灾难，哪怕不是 "/" 本身。 */
const CRITICAL_TOP = [
  'etc', 'usr', 'var', 'home', 'root', 'boot', 'opt', 'srv',
  'bin', 'sbin', 'lib', 'lib64', 'sys', 'proc', 'dev', 'mnt', 'media',
]

/**
 * rm 的危险性取决于「带 -r 或 -f」且「目标是根 / 家目录 / 关键顶层目录」。
 *
 * 必须是组合判定：单条正则要么漏（`/home` 删掉不算根）、要么误杀
 * （把 `rm -rf /home/user/build` 也拦了，那是正常清理）。
 * 更深的路径一律放行——`/var/www/html`、`/home/u/project/build` 都是日常。
 */
function dangerousRm(text) {
  if (!/\brm\b/i.test(text)) return false
  if (!/-[a-z]*[rf]/i.test(text)) return false
  // 根 / 家目录本体
  if (/(?:^|\s)(?:\/(?:\*)?|~(?:\/)?|\$HOME)(?:\s|$|"|')/.test(text)) return true
  // 关键顶层目录（可带 /*，但不含更深路径段）
  const top = new RegExp('(?:^|\\s)/(?:' + CRITICAL_TOP.join('|') + ')(?:/\\*)?(?:\\s|$|"|\')', 'i')
  if (top.test(text)) return true
  // Windows 关键根
  if (/(?:^|\s)["']?[a-z]:\\(?:windows|users|program files|programdata)(?:\\\\)?(?:["']|\s|$|\*)/i.test(text)) {
    return true
  }
  return false
}

/**
 * 判断一条命令是否可放行。
 *
 * 顺序：先看例外，再看黑名单。例外只救**明显落在临时区/测试库**的情形。
 *
 * @returns {{allow: boolean, rule?: string, why?: string}}
 */
export function checkCommand(command) {
  const text = String(command ?? '')
  if (text.trim() === '') return { allow: true }

  if (dangerousRm(text)) {
    const allowed = firstMatch(ALLOW_RULES, text)
    if (allowed === null) return { allow: false, rule: 'rm-absolute-root', why: '删除根目录或家目录，不可逆' }
  }

  const hit = firstMatch(COMMAND_RULES, text)
  if (hit === null) return { allow: true }
  const allowed = firstMatch(ALLOW_RULES, text)
  if (allowed !== null) return { allow: true, rule: allowed.id }
  return { allow: false, rule: hit.id, why: hit.why }
}

/** 写入类工具的危险目标。 */
export const PATH_RULES = [
  { id: 'write-system', re: /^[a-z]:\\(?:windows|program files|programdata)\\?/i, why: '写系统目录' },
  { id: 'write-graph-log', re: /[\\/]\.war[\\/]_graph[\\/](?:nodes|edges)\.jsonl$/i, why: '直接改写意图图日志（必须走内核工具，不能手改）' },
]

export function checkWritePath(path) {
  const text = String(path ?? '')
  if (text === '') return { allow: true }
  const hit = firstMatch(PATH_RULES, text)
  if (hit === null) return { allow: true }
  return { allow: false, rule: hit.id, why: hit.why }
}

/**
 * tools/pre-execute 用的最小闸门：不匹配返回 null（调用方放行），匹配返回拒绝理由。
 */
export function gate(toolName, args) {
  const name = String(toolName ?? '')
  if (name === 'pwsh' || name === 'bash') {
    const r = checkCommand(args?.command ?? args?.cmd ?? '')
    return r.allow ? null : r
  }
  if (name === 'write' || name === 'edit' || name === 'warfs_write' || name === 'warfs_replace' || name === 'str_replace_editor') {
    const r = checkWritePath(args?.path ?? args?.file_path ?? '')
    return r.allow ? null : r
  }
  return null
}

/** 给模型看的拒绝文案：说清是什么、为什么、怎么继续。 */
export function denialText(hit) {
  return (
    'REFUSED（动作闸门）: ' + String(hit.rule) + ' —— ' + String(hit.why) + '。\n' +
    '这不是故障，是无人值守的刹车。\n' +
    '要造破坏性测试数据，把目标限制在临时目录（/tmp、%TEMP%、./tmp）或明确的测试库名里；\n' +
    '要删自己的账本或证据，那不属于测试，属于自毁 —— 需要人明确下令。'
  )
}
