/**
 * 最小 WebSocket 客户端 —— 只用 node:http + node:crypto，零依赖。
 *
 * 为什么不用全局 WebSocket：
 *   1. 老版本 Node 的 undici 实现会自动带 Origin 头，CDP 服务端会 403；
 *   2. 走 undici 的 fetch/WebSocket 在部分版本会受代理环境变量影响；
 *   3. 自己实现只有 ~150 行，换来的是「任何 Node 22+ 都能跑，Windows 也一样」。
 *
 * 刻意不发 Origin 头 —— 这是 CDP 403 的根因。
 */
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

export class WebSocketLike {
  #socket
  #buf = Buffer.alloc(0)
  #frags = []
  #fragOp = 0
  #closed = false
  #handlers = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.on('data', (chunk) => {
      this.#buf = Buffer.concat([this.#buf, chunk])
      this.#drain()
    })
    socket.on('close', () => this.#finish())
    socket.on('error', () => this.#finish())
  }

  static connect(url, { headers = {}, timeout = 15000 } = {}) {
    const u = new URL(url)
    const secure = u.protocol === 'wss:'
    const key = randomBytes(16).toString('base64')

    return new Promise((resolve, reject) => {
      const mod = secure ? null : http
      if (!mod) return reject(new Error('wss 未实现，请用 ws://（adb forward 出来的地址都是 ws://）'))
      const req = http.request({
        host: u.hostname,
        port: Number(u.port || 80),
        path: `${u.pathname}${u.search}`,
        agent: false, // 不复用连接、不走代理
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          ...headers
          // 注意：这里绝不能加 Origin
        }
      })

      const timer = setTimeout(() => {
        req.destroy(new Error(`WebSocket 握手超时（${timeout}ms）`))
      }, timeout)

      req.on('upgrade', (res, socket) => {
        clearTimeout(timer)
        const accept = res.headers['sec-websocket-accept']
        const expect = createHash('sha1').update(key + GUID).digest('base64')
        if (accept !== expect) {
          socket.destroy()
          return reject(new Error('WebSocket 握手被拒绝：Sec-WebSocket-Accept 不匹配'))
        }
        resolve(new WebSocketLike(socket))
      })

      req.on('response', (res) => {
        clearTimeout(timer)
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          reject(new Error(`WebSocket 握手失败：HTTP ${res.statusCode} ${body.slice(0, 200)}`))
        })
      })

      req.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })

      req.end()
    })
  }

  on(event, handler) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, [])
    this.#handlers.get(event).push(handler)
    return this
  }

  #emit(event, payload) {
    for (const h of this.#handlers.get(event) ?? []) {
      try {
        h(payload)
      } catch {
        /* 订阅方异常不影响读循环 */
      }
    }
  }

  send(text) {
    if (this.#closed) throw new Error('WebSocket 已关闭')
    this.#socket.write(encodeFrame(OP.TEXT, Buffer.from(text, 'utf8')))
  }

  close() {
    if (this.#closed) return
    try {
      this.#socket.write(encodeFrame(OP.CLOSE, Buffer.alloc(0)))
    } catch {
      /* ignore */
    }
    this.#socket.end()
    this.#finish()
  }

  #finish() {
    if (this.#closed) return
    this.#closed = true
    this.#emit('close')
    try {
      this.#socket.destroy()
    } catch {
      /* ignore */
    }
  }

  #drain() {
    while (true) {
      if (this.#buf.length < 2) return
      const b0 = this.#buf[0]
      const b1 = this.#buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2

      if (len === 126) {
        if (this.#buf.length < offset + 2) return
        len = this.#buf.readUInt16BE(offset)
        offset += 2
      } else if (len === 127) {
        if (this.#buf.length < offset + 8) return
        const high = this.#buf.readUInt32BE(offset)
        const low = this.#buf.readUInt32BE(offset + 4)
        len = high * 2 ** 32 + low
        offset += 8
      }

      let mask
      if (masked) {
        if (this.#buf.length < offset + 4) return
        mask = this.#buf.subarray(offset, offset + 4)
        offset += 4
      }

      if (this.#buf.length < offset + len) return
      let payload = this.#buf.subarray(offset, offset + len)
      if (masked) {
        const out = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
        payload = out
      }
      this.#buf = this.#buf.subarray(offset + len)

      if (opcode === OP.PING) {
        this.#socket.write(encodeFrame(OP.PONG, payload))
        continue
      }
      if (opcode === OP.PONG) continue
      if (opcode === OP.CLOSE) {
        this.close()
        return
      }

      if (opcode === OP.CONT) {
        this.#frags.push(payload)
        if (!fin) continue
        const whole = Buffer.concat(this.#frags)
        this.#frags = []
        if (this.#fragOp === OP.TEXT) this.#emit('message', whole.toString('utf8'))
        continue
      }

      if (!fin) {
        this.#fragOp = opcode
        this.#frags = [payload]
        continue
      }

      if (opcode === OP.TEXT) this.#emit('message', payload.toString('utf8'))
      else if (opcode === OP.BIN) this.#emit('binary', payload)
    }
  }
}

function encodeFrame(opcode, payload) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(6)
    header[1] = 0x80 | len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(8)
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(14)
    header[1] = 0x80 | 127
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2)
    header.writeUInt32BE(len % 2 ** 32, 6)
  }
  header[0] = 0x80 | opcode
  const mask = randomBytes(4)
  mask.copy(header, header.length - 4)
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, masked])
}
