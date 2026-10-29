/**
 * ADB 通道：macOS / Windows 通用。只做「原语」，不做业务。
 *
 * 为什么脚本内不用 mobile-mcp：Cola 里默认没有那个 MCP，
 * 而 adb 是唯一在两端都稳定存在的东西。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { ChannelError } from './cdp.mjs'

const isWin = process.platform === 'win32'
const ADB_NAME = isWin ? 'adb.exe' : 'adb'

let cachedAdb = null

function fromPath() {
  const probe = isWin
    ? spawnSync('where', ['adb'], { encoding: 'utf8', windowsHide: true })
    : spawnSync('which', ['adb'], { encoding: 'utf8' })
  if (probe.status === 0) {
    const first = (probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (first && existsSync(first)) return first
  }
  return null
}

/** 按「环境变量 → SDK 目录 → PATH」顺序找 adb，找不到返回 null。 */
export function resolveAdb() {
  if (cachedAdb) return cachedAdb

  const explicit = process.env.ADB || process.env.COLA_ADB
  if (explicit && existsSync(explicit)) return (cachedAdb = explicit)

  const candidates = []
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const root = process.env[key]
    if (root) candidates.push(path.join(root, 'platform-tools', ADB_NAME))
  }

  if (isWin) {
    const local = process.env.LOCALAPPDATA
    if (local) candidates.push(path.join(local, 'Android', 'Sdk', 'platform-tools', ADB_NAME))
    candidates.push(path.join(homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', ADB_NAME))
    candidates.push('C:\\Android\\platform-tools\\adb.exe')
  } else {
    candidates.push(path.join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'))
    candidates.push('/opt/homebrew/bin/adb', '/usr/local/bin/adb', '/usr/bin/adb')
    candidates.push(path.join(homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'))
  }

  for (const c of candidates) {
    if (existsSync(c) && verify(c)) return (cachedAdb = c)
  }

  const onPath = fromPath()
  if (onPath && verify(onPath)) return (cachedAdb = onPath)

  return null
}

function verify(bin) {
  const r = spawnSync(bin, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
  return r.status === 0 && /Android Debug Bridge/i.test(`${r.stdout}${r.stderr}`)
}

/** 同步跑一条 adb 命令。失败不抛，交给调用方按 code 判断。 */
export function adb(args, { timeout = 20000, input } = {}) {
  const bin = resolveAdb()
  if (!bin) {
    throw new ChannelError(
      'NoAdb',
      '找不到 adb',
      isWin
        ? '装 Android SDK Platform-Tools 并把 platform-tools 目录加进 PATH，或设置 ADB 环境变量指向 adb.exe'
        : 'macOS: brew install --cask android-platform-tools；或设置 ADB 环境变量指向 adb 二进制'
    )
  }
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout,
    input,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  })
  if (r.error?.code === 'ETIMEDOUT') {
    throw new ChannelError('AdbTimeout', `adb ${args[0]} 超时（${timeout}ms）`)
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export function adbText(args, opts) {
  const r = adb(args, opts)
  if (r.code !== 0) {
    throw new ChannelError(
      'AdbFail',
      `adb ${args.join(' ')} 失败（exit ${r.code}）：${(r.stderr || r.stdout).trim().slice(0, 300)}`
    )
  }
  return r.stdout
}

/** 列出已连接且已授权的设备。 */
export function devices() {
  const out = adbText(['devices', '-l'])
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/)
      const meta = {}
      for (const kv of rest) {
        const i = kv.indexOf(':')
        if (i > 0) meta[kv.slice(0, i)] = kv.slice(i + 1)
      }
      return { serial, state, model: meta.model ?? null }
    })
}

export function requireDevice(serial) {
  const list = devices()
  const chosen = serial ? list.find((d) => d.serial === serial) : list.find((d) => d.state === 'device')
  if (!chosen) {
    const unauthorized = list.find((d) => d.state === 'unauthorized')
    if (unauthorized) {
      throw new ChannelError(
        'Unauthorized',
        `设备 ${unauthorized.serial} 未授权`,
        '在手机上点「允许 USB 调试」，然后再跑一次'
      )
    }
    throw new ChannelError(
      'NoDevice',
      list.length ? `没有可用设备（状态：${list.map((d) => `${d.serial}=${d.state}`).join(', ')}）` : '没有连接任何安卓设备',
      '插上数据线、开「USB 调试」，然后 `adb devices` 应出现 device'
    )
  }
  if (chosen.state !== 'device') {
    throw new ChannelError('DeviceNotReady', `设备状态是 ${chosen.state}`, '手机上确认授权弹窗')
  }
  return chosen
}

export function shell(cmd, { serial } = {}) {
  const args = serial ? ['-s', serial, 'shell', cmd] : ['shell', cmd]
  return adbText(args)
}

export function forward(port, socketName, { serial } = {}) {
  const args = serial ? ['-s', serial, 'forward'] : ['forward']
  adbText([...args, `tcp:${port}`, `localabstract:${socketName}`])
  return `tcp:${port} -> localabstract:${socketName}`
}

export function removeForward(port, { serial } = {}) {
  const args = serial ? ['-s', serial, 'forward'] : ['forward']
  adb([...args, '--remove', `tcp:${port}`])
}

/** 找某个包名的 pid（微信的 WebView devtools socket 名依赖它）。 */
export function pidof(pkg, { serial } = {}) {
  const args = serial ? ['-s', serial, 'shell'] : ['shell']
  const r = adb([...args, `pidof ${pkg}`])
  if (r.code === 0) {
    const pid = r.stdout.trim().split(/\s+/)[0]
    if (pid) return pid
  }
  // 老系统没有 pidof
  const ps = adb([...args, 'ps -A'])
  const out = ps.code === 0 ? ps.stdout : adb([...args, 'ps']).stdout
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(pkg)) {
      const m = line.trim().match(/^\S+\s+(\d+)/)
      if (m) return m[1]
    }
  }
  return null
}

