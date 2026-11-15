/**
 * war-stops —— 自毁闸门（无人值守的刹车片）。
 *
 * 与 roe-gate 的分工必须说清，两者撞不了车：
 *   · roe-gate 管「别把靶标的业务打死」（DoS 工具、钓鱼、持久化、代理隧道），
 *     它的底线是"不破坏业务"；
 *   · war-stops 管「别把自己打死」（根目录删除、格式化磁盘、整库删除、关停宿主、
 *     清空防火墙、删自己的账本与证据）。
 * 一个对外，一个对内。
 *
 * 为什么必须有：授权边界（rt_config / blue_config 的 fail-closed 闸门）管的是**目标范围**，
 * 管不到**动作强度**。`rm -rf /` 打在授权目标上也照样毁灭；而无人值守意味着没人踩刹车。
 *
 * ★ 边界诚实：黑名单天然失败开放。没列到的危险动作拦不住，换个写法也可能绕开。
 *   它是"把已知自毁动作挡在门外并留痕"，不是安全保证。真正的防呆是三件叠加：
 *   授权边界（fail-closed）+ 预算上限（待建）+ 本闸门。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { gate, denialText } from './match.js'

export const name = 'war-stops'
export const inject = ['tools']

export function apply(ctx, config) {
  const cfg = config ?? {}
  const root = typeof cfg.root === 'string' && cfg.root ? cfg.root : process.env.WAR_ROOT || '<HOME>/.war'
  const logDir = path.join(root, '_stops')
  const logFile = path.join(logDir, 'stops.jsonl')
  const enabled = cfg.enabled !== false

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

  void log({ at: new Date().toISOString(), kind: 'startup', enabled, root })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const base = await next()
    if (!enabled) return base
    try {
      if (base !== undefined && base.kind !== 'allow') return base
      // 参数挂在 exec.arguments（已核对：board2 / egress / roe-gate 都这么读）。
      const hit = gate(exec?.name, exec?.arguments)
      if (hit === null) return base
      void log({
        at: new Date().toISOString(),
        kind: 'denied',
        tool: String(exec?.name ?? ''),
        rule: String(hit.rule ?? ''),
        why: String(hit.why ?? ''),
        role: String(exec?.agent?.session?.header?.origin ?? '') === 'subagent' ? 'worker' : 'lead',
        agent: String(exec?.agent?.id ?? ''),
      })
      return { kind: 'deny', reason: denialText(hit) }
    } catch (error) {
      // 闸门自己坏了要留痕并放行：一个坏掉的闸门把整支队伍堵死，比漏掉一次拦截更糟。
      void log({ at: new Date().toISOString(), kind: 'gate-error', error: String(error?.message ?? error) })
      return base
    }
  })
}
