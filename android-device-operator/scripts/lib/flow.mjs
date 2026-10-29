/**
 * 流程执行器：一次调用跑完多步，不把每一小步都丢回给模型。
 * 这是整条链路最省时间的部分 —— 10 步流程 = 1 次工具调用。
 */
import fs from 'node:fs'
import { ChannelError } from './cdp.mjs'
import { normalizeCond } from './page.mjs'

export function loadFlow(file) {
  const abs = file.startsWith('~') ? file.replace('~', process.env.HOME || process.env.USERPROFILE) : file
  let raw
  try {
    raw = fs.readFileSync(abs, 'utf8')
  } catch (e) {
    throw new ChannelError('FlowLoad', `读不到流程文件：${file}（${e.code || e.message}）`)
  }
  let flow
  try {
    flow = JSON.parse(raw)
  } catch (e) {
    throw new ChannelError('FlowParse', `流程文件不是合法 JSON：${e.message}`)
  }
  validateFlow(flow)
  return flow
}

export function validateFlow(flow) {
  if (!flow || typeof flow !== 'object') throw new ChannelError('FlowSchema', '流程必须是对象')
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    throw new ChannelError('FlowSchema', 'flow.steps 必须是非空数组')
  }
  flow.steps.forEach((step, i) => {
    if (!step || typeof step !== 'object') throw new ChannelError('FlowSchema', `第 ${i + 1} 步不是对象`)
    if (!step.act && !step.expect) {
      throw new ChannelError('FlowSchema', `第 ${i + 1} 步既没有 act 也没有 expect`)
    }
    if (!step.expect) {
      // 硬约束：动作必须带后置条件，否则「点了」不等于「生效了」
      throw new ChannelError(
        'FlowSchema',
        `第 ${i + 1} 步缺少 expect。每个动作都必须声明它要达成的状态`,
        '例：{"act":{"op":"click","ref":"css:#next"},"expect":{"text":"2/10"}}'
      )
    }
    step.expect = normalizeCond(step.expect, { timeout: step.timeout ?? flow.defaultTimeout ?? 8 })
  })
  return flow
}

/**
 * 逐步执行。任何一步的 expect 两次不成立就整体失败，并把现场状态带回去。
 */
export async function runFlow(ctx, flow, { onStep = () => {} } = {}) {
  const results = []
  const startedAll = Date.now()

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i]
    const label = step.name || `第 ${i + 1} 步`
    const retries = step.retries ?? 0
    const started = Date.now()
    let lastError = null
    let passed = false

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (step.act) await ctx.act(step.act)
        const exp = await ctx.expect(step.expect, step.expect.timeout ?? 8)
        if (exp.ok) {
          passed = true
          break
        }
        lastError = {
          code: 'ExpectTimeout',
          message: `条件未成立：${JSON.stringify(step.expect)}`,
          last: exp.last ? { url: exp.last.url, text: (exp.last.text || '').slice(0, 300) } : null
        }
      } catch (e) {
        lastError = { code: e.code || 'StepError', message: e.message, hint: e.hint }
      }
    }

    const entry = {
      i: i + 1,
      name: label,
      ok: passed,
      ms: Date.now() - started,
      ...(step.act ? { act: `${step.act.op}:${step.act.ref ?? step.act.url ?? ''}` } : {}),
      ...(passed ? {} : { error: lastError })
    }
    results.push(entry)
    onStep(entry)

    if (!passed) {
      return {
        ok: false,
        failedAt: i + 1,
        total: flow.steps.length,
        ms: Date.now() - startedAll,
        steps: results
      }
    }
  }

  return {
    ok: true,
    failedAt: null,
    total: flow.steps.length,
    ms: Date.now() - startedAll,
    steps: results
  }
}