/** 列出 /proc/net/unix 里的 devtools socket，判断调试开关是否生效。 */
export function devtoolsSockets({ serial } = {}) {
  const out = shell('cat /proc/net/unix', { serial })
  const names = new Set()
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/(@?[\w.@:-]*devtools[\w.@:-]*)/i)
    if (m) names.add(m[1].replace(/^@/, ''))
  }
  return [...names]
}

export function tap(x, y, { serial } = {}) {
  shell(`input tap ${Math.round(x)} ${Math.round(y)}`, { serial })
}

export function swipe(x1, y1, x2, y2, ms = 300, { serial } = {}) {
  shell(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${ms}`, { serial })
}

export function keyevent(code, { serial } = {}) {
  shell(`input keyevent ${code}`, { serial })
}

/** 只在 ASCII 场景可用；中文请走人机交接（见 references/failures.md）。 */
export function inputText(text, { serial } = {}) {
  if (!/^[\x20-\x7E\n\t]*$/.test(text)) {
    throw new ChannelError(
      'NonAsciiInput',
      '纯 adb 的 input text 只支持 ASCII',
      '中文/emoji 输入请交给人手输入，或改用 CDP 通道写 value（H5 页面可用）'
    )
  }
  shell(`input text ${quoteForShell(text)}`, { serial })
}

function quoteForShell(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** 当前前台 Activity，用于判断页面归属。 */
export function currentFocus({ serial } = {}) {
  const args = serial ? ['-s', serial, 'shell'] : ['shell']
  const r = adb([...args, 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"'])
  return (r.stdout || '').trim()
}

export function screenSize({ serial } = {}) {
  const out = shell('wm size', { serial })
  const m = out.match(/Override size:\s*(\d+)x(\d+)/) || out.match(/Physical size:\s*(\d+)x(\d+)/)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

const DUMP_PATH = '/sdcard/cola_ui_dump.xml'

/** 拉一份无障碍树 XML。注意：会占用 UiAutomation，别和 Appium/uiautomator 并发。 */
export function uiXml({ serial } = {}) {
  const s = serial ? ['-s', serial] : []
  const dump = adb([...s, 'shell', `uiautomator dump ${DUMP_PATH}`], { timeout: 30000 })
  if (dump.code !== 0) {
    throw new ChannelError(
      'UiDumpFail',
      `uiautomator dump 失败：${(dump.stderr || dump.stdout).trim().slice(0, 200)}`,
      '确认屏幕已解锁；若另一进程占用 UiAutomation，先停掉它'
    )
  }
  const r = adb([...s, 'exec-out', `cat ${DUMP_PATH}`], { timeout: 30000 })
  if (r.code !== 0 || !r.stdout.includes('<hierarchy')) {
    throw new ChannelError('UiDumpFail', '拉取 UI XML 失败或内容不完整')
  }
  return r.stdout
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

/** 极简 XML 解析：只要 text / content-desc / bounds / clickable。 */
export function parseUiNodes(xml) {
  const nodes = []
  const nodeRe = /<node\b([^>]*?)\/?>/g
  let m
  let i = 0
  while ((m = nodeRe.exec(xml))) {
    const attrs = {}
    const attrRe = /([\w:-]+)="([^"]*)"/g
    let a
    while ((a = attrRe.exec(m[1]))) attrs[a[1]] = decodeEntities(a[2])
    const text = (attrs.text || '').trim()
    const desc = (attrs['content-desc'] || '').trim()
    const label = text || desc
    const b = (attrs.bounds || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)
    const box = b
      ? { x: +b[1], y: +b[2], w: +b[3] - +b[1], h: +b[4] - +b[2] }
      : null
    const clickable = attrs.clickable === 'true'
    if (label || clickable) {
      nodes.push({
        ref: `ax:${i}`,
        role: (attrs.class || '').split('.').pop() || 'node',
        text: label,
        clickable,
        box,
        raw: attrs
      })
    }
    i++
  }
  return nodes
}
