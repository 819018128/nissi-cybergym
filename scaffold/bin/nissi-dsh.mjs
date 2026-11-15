#!/usr/bin/env node
/**
 * Nissi 入口 —— 把 **DSH 内核**（本仓库 `dsh/`，整体移植自 @deepseek-ai/dsh）当作 Nissi 自己的引擎来启动。
 *
 * 定位（2026-11-13，用户定调）：
 *   **Nissi 是独立的 harness，内核整体移植 DSH，然后在其上做个性化。**
 *   本文件不做"再实现一遍"，它只做三件事：
 *     1. 把内核的 home **无条件**指到 Nissi 自己的数据根 —— 绝不继承外部的 `DSH_HOME`；
 *     2. 把品牌与默认 preset 换成 Nissi 的（后面几步做，先保证能跑）；
 *     3. 其余参数**原样转发**给 DSH 内核（`--profile web` / `headless` / `tui` / `--patch` …）。
 *
 * ── 硬规则一：DSH_HOME 必须由本文件决定 ──────────────────────────────────────
 * 曾经的写法是 `process.env.DSH_HOME ?? kernelHome`。它有一个隐蔽后果：
 * 只要在**已有 DSH 环境的 shell 里**启动（比如从 DSH 自己的终端里），
 * `DSH_HOME` 早就被设成了 `~/.dsh`，于是 Nissi 静默地跑在**真实 DSH 的家**上 ——
 * 同一批 profiles / 同一批 patch / 同一批会话 / 同一份凭据。那不是"两个独立 harness"，
 * 那是同一个 harness 换了个人叫它。
 * 现在改为**无条件覆盖**：外部 DSH_HOME 一律剥掉，要换家只能用 Nissi 自己的变量
 * （`NISSI_DSH_HOME` 或 `NISSI_ROOT`）。
 *
 * ── 硬规则二：内核布局是 0.2.1 的，不是 0.1.1 的 ────────────────────────────
 * 0.1.1 时 dsh 包自带 `config/` 与内嵌 node_modules，内核在 `dsh/lib/bin.js`。
 * 0.2.1 起 `files` 收窄为 `lib/*.js` + `lib/types/*.d.ts`，preset 搬进独立包，
 * 依赖平铺在安装树 `node_modules/` 里，所以内核在：
 *   dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
 * 换内核版本时这里最容易错 —— 下面显式断言，不靠"应该能找到"。
 *
 * 为什么不直接改内核的 bin.js：
 *   那是移植来的构建产物（chunk 名带 hash，上游升级即失效）。个性化留在入口层，
 *   内核保持原样 —— 这是"在其上做二次开发"最省力的切法。
 *
 * 用法与 DSH 完全一致（因为转发）：
 *   node bin/nissi-dsh.mjs --version
 *   node bin/nissi-dsh.mjs web --port 7795 --no-open
 *   node bin/nissi-dsh.mjs --profile headless "run the tests"
 *
 * 环境变量：
 *   NISSI_DSH_HOME   直接指定内核 home（最高优先；用于探针/多实例）
 *   NISSI_ROOT       Nissi 数据根，内核 home 取 `<NISSI_ROOT>/dsh-home`（默认 `~/.nissi`）
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const KERNEL = join(ROOT, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

if (!existsSync(KERNEL)) {
  console.error(`✗ 找不到内核：${KERNEL}`)
  console.error('  期望布局是 0.2.x：dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  console.error('  （0.1.x 的 dsh/lib/bin.js 是另一套布局，不能混用。换机器先重跑 scripts/vendor-dsh.mjs）')
  process.exit(1)
}

/**
 * 内核 home 的解析顺序（第一条非空即止）：
 *   1. `NISSI_DSH_HOME` —— 显式指定，探针与多实例用；
 *   2. `<NISSI_ROOT>/dsh-home`，`NISSI_ROOT` 缺省为 `~/.nissi`。
 *
 * ⚠ 这里**故意不读 `process.env.DSH_HOME`**：见文件头"硬规则一"。
 */
