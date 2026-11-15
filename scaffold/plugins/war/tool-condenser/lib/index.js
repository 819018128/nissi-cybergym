/**
 * war-tool-condenser - bounded condensation of large tool output (LIVE)
 *
 * MEASURED JUSTIFICATION (2026-11-11, one live war-lead session, 19 minutes):
 *   - 36 tool results exceeded 8 KB
 *   - cumulative 1,516,217 bytes (~1.45 MB) of model-facing text
 *   - largest single result: project_map = 736,705 bytes (720 KB)
 *   - six results over 40 KB (pwsh 64,147 / 64,136 / 62,384 / 61,258 / 60,746 / 43,442)
 * Earlier historical measurement over 3 sessions: tool output was 6.19 MB raw but
 * 1.65 GB of compounded context traffic (each result is re-carried by every later
 * request, 272 times on average) - roughly 70% of all context volume.
 *
 * WHAT IT DOES
 *   On host event `tools/post-execute` (waterfall), when the model-facing content of
 *   a successful tool result exceeds `condenseBytes`:
 *     1. write the complete text to <spillDir>/<callId>.txt
 *     2. replace the model-facing projection with a short preview + the spill path
 *   The model can still read the whole thing with the normal `read` tool. Nothing is
 *   discarded - it is moved out of the per-request prefix.
 *
 * CONTRACT (verified against dsh-tools/lib/types/index.d.ts, not guessed)
 *   'tools/post-execute'(exec: ToolExecution, result: Readonly<ToolExecutionResult>,
 *                        next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
 *   ToolExecutionResult.content: ContentBlock[]            <- model-facing projection
 *   PostToolDecision =
 *     { kind:'accept', content?: ContentBlock[] }          <- what we return
 *   | { kind:'accept', value: JsonValue }                  <- mutually exclusive with content
 *   | { kind:'block', feedback: ContentBlock[] }
 *
 * SAFETY
 *   - never throws: any failure returns the host's own decision
 *   - error results are never condensed (a stack trace is usually the whole point)
 *   - only acts when the default decision carries `content`; a `value`-only decision
 *     is left untouched (the two accept variants are mutually exclusive)
 *   - spill failure keeps the original projection rather than losing content
 *   - degrades to observation (log only) when `enabled` is false
 *
 * ENCODING WARNING: edit this file with a UTF-8 safe writer only. Keep comments ASCII.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export const name = 'war-tool-condenser'

/** Condense only above this many bytes of model-facing content. */
export const DEFAULT_CONDENSE_BYTES = 8192
/** How many leading characters of the original text the preview keeps. */
export const DEFAULT_PREVIEW_CHARS = 2048

/** Join the text blocks of a ContentBlock[] into one string (never throws). */
export function textBlocksOf(content) {
  try {
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') parts.push(block)
      else if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
  } catch {
    /* unreadable -> empty */
  }
  return ''
}

/** Byte length of the model-facing content (never throws). */
export function measureContentBytes(content) {
  try {
    if (typeof content === 'string') return Buffer.byteLength(content, 'utf8')
    if (!Array.isArray(content)) return 0
    let n = 0
    for (const block of content) {
      if (typeof block === 'string') n += Buffer.byteLength(block, 'utf8')
      else if (block && typeof block.text === 'string') n += Buffer.byteLength(block.text, 'utf8')
      else if (block != null) n += Buffer.byteLength(JSON.stringify(block), 'utf8')
    }
    return n
  } catch {
    return 0
  }
}

/** Filesystem-safe file name from a call id. */
export function spillNameOf(callId) {
  const raw = String(callId ?? '').trim()
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return (safe === '' ? 'call' : safe) + '.txt'
}

/**
 * Build the condensed model-facing content.
 * @returns ContentBlock[] presenting a preview plus the spill path
 */
