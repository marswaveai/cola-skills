/**
 * CDP 通道：通过 adb forward 出来的本地端口，直接对 WebView 执行 JS。
 *
 * 三个坑已经在代码里解决：
 *   1. 不走代理 —— 用 node:http + agent:false，不读 HTTP_PROXY；
 *   2. 不发 Origin —— ws.mjs 里刻意不加；
 *   3. target 必须用 URL 谓词唯一命中 —— 禁止 `pages[0]`。
 */
import http from 'node:http'
import { WebSocketLike } from './ws.mjs'

export class ChannelError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

/** GET 本地 CDP 端点（不经过任何代理） */
export function httpGet(port, path, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false, timeout },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new ChannelError('HttpStatus', `HTTP ${res.statusCode}: ${body.slice(0, 160)}`))
          }
          try {
            resolve(JSON.parse(body))
          } catch (e) {
            reject(new ChannelError('BadJson', `CDP 返回的不是 JSON: ${body.slice(0, 160)}`))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new ChannelError('Timeout', `连接 127.0.0.1:${port} 超时`)))
    req.on('error', (e) =>
      reject(
        new ChannelError(
          e.code === 'ECONNREFUSED' ? 'NoPort' : 'Transport',
          `连不上 127.0.0.1:${port}（${e.code || e.message}）`,
          e.code === 'ECONNREFUSED'
            ? '端口没映射：先跑 `adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>`，或执行 preflight 看具体缺哪步'
            : undefined
        )
      )
    )
    req.end()
  })
}

export async function version(port) {
  return httpGet(port, '/json/version')
}

export async function listTargets(port) {
  const list = await httpGet(port, '/json/list')
  return Array.isArray(list) ? list.filter((t) => t.type === 'page') : []
}

/**
 * 按 URL 子串选唯一 target。
 * 命中 0 个 → NoTarget；命中 >1 个 → TargetAmbiguous（绝不默默取第一个）。
 */
export function pickTarget(targets, urlPart) {
  if (!urlPart) {
    if (targets.length === 1) return targets[0]
    if (targets.length === 0) {
      throw new ChannelError('NoTarget', '调试列表为空：微信 WebView 可能已被回收', '在微信里重新打开活动页，再跑一次')
    }
    throw new ChannelError(
      'TargetAmbiguous',
      `有 ${targets.length} 个可调试页面，无法确定要操作哪一个`,
      `加 --url <片断> 指定；当前：${targets.map((t) => t.url).join(' | ').slice(0, 300)}`
    )
  }
  const hit = targets.filter((t) => (t.url || '').includes(urlPart))
  if (hit.length === 1) return hit[0]
  if (hit.length === 0) {
    throw new ChannelError(
      'NoTarget',
      `没有 URL 包含 "${urlPart}" 的可调试页面`,
      `当前页面：${targets.map((t) => t.url).join(' | ').slice(0, 300) || '（空）'}`
    )
  }
  throw new ChannelError(
    'TargetAmbiguous',
    `有 ${hit.length} 个页面都包含 "${urlPart}"，无法唯一确定`,
    hit.map((t) => t.url).join(' | ').slice(0, 300)
  )
}

const CDP_TIMEOUT = 'CdpTimeout'

export class CdpSession {
  #ws
  #seq = 0
  #pending = new Map()
  #closed = false

  constructor(ws) {
    this.#ws = ws
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.id == null) return // 事件通知，忽略
      const entry = this.#pending.get(msg.id)
      if (!entry) return
      this.#pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) entry.reject(new ChannelError('CdpError', msg.error.message || 'CDP 返回错误'))
      else entry.resolve(msg.result)
    })
    ws.on('close', () => {
      this.#closed = true
      for (const [, e] of this.#pending) {
        clearTimeout(e.timer)
        e.reject(new ChannelError('CdpClosed', 'WebSocket 连接被关闭'))
      }
      this.#pending.clear()
    })
  }

  static async open(wsUrl, { timeout = 15000 } = {}) {
    const ws = await WebSocketLike.connect(wsUrl, { timeout })
    return new CdpSession(ws)
  }

  call(method, params = {}, timeout = 25000) {
    if (this.#closed) return Promise.reject(new ChannelError('CdpClosed', '连接已关闭'))
    const id = ++this.#seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new ChannelError(CDP_TIMEOUT, `${method} 超时（${timeout}ms）`))
      }, timeout)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.#ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new ChannelError('CdpSend', e.message))
      }
    })
  }

  /** 执行 JS 并取回值。页面里 throw 会变成 JsError。 */
  async evaluate(expression, { awaitPromise = true, timeout = 25000 } = {}) {
    const r = await this.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
      timeout
    )
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      const text = d.exception?.description || d.text || 'JS 抛错'
      throw new ChannelError('JsError', text.split('\n')[0].slice(0, 300))
    }
    return r.result?.value
  }

  close() {
    this.#ws.close()
  }
}