function resolveKernelHome() {
  const explicit = (process.env.NISSI_DSH_HOME ?? '').trim()
  if (explicit !== '') {
    mkdirSync(explicit, { recursive: true })
    return { home: explicit, why: 'NISSI_DSH_HOME' }
  }
  const rootEnv = (process.env.NISSI_ROOT ?? '').trim()
  const root = rootEnv === '' ? join(homedir(), '.nissi') : rootEnv
  const home = join(root, 'dsh-home')
  mkdirSync(home, { recursive: true })
  return { home, why: rootEnv === '' ? '~/.nissi/dsh-home' : 'NISSI_ROOT/dsh-home' }
}

const { home: kernelHome, why } = resolveKernelHome()

/**
 * 剥离会污染"独立性"的继承变量。
 *
 * 剥之前先记下来 —— 静默改环境正是本项目最恨的那类失败：现象是"什么都没变"，
 * 真相是"变的东西没人说"。
 */
const INHERITED = ['DSH_HOME', 'DSH_WEB_URL', 'DSH_WEB_MODE']
const stripped = []
const env = { ...process.env }
for (const key of INHERITED) {
  if (key in env) {
    stripped.push(`${key}=${env[key]}`)
    delete env[key]
  }
}
env.DSH_HOME = kernelHome

/**
 * 红队引擎目录 —— 给 nissi-redteam-workbench 用。
 *
 * 为什么必须由入口层给：rtwb 默认从安装路径上溯 4 层推 `<root>/redteam-recon`。
 * 装在 `<NISSI>\plugins\redteam-workbench\lib` 时，上溯 4 层是 `E:\` ——
 * 又是一个「安静指错」：工具照常注册，一调用才说引擎不可达。
 * 插件本身把 `RT_HOME` 放在最高优先，所以这里显式注入 `<NISSI_ROOT>/redteam-recon`。
 * （Kali 已卸载，kali-bridge 那条 SSH 路线不再使用，故只注入 RT_HOME。）
 */
const rtHome = (process.env.RT_HOME ?? '').trim() !== '' ? process.env.RT_HOME.trim() : join(dirname(kernelHome), 'redteam-recon')
env.RT_HOME = rtHome
if (!existsSync(join(rtHome, 'rt_auto.py'))) {
  console.error(`[nissi] ⚠ 红队引擎不完整：${rtHome} 缺 rt_auto.py`)
  console.error('[nissi]   rtwb_* 工具会注册但调用必然失败 —— 先跑 node scripts/import-rt-engine.mjs')
}

/**
 * Python 解释器 —— 同样显式给定。
 *
 * 为什么不能指望插件自己在 PATH 上找：DSH 的 shell 执行器跑在它自己的环境里，
 * 实测 `python` / `python3` 都解析失败 ⇒ 引擎「不可达」⇒ 工具全部空转。
 * 这类失败最贵：它看起来像「目标上没东西」。
 * 这里在入口层用 where 解析出**绝对路径**注入 RT_PYTHON，解析不到就明确报出来。
 */
if ((process.env.RT_PYTHON ?? '').trim() === '') {
  let found = ''
  for (const name of ['python', 'python3', 'py']) {
    try {
      const out = execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '')[0]
      if (first !== undefined) {
        found = first
        break
      }
    } catch {
      /* 试下一个 */
    }
  }
  if (found !== '') {
    env.RT_PYTHON = found
  } else {
    console.error('[nissi] ⚠ 没找到 python 解释器，rtwb_* 引擎工具会失败；用 RT_PYTHON 指定一个绝对路径')
  }
}


const args = process.argv.slice(2)

// 只在剥离过继承变量时报一句（正常从干净 shell 启动时这里不说话）。
if (stripped.length > 0) {
  console.error(`[nissi] 已剥掉继承的 DSH 环境变量（保持独立）：${stripped.join('、')}`)
  console.error(`[nissi] 内核 home → ${kernelHome}（来自 ${why}）`)
}

const child = spawn(process.execPath, [KERNEL, ...args], {
  stdio: 'inherit',
  env,
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
child.on('error', (error) => {
  console.error(`✗ 启动内核失败：${error.message}`)
  process.exit(1)
})
