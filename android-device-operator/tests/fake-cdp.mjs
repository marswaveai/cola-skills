/**
 * 测试用的最小 CDP 假服务器：实现 /json/list + WebSocket 握手 + Runtime.evaluate。
 * 目的不是模拟浏览器，而是验证「握手头、帧编解码、id 配对、异常透传」这条管道。
 */
import http from 'node:http'
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function startFakeCdp({ url = 'https://example.test/page', title = 'Fake Page', evaluate } = {}) {
  const state = { origin: undefined, connections: 0, messages: [] }
  const sockets = new Set()

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify([
          {
            id: 'page-1',
            type: 'page',
            title,
            url,
            webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/page-1`
          },
          { id: 'worker-1', type: 'worker', url: 'about:blank' }
        ])
      )
      return
    }
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ Browser: 'FakeCDP/1.0' }))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })

  server.on('upgrade', (req, socket) => {
    state.origin = req.headers.origin
    state.connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${GUID}`).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        ''
      ].join('\r\n')
    )

    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (true) {
        if (buf.length < 2) return
        const opcode = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = buf.readUInt32BE(2) * 2 ** 32 + buf.readUInt32BE(6)
          off = 10
        }
        let mask
        if (masked) {
          if (buf.length < off + 4) return
          mask = buf.subarray(off, off + 4)
          off += 4
        }
        if (buf.length < off + len) return
        let payload = buf.subarray(off, off + len)
        if (masked) {
          const out = Buffer.allocUnsafe(len)
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
          payload = out
        }
        buf = buf.subarray(off + len)

        if (opcode === 0x8) {
          socket.end()
          return
        }
        if (opcode !== 0x1) continue

        const msg = JSON.parse(payload.toString('utf8'))
        state.messages.push(msg)
        let body
        try {
          const value = evaluate ? evaluate(msg) : { echoed: msg.params?.expression }
          body = JSON.stringify({ id: msg.id, result: { result: { value } } })
        } catch (e) {
          body = JSON.stringify({
            id: msg.id,
            result: { exceptionDetails: { text: 'Uncaught', exception: { description: e.message } } }
          })
        }
        socket.write(frame(body))
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        // 关键：必须主动销毁还挂着的 WS socket，否则 server.close() 会一直等
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy()
            sockets.clear()
            server.close(r)
          })
      })
    })
  })
}

function frame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2)
    header.writeUInt32BE(len % 2 ** 32, 6)
  }
  return Buffer.concat([header, payload])
}
