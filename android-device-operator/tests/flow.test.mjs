import test from 'node:test'
import assert from 'node:assert/strict'
import { startFakeCdp } from './fake-cdp.mjs'
import { openContext } from '../scripts/lib/channel.mjs'
import { runFlow, validateFlow } from '../scripts/lib/flow.mjs'
import { ChannelError } from '../scripts/lib/cdp.mjs'

/** 假 CDP 里 location.href 必须返回字符串，否则 attach 的实时 URL 复核会失效 */
function respond(msg, page) {
  const expr = msg.params.expression
  if (expr === 'location.href') return page.url
  return page
}

function fakePage(counter) {
  return {
    url: 'https://example.test/page',
    title: 'Fake Page',
    text: `第 ${counter} 题 ${counter}/10`,
    lines: [`第 ${counter} 题 ${counter}/10`],
    elements: [
      { ref: 'css:#next', role: 'a', text: '下一题', value: null, id: 'next', box: { x: 0, y: 0, w: 80, h: 40 } }
    ],
    readyState: 'complete'
  }
}

test('端到端：snapshot → click → expect 条件成立', async () => {
  let counter = 1
  const fake = await startFakeCdp({
    url: 'https://example.test/page',
    evaluate: (msg) => {
      const expr = msg.params.expression
      if (expr.includes('el.click()')) {
        counter++
        return { ok: true, tag: 'A' }
      }
      return respond(msg, fakePage(counter))
    }
  })
  try {
    const ctx = await openContext({ port: fake.port, urlPart: 'example.test', autoForward: false })
    assert.equal(ctx.kind, 'webview')

    const before = await ctx.snapshot()
    assert.equal(before.text, '第 1 题 1/10')
    assert.equal(before.channel, 'webview')

    const r = await ctx.act({ op: 'click', ref: 'css:#next' })
    assert.equal(r.ok, true)

    const exp = await ctx.expect({ kind: 'text', value: '2/10' }, 3)
    assert.equal(exp.ok, true)
    ctx.close()
  } finally {
    await fake.close()
  }
})

test('expect 超时返回 ok=false 且带上最后的现场', async () => {
  const fake = await startFakeCdp({ evaluate: (msg) => respond(msg, fakePage(1)) })
  try {
    const ctx = await openContext({ port: fake.port, urlPart: 'example.test', autoForward: false })
    const started = Date.now()
    const exp = await ctx.expect({ kind: 'text', value: '9/10' }, 1.2)
    const elapsed = Date.now() - started
    assert.equal(exp.ok, false)
    // timeout 的单位是「秒」。这里守住这条契约：写成 1.2 就必须真的等约 1.2 秒，
    // 不能变成 1.2 毫秒（曾经踩过：传秒当毫秒用，条件检查一次就返回失败）。
    assert.ok(elapsed >= 1000, `expect 应等待约 1.2 秒，实际 ${elapsed}ms`)
    assert.ok(elapsed < 3000, `expect 不该等太久，实际 ${elapsed}ms`)
    assert.match(exp.last.text, /1\/10/)
    ctx.close()
  } finally {
    await fake.close()
  }
})

test('runFlow：一次调用跑完多步，返回每步耗时', async () => {
  let counter = 1
  const fake = await startFakeCdp({
    evaluate: (msg) => {
      if (msg.params.expression.includes('el.click()')) {
        counter++
        return { ok: true }
      }
      return respond(msg, fakePage(counter))
    }
  })
  try {
    const ctx = await openContext({ port: fake.port, urlPart: 'example.test', autoForward: false })
    const flow = validateFlow({
      name: 'demo',
      steps: [
        { act: { op: 'click', ref: 'css:#next' }, expect: { text: '2/10' } },
        { act: { op: 'click', ref: 'css:#next' }, expect: { text: '3/10' } }
      ]
    })
    const result = await runFlow(ctx, flow)
    assert.equal(result.ok, true)
    assert.equal(result.total, 2)
    assert.equal(result.steps.length, 2)
    assert.ok(result.steps.every((s) => s.ok && s.ms >= 0))
    ctx.close()
  } finally {
    await fake.close()
  }
})

test('runFlow：某步条件不成立就停在那一步并带回现场', async () => {
  const fake = await startFakeCdp({
    evaluate: (msg) =>
      msg.params.expression.includes('el.click()') ? { ok: true } : respond(msg, fakePage(1))
  })
  let ctx
  try {
    ctx = await openContext({ port: fake.port, urlPart: 'example.test', autoForward: false })
    const flow = validateFlow({
      steps: [{ act: { op: 'click', ref: 'css:#next' }, expect: { text: '2/10', timeout: 1 } }]
    })
    const result = await runFlow(ctx, flow)
    assert.equal(result.ok, false)
    assert.equal(result.failedAt, 1)
    assert.equal(result.steps[0].error.code, 'ExpectTimeout')
  } finally {
    ctx?.close()
    await fake.close()
  }
})

test('validateFlow 拒绝没有 expect 的步骤', () => {
  assert.throws(
    () => validateFlow({ steps: [{ act: { op: 'click', ref: 'css:#a' } }] }),
    (e) => e instanceof ChannelError && e.code === 'FlowSchema'
  )
})

test('openContext：两条通道都不通时抛 NoChannel，而不是返回半成品上下文', async () => {
  const fake = await startFakeCdp()
  try {
    await assert.rejects(
      // 假端口 + 不存在的设备序列号 = 两条路都走不通
      () => openContext({ port: fake.port, urlPart: 'nope', serial: '__no_such_device__', autoForward: false }),
      (e) => ['NoTarget', 'NoChannel', 'NoAdb'].includes(e.code)
    )
  } finally {
    await fake.close()
  }
})
