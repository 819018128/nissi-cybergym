/**
 * hive-vulndb — a fingerprint-indexed vulnerability knowledge base with an
 * agent-driven build procedure.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * This is NOT a CVE dump, and it is deliberately not a mirror of NVD or OSV.
 * Those are RAW FEEDS: keyed by CVE id, describing a vulnerability in the
 * abstract. What an operator actually needs mid-engagement is the opposite
 * shape:
 *
 *   key          fingerprint (product + version as seen on the target)
 *   content      a verification chain — how to trigger it, what success LOOKS
 *                like, which pitfalls bite in practice
 *   provenance   was this found by source audit, or assembled from public
 *                reporting?
 *   maturity     draft | verified | weaponized — has anyone confirmed it HERE?
 *
 * So the design is three layers, and this plugin is the middle one:
 *
 *   raw layer     NVD 2.0 / OSV / CISA KEV / EPSS -> `vdb_import`
 *                 (bulk, keyed by CVE, low signal per record)
 *   index layer   THIS PLUGIN — fingerprint keyed, full-text, state machine,
 *                 provenance, per-fingerprint rollup
 *   procedure     `vdb_build` — hands the agent a playbook for researching one
 *                 fingerprint live and filing what it finds
 *
 * The database ships EMPTY. That is the point, not a gap: the value is the
 * index shape, the collection discipline and the state machine. Content arrives
 * from the operator's own research and from imported feeds.
 *
 * WHAT `vdb_build` IS FOR
 * -----------------------
 * There is no such thing as a real-time 0day feed worth subscribing to. The
 * working substitute is the loop this plugin encodes: you hit a fingerprint, you
 * ask for the build playbook, the playbook tells you to search live (vendor
 * docs and advisories first, community writeups last), and what you learn is
 * filed as a `draft` entry so the NEXT time that fingerprint appears it is a
 * lookup instead of a research project. The KB is a cache of research, not a
 * feed consumer.
 *
 * Every entry an agent files lands as `draft`. Promotion to `verified` or
 * `weaponized` is a separate, deliberate act (`vdb_promote`) with a reason,
 * because an agent's own confidence is not evidence.
 */

import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const STATUSES = ['draft', 'verified', 'weaponized']
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
const SOURCES = ['audit', 'web', 'manual', 'feed']

const nowIso = () => new Date().toISOString()
const newId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

/* ───────────────────── the build playbook (procedure) ───────────────────── */

const BUILD_PLAYBOOK = (fingerprint, hintLine) => `# VDB build playbook — fingerprint: ${fingerprint}

${hintLine}

Goal: build a high-signal, directly reusable entry set for this one fingerprint.
Prefer omission over speculation — an entry nobody can reproduce is worse than
no entry, because it wastes a future operator's time.

## 0. Check coverage first

Call \`vdb_search\` with this fingerprint BEFORE researching. Existing entries are
not rebuilt; top up only what is missing.

If an existing entry is stale (version boundary moved, a real PoC appeared),
file a NEW entry and record the old id in \`supersedes\` rather than editing the
old text in place — the history of what was believed when is part of the record.

## 1. Research, by source priority (high to low)

1. Vendor documentation and release notes
2. Vendor security advisories
3. Upstream issue / PR / commit (a fix commit is the strongest version boundary)
4. NVD / GitHub Advisory / distro advisories
5. High-quality community writeups
6. Open-source PoC repositories
7. Blog / social posts

Rules:
- Weight current-year vulnerabilities. Include a classic only if it is still
  widely deployed.
- Take version boundaries from a primary source where you can. A boundary copied
  from a secondary writeup is a guess wearing a citation.
- Prefer an open-source PoC that is actually used (stars, recent commits, forks).
  If the only reference is closed-source and low-traffic, say so explicitly IN
  the entry body — do not let it pass as corroborated.

## 2. Collection discipline — what is worth an entry

Collect only what is directly actionable:
remote code execution, authentication bypass, SQL injection, arbitrary file
read/write, insecure deserialization, command or expression injection, default
credentials, hardcoded secrets.

Do NOT collect: pure information disclosure, fingerprint-only observations, or
harmless misconfiguration. Those are facts, not attack paths — put them on the
board as intel, not here.

A fingerprint itself IS worth an entry: once you have confirmed the product, add
one entry with \`vuln_type=fingerprint\` whose content is a single code block
holding the matching query (FOFA / Shodan / ZoomEye), and nothing else.

## 3. Body template (\`content_md\` — follow it exactly)

\`\`\`markdown
### 信息概览
- 漏洞类型：一个主类型
- 影响版本：版本边界 + 依据来源
- CVE / CNVD / 厂商编号：没有就写「未分配」
- 严重级别：critical / high / medium

### 利用/验证步骤
最小可复现链路。原始 HTTP 请求、curl、命令行与成功回显优先，不要贴无关大段代码。

### 成功判定
一句话说清「看到什么就算成了」——可观察的回显或状态变化。

### 修复方式
官方补丁、升级版本或可落地的临时缓解。

### 坑点
实战真会踩的坑；没有明显内容就整节省略。

### 参考
按第 1 节的优先级排列来源链接。
\`\`\`

Style: short sentences, steps not prose, written for someone verifying rather
than someone learning.

## 4. File it

One \`vdb_add\` call per entry — never batch several into one call. Set:

- \`fingerprint\`: exactly "${fingerprint}"
- \`slug\`: lowercase-hyphenated, e.g. \`auth-bypass-via-path-case\`
- \`vuln_type\`: one primary type
- \`severity\`, \`score_hint\`: your estimate, clearly an estimate
- \`content_md\`: per the template above
- \`source\`: \`audit\` if you found it by reading source, \`web\` if assembled from
  public reporting

New entries are always \`draft\`. Promotion is not yours to grant.

## 5. Report back

State which entries you filed (titles), which are provisional and why, and the
source distribution. Do not present the count as coverage — count is not
coverage.`

