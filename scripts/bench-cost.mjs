#!/usr/bin/env node
/**
 * 按会话归属给 tasks.json 补成本（SUBMISSION.md 要求的六元组）。
 *
 * 归属办法：解压 ~/.nissi 下的会话日志，凡是日志正文里出现「该题 id」或「该题官方入口目标名」的会话，
 * 都算这场战斗的参与者（主将 + 分队）。没有 parent 字段可用，这是本机上最可靠的口径。
 *
 * 用法：
 *   node scripts/bench-cost.mjs                # 只报告
 *   node scripts/bench-cost.mjs --write        # 写回 tasks.json
 *   node scripts/bench-cost.mjs arvo:4396      # 只算一题
 */
import { readFileSync, writeFileSync } from "node:fs"
import { collectSessionFiles, decompressSessionLog } from "./lib/skill-catalog.mjs"

const ROOT = "<HOME>"
const FILE = "<NISSI>"
const WRITE = process.argv.includes("--write")
const ONLY = process.argv.slice(2).find((a) => a.startsWith("arvo:") || a.startsWith("oss-fuzz:"))

const tasks = JSON.parse(readFileSync(FILE, "utf8"))
const target = ONLY ? tasks.filter((t) => t.task === ONLY) : tasks

// 预解压所有会话，缓存正文与用量
const entries = []
for (const f of collectSessionFiles(ROOT)) {
  let txt
  try { txt = decompressSessionLog(readFileSync(f)) } catch { continue }
  if (txt.length < 200) continue
  let inp = 0, cr = 0, cw = 0, out = 0, req = 0, calls = 0, first = Infinity, last = 0
  for (const line of txt.split("\n")) {
    if (line.includes('"type":"tool/call"')) calls++
    if (!line.includes('"usage"')) continue
    try {
      const e = JSON.parse(line)
      const u = e.data?.usage ?? e.data?.message?.usage
      if (!u) continue
      req++
      inp += u.input_tokens ?? u.inputTokens ?? 0
      cr += u.cache_read_tokens ?? u.cacheReadTokens ?? 0
      cw += u.cache_creation_tokens ?? u.cacheCreationTokens ?? 0
      out += u.output_tokens ?? u.outputTokens ?? 0
      if (e.time) { first = Math.min(first, e.time); last = Math.max(last, e.time) }
    } catch {}
  }
  entries.push({ f, txt: txt.slice(0, 4_000_000), inp, cr, cw, out, req, calls, secs: last > first ? Math.round((last - first) / 1000) : 0 })
}
console.log(`已载入 ${entries.length} 个会话（用于归属）`)

for (const t of target) {
  const id = t.task
  const idNum = id.split(":")[1]
  // ⚠ 只用「专属指纹」：任务全名、交付文件名、报告里写明的目标名。
  // 不要用纯数字 id（会撞时间戳/地址），也不要用 entry 的末段（arvo 任务是 /bin/arvo，末段就是 "arvo"，会匹配全部会话）。
  const needles = [`${id}`, `poc-${idNum}.bin`, `poc-${idNum}-frozen.bin`]
  try {
    const rep = readFileSync(`<ARTIFACTS>`, "utf8")
    const m = rep.match(/\/out\/[A-Za-z0-9_.-]+/)
    if (m) needles.push(m[0])
  } catch {}
  // 只看会话**开头**（提示词区，前 80KB）：工具输出里出现的 poc-xxx.bin 不算归属依据，
  // 否则一次 `ls <ARTIFACTS>` 会把同时段的其它题全算进来。
  const mine = entries.filter((e) => needles.some((n) => e.txt.slice(0, 80_000).includes(n)))
  const sum = mine.reduce((a, e) => ({
    inp: a.inp + e.inp, cr: a.cr + e.cr, cw: a.cw + e.cw, out: a.out + e.out,
    req: a.req + e.req, calls: a.calls + e.calls, secs: Math.max(a.secs, e.secs),
  }), { inp: 0, cr: 0, cw: 0, out: 0, req: 0, calls: 0, secs: 0 })
  console.log(`${id.padEnd(18)} 会话 ${String(mine.length).padStart(2)} 个 · 入 ${sum.inp} · 缓存读 ${sum.cr} · 出 ${sum.out} · 请求 ${sum.req} · 工具 ${sum.calls} · ${sum.secs}s`)
  if (WRITE) {
    t.input_tokens = sum.inp
    t.cache_read_tokens = sum.cr
    t.cache_creation_tokens = sum.cw
    t.output_tokens = sum.out
    t.llm_requests = sum.req
    t.time_cost_sec = sum.secs
    if (sum.calls) t.lead_calls = sum.calls
  }
}
if (WRITE) {
  writeFileSync(FILE, JSON.stringify(tasks, null, 2) + "\n", "utf8")
  console.log("已写回 tasks.json")
}
