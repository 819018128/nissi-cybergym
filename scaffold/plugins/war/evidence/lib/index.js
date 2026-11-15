/**
 * hive-evidence — render HTTP exchanges and terminal sessions as PNG evidence
 * cards, using a headless browser that is already on the machine.
 *
 * A DELIBERATE DEPARTURE
 * ----------------------
 * The tool this replaces renders its output to look like a commercial
 * interception proxy's UI. This one does not, on purpose. When a screenshot is
 * the evidence, the single most damaging thing you can hand an opposing party
 * is a reason to ask "is this actually the tool it appears to be, or was it
 * drawn?" An evidence card should therefore be visibly NOT a screenshot of a
 * product: it states its own provenance (captured at, from where, by what
 * session) on the card itself, so nobody has to take the styling on trust.
 *
 * That is also why every card carries an integrity block: a SHA-256 over the
 * exact request and response bytes, and the raw byte counts. Anyone holding the
 * same capture can recompute it. A picture alone proves nothing; a picture with
 * a recomputable digest over stated bytes is a record.
 *
 * WHY HEADLESS CHROME VIA CLI, NOT A DRIVER LIBRARY
 * -------------------------------------------------
 * `chrome --headless --screenshot` needs no npm dependency, no browser download
 * and no version pairing, which matters on an offline engagement host. The
 * browser is already installed on virtually every machine this runs on, and the
 * plugin reuses whichever of Chrome or Edge it finds. A driver library would add
 * a dependency tree to a tool whose whole job is to be trustworthy and boring.
 *
 * Fonts: the card asks for a font stack that resolves to whatever monospace and
 * CJK faces the host already has. Nothing is bundled, so the plugin stays a few
 * kilobytes rather than carrying a 16 MB font file to draw a screenshot.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'

const run = promisify(execFile)

const KINDS = new Set(['http', 'terminal'])
const MAX_FIELD_BYTES = 512 * 1024
const RENDER_TIMEOUT_MS = 60_000
/** How long to wait for the screenshot file to appear after launching. */
const RENDER_SETTLE_MS = 30_000

/** Poll for a file that reaches `minBytes`. Returns its stat, or null on timeout. */
async function waitForFile(file, timeoutMs, minBytes = 1) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const stat = await fs.stat(file)
      if (stat.size >= minBytes) return stat
    } catch {
      /* not there yet */
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const nowIso = () => new Date().toISOString()

/** Candidate browser binaries, most preferred first. */
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

async function findBrowser() {
  if (process.env.HIVE_BROWSER) {
    try {
      await fs.access(process.env.HIVE_BROWSER)
      return process.env.HIVE_BROWSER
    } catch {
      /* fall through to discovery */
    }
  }
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      /* try the next one */
    }
  }
  return null
}

const byteLength = (s) => Buffer.byteLength(String(s ?? ''), 'utf8')

/** SHA-256 over the exact bytes shown on the card. Recomputable by a third party. */
function digest(...parts) {
  const h = createHash('sha256')
  for (const p of parts) h.update(Buffer.from(String(p ?? ''), 'utf8'))
  return h.digest('hex')
}

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * Colourise only enough to be readable: HTTP request line / status line, header
 * names, and a verdict marker. Everything else stays plain so nothing looks
 * embellished.
 */
function highlightHttp(text) {
  return escapeHtml(text)
    .split('\n')
    .map((line) => {
      if (/^HTTP\/[\d.]+ \d{3}/.test(line)) {
        const m = line.match(/^(HTTP\/[\d.]+) (\d{3})(.*)$/)
        const tone = Number(m[2]) >= 200 && Number(m[2]) < 300 ? 'ok' : Number(m[2]) >= 500 ? 'bad' : 'warn'
        return `<span class="status ${tone}">${m[1]} ${m[2]}</span>${m[3]}`
      }
      if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s/.test(line)) {
        return `<span class="reqline">${line}</span>`
      }
      const header = line.match(/^([A-Za-z0-9-]+):(.*)$/)
      if (header) return `<span class="hdr">${header[1]}:</span>${header[2]}`
      return line
    })
    .join('\n')
}

