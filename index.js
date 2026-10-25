// dsh-font-picker host half（静态插件，随 dsh web 常驻）
//
// 职责：
//   ① 枚举系统已装字体 —— 直接 node:child_process 跑 reg query（零第三方依赖）
//      排序键 = 字体文件 birthtime（安装时间），新 → 旧
//   ② 持久化当前选择到 $DSH_HOME\font-picker.json
//   ③ 首屏注入：把「当前选择」的 <style> 与 window.__DSH_FONT_PICKER__ 塞进 index.html
//      （字体清单**不**注入 —— 445 条太大，改走 HTTP API 按需取）
//   ④ HTTP API（同源 fetch）：
//        GET  /font-picker/api/fonts?q=&limit=   字体清单（过滤 + 分页）
//        GET  /font-picker/api/state             当前选择
//        POST /font-picker/api/set               写入选择
//        POST /font-picker/api/refresh           重新枚举
//
// 生命周期：枚举挂在 tapIndex 上 —— 每次页面加载（开窗 / F5）都会检查一次 TTL，
//   过期就重新枚举。这跟「Chromium 进程级缓存字体枚举、装完新字体必须重开窗口」
//   的节拍天然对齐：重开窗口 = 重新枚举，零手工步骤。

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** 插件名，必须与 package.json 的 name 一致。 */
export const name = 'dsh-font-picker'

/** 硬依赖：只需要 webServer（注册路由 + index 注入）。 */
export const inject = ['webServer']

/** 字体清单缓存寿命（毫秒）。超过就重新枚举一次。 */
const TTL_MS = 30 * 1000

/** Windows 系统字体目录（注册表里的相对文件名落在这里）。 */
const SYS_FONT_DIR = 'C:\\Windows\\Fonts\\'

/** 默认返回条数 / 上限。 */
const DEFAULT_LIMIT = 80
const MAX_LIMIT = 300

// ── 内存态 ───────────────────────────────────────────────────────────────────

/** 当前选择：空串 = 跟随 DSH 默认。 */
let state = { uiFont: '', codeFont: '', terminalFont: '' }

/** 字体清单（[{ name, file, installedAt }]），按 installedAt 倒序。 */
let fonts = []

/** fonts 的取用时间戳。 */
let fontsAt = 0

// ── 持久化 ───────────────────────────────────────────────────────────────────

/**
 * 状态文件的绝对路径：优先 $DSH_HOME，否则退回 ~/.dsh。
 * @returns 状态文件路径。
 */
function stateFilePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'font-picker.json')
}

/** 从磁盘读回选择；文件不存在或损坏时保持空态。 */
function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(), 'utf8'))
    state = {
      uiFont: typeof parsed.uiFont === 'string' ? parsed.uiFont : '',
      codeFont: typeof parsed.codeFont === 'string' ? parsed.codeFont : '',
      terminalFont: typeof parsed.terminalFont === 'string' ? parsed.terminalFont : '',
    }
  } catch (e) {
    state = { uiFont: '', codeFont: '', terminalFont: '' }
  }
}

/**
 * 把当前选择写回磁盘。
 * @returns 成功与否。
 */
function saveState() {
  try {
    const target = stateFilePath()
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(state, null, 2), 'utf8')
    return true
  } catch (e) {
    console.error('[dsh-font-picker] save state failed:', (e && e.message) || e)
    return false
  }
}

// ── 字体枚举 ─────────────────────────────────────────────────────────────────

/**
 * 解析 `reg query ...\Fonts` 的输出。
 *
 * 每行形如：
 *     Arial Bold (TrueType)    REG_SZ    arialbd.ttf
 *     Microsoft YaHei & Microsoft YaHei UI (TrueType)    REG_SZ    msyh.ttc
 *
 * 规则：剥掉尾部 `(TrueType)` 一类括号；按 `&` 拆成多个族名；
 * 跳过以 `@` 开头的竖排字体；**保留变体后缀**（Bold / Italic / Regular），
 * 因为用户明确要能选不同粗度。
 *
 * @param text - reg query 的原始 stdout。
 * @returns `[{ name, file }]`，未去重、未排序。
 */
