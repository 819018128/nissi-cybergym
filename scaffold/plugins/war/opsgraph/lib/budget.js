/**
 * 战役预算：意图数 + 墙钟。无人值守的第三道刹车。
 *
 * 三件套的分工（都不可省）：
 *   ① 授权边界（rt_config / blue_config 的 fail-closed 闸门）—— 只打在授权目标上；
 *   ② 自毁闸门（war-stops）—— 不做不可逆的自毁动作；
 *   ③ 预算上限（本条）—— 到点就收，不许无限烧。
 *
 * ★ token 口径暂缺：插件拿不到每会话的 token 计量（需要宿主遥测），所以这里只做
 *   **图里算得出来的**两个：意图数、墙钟（最早上图节点到现在）。这是诚实的能力边界，
 *   不是遗漏 —— 写一个拿不到数的 token 上限，只会变成永远不触发的装饰。
 *
 * 到点之后的期望行为不是"崩溃"，而是"收口"：主帅应当停止派新意图、把已有战果写回板面、
 * 做战役收口（board_campaign_close）。所以拒绝文案要告诉它怎么收，而不是只说"不行"。
 */

/** 默认上限。0 或未设置 = 该项不启用。 */
export const DEFAULT_LIMITS = {
  maxIntents: 200, // 一场战役最多派 200 条意图
  maxWallMs: 6 * 60 * 60 * 1000, // 墙钟 6 小时
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * 从图里算战役统计。
 *
 * 墙钟取「最早上图节点到现在」：图里没有节点时为 0，不会误触。
 */
export function campaignStats(nodes, nowMs) {
  const list = Array.isArray(nodes) ? nodes : []
  let intents = 0
  let earliest = null
  for (const node of list) {
    if (node?.kind === 'intent') intents += 1
    const at = Date.parse(String(node?.createdAt ?? ''))
    if (Number.isFinite(at)) {
      if (earliest === null || at < earliest) earliest = at
    }
  }
  const now = typeof nowMs === 'number' ? nowMs : Date.now()
  return {
    intents,
    nodes: list.length,
    startedAtMs: earliest,
    wallMs: earliest === null ? 0 : Math.max(0, now - earliest),
  }
}

/**
 * 判断预算是否用尽。
 *
 * @returns {{exceeded: boolean, reasons: string[], stats: object, limits: object}}
 */
export function checkBudget(nodes, limits, nowMs) {
  const cfg = limits ?? {}
  const maxIntents = num(cfg.maxIntents, DEFAULT_LIMITS.maxIntents)
  const maxWallMs = num(cfg.maxWallMs, DEFAULT_LIMITS.maxWallMs)
  const stats = campaignStats(nodes, nowMs)
  const reasons = []
  if (maxIntents > 0 && stats.intents >= maxIntents) {
    reasons.push('意图数已达上限 ' + String(stats.intents) + '/' + String(maxIntents))
  }
  if (maxWallMs > 0 && stats.wallMs >= maxWallMs) {
    const hours = (stats.wallMs / 3600000).toFixed(1)
    const cap = (maxWallMs / 3600000).toFixed(1)
    reasons.push('墙钟已达上限 ' + hours + 'h/' + cap + 'h')
  }
  return { exceeded: reasons.length > 0, reasons, stats, limits: { maxIntents, maxWallMs } }
}

/** 给态势文本用的一行。 */
export function budgetLine(result) {
  const s = result?.stats ?? { intents: 0, wallMs: 0 }
  const l = result?.limits ?? DEFAULT_LIMITS
  const hours = (s.wallMs / 3600000).toFixed(1)
  const capH = (l.maxWallMs / 3600000).toFixed(1)
  const head =
    '预算：意图 ' + String(s.intents) + '/' + String(l.maxIntents) +
    ' · 墙钟 ' + hours + 'h/' + capH + 'h'
  if (result?.exceeded !== true) return head
  return head + '\n预算已用尽：' + (result.reasons ?? []).join('；') + ' —— 停止派新意图，写回战果并收口。'
}

/** 拒绝派活时的文案：不只说不行，要说怎么收。 */
export function budgetRefusal(result) {
  return (
    'REFUSED（战役预算）: ' + (result?.reasons ?? []).join('；') + '。\n' +
    '这不是故障，是无人值守的上限。现在该做的是收口，不是继续派：\n' +
    '1) 把已经拿到的事实与战果写回板面；2) 用 board_campaign_close 做战役收口；\n' +
    '3) 确有未打完的方向，写进收口理由里交給下一仗，而不是在这里继续烧。'
  )
}
