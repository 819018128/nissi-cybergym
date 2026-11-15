/**
 * hive-egress — per-engagement egress control: one proxy profile per engagement,
 * a three-state view, a liveness probe, command wrapping, and a fail-closed gate.
 *
 * WHAT THIS IS FOR (read this before changing the gate)
 * ----------------------------------------------------
 * This is an OPSEC and attribution control, not a performance feature. Three
 * jobs, in order of importance:
 *
 *   1. FAIL CLOSED. Once egress is ENABLED, a target-touching command whose
 *      traffic would not go through the proxy is REFUSED — it is not silently
 *      sent direct. The failure this prevents is the worst kind in offensive
 *      work: the proxy dies, every tool quietly falls back to the operator's
 *      real source address, and nothing in the output says so. That is why the
 *      state is three-valued rather than a boolean:
 *
 *        disabled — egress was never enabled; direct traffic is CORRECT, not a
 *                   leak. Tools run normally.
 *        enabled  — egress is on and the probe passed; target-touching commands
 *                   must carry proxy evidence or they are refused.
 *        down     — egress is on but unreachable. Nothing target-touching runs,
 *                   with or without proxy evidence, until it recovers.
 *
 *   2. ONE SOURCE ADDRESS PER ENGAGEMENT. Every host in an engagement egresses
 *      through the same proxy, so the range side can attribute and count the
 *      engagement, and the operator's origin is not exposed.
 *
 *   3. AUDIT. Every profile change, probe result, enable/disable and gate denial
 *      is appended to a durable log.
 *
 * WHY A GATE AND NOT A REWRITE
 * ----------------------------
 * A `ToolGuard` is SYNCHRONOUS and returns a denial reason; it cannot rewrite a
 * call. So this plugin cannot inject `--proxy` into a command the way a platform
 * shell wrapper can. It does the next best thing and arguably the more honest
 * one: it REFUSES the unwrapped call and hands back the exact wrapped form via
 * `egress_wrap`, which the caller then runs. The gate reads only in-memory state
 * because it cannot touch the filesystem.
 *
 * The metadata guard matters: `169.254.169.254` and the cloud metadata hostnames
 * are in the default bypass set, so an HTTP proxy is never used to reach a
 * metadata endpoint — that would turn the engagement's own proxy into an SSRF
 * channel into the cloud account.
 */

import os from 'node:os'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const PROXY_TYPES = new Set(['http', 'https', 'socks5', 'socks4'])
const PROBE_TIMEOUT_MS = 5000
const MAX_PROFILES = 32

/**
 * Never routed through the engagement proxy. The last two are cloud metadata
 * services: proxying to them would make the engagement's proxy an SSRF path.
 */
const DEFAULT_BYPASS = ['127.0.0.1', 'localhost', '::1', '169.254.169.254', 'metadata.google.internal']

/** Tools whose traffic reaches a target, and the proxy flag each one takes. */
const TOOL_FLAGS = {
  curl: { style: 'url-flag', flag: '-x' },
  wget: { style: 'env' },
  nuclei: { style: 'url-flag', flag: '-proxy' },
  sqlmap: { style: 'eq-flag', flag: '--proxy' },
  nmap: { style: 'url-flag', flag: '--proxies' },
  masscan: { style: 'proxychains' },
  nikto: { style: 'env' },
  ffuf: { style: 'env' },
  gobuster: { style: 'env' },
  hydra: { style: 'proxychains' },
  fscan: { style: 'url-flag', flag: '-proxy' },
  fscanx: { style: 'url-flag', flag: '-proxy' },
  ssh: { style: 'proxychains' },
  nc: { style: 'proxychains' },
  netcat: { style: 'proxychains' },
  socat: { style: 'proxychains' },
}

/** A target-touching tool name appearing as a command word. */
const NETWORK_TOOL_RE = new RegExp(
  String.raw`(?:^|[\s;|&(])(?:${Object.keys(TOOL_FLAGS).join('|')})(?:\.exe)?(?=[\s;|&)]|$)`,
  'i',
)

/** Evidence that a command is already routed through a proxy. */
const PROXY_EVIDENCE = [
  /proxychains/i,
  /--proxies?\b/i,
  /-x\s+\S+/i,
  /--socks5/i,
  /HTTP_PROXY\s*=/i,
  /HTTPS_PROXY\s*=/i,
  /ALL_PROXY\s*=/i,
]

