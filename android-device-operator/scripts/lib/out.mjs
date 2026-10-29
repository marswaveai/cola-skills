/** 统一输出与退出码。退出码是给 agent 看的：2 = 需要人，3 = 失败可重试。 */
import fs from 'node:fs'

const NEEDS_HUMAN = new Set([
  'NoAdb',
  'NoDevice',
  'Unauthorized',
  'DeviceNotReady',
  'GateClosed',
  'NoTarget',
  'TargetAmbiguous',
  'NonAsciiInput',
  'NeedsHuman'
])

/**
 * 用 fs.writeSync 而不是 console.log：
 * Windows 下 process.exit() 会截断还没刷出去的管道输出，同步写才不会丢 JSON。
 */
export function emit(payload, { pretty = false } = {}) {
  const text = `${pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload)}\n`
  try {
    fs.writeSync(1, text)
  } catch (e) {
    if (e.code !== 'EPIPE') throw e
  }
}

export function exitCodeFor(code) {
  return NEEDS_HUMAN.has(code) ? 2 : 3
}

export function fail(code, message, hint, extra = {}) {
  emit({ ok: false, error: { code, message, ...(hint ? { hint } : {}) }, ...extra })
  process.exit(exitCodeFor(code))
}

export function ok(data, extra = {}, opts) {
  emit({ ok: true, ...data, ...extra }, opts)
  process.exit(0)
}

/** 裁剪快照体积：agent 只需要够判断的上下文，不需要整页。 */
export function trimSnapshot(page, { full = false } = {}) {
  if (full) return page
  const lines = (page.lines || []).slice(0, 200)
  const text = String(page.text || '')
  return {
    ...page,
    lines,
    text: text.length > 3000 ? `${text.slice(0, 3000)}…` : text,
    textTruncated: text.length > 3000,
    elements: (page.elements || []).slice(0, 120)
  }
}