export function condensedContent(text, opts) {
  const previewChars = opts.previewChars
  const preview = text.slice(0, previewChars)
  const totalBytes = Buffer.byteLength(text, 'utf8')
  const totalChars = text.length
  const head =
    '[condensed] original output was ' + totalBytes + ' bytes (' + totalChars + ' chars). ' +
    'The complete text is on disk at:\n  ' + opts.spillPath + '\n' +
    'Read that file (offset/limit) to inspect any part of it.\n' +
    'First ' + previewChars + ' characters follow.\n\n' +
    '-------- preview --------\n'
  const tail =
    text.length > previewChars
      ? '\n-------- end preview (' + (totalChars - previewChars) + ' chars omitted) --------'
      : ''
  return [{ type: 'text', text: head + preview + tail }]
}

export function apply(ctx, config) {
  const cfg = config ?? {}
  const root = typeof cfg.root === 'string' && cfg.root ? cfg.root : (process.env.WAR_ROOT || '<HOME>/.war')
  const logDir = path.join(root, '_broker')
  // Spill MUST NOT live inside the war hive: the war plugins walk that root
  // synchronously on the main thread, and hundreds of 8-700 KB spill files would
  // recreate the exact scan cost that was cleaned up earlier (601 MB / 21k files
  // once turned a single walk into 11 seconds).
  const home = process.env.DSH_HOME || '<HOME>/.dsh'
  const spillDir =
    typeof cfg.spillDir === 'string' && cfg.spillDir ? cfg.spillDir : path.join(home, '_spill', 'war')
  const logFile = path.join(logDir, 'condenser.jsonl')
  const threshold = typeof cfg.condenseBytes === 'number' ? cfg.condenseBytes : DEFAULT_CONDENSE_BYTES
  const previewChars = typeof cfg.previewChars === 'number' ? cfg.previewChars : DEFAULT_PREVIEW_CHARS
  const enabled = cfg.enabled === true

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

  void log({ at: new Date().toISOString(), kind: 'startup', enabled, threshold, previewChars, spillDir })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Only condense for the lead: the `war` preset also runs for worker subagents,
    // whose outputs stay small and whose sessions are short-lived.
    if (String(exec?.agent?.session?.header?.origin ?? '') === 'subagent') return next()
    const base = await next()
    try {
      if (base === undefined || base.kind !== 'accept') return base
      // Error output is the evidence; never condense it.
      if (result !== undefined && result !== null && result.isError === true) return base

      // WHERE the text lives (verified with a live in-host probe, not guessed):
      //   default decision  = { kind: 'accept' }            <- no content, no value
      //   result.content    = [{ type: 'text', text: ... }]  <- the model-facing text
      //   result.value      = { kind, exitCode, stdout, stderr, ... }
      // So the source MUST be result.content. An earlier version required
      // base.content and therefore never fired at all.
      const content = Array.isArray(result?.content)
        ? result.content
        : Array.isArray(base.content)
          ? base.content
          : null
      if (content === null) return base

      const bytes = measureContentBytes(content)
      if (bytes < threshold) return base

      const text = textBlocksOf(content)
      if (text.length === 0) return base

      const tool = String(exec?.name ?? '?')
      const callId = String(exec?.rootCallId ?? '')
      const fileName = callId === '' ? spillNameOf(tool + '-' + Date.now()) : spillNameOf(callId)
      const spillPath = path.join(spillDir, fileName)

      if (!enabled) {
        void log({ at: new Date().toISOString(), kind: 'would-condense', tool, bytes, threshold, enabled })
        return base
      }

      try {
        await fs.mkdir(spillDir, { recursive: true })
        await fs.writeFile(spillPath, text, 'utf8')
      } catch (error) {
        // Spilling failed: keep the original projection rather than losing content.
        void log({ at: new Date().toISOString(), kind: 'spill-failed', tool, bytes, error: String(error?.message ?? error) })
        return base
      }

      const condensed = condensedContent(text, { previewChars, spillPath })
      void log({ at: new Date().toISOString(), kind: 'condensed', tool, bytes, previewChars, spillPath, enabled })
      return { kind: 'accept', content: condensed }
    } catch {
      return base
    }
  })
}