function cardHtml({ kind, title, meta, request, response, terminal, digestValue, capturedAt, sessionId }) {
  const metaRows = Object.entries(meta ?? {})
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `<div class="mrow"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join('')

  const body =
    kind === 'http'
      ? `<section class="pane">
           <h2>Request <span class="bytes">${byteLength(request)} bytes</span></h2>
           <pre class="code">${highlightHttp(request)}</pre>
         </section>
         <section class="pane">
           <h2>Response <span class="bytes">${byteLength(response)} bytes</span></h2>
           <pre class="code">${highlightHttp(response)}</pre>
         </section>`
      : `<section class="pane">
           <h2>Session <span class="bytes">${byteLength(terminal)} bytes</span></h2>
           <pre class="code term">${escapeHtml(terminal)}</pre>
         </section>`

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg:#f6f7f9; --card:#ffffff; --ink:#1b1f24; --dim:#5b6572;
    --line:#dfe3e8; --ok:#1a7f37; --warn:#9a6700; --bad:#b42318; --accent:#0b4f8a;
  }
  * { box-sizing: border-box; }
  body {
    margin:0; padding:24px; background:var(--bg); color:var(--ink);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; font-size:13px;
  }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  header { padding:14px 18px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 4px; font-size:15px; font-weight:600; }
  .sub { color:var(--dim); font-size:12px; }
  .provenance {
    margin-top:10px; padding:8px 10px; border-left:3px solid var(--accent);
    background:#f0f6fc; color:var(--dim); font-size:11.5px; line-height:1.5;
  }
  dl.meta { display:grid; grid-template-columns:auto 1fr; gap:2px 14px; margin:12px 0 0; }
  .mrow { display:contents; }
  dl.meta dt { color:var(--dim); font-size:11.5px; padding:1px 0; }
  dl.meta dd { margin:0; font-size:11.5px; padding:1px 0; word-break:break-all; }
  .pane { padding:12px 18px 16px; border-top:1px solid var(--line); }
  .pane:first-of-type { border-top:none; }
  h2 { margin:0 0 8px; font-size:12px; font-weight:600; color:var(--dim); text-transform:uppercase; letter-spacing:.04em; }
  .bytes { font-weight:400; text-transform:none; letter-spacing:0; color:#8a94a0; }
  pre.code {
    margin:0; padding:12px 14px; background:#0f1419; color:#dfe6ee; border-radius:6px;
    font-family: "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Microsoft YaHei Mono", monospace;
    font-size:11.5px; line-height:1.55; white-space:pre-wrap; word-break:break-all; overflow-wrap:anywhere;
  }
  pre.term { background:#101418; color:#cfe3d4; }
  .status { font-weight:700; }
  .status.ok { color:#4ade80; } .status.warn { color:#fbbf24; } .status.bad { color:#f87171; }
  .reqline { color:#7dd3fc; font-weight:600; }
  .hdr { color:#a5b4fc; }
  footer {
    padding:12px 18px 14px; border-top:1px solid var(--line); background:#fbfcfd;
    font-family: Consolas, "DejaVu Sans Mono", monospace; font-size:10.5px; color:var(--dim); line-height:1.6;
  }
  footer .hash { color:var(--ink); word-break:break-all; }
</style></head>
<body><div class="card">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="sub">${kind === 'http' ? 'HTTP exchange' : 'Terminal session'} · captured ${escapeHtml(capturedAt)}</div>
    <div class="provenance">
      本卡片由取证工具在本地渲染生成，<strong>不是第三方工具的界面截图</strong>。
      下方的完整性摘要可据此对同一次抓包重新计算。<br>
      Rendered locally by an evidence tool — not a screenshot of any third-party UI.
      The digest below is recomputable from the same capture.
    </div>
    ${metaRows ? `<dl class="meta">${metaRows}</dl>` : ''}
  </header>
  ${body}
  <footer>
    sha256(request+response) = <span class="hash">${escapeHtml(digestValue)}</span><br>
    captured_at = ${escapeHtml(capturedAt)} &nbsp; session = ${escapeHtml(sessionId)} &nbsp; renderer = hive-evidence
  </footer>
</div></body></html>`
}

/* ───────────────────────────── plugin ───────────────────────────── */

export const name = 'hive-evidence'
export const inject = ['tools']

