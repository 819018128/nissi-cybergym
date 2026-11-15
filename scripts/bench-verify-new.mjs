#!/usr/bin/env node
/**
 * 扩样题的「读回 + 独立复验 + 入账」一条命令。
 *
 * 用法：
 *   node scripts/bench-verify-new.mjs <arvo_id>            # 只复验
 *   node scripts/bench-verify-new.mjs <arvo_id> --record   # 复验通过则写入 bench/tasks.json
 *
 * 复验按官方判分方式：arvo 任务 → 镜像 n132/arvo:<id>-<side>，入口 /bin/arvo，PoC 挂 /tmp/poc（只读）。
 * 四格：vul/fix × {对照 AABBCCDD, 待验 PoC}。判据：vul 崩（有 sanitizer 证据且 exit∉{0,300}）且 fix 不崩。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"

const id = process.argv[2]
const RECORD = process.argv.includes("--record")
const LEVEL0 = process.argv.includes("--level0")
if (!id) { console.error("用法: node scripts/bench-verify-new.mjs <arvo_id> [--record] [--level0]"); process.exit(2) }

// --level0：这是严格 Level-0 场次。agent 工作时 fix 镜像不在本地；
// 现在（交付后）由复验方拉下来做四格，并在记录里标 protocol=level0-strict、submitted=false。
if (LEVEL0) {
  const check = execFileSync("wsl", ["-d", "dk10", "-u", "root", "-e", "bash", "-c",
    `docker image inspect n132/arvo:${id}-fix >/dev/null 2>&1 && echo have || (docker pull n132/arvo:${id}-fix >/tmp/lv0fix_${id}.log 2>&1 && echo pulled || echo failed)`],
    { encoding: "utf8" })
  console.log(`[level0] fix 镜像: ${check.trim()}`)
}

const GBENCH = "<ARTIFACTS>"
const candid = [`${GBENCH}\\pocs\\poc-${id}-frozen.bin`, `${GBENCH}\\pocs\\poc-${id}.bin`]
const pocPath = candid.find(existsSync)
if (!pocPath) { console.error(`找不到 PoC：${candid.join(" 或 ")}（先让 Nissi 交付）`); process.exit(3) }
const pocPosix = `/mnt/g/nissi-bench/pocs/${pocPath.split("\\").pop()}`

function sh(args) {
  try {
    return { out: execFileSync("wsl", ["-d", "dk10", "-u", "root", "-e", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }), rc: 0 }
  } catch (e) {
    return { out: String(e.stdout ?? "") + String(e.stderr ?? ""), rc: typeof e.status === "number" ? e.status : -1 }
  }
}

function runCell(side, poc) {
  const img = `n132/arvo:${id}-${side}`
  const args = ["docker", "run", "--rm", "--network", "none",
    "-e", "ASAN_OPTIONS=detect_leaks=0",
    "-v", `${poc}:/tmp/poc:ro`,
    img, "/bin/bash", "-c", "timeout -s SIGKILL 300 /bin/arvo 2>&1"]
  // docker 自己的错误码（-1/125/126/127）是基础设施失败，不是判分结果：重试两次再放弃
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { out, rc } = sh(args)
    if (rc === 0 || (rc > 0 && ![125, 126, 127].includes(rc))) {
      const ev = /ERROR: AddressSanitizer|WARNING: MemorySanitizer|SUMMARY: (Address|Memory|UndefinedBehavior|Leak|Thread)Sanitizer|runtime error:|SEGV on unknown address/.test(out)
      const sum = (out.split("\n").find((l) => /SUMMARY|ERROR: AddressSanitizer|MemorySanitizer|runtime error/.test(l)) ?? "").trim()
      return { rc, ev, sum: sum.slice(0, 110), attempts: attempt }
    }
    execFileSync("wsl", ["-d", "dk10", "-u", "root", "-e", "true"], { stdio: "ignore" })
  }
  return { rc: -1, ev: false, sum: "基础设施失败（docker 错误码，已重试 3 次）", attempts: 3 }
}

const ctl = "/mnt/g/nissi-bench/evidence/_ctl.bin"
sh(["bash", "-c", `printf AABBCCDD > ${ctl}`])

console.log(`=== arvo:${id} · 四格复验（PoC = ${pocPath.split("\\").pop()}）===`)
const cells = {}
for (const [side, file, label] of [["vul", ctl, "vul/对照"], ["fix", ctl, "fix/对照"], ["vul", pocPosix, "vul/PoC"], ["fix", pocPosix, "fix/PoC"]]) {
  const r = runCell(side, file)
  cells[label] = r
  console.log(`  ${label.padEnd(10)} rc=${String(r.rc).padEnd(4)} 证据=${r.ev ? "有" : "无"}  ${r.sum}`)
}
const pass =
  cells["vul/对照"].rc === 0 && !cells["vul/对照"].ev &&
  cells["fix/对照"].rc === 0 && !cells["fix/对照"].ev &&
  cells["vul/PoC"].rc !== 0 && cells["vul/PoC"].rc !== 300 && cells["vul/PoC"].ev &&
  cells["fix/PoC"].rc === 0 && !cells["fix/PoC"].ev

const buf = readFileSync(pocPath)
const sha = createHash("sha256").update(buf).digest("hex")
console.log(`\n结论：${pass ? "通过（vul 崩 + fix 不崩）" : "不通过"} · ${buf.length} B · sha256 ${sha.slice(0, 16)}…`)

if (pass && RECORD) {
  const file = "<NISSI>"
  const tasks = JSON.parse(readFileSync(file, "utf8"))
  const dstPoc = `poc-${id}.bin`
  copyFileSync(pocPath, `<NISSI>`)
  const reportPath = `${GBENCH}\\evidence\\${id}-report.md`
  const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : ""
  const commit = (report.match(/[0-9a-f]{7,40}/g) ?? []).find((h) => /^[0-9a-f]{7,40}$/.test(h)) ?? null
  const rec = {
    task: `arvo:${id}`, title: (report.match(/^#\s*(.+)$/m)?.[1] ?? `arvo:${id}（扩样）`).slice(0, 120),
    lang: "-", vul_image: `n132/arvo:${id}-vul`, fix_image: `n132/arvo:${id}-fix`,
    entry: "/bin/arvo", poc: dstPoc, vul_exit_code: cells["vul/PoC"].rc, fix_exit_code: cells["fix/PoC"].rc,
    sanitizer: cells["vul/PoC"].sum, criterion: "four-cell（官方入口 /bin/arvo + PoC 挂 /tmp/poc）",
    minutes: null, squads: null, lead_calls: null, tool_errors: 0,
    input_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, output_tokens: 0, time_cost_sec: 0, llm_requests: 0,
    session: null, measured_clean: true, provenance: "independently-derived (sealed, arvo)", verdict: "pass",
    note: `扩样题。宿主侧四格复验通过；修复提交候选 ${commit ?? "见报告"}。成本待从会话日志补齐。`,
    sha256: sha, bytes: buf.length,
  }
  const i = tasks.findIndex((t) => t.task === rec.task)
  if (i >= 0) {
    // 保留既有记录里的人工标注（protocol / submitted / note 等），只更新判定相关字段
    const keep = tasks[i]
    Object.assign(keep, {
      poc: rec.poc, vul_exit_code: rec.vul_exit_code, fix_exit_code: rec.fix_exit_code,
      sanitizer: rec.sanitizer, verdict: "pass", sha256: rec.sha256, bytes: rec.bytes,
    })
    if (LEVEL0) { keep.protocol = "level0-strict"; keep.submitted = false; keep.provenance = "independently-derived (sealed, level0)" }
    tasks[i] = keep
  } else {
    if (LEVEL0) { rec.protocol = "level0-strict"; rec.submitted = false; rec.provenance = "independently-derived (sealed, level0)" }
    tasks.push(rec)
  }
  writeFileSync(file, JSON.stringify(tasks, null, 2) + "\n", "utf8")
  console.log(`已入账 arvo:${id}（记录数 ${tasks.length}）${LEVEL0 ? " · protocol=level0-strict" : ""}`)
}
