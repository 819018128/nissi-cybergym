import { readFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"

const bench = "<NISSI>"
const tasks = JSON.parse(readFileSync(join(bench, "tasks.json"), "utf8"))
const need = ["task", "vul_image", "fix_image", "entry", "poc", "vul_exit_code", "fix_exit_code", "verdict", "sha256", "bytes", "provenance", "input_tokens", "cache_read_tokens", "cache_creation_tokens", "output_tokens", "time_cost_sec", "llm_requests"]
let bad = 0
console.log("题".padEnd(20) + "verdict  bytes     sha256一致  必需字段  两侧")
console.log("-".repeat(78))
for (const t of tasks) {
  // 未解记录：没有 PoC 是正常的，只校验「有 PoC 的记录」
  if (t.verdict === "unsolved" || t.poc === null || t.poc === undefined) {
    console.log(t.task.padEnd(20) + String(t.verdict ?? "-").padEnd(8) + "-".padEnd(10) + "-".padEnd(11) + "-".padEnd(10) + "未解（进分母）")
    continue
  }
  const missing = need.filter((k) => t[k] === undefined || t[k] === null)
  const f = join(bench, "pocs", t.poc)
  const exists = existsSync(f)
  let shaOk = false
  if (exists) shaOk = createHash("sha256").update(readFileSync(f)).digest("hex") === t.sha256
  const twoSided = Number.isInteger(t.vul_exit_code) && Number.isInteger(t.fix_exit_code) && t.vul_exit_code !== 0 && t.fix_exit_code === 0
  if (missing.length || !exists || !shaOk || !twoSided || t.verdict !== "pass") bad++
  console.log(
    t.task.padEnd(20) +
    String(t.verdict).padEnd(8) +
    String(t.bytes).padEnd(10) +
    (shaOk ? "✓" : "✗").padEnd(11) +
    (missing.length ? "缺:" + missing.join(",") : "✓").padEnd(10) +
    (twoSided ? `${t.vul_exit_code}/${t.fix_exit_code}` : "✗")
  )
}
console.log("-".repeat(78))
console.log(`记录数=${tasks.length}  不合格=${bad}`)
console.log(`PoC 文件数=${readJsonLen()}`)

function readJsonLen() {
  const d = JSON.parse(readFileSync(join(bench, "tasks.json"), "utf8"))
  return d.length
}
