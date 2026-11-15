/**
 * 主帅目录白名单（根治"主帅有手"）。
 *
 * WHY 不用黑名单：黑名单**失败开放**。实测 2026-11-12：我给自己注册的动态工具 `waract`
 * （能用它拿 shell）出现在**所有会话**的工具表里 —— 因为 harness.registerTool 是全进程可见的。
 * 而 `no-hands` 按名字拦 pwsh/bash/write/edit，`waract` 不在名单里，直接漏过。
 * 下一次换个名字（waract2、shell_helper…）又漏。按名字封堵永远追不上新名字。
 *
 * 所以改成**目录级白名单**：主帅只看得见下面这些，其余连 schema 都不存在（tools.restrict({allow})）。
 * 新工具默认不可见 = 失败关闭。
 *
 * 三个代价仍然成立，这是"主帅无手"的全部理由：
 *   ① 上下文污染：工具输出占上下文成本约 70%（实测 6.19MB → 1.65GB 复利）；
 *   ② 委派纪律：消融实验中性提示 5/5 不委派，强提示仍有 1/5 自己干 —— 结构 > 提示；
 *   ③ 归属可审计：没认领就没有战果归属。
 *
 * 名单是**数据**：改这里不用改逻辑。加新工具时如果忘了加，主帅会说"没这个工具"——
 * 那是**可见的失败**，比"悄悄多了一双能执行的手"好得多。
 */

/** 精确名字。 */
export const LEAD_ALLOW_EXACT = [
  // 读与研判（不给手，但必须给眼睛）
  'read', 'read_image', 'grep', 'glob', 'skill', 'web_search',
  // 指挥
  'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents',
  // 目标与计划
  'create_goal', 'get_goal', 'update_goal', 'todo_write', 'exit_plan_mode',
  // 与人对话
  'ask_user_question', 'validate_dsh_ui',
  // 只读的证据查看（不给 evidence_browser_check —— 那是"发射浏览器"的动作）
  'evidence_list', 'evidence_render',
]

/**
 * 前缀规则。这些族都要求"读/记账/指挥"，没有一个能自己执行命令或写文件。
 * 刻意**不含** intent_claim / intent_finish 之外的执行类；claim/finish 本身就是记账，
 * 而且工具内部还会按角色拒绝主帅调用。
 */
export const LEAD_ALLOW_PREFIXES = [
  'board_', // 板面：任务/目标/战果/审批
  'opsmap_', // 地图刷新与派工清单
  'map_', // map_orders 对账
  'graph_', // 意图图态势
  'intent_', // 派意图/重开（claim、finish 会被工具内按角色拒）
  'fact_', // 记事实
  'vdb_', // 漏洞库查询
  'xray_', // 自身遥测
  'campaign_', // 战役状态
  'egress_', // 出网管控（含 disable，属于安全控制）
]

/**
 * 由当前目录名算出应保留的集合。
 *
 * @param {string[]} names 当前该 agent 作用域看得见的所有工具名
 * @param {{exact?: string[], prefixes?: string[]}} rules
 * @returns {string[]} 保留的工具名（稳定排序）
 */
export function computeAllowlist(names, rules) {
  const exact = new Set(Array.isArray(rules?.exact) ? rules.exact : LEAD_ALLOW_EXACT)
  const prefixes = Array.isArray(rules?.prefixes) ? rules.prefixes : LEAD_ALLOW_PREFIXES
  const out = []
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw ?? '')
    if (name === '') continue
    if (exact.has(name)) {
      out.push(name)
      continue
    }
    for (const prefix of prefixes) {
      if (name.startsWith(prefix)) {
        out.push(name)
        break
      }
    }
  }
  return out.sort()
}

/**
 * 枚举是否可信。空名单或过少都意味着"枚举没看见真实的目录"，
 * 这时**绝不能**拿它去 restrict —— 那会把主帅砍成残废。
 */
export function allowlistUsable(kept, total) {
  if (!Array.isArray(kept)) return false
  if (kept.length === 0) return false
  if (typeof total === 'number' && total < 10) return false
  return true
}