export function parseFontRegistry(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('HKEY_') || trimmed.startsWith('Active code page')) continue
    // 值与名字之间通常有 4 个空格，但注过 tab 也会出现 —— 所以只要求「至少一个空白」。
    const matched = /^(.*?)\s+REG_SZ\s+(.*)$/.exec(trimmed)
    if (matched === null) continue
    let faceName = matched[1].trim()
    const file = matched[2].trim()
    faceName = faceName.replace(/\s*\((?:TrueType|OpenType|All res|PostScript[^)]*)\)\s*$/i, '').trim()
    if (faceName === '' || faceName.charAt(0) === '@') continue
    for (const part of faceName.split('&')) {
      const single = part.trim()
      if (single !== '') rows.push({ name: single, file })
    }
  }
  return rows
}

/**
 * 注册表里的文件名可能是相对（落在系统字体目录）或绝对（用户字体）。
 * @param file - 注册表给的文件名。
 * @returns 绝对路径。
 */
function resolveFontPath(file) {
  return /^[a-zA-Z]:\\/.test(file) ? file : SYS_FONT_DIR + file
}

/**
 * 取字体文件的安装时间（创建时间）。
 * @param path - 字体文件绝对路径。
 * @returns 毫秒时间戳；取不到返回 0。
 */
function installTime(path) {
  try {
    const info = statSync(path)
    return Math.round(info.birthtimeMs || info.mtimeMs || 0)
  } catch (e) {
    return 0
  }
}

/**
 * 跑 reg query 并整理成去重、按安装时间倒序的清单。
 * @returns `[{ name, file, installedAt }]`。
 */
function enumerateFonts() {
  const command = 'chcp 65001>nul & reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"'
    + ' & reg query "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"'
  let text = ''
  try {
    text = execSync(command, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 20000, windowsHide: true })
  } catch (error) {
    // reg query 对「键不存在」会返回非零；stdout 仍然有效，尽量捞回来。
    text = error && typeof error.stdout === 'string' ? error.stdout : ''
    if (text === '') console.error('[dsh-font-picker] reg query failed:', (error && error.message) || error)
  }

  const byName = new Map()
  for (const row of parseFontRegistry(text)) {
    const file = resolveFontPath(row.file)
    const installedAt = installTime(file)
    const previous = byName.get(row.name)
    if (previous === undefined || installedAt > previous.installedAt) {
      byName.set(row.name, { name: row.name, file, installedAt })
    }
  }

  const items = Array.from(byName.values())
  items.sort((a, b) => (b.installedAt - a.installedAt) || a.name.localeCompare(b.name, 'zh'))
  return items
}

/**
 * 按需刷新字体清单缓存。
 * @param force - true 时无视 TTL 强制重跑。
 * @returns 是否真的重新枚举了。
 */
function refresh(force) {
  if (!force && fonts.length > 0 && Date.now() - fontsAt < TTL_MS) return false
  fonts = enumerateFonts()
  fontsAt = Date.now()
  return true
}

// ── 首屏注入 ─────────────────────────────────────────────────────────────────

/**
 * 把一个选择值变成 CSS 值：含逗号视为完整 font-family 串，否则加引号。
 * @param value - 用户选择。
 * @returns 可直接写进 CSS 的文本。
 */