export function apply(ctx, config) {
  const configuredRoot = typeof config?.root === 'string' && config.root ? config.root : null
  /* 兜底是**绝对路径**，且**刻意不是真板面** ——
   未配置 root 时写到 ~/.dsh/hive-board（隔离、可丢弃），而不是 cwd（换目录就丢 ✗）
   也不是 ~/.war（兜底绝不能静默污染生产数据 ✗）。
   生产上走不到这一支：两个预设都显式配了绝对 root。 */
  const root = () => configuredRoot ?? path.join(os.homedir(), '.dsh', 'hive-board')
  const outDir = () => path.join(root(), 'evidence')

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
            const caller = callerOf(exec)
            if (caller === null) {
              return 'ERROR: the runtime supplied no calling-session identity (exec.agent.id). Refusing.'
            }
            await fs.mkdir(outDir(), { recursive: true })
            return await spec.run(args, caller)
          } catch (error) {
            return `ERROR: ${error?.message ?? String(error)}`
          }
        },
      }),
    )
  }

  register({
    name: 'evidence_browser_check',
    description:
      'Report which headless browser this plugin will use, and whether it runs. Call this first if a render ever fails — the whole capability rests on a browser being present.',
    parameters: {},
    async run() {
      const browser = await findBrowser()
      if (!browser) {
        return JSON.stringify(
          {
            ok: false,
            message: 'No Chrome/Edge binary found. Set HIVE_BROWSER to an absolute browser path, or install one.',
            searched: BROWSER_CANDIDATES,
          },
          null,
          2,
        )
      }
      try {
        const { stdout, stderr } = await run(browser, ['--version'], { timeout: 15_000, windowsHide: true })
        const text = `${stdout ?? ''}${stderr ?? ''}`.trim()
        const version = text.match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? null
        return JSON.stringify(
          {
            ok: true,
            browser,
            version,
            // `--version` is best-effort: when an instance is already running,
            // the invocation can hand off and print a session notice instead.
            // The binary existing is the real precondition; a render retries
            // with an isolated profile so it cannot inherit that session.
            raw: version ? undefined : text.slice(0, 200),
          },
          null,
          2,
        )
      } catch (error) {
        return JSON.stringify({ ok: false, browser, message: String(error?.message ?? error).split('\n')[0] }, null, 2)
      }
    },
  })

  register({
    name: 'evidence_render',
    description:
      'Render an HTTP exchange or a terminal session as a PNG evidence card, and return its path plus the integrity digest. The card states its own provenance and carries a SHA-256 over the exact bytes shown, so the evidence does not rest on the image alone. Put the returned path on the finding card.',
    parameters: {
      kind: { type: 'string', required: true, description: 'http | terminal' },
      title: { type: 'string', required: true, description: 'Short evidence title, e.g. "Default creds accepted on /admin".' },
      request: { type: 'string', description: 'Raw HTTP request (kind=http).' },
      response: { type: 'string', description: 'Raw HTTP response (kind=http).' },
      terminal: { type: 'string', description: 'Command and output (kind=terminal).' },
      url: { type: 'string', description: 'Target URL, shown in the card metadata.' },
      note: { type: 'string', description: 'One line of context shown in the card metadata.' },
      filename: { type: 'string', description: 'Optional output basename (no extension).' },
    },
    async run(args, caller) {
      const kind = String(args.kind)
      if (!KINDS.has(kind)) return `ERROR: kind must be one of ${[...KINDS].join(' | ')}`
      if (kind === 'http') {
        if (!args.request) return 'ERROR: request is required when kind=http'
        if (!args.response) return 'ERROR: response is required when kind=http'
      } else if (!args.terminal) {
        return 'ERROR: terminal is required when kind=terminal'
      }
      const request = kind === 'http' ? String(args.request) : ''
      const response = kind === 'http' ? String(args.response) : ''
      const terminal = kind === 'terminal' ? String(args.terminal) : ''
      const oversized = [
        ['request', request],
        ['response', response],
        ['terminal', terminal],
      ].find(([, v]) => byteLength(v) > MAX_FIELD_BYTES)
      if (oversized) {
        return `ERROR: ${oversized[0]} is ${byteLength(oversized[1])} bytes; the limit is ${MAX_FIELD_BYTES}. Trim to the decisive exchange — a card that is 500 KB of log makes a worse exhibit, not a better one.`
      }

      const browser = await findBrowser()
      if (!browser) {
        return 'ERROR: no Chrome/Edge binary found for rendering. Set HIVE_BROWSER to an absolute path, or call evidence_browser_check for the searched locations.'
      }

      const capturedAt = nowIso()
      const digestValue = digest(request, '\n---\n', response, terminal)
      const meta = {
        url: args.url ? String(args.url) : undefined,
        note: args.note ? String(args.note) : undefined,
        request_bytes: kind === 'http' ? byteLength(request) : undefined,
        response_bytes: kind === 'http' ? byteLength(response) : undefined,
      }
      const html = cardHtml({ kind, title: String(args.title), meta, request, response, terminal, digestValue, capturedAt, sessionId: caller })

      const base = String(args.filename ?? `evidence-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '_')
      const htmlPath = path.join(outDir(), `${base}.html`)
      const pngPath = path.join(outDir(), `${base}.png`)
      await fs.writeFile(htmlPath, html, 'utf8')

      const height = kind === 'http' ? 1400 : 1000
      // A private profile directory is REQUIRED, not cosmetic. When an ordinary
      // Chrome instance is already running, a new invocation hands its command
      // line to that instance and exits: the headless flags are silently
      // ignored and no screenshot is written. An isolated --user-data-dir makes
      // this a genuinely separate browser, so the flags take effect.
      //
      // WHERE it lives matters as much as whether it exists. It used to be
      // created under outDir(), i.e. inside the shared hive root that every war
      // plugin walks on the main thread. The removal in `finally` below is
      // best-effort by necessity — on Windows the detached browser can still
      // hold these files when it runs — so one missed removal left a complete
      // Chrome profile (thousands of cache files) inside a directory that is
      // then re-scanned synchronously. A hundred of those turned a single hive
      // walk into ~11s of blocked event loop, which starved the host's SSE
      // stream and froze every open session. Putting the profile in the OS temp
      // directory makes "cleanup failed" a harmless event rather than a
      // growing tax on every later tool call.
      const profileName = `.chrome-profile-${process.pid}-${Date.now()}`
      let profileDir = path.join(os.tmpdir(), profileName)
      try {
        await fs.mkdir(profileDir, { recursive: true })
      } catch (error) {
        // Temp unavailable (read-only or full volume): fall back to the previous
        // location so rendering still works exactly as it did before.
        console.warn(
          `[hive-evidence] temp profile dir unavailable (${error?.message ?? String(error)}); falling back to ${outDir()}`,
        )
        profileDir = path.join(outDir(), profileName)
        await fs.mkdir(profileDir, { recursive: true })
      }
      const browserArgs = [
        '--headless=new',
        `--user-data-dir=${profileDir}`,
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        '--default-background-color=FFFFFFFF',
        '--virtual-time-budget=4000',
        `--window-size=1240,${height}`,
        `--screenshot=${pngPath}`,
        `file:///${htmlPath.replace(/\\/g, '/')}`,
      ]
      try {
        try {
          await run(browser, browserArgs, { timeout: RENDER_TIMEOUT_MS, windowsHide: true })
        } catch (error) {
          // A non-zero exit is NOT proof the render failed: Chrome's launcher
          // process can report an error while the browser it spawned carries on.
          // The file check below is the arbiter; the retry is best-effort.
          if (process.platform === 'win32') {
            await run(browser, [...browserArgs, '--no-sandbox'], { timeout: RENDER_TIMEOUT_MS, windowsHide: true }).catch(() => {})
          }
        }
      } finally {
        // Best-effort by design: the detached browser can still hold these files
        // on Windows, and a failed removal is NOT a render failure. It is still
        // worth saying out loud — a silently swallowed cleanup error is exactly
        // how a hundred stale profiles accumulated with nobody noticing.
        //
        // Same retry posture this plugin's own test teardown adopted after
        // hitting `ENOTEMPTY ... .chrome-profile-...` on 2026-11-05: Node only
        // retries EBUSY/ENOTEMPTY/EPERM, which is precisely the shape here.
        // The production path was left without it, which is why the debris
        // survived while the test suite stayed green.
        await fs
          .rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
          .catch((error) => {
            console.warn(
              `[hive-evidence] could not remove profile dir ${profileDir} (${error?.message ?? String(error)}); leaving it is harmless, delete it later`,
            )
          })
      }

      // Trust the FILE, not the exit code. Chrome's launcher often exits the
      // moment it has handed the real work to a detached browser process, so a
      // clean exit means nothing and a non-zero exit means even less. Poll for
      // the screenshot to actually appear.
      const stat = await waitForFile(pngPath, RENDER_SETTLE_MS, 512)
      if (!stat) {
        return (
          `ERROR: no screenshot appeared at ${pngPath} within ${RENDER_SETTLE_MS}ms. ` +
          `The browser process exited, so this is a render problem, not a slow machine. ` +
          `Call evidence_browser_check, then try running the browser by hand with ` +
          `--headless=new --screenshot=<path> on the same file:// URL.`
        )
      }
      const size = stat.size

      // The HTML is a byproduct; the PNG is the exhibit. Keeping the HTML would
      // let someone re-render with edited content, so it is removed.
      await fs.rm(htmlPath, { force: true })

      return JSON.stringify(
        {
          ok: true,
          path: pngPath,
          bytes: size,
          sha256_request_response: digestValue,
          captured_at: capturedAt,
          note: 'Attach this path to the finding card. The digest lets a third party recompute the same value from the same capture — the image alone is not the evidence.',
        },
        null,
        2,
      )
    },
  })

  register({
    name: 'evidence_list',
    description: 'List the evidence cards rendered so far, newest last, with sizes.',
    parameters: {},
    async run() {
      let names = []
      try {
        names = await fs.readdir(outDir())
      } catch {
        return JSON.stringify({ count: 0, cards: [] }, null, 2)
      }
      const cards = []
      for (const n of names.filter((x) => x.endsWith('.png')).sort()) {
        const stat = await fs.stat(path.join(outDir(), n))
        cards.push({ file: n, path: path.join(outDir(), n), bytes: stat.size, modified_at: stat.mtime.toISOString() })
      }
      return JSON.stringify({ count: cards.length, dir: outDir(), cards }, null, 2)
    },
  })
}

export default { name, inject, apply }