/* ───────────────────────── storage ───────────────────────── */

async function ensureRoot(root) {
  await fs.mkdir(path.join(root, 'vdb', 'entries'), { recursive: true })
}

async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function listEntries(root) {
  const dir = path.join(root, 'vdb', 'entries')
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const e = await readJson(path.join(dir, n))
    if (e) out.push(e)
  }
  return out
}

/** The fields a search hit shows before anyone asks for the body. */
function card(e) {
  return {
    id: e.id,
    fingerprint: e.fingerprint,
    title: e.title,
    vuln_type: e.vuln_type,
    severity: e.severity,
    status: e.status,
    source: e.source,
    cve: e.cve,
    supersedes: e.supersedes,
    updated_at: e.updated_at,
  }
}

function matchesText(e, keyword) {
  const k = keyword.toLowerCase()
  return (
    String(e.title ?? '').toLowerCase().includes(k) ||
    String(e.content_md ?? '').toLowerCase().includes(k) ||
    String(e.vuln_type ?? '').toLowerCase().includes(k) ||
    String(e.cve ?? '').toLowerCase().includes(k) ||
    String(e.fingerprint ?? '').toLowerCase().includes(k)
  )
}

/* ───────────────────────────── plugin ───────────────────────────── */

export const name = 'hive-vulndb'
export const inject = ['tools']

/**
 * 证据引用必须落在盘上（见 vdb_promote 里的说明）。
 * 两处都算：`<root>/evidence/<name>`（渲染件）与 `<root>/findings/<id>`（发现卡）。
 */
async function resolveEvidence(rootDir, wanted) {
  const needle = String(wanted).trim()
  if (needle === '') return { ok: false }
  const candidates = [
    path.join(rootDir, 'evidence', needle),
    path.join(rootDir, 'findings', needle),
    path.join(rootDir, 'findings', needle + '.json'),
  ]
  for (const c of candidates) {
    try {
      await fs.access(c)
      return { ok: true, path: c }
    } catch { /* 下一个 */ }
  }
  return { ok: false }
}