const nowIso = () => new Date().toISOString()
const newId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`

const commandTextOf = (args) => {
  if (typeof args === 'string') return args
  if (args && typeof args === 'object') {
    for (const key of ['command', 'cmd', 'script', 'input']) {
      if (typeof args[key] === 'string') return args[key]
    }
  }
  return ''
}

/* ───────────────────────── storage ───────────────────────── */

async function ensureRoot(root) {
  await fs.mkdir(path.join(root, 'egress', 'profiles'), { recursive: true })
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

async function listProfiles(root) {
  const dir = path.join(root, 'egress', 'profiles')
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const p = await readJson(path.join(dir, n))
    if (p) out.push(p)
  }
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
}

async function appendAudit(root, event) {
  const file = path.join(root, 'egress', 'audit.jsonl')
  await fs.appendFile(file, `${JSON.stringify({ at: nowIso(), ...event })}\n`, 'utf8')
}

/* ───────────────────── proxy url / wrapping (pure) ───────────────────── */

/** Mask a secret in any rendered URL. */
function renderProxyUrl(profile, { withSecret = false } = {}) {
  const scheme = profile.type === 'socks5' ? 'socks5' : profile.type === 'socks4' ? 'socks4' : 'http'
  const auth = profile.username
    ? `${profile.username}${withSecret && profile.password ? `:${profile.password}` : ':***'}@`
    : ''
  return `${scheme}://${auth}${profile.host}:${profile.port}`
}

/**
 * The command with proxy routing applied, or null when the tool has no known
 * flag form and proxychains is the only option (the caller decides).
 * Pure: the gate uses it too, so the remedy it prints is the remedy that works.
 */
