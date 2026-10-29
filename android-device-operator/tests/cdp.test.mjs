import test from 'node:test'
import assert from 'node:assert/strict'
import { startFakeCdp } from './fake-cdp.mjs'
import { CdpSession, ChannelError, listTargets, pickTarget, version } from '../scripts/lib/cdp.mjs'

test('握手不发 Origin（CDP 403 的根因）', async () => {
  const fake = await startFakeCdp()
  try {
    await version(fake.port)
    const targets = await listTargets(fake.port)
    const s = await CdpSession.open(targets[0].webSocketDebuggerUrl)
    await s.evaluate('1+1')
    s.close()
    assert.equal(fake.state.origin, undefined, 'Origin 头必须缺席')
  } finally {
    await fake.close()
  }
})

test('listTargets 只返回 page 类型', async () => {
  const fake = await startFakeCdp()
  try {
    const targets = await listTargets(fake.port)
    assert.equal(targets.length, 1)
    assert.equal(targets[0].type, 'page')
  } finally {
    await fake.close()
  }
})

test('evaluate 大响应（>64KB，走 127 长度分支）', async () => {
  const big = 'x'.repeat(200_000)
  const fake = await startFakeCdp({ evaluate: () => big })
  try {
    const targets = await listTargets(fake.port)
    const s = await CdpSession.open(targets[0].webSocketDebuggerUrl)
    const value = await s.evaluate('BIG')
    s.close()
    assert.equal(value.length, 200_000)
  } finally {
    await fake.close()
  }
})

test('页面里 throw 变成 JsError，不是静默失败', async () => {
  const fake = await startFakeCdp({
    evaluate: () => {
      throw new Error('boom')
    }
  })
  try {
    const targets = await listTargets(fake.port)
    const s = await CdpSession.open(targets[0].webSocketDebuggerUrl)
    await assert.rejects(() => s.evaluate('throw'), (e) => e instanceof ChannelError && e.code === 'JsError')
    s.close()
  } finally {
    await fake.close()
  }
})

test('pickTarget：唯一命中才返回，多命中必须报 TargetAmbiguous', () => {
  const one = [{ id: 'a', url: 'https://x/a' }]
  assert.equal(pickTarget(one, 'x/a').id, 'a')

  const two = [
    { id: 'a', url: 'https://x/a' },
    { id: 'b', url: 'https://x/a/2' }
  ]
  assert.throws(
    () => pickTarget(two, 'x/a'),
    (e) => e.code === 'TargetAmbiguous'
  )
  assert.equal(pickTarget(two, 'a/2').id, 'b')
  assert.throws(
    () => pickTarget(two, 'nope'),
    (e) => e.code === 'NoTarget'
  )
})

test('没有 urlPart 且有多个页面时也不能默默取第一个', () => {
  const two = [
    { id: 'a', url: 'https://x/a' },
    { id: 'b', url: 'https://x/b' }
  ]
  assert.throws(
    () => pickTarget(two, undefined),
    (e) => e.code === 'TargetAmbiguous'
  )
})