export function apply(ctx, config) {
  const configuredRoot = typeof config?.root === 'string' && config.root ? config.root : null
  /* 兜底是**绝对路径**，且**刻意不是真板面** ——
   未配置 root 时写到 ~/.dsh/hive-board（隔离、可丢弃），而不是 cwd（换目录就丢 ✗）
   也不是 ~/.war（兜底绝不能静默污染生产数据 ✗）。
   生产上走不到这一支：两个预设都显式配了绝对 root。 */
  const root = () => configuredRoot ?? path.join(os.homedir(), '.dsh', 'hive-board')

  const callerOf = (exec) => {
    const id = exec?.agent?.id
    return typeof id === 'string' && id.length > 0 ? id : null
  }

  const register = (spec) => {
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute(args, exec) {
          try {
            await ensureRoot(root())
            const caller = callerOf(exec)
            if (caller === null) {
              return 'ERROR: the runtime supplied no calling-session identity (exec.agent.id). Refusing.'
            }
            return await spec.run(args, caller)
          } catch (error) {
            return `ERROR: ${error?.message ?? String(error)}`
          }
        },
      }),
    )
  }

  register({
    name: 'vdb_search',
    description:
      'Search the vulnerability knowledge base. Search by `fingerprint` for an exact product+version match, or by `keyword` for full text over title / body / vuln type / CVE. ALWAYS search before researching a product from scratch — a weaponized entry here is a ready-made attack path.',
    parameters: {
      fingerprint: { type: 'string', description: 'Exact fingerprint, e.g. "apache:httpd:2.4.49".' },
      keyword: { type: 'string', description: 'Full-text term.' },
      status: { type: 'string', description: 'Filter: draft | verified | weaponized' },
      limit: { type: 'string', description: 'Max hits (default 20).' },
    },
    async run(args) {
      if (!args.fingerprint && !args.keyword) return 'ERROR: fingerprint or keyword is required'
      const limit = Math.max(1, Math.min(200, Number(args.limit ?? 20) || 20))
      const status = args.status ? String(args.status) : null
      if (status && !STATUSES.includes(status)) return `ERROR: status must be one of ${STATUSES.join(' | ')}`
      const all = await listEntries(root())
      const hits = all
        .filter((e) => (args.fingerprint ? e.fingerprint === String(args.fingerprint) : true))
        .filter((e) => (args.keyword ? matchesText(e, String(args.keyword)) : true))
        .filter((e) => (status ? e.status === status : true))
      const rank = { weaponized: 0, verified: 1, draft: 2 }
      hits.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
      const page = hits.slice(0, limit)
      return JSON.stringify(
        {
          count: hits.length,
          shown: page.length,
          note: hits.length === 0
            ? 'No entry for this query. That is an empty knowledge base, NOT evidence the product is clean — research it live with vdb_build.'
            : undefined,
          entries: page.map(card),
        },
        null,
        2,
      )
    },
  })

  register({
    name: 'vdb_get',
    description: 'Read one entry in full, including its content_md body.',
    parameters: { id: { type: 'string', required: true } },
    async run(args) {
      const e = await readJson(path.join(root(), 'vdb', 'entries', `${args.id}.json`))
      if (!e) return `ERROR: unknown entry ${args.id}`
      return JSON.stringify(e, null, 2)
    },
  })

  register({
    name: 'vdb_add',
    description:
      'File one entry. It lands as `draft` — an agent cannot promote its own work. Use vdb_build to get the playbook and the body template before filing. One call per entry, never batch.',
    parameters: {
      fingerprint: { type: 'string', required: true, description: 'Product+version as seen on the target.' },
      title: { type: 'string', required: true, description: 'One-line vulnerability title.' },
      content_md: { type: 'string', required: true, description: 'Body, following the playbook template.' },
      vuln_type: { type: 'string' },
      severity: { type: 'string', description: 'critical | high | medium | low | info' },
      score_hint: { type: 'string' },
      slug: { type: 'string' },
      cve: { type: 'string' },
      source: { type: 'string', description: 'audit | web | manual | feed' },
      supersedes: { type: 'string', description: 'Existing entry id this one replaces.' },
      references: { type: 'string', description: 'Newline-separated reference URLs.' },
    },
    async run(args, caller) {
      if (!args.fingerprint) return 'ERROR: fingerprint is required'
      if (!args.title) return 'ERROR: title is required'
      if (!args.content_md) return 'ERROR: content_md is required'
      const severity = args.severity ? String(args.severity) : null
      if (severity && !SEVERITIES.includes(severity)) return `ERROR: severity must be one of ${SEVERITIES.join(' | ')}`
      const source = args.source ? String(args.source) : 'manual'
      if (!SOURCES.includes(source)) return `ERROR: source must be one of ${SOURCES.join(' | ')}`
      const fingerprint = String(args.fingerprint)
      // A stale entry is superseded by a new one, never edited in place: what was
      // believed when is part of the record.
      if (args.supersedes) {
        const old = await readJson(path.join(root(), 'vdb', 'entries', `${args.supersedes}.json`))
        if (!old) return `ERROR: unknown supersedes entry ${args.supersedes}`
      }
      const entry = {
        id: newId('vdb'),
        fingerprint,
        slug: args.slug ? slugify(args.slug) : slugify(args.title),
        title: String(args.title),
        vuln_type: args.vuln_type ? String(args.vuln_type) : null,
        severity,
        score_hint: args.score_hint ? String(args.score_hint) : null,
        cve: args.cve ? String(args.cve) : null,
        content_md: String(args.content_md),
        references: args.references
          ? String(args.references).split('\n').map((s) => s.trim()).filter(Boolean)
          : [],
        source,
        status: 'draft',
        supersedes: args.supersedes ? String(args.supersedes) : null,
        promotions: [],
        created_at: nowIso(),
        created_by: caller,
        updated_at: nowIso(),
        updated_by: caller,
      }
      await writeJson(path.join(root(), 'vdb', 'entries', `${entry.id}.json`), entry)
      const siblings = (await listEntries(root())).filter((e) => e.fingerprint === fingerprint)
      return (
        `FILED ${entry.id} as draft for "${fingerprint}" (${siblings.length} entries now cover this fingerprint).\n` +
        `Promotion to verified/weaponized needs vdb_promote with a reason — file it with the evidence and let a human confirm.\n` +
        `${JSON.stringify(card(entry), null, 2)}`
      )
    },
  })

  register({
    name: 'vdb_promote',
    description:
      'Promote or demote an entry (draft -> verified -> weaponized), recording who and why. This is a deliberate review act: an agent stating its own confidence is not evidence. Cite what confirmed it in the reason.',
    parameters: {
      id: { type: 'string', required: true },
      status: { type: 'string', required: true, description: 'draft | verified | weaponized' },
      reason: { type: 'string', required: true, description: 'What confirmed it, and by whom.' },
      evidence: {
        type: 'string',
        description:
          'REQUIRED for verified/weaponized: an artifact that actually exists — a name under <root>/evidence ' +
          '(produced by evidence_render) or a finding id under <root>/findings (produced by board_finding_add).',
      },
      cve: { type: 'string', description: 'Assign a CVE id if one was issued since filing.' },
    },
    async run(args, caller) {
      const status = String(args.status)
      if (!STATUSES.includes(status)) return `ERROR: status must be one of ${STATUSES.join(' | ')}`
      if (!args.reason) return 'ERROR: reason is required — a promotion without a stated basis is not review'
      const file = path.join(root(), 'vdb', 'entries', `${args.id}.json`)
      const entry = await readJson(file)
      if (!entry) return `ERROR: unknown entry ${args.id}`
      const previous = entry.status
      if (previous === status) return `ALREADY ${status.toUpperCase()}`

      /* ── 证据必须真的存在（2026-11-06 收紧）──────────────────────────────
       *
       * 原来这条工具只要求 reason 非空，而描述里写着 "an agent stating its own
       * confidence is not evidence"。两句读起来都很硬，实际上一个模型写
       * `reason: "ok"` 就能把条目推到 verified —— 然后 `vdb_stats` 上"已验证 1 条"，
       * 谁也不知道它凭什么算验证过。
       *
       * 现在：推到 verified / weaponized 必须**引用一件在盘上真的存在的东西**：
       *   · `<root>/evidence/<name>`（`evidence_render` 产出的截图/报告），或
       *   · `<root>/findings/<id>`（`board_finding_add` 写下的发现卡）。
       * 降级回 draft 不需要证据 —— 降级是收力，不是宣布结论。 */
      const evidence = String(args.evidence ?? '').trim()
      if (status !== 'draft') {
        if (evidence === '') {
          return (
            `REFUSED: 推到 ${status} 必须引用一件**真实存在**的证据。\n` +
            '  · 有渲染件 → evidence="<文件名>"（在 ' + path.join(root(), 'evidence') + ' 下）\n' +
            '  · 有板面发现卡 → evidence="<finding id>"（在 ' + path.join(root(), 'findings') + ' 下）\n' +
            '理由再漂亮也只是你的判断；"验证过"这句话要有东西在盘上撑着。'
          )
        }
        const found = await resolveEvidence(root(), evidence)
        if (!found.ok) {
          return (
            `REFUSED: 引用不到证据 "${evidence}"。\n` +
            '这两处都没有它（' + path.join(root(), 'evidence') + ' / ' + path.join(root(), 'findings') + '）。\n' +
            '先产出证据（evidence_render 渲染，或 board_finding_add 记一张发现卡），再回来推状态。'
          )
        }
      }

      entry.status = status
      if (args.cve) entry.cve = String(args.cve)
      if (evidence !== '') entry.evidence = evidence
      entry.promotions = [
        ...(entry.promotions ?? []),
        {
          from: previous,
          to: status,
          reason: String(args.reason),
          evidence: evidence === '' ? null : evidence,
          at: nowIso(),
          by: caller,
        },
      ]
      entry.updated_at = nowIso()
      entry.updated_by = caller
      await writeJson(file, entry)
      return (
        `PROMOTED ${entry.id}: ${previous} -> ${status}\n` +
        `reason recorded: ${args.reason}` +
        (evidence === '' ? '' : `\nevidence: ${evidence}`)
      )
    },
  })

  register({
    name: 'vdb_build',
    description:
      'Get the build playbook for one fingerprint: the research procedure, source priority, collection discipline and body template — plus what already exists so you top up instead of rebuilding. This is how the knowledge base grows; there is no 0day feed to subscribe to.',
    parameters: {
      fingerprint: { type: 'string', required: true },
      product_hint: { type: 'string', description: 'Vendor/product clue to narrow the research.' },
    },
    async run(args) {
      const fingerprint = String(args.fingerprint)
      const hintLine =
        args.product_hint && String(args.product_hint) !== ''
          ? `Product clue: ${args.product_hint} — confirm vendor and version line around it first.`
          : 'Product clue: none given. Confirm the vendor and full product name before researching.'
      const existing = (await listEntries(root())).filter((e) => e.fingerprint === fingerprint)
      const coverage =
        existing.length === 0
          ? 'COVERAGE: no entries for this fingerprint yet — build from scratch.'
          : `COVERAGE: ${existing.length} existing entr${existing.length === 1 ? 'y' : 'ies'} — do NOT rebuild these, only top up what is missing:\n` +
            existing.map((e) => `  [${e.id}] (${e.status}) ${e.title}`).join('\n')
      return `${BUILD_PLAYBOOK(fingerprint, hintLine)}\n\n---\n\n${coverage}`
    },
  })

  register({
    name: 'vdb_import',
    description:
      'Bulk-import raw feed records (NVD / OSV / KEV shape) as draft entries. This is the raw layer: records arrive keyed by CVE with no verification chain, so every imported entry is marked source=feed and status=draft, and none of them should be treated as an attack path until someone builds one out.',
    parameters: {
      path: { type: 'string', description: 'Path to a JSON file holding an array of records.' },
      json: { type: 'string', description: 'Inline JSON array of records (alternative to path).' },
      fingerprint_prefix: { type: 'string', description: 'Prefix for records that carry no fingerprint.' },
    },
    async run(args, caller) {
      let raw = null
      if (args.path) {
        const text = await fs.readFile(String(args.path), 'utf8')
        raw = JSON.parse(text)
      } else if (args.json) {
        raw = JSON.parse(String(args.json))
      } else {
        return 'ERROR: provide path or json'
      }
      const records = Array.isArray(raw) ? raw : Array.isArray(raw?.vulnerabilities) ? raw.vulnerabilities : null
      if (!records) return 'ERROR: expected a JSON array, or an object with a `vulnerabilities` array'
      const prefix = args.fingerprint_prefix ? String(args.fingerprint_prefix) : 'unclassified'
      let imported = 0
      const skipped = []
      const existing = await listEntries(root())
      const seen = new Set(existing.map((e) => `${e.cve ?? ''}::${e.fingerprint}`))
      for (const r of records) {
        const cve = r?.cve ?? r?.id ?? r?.aliases?.[0] ?? null
        const summary = r?.summary ?? r?.description ?? r?.title ?? ''
        const fingerprint = r?.fingerprint ?? (cve ? `${prefix}:${cve}` : null)
        if (!fingerprint) {
          skipped.push('record without cve/fingerprint')
          continue
        }
        if (seen.has(`${cve ?? ''}::${fingerprint}`)) {
          skipped.push(`${cve ?? fingerprint} (already present)`)
          continue
        }
        const entry = {
          id: newId('vdb'),
          fingerprint,
          slug: slugify(cve ?? summary.slice(0, 40) ?? 'imported'),
          title: String(r?.title ?? summary.slice(0, 120) ?? cve ?? 'imported record'),
          vuln_type: r?.vuln_type ?? null,
          severity: SEVERITIES.includes(String(r?.severity).toLowerCase()) ? String(r.severity).toLowerCase() : null,
          score_hint: r?.cvss_score !== undefined ? String(r.cvss_score) : null,
          cve: cve ? String(cve) : null,
          content_md:
            `### 信息概览\n- 来源：imported feed record (未核实)\n- CVE：${cve ?? '未分配'}\n\n` +
            `### 原始描述\n${String(summary)}\n\n` +
            `### 待补充\n本条目由原始 feed 导入，尚无验证链。需要 ` +
            `\`vdb_build fingerprint="${fingerprint}"\` 补出利用/成功判定/坑点后才能作为攻击路径使用。`,
          references: Array.isArray(r?.references)
            ? r.references.map((x) => (typeof x === 'string' ? x : x?.url)).filter(Boolean)
            : [],
          source: 'feed',
          status: 'draft',
          supersedes: null,
          promotions: [],
          created_at: nowIso(),
          created_by: caller,
          updated_at: nowIso(),
          updated_by: caller,
        }
        await writeJson(path.join(root(), 'vdb', 'entries', `${entry.id}.json`), entry)
        seen.add(`${cve ?? ''}::${fingerprint}`)
        imported++
      }
      return JSON.stringify(
        {
          imported,
          skipped: skipped.length,
          skipped_reasons: skipped.slice(0, 10),
          note: 'Imported entries are raw feed records: no verification chain, all draft. They are retrieval targets, not attack paths, until built out with vdb_build.',
        },
        null,
        2,
      )
    },
  })

  register({
    name: 'vdb_stats',
    description:
      'Knowledge base statistics: totals by status and source, plus a per-fingerprint rollup. Read this to see where the base is thin — a fingerprint with only draft entries has no verified attack path behind it.',
    parameters: { limit: { type: 'string', description: 'Max fingerprints in the rollup (default 25).' } },
    async run(args) {
      const limit = Math.max(1, Math.min(500, Number(args.limit ?? 25) || 25))
      const all = await listEntries(root())
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, all.filter((e) => e.status === s).length]))
      const bySource = Object.fromEntries(SOURCES.map((s) => [s, all.filter((e) => e.source === s).length]))
      const fingerprints = new Map()
      for (const e of all) {
        const row = fingerprints.get(e.fingerprint) ?? { fingerprint: e.fingerprint, total: 0, draft: 0, verified: 0, weaponized: 0, last_update: null }
        row.total++
        row[e.status] = (row[e.status] ?? 0) + 1
        if (!row.last_update || e.updated_at > row.last_update) row.last_update = e.updated_at
        fingerprints.set(e.fingerprint, row)
      }
      const rollup = [...fingerprints.values()].sort((a, b) => b.total - a.total)
      return JSON.stringify(
        {
          total: all.length,
          by_status: byStatus,
          by_source: bySource,
          coverage_note:
            all.length === 0
              ? 'The knowledge base is empty. It ships that way: content comes from your own research and from vdb_import.'
              : undefined,
          fingerprints: rollup.slice(0, limit),
          fingerprints_total: rollup.length,
        },
        null,
        2,
      )
    },
  })
}

export default { name, inject, apply }