function wrapCommand(command, profile) {
  const url = renderProxyUrl(profile, { withSecret: true })
  const safeUrl = renderProxyUrl(profile, { withSecret: false })
  const match = command.match(NETWORK_TOOL_RE)
  if (!match) return null
  const tool = match[0].trim().toLowerCase().replace(/\.exe$/, '').replace(/^[\s;|&(]+/, '')
  const spec = TOOL_FLAGS[tool]
  if (!spec) return null
  if (spec.style === 'url-flag' || spec.style === 'eq-flag') {
    const separator = spec.style === 'eq-flag' ? '=' : ' '
    // `match[0]` carries its leading delimiter, so the flag needs its own space
    // or the result reads `curl-x …`, which does not run at all.
    const splice = (m) => `${m} ${spec.flag}${separator}${url}`
    const spliceSafe = (m) => `${m} ${spec.flag}${separator}${safeUrl}`
    return {
      tool,
      wrapped: command.replace(NETWORK_TOOL_RE, splice),
      display: command.replace(NETWORK_TOOL_RE, spliceSafe),
      note: `injected ${spec.flag} for ${tool}`,
    }
  }
  if (spec.style === 'env') {
    return {
      tool,
      wrapped: `HTTP_PROXY=${url} HTTPS_PROXY=${url} ALL_PROXY=${url} ${command}`,
      display: `HTTP_PROXY=${safeUrl} HTTPS_PROXY=${safeUrl} ALL_PROXY=${safeUrl} ${command}`,
      note: `prefixed proxy environment for ${tool}`,
    }
  }
  return {
    tool,
    wrapped: `proxychains4 -q ${command}`,
    display: `proxychains4 -q ${command}`,
    note: `${tool} needs proxychains (no reliable native proxy flag); point proxychains at ${safeUrl}`,
  }
}

function hasProxyEvidence(command) {
  return PROXY_EVIDENCE.some((re) => re.test(command))
}

/* ───────────────────────────── plugin ───────────────────────────── */

export const name = 'hive-egress'
export const inject = ['tools']

export function apply(ctx, config) {
  const configuredRoot = typeof config?.root === 'string' && config.root ? config.root : null
  /* 兜底是**绝对路径**，且**刻意不是真板面** ——
   未配置 root 时写到 ~/.dsh/hive-board（隔离、可丢弃），而不是 cwd（换目录就丢 ✗）
   也不是 ~/.war（兜底绝不能静默污染生产数据 ✗）。
   生产上走不到这一支：两个预设都显式配了绝对 root。 */
  const root = () => configuredRoot ?? path.join(os.homedir(), '.dsh', 'hive-board')

  /**
   * Mirror the synchronous gate reads. `enabled` and `healthy` are the whole
   * point: a three-valued decision cannot be made from a boolean.
   */
  const state = { enabled: false, healthy: false, profile: null, checked_at: null, message: '' }

  const egressView = () => {
    if (!state.enabled) return { state: 'disabled', healthy: null, message: 'Egress is not enabled; tools reach targets directly. This is correct, not a leak.' }
    if (!state.healthy) return { state: 'down', healthy: false, message: 'Egress is ENABLED but the proxy is unreachable. Target-touching commands are refused until it recovers — do NOT fall back to direct.' }
    return { state: 'enabled', healthy: true, message: 'Egress is enabled and healthy; target-touching commands must carry proxy routing.' }
  }

  /** Load persisted state at mount, so a restart does not silently un-gate. */
  async function hydrate() {
    await ensureRoot(root())
    const saved = await readJson(path.join(root(), 'egress', 'state.json'))
    if (saved && saved.enabled) {
      state.enabled = true
      state.profile = saved.profile ?? null
      state.checked_at = saved.checked_at ?? null
      // A persisted "enabled" is NOT a healthy claim: until this process probes
      // the proxy itself, the honest state is down. Fail closed across restart.
      state.healthy = false
      state.message = 'enabled before restart; probe again with egress_probe'
    }
  }
  void hydrate()

  /* ── the fail-closed gate ─────────────────────────────────────── */

  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        const toolName = String(exec?.name ?? '')
        if (toolName !== 'bash' && toolName !== 'pwsh') return undefined
        const command = commandTextOf(exec?.arguments)
        if (command === '' || !NETWORK_TOOL_RE.test(command)) return undefined

        if (!state.enabled) return undefined

        if (!state.healthy) {
          return (
            `HIVE EGRESS GATE: refused \`${toolName}\` because this looks like target-touching traffic and egress is ENABLED but DOWN. ` +
            `Running it now would send traffic from the operator's real address. ` +
            `Bring the proxy back and re-probe with egress_probe, or deliberately disable egress with egress_disable if direct traffic is intended.`
          )
        }

        if (hasProxyEvidence(command)) return undefined

        const wrapped = state.profile ? wrapCommand(command, state.profile) : null
        const remedy = wrapped
          ? `Run this instead: ${wrapped.display}`
          : `No native proxy form is known for this command; route it through proxychains4 pointed at ${state.profile ? renderProxyUrl(state.profile) : '<profile>'}. Call egress_wrap to get the exact form.`
        return (
          `HIVE EGRESS GATE: refused \`${toolName}\` because egress is ENABLED and this target-touching command carries no proxy routing. ` +
          `Sending it as written would bypass the engagement's egress. ${remedy}`
        )
      }),
    'tools.guard(hive:egress)',
  )

  /* ── tools ────────────────────────────────────────────────────── */

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
            if (caller === null && spec.needsCaller !== false) {
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
    name: 'egress_profile_set',
    description:
      'Create or update the engagement egress profile. One profile is normally enough: every host in an engagement should leave through the same source address. The password is stored in the profile file — protect that file.',
    parameters: {
      name: { type: 'string', required: true, description: 'A label for this egress, e.g. "drill-egress".' },
      type: { type: 'string', required: true, description: 'http | https | socks5 | socks4' },
      host: { type: 'string', required: true },
      port: { type: 'string', required: true },
      username: { type: 'string' },
      password: { type: 'string' },
      bypass: { type: 'string', description: 'Comma-separated hosts that must never be proxied.' },
    },
    async run(args, caller) {
      const type = String(args.type)
      if (!PROXY_TYPES.has(type)) return `ERROR: type must be one of ${[...PROXY_TYPES].join(' | ')}`
      const port = Number(args.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return 'ERROR: port must be an integer in 1-65535'
      const existing = await listProfiles(root())
      const duplicate = existing.find((p) => p.name === String(args.name))
      if (!duplicate && existing.length >= MAX_PROFILES) return `ERROR: at most ${MAX_PROFILES} profiles`
      const bypass = args.bypass
        ? String(args.bypass).split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULT_BYPASS
      const profile = {
        id: duplicate?.id ?? newId('egress'),
        name: String(args.name),
        type,
        host: String(args.host),
        port,
        username: args.username ? String(args.username) : null,
        password: <REDACTED> ? String(args.password) : (duplicate?.password ?? null),
        bypass,
        created_at: duplicate?.created_at ?? nowIso(),
        updated_at: nowIso(),
        updated_by: caller,
      }
      await writeJson(path.join(root(), 'egress', 'profiles', `${profile.id}.json`), profile)

      // Re-pointing the active profile MUST also invalidate its health. An
      // earlier probe result describes the OLD endpoint; keeping it would let
      // the gate believe traffic is flowing through the new proxy while it is
      // actually still aimed at the old one — the exact silent-leak this plugin
      // exists to prevent.
      const wasActive = !state.profile || state.profile.id === profile.id
      if (wasActive) {
        state.profile = profile
        state.healthy = false
        state.checked_at = null
        state.message = 'profile changed; probe again with egress_probe'
        await writeJson(path.join(root(), 'egress', 'state.json'), {
          enabled: state.enabled,
          profile: state.profile,
          checked_at: null,
          healthy: false,
        })
      }

      await appendAudit(root(), { entity: 'egress', action: duplicate ? 'profile-updated' : 'profile-created', id: profile.id, by: caller })
      return (
        `SAVED ${profile.id} (${type} ${profile.host}:${profile.port}, bypass ${bypass.length} entries)\n` +
        (wasActive && state.enabled
          ? 'NOTE: this was the active profile, so egress health was reset — run egress_probe before target-touching commands.\n'
          : '') +
        JSON.stringify({ ...profile, password: <REDACTED> ? '***' : null }, null, 2)
      )
    },
  })

  register({
    name: 'egress_profile_list',
    description: 'List egress profiles with the password masked, plus the current egress state.',
    parameters: {},
    async run() {
      const profiles = await listProfiles(root())
      return JSON.stringify(
        {
          view: egressView(),
          active_profile_id: state.profile?.id ?? null,
          profiles: profiles.map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            endpoint: `${p.host}:${p.port}`,
            has_secret: <REDACTED>,
            bypass: p.bypass,
            url: renderProxyUrl(p),
          })),
        },
        null,
        2,
      )
    },
  })

  register({
    name: 'egress_probe',
    description:
      'Actively test the proxy endpoint by opening a TCP connection to host:port and measure latency. This is what promotes the state from down to enabled. Until it passes, target-touching commands stay refused.',
    parameters: {
      profile_id: { type: 'string', description: 'Defaults to the last-enabled profile.' },
    },
    async run(args) {
      let profile = null
      if (args.profile_id) {
        profile = await readJson(path.join(root(), 'egress', 'profiles', `${args.profile_id}.json`))
        if (!profile) return `ERROR: unknown profile_id ${args.profile_id}`
      } else {
        profile = state.profile ?? (await listProfiles(root()))[0] ?? null
      }
      if (!profile) return 'ERROR: no egress profile exists; create one with egress_profile_set'

      const started = Date.now()
      const result = await new Promise((resolve) => {
        const socket = net.connect({ host: profile.host, port: profile.port })
        const done = (ok, message) => {
          socket.destroy()
          resolve({ ok, message })
        }
        socket.setTimeout(PROBE_TIMEOUT_MS)
        socket.once('connect', () => done(true, `TCP connect to ${profile.host}:${profile.port} succeeded`))
        socket.once('timeout', () => done(false, `TCP connect timed out after ${PROBE_TIMEOUT_MS}ms`))
        socket.once('error', (err) => done(false, `TCP connect failed: ${err?.code ?? err?.message ?? String(err)}`))
      })
      const latency = Date.now() - started

      state.profile = profile
      state.healthy = result.ok
      state.checked_at = nowIso()
      state.message = result.message
      if (!state.enabled) state.enabled = state.enabled || false
      await writeJson(path.join(root(), 'egress', 'state.json'), {
        enabled: state.enabled,
        profile: state.profile,
        checked_at: state.checked_at,
        healthy: state.healthy,
      })
      await appendAudit(root(), {
        entity: 'egress',
        action: result.ok ? 'probe-ok' : 'probe-failed',
        id: profile.id,
        reason: result.message,
      })
      return JSON.stringify(
        { ok: result.ok, latency_ms: latency, endpoint: `${profile.host}:${profile.port}`, message: result.message, view: egressView() },
        null,
        2,
      )
    },
  })

  register({
    name: 'egress_enable',
    description:
      'Turn egress ON for this engagement. From this moment the fail-closed gate refuses target-touching commands that are unrouted, and refuses everything if the proxy is down. The profile must pass a probe before the state becomes enabled.',
    parameters: { profile_id: { type: 'string' } },
    async run(args, caller) {
      let profile = null
      if (args.profile_id) {
        profile = await readJson(path.join(root(), 'egress', 'profiles', `${args.profile_id}.json`))
        if (!profile) return `ERROR: unknown profile_id ${args.profile_id}`
      } else {
        profile = state.profile ?? (await listProfiles(root()))[0] ?? null
      }
      if (!profile) return 'ERROR: no egress profile exists; create one with egress_profile_set'
      state.enabled = true
      state.profile = profile
      await writeJson(path.join(root(), 'egress', 'state.json'), {
        enabled: true,
        profile,
        checked_at: state.checked_at,
        healthy: state.healthy,
      })
      await appendAudit(root(), { entity: 'egress', action: 'enabled', id: profile.id, by: caller })
      return JSON.stringify(
        {
          enabled: true,
          view: egressView(),
          note: state.healthy
            ? 'Proxy was already probed healthy; the gate now requires proxy routing on target-touching commands.'
            : 'Proxy has NOT passed a probe in this process. Until egress_probe succeeds, ALL target-touching commands are refused.',
        },
        null,
        2,
      )
    },
  })

  register({
    name: 'egress_disable',
    description:
      'Turn egress OFF. Direct traffic becomes correct again and the gate stops refusing unrouted commands. Disabling is a deliberate act — record why in the reason.',
    parameters: { reason: { type: 'string', description: 'Why egress is being disabled.' } },
    async run(args, caller) {
      state.enabled = false
      state.healthy = false
      await writeJson(path.join(root(), 'egress', 'state.json'), { enabled: false, profile: state.profile, checked_at: null, healthy: false })
      await appendAudit(root(), { entity: 'egress', action: 'disabled', id: state.profile?.id ?? null, reason: args.reason ? String(args.reason) : null, by: caller })
      return JSON.stringify({ enabled: false, view: egressView() }, null, 2)
    },
  })

  register({
    name: 'egress_status',
    description: 'Read the egress view: disabled | enabled | down, the active profile, the last probe result, and the recent audit trail.',
    parameters: { audit_limit: { type: 'string', description: 'How many audit entries to include (default 10).' } },
    async run(args) {
      const limit = Math.max(1, Math.min(200, Number(args.audit_limit ?? 10) || 10))
      let audit = []
      try {
        const text = await fs.readFile(path.join(root(), 'egress', 'audit.jsonl'), 'utf8')
        audit = text.trim().split('\n').filter(Boolean).slice(-limit).map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { raw: line }
          }
        })
      } catch {
        /* no audit yet */
      }
      return JSON.stringify(
        {
          view: egressView(),
          enabled: state.enabled,
          healthy: state.healthy,
          checked_at: state.checked_at,
          profile: state.profile ? { id: state.profile.id, type: state.profile.type, endpoint: `${state.profile.host}:${state.profile.port}`, url: renderProxyUrl(state.profile) } : null,
          audit,
        },
        null,
        2,
      )
    },
  })

  register({
    name: 'egress_wrap',
    description:
      'Return the exact command form that routes through the engagement proxy, for the tool named in the command. Use it when the gate refuses an unrouted command: run what this returns instead of the original.',
    parameters: {
      command: { type: 'string', required: true, description: 'The command you intend to run, unwrapped.' },
    },
    async run(args) {
      const profile = state.profile ?? (await listProfiles(root()))[0] ?? null
      if (!profile) return 'ERROR: no egress profile exists; create one with egress_profile_set'
      const command = String(args.command)
      if (!NETWORK_TOOL_RE.test(command)) {
        return `This command does not name a known target-touching tool, so no proxy form is known.\nIf it does reach a target, prefix it with proxychains4 pointed at ${renderProxyUrl(profile)}.`
      }
      if (hasProxyEvidence(command)) {
        return `This command already carries proxy routing, so the gate will allow it.\n\n${command}`
      }
      const wrapped = wrapCommand(command, profile)
      if (!wrapped) return `No wrapper form for this command; use proxychains4 pointed at ${renderProxyUrl(profile)}.`
      return JSON.stringify(
        {
          tool: wrapped.tool,
          note: wrapped.note,
          proxy: renderProxyUrl(profile),
          run_this: wrapped.display,
          bypass: profile.bypass,
          caveat: 'The rendered command masks the password as ***; the gate recognises the real form. Substitute the real secret yourself, or use a proxychains config file so the secret never enters the command line.',
        },
        null,
        2,
      )
    },
  })
}

export default { name, inject, apply }