function cssValue(value) {
  return value.indexOf(',') >= 0 ? value : '"' + value.replace(/"/g, '') + '"'
}

/**
 * 当前选择的 `:root` 覆盖样式（空选择不产出规则）。
 * @returns CSS 文本。
 */
function rootStyleText() {
  const parts = []
  if (state.uiFont !== '') parts.push(':root{--dsw-font-family:' + cssValue(state.uiFont) + ' !important;}')
  if (state.codeFont !== '') parts.push(':root{--ds-font-family-code:' + cssValue(state.codeFont) + ' !important;}')
  if (state.terminalFont !== '') parts.push(':root{--ds-font-family-terminal:' + cssValue(state.terminalFont) + ' !important;}')
  return parts.join('')
}

/**
 * 首屏种子脚本：只带当前选择，不带字体清单（清单太大，走 API）。
 * @returns `<script>` 文本。
 */
function bootstrapScript() {
  const json = JSON.stringify({ uiFont: state.uiFont, codeFont: state.codeFont, terminalFont: state.terminalFont })
  return '<script id="dsh-font-picker-boot">window.__DSH_FONT_PICKER__='
    + json.replace(/</g, '\\u003c')
    + ';</script>'
}

// ── HTTP 工具 ────────────────────────────────────────────────────────────────

/**
 * 回一个 JSON 响应。
 * @param res - node 响应对象。
 * @param status - HTTP 状态码。
 * @param payload - 可 JSON 化的对象。
 */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * 读完请求体。
 * @param req - node 请求对象。
 * @returns 请求体文本（失败时空串）。
 */
function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

// ── 插件本体 ─────────────────────────────────────────────────────────────────

/**
 * 插件入口。
 * @param ctx - host cordis context。
 */
export function apply(ctx) {
  loadState()
  refresh(true)

  // 首屏：防闪 <style> + 当前选择种子。每次渲染 index 都重新采集，
  // 所以顺手在这里检查一次 TTL —— 页面一加载就等于一次「重新枚举」的机会。
  ctx.webServer.tapIndex((html) => {
    try {
      refresh(false)
    } catch (e) {
      console.error('[dsh-font-picker] refresh on index failed:', (e && e.message) || e)
    }
    const payload = '<style id="dsh-font-picker-style">' + rootStyleText() + '</style>' + bootstrapScript()
    return html.includes('</head>') ? html.replace('</head>', payload + '</head>') : payload + html
  })

  ctx.webServer.register({
    kind: 'prefix',
    path: '/font-picker',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        const pathname = url.pathname
        const method = req.method || 'GET'

        if (pathname === '/font-picker/api/state' && method === 'GET') {
          return sendJson(res, 200, { uiFont: state.uiFont, codeFont: state.codeFont, terminalFont: state.terminalFont, allTotal: fonts.length })
        }

        if (pathname === '/font-picker/api/fonts' && method === 'GET') {
          refresh(false)
          const query = (url.searchParams.get('q') || '').trim().toLowerCase()
          const parsedLimit = Number.parseInt(url.searchParams.get('limit') || '', 10)
          const limit = Number.isFinite(parsedLimit)
            ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
            : DEFAULT_LIMIT
          const hit = query === '' ? fonts : fonts.filter((f) => f.name.toLowerCase().indexOf(query) >= 0)
          return sendJson(res, 200, {
            items: hit.slice(0, limit).map((f) => ({ name: f.name, installedAt: f.installedAt })),
            total: hit.length,
            allTotal: fonts.length,
            fetchedAt: fontsAt,
          })
        }

        if (pathname === '/font-picker/api/set' && method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const raw = body && typeof body.which === 'string' ? body.which : 'ui'
          const which = raw === 'code' || raw === 'terminal' ? raw : 'ui'
          const value = body && typeof body.value === 'string' ? body.value : ''
          if (which === 'ui') state.uiFont = value
          else if (which === 'terminal') state.terminalFont = value
          else state.codeFont = value
          const saved = saveState()
          return sendJson(res, 200, { ok: saved, uiFont: state.uiFont, codeFont: state.codeFont, terminalFont: state.terminalFont })
        }

        if (pathname === '/font-picker/api/refresh' && method === 'POST') {
          const changed = refresh(true)
          return sendJson(res, 200, { ok: true, changed, allTotal: fonts.length, fetchedAt: fontsAt })
        }

        return sendJson(res, 404, { error: 'not found: ' + pathname })
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) })
      }
    },
  })

  console.log('[dsh-font-picker] host ready,', fonts.length, 'font names, state file', stateFilePath())
}
