#!/usr/bin/env node
/**
 * android-device-operator CLI —— 唯一入口。
 *
 * 设计原则（写进代码，不写在文档里）：
 *   1. 每条命令输出一行 JSON，人看 hint，agent 看 ok/code
 *   2. 退出码 0 成功 / 2 需要人 / 3 失败可重试
 *   3. 动作必须带后置条件才能算「完成」
 */
import * as adb from './lib/adb.mjs'
import { attach, ensureCdp, openContext } from './lib/channel.mjs'
import { CdpSession, listTargets, version as cdpVersion } from './lib/cdp.mjs'
import { loadFlow, runFlow } from './lib/flow.mjs'
import { normalizeCond } from './lib/page.mjs'
import { emit, fail, ok, trimSnapshot } from './lib/out.mjs'

const COMMANDS = ['preflight', 'devices', 'channel', 'pages', 'open', 'close', 'snapshot', 'act', 'expect', 'run']

function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) {
      flags._ = [...(flags._ || []), a]
      continue
    }
    const key = a.slice(2)
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      i++
    }
  }
  return { cmd, flags }
}

const HELP = `android-device-operator

用法：
  node cli.mjs preflight                     自检：adb / 设备 / 解锁 / 调试端口 / 页面
  node cli.mjs devices                       列出设备
  node cli.mjs channel                       报告当前走哪条通道
  node cli.mjs pages [--live]                列出可调试页面
  node cli.mjs close --all | --id <id>       关掉多余标签页（Chrome 会越开越多）
  node cli.mjs open --to <URL>               打开页面
  node cli.mjs snapshot [--url 片段]         抓页面结构（默认优先 CDP）
  node cli.mjs act --op click --ref css:#x   执行一个动作
  node cli.mjs expect --text "3/10"          等待条件成立
  node cli.mjs run --flow x.json             跑多步流程（一次调用跑完）

通用参数：
  --url <片段>       目标页面 URL 片段（多页面时必须给）
  --channel <c>      webview | device（默认自动）
  --port <n>         CDP 端口（默认 9223）
  --serial <id>      指定设备
  --no-auto-forward  不自动做 adb forward
  --pretty           缩进输出
  --full             不裁剪快照

act 参数：
  --op click|type|navigate|swipe|press|eval
  --ref <ref>        css:... | text:... | text~:... | id:... | ax:...
  --text <s>         输入内容 / 要等待出现的文本
  --to <URL>         navigate 的目标地址
  --key <code>       按键码（press）
  --xy x,y           坐标（兜底）
  --touch            用触摸事件代替 click（有些 H5 只认这个）
  --expect-text <s>  动作后必须出现的文本（强烈建议）

退出码：0 成功 / 2 需要人 / 3 失败可重试
`

function ctxOpts(flags) {
  return {
    port: flags.port ? Number(flags.port) : undefined,
    serial: typeof flags.serial === 'string' ? flags.serial : undefined,
    urlPart: typeof flags.url === 'string' ? flags.url : undefined,
    autoForward: !flags['no-auto-forward'],
    force: typeof flags.channel === 'string' ? flags.channel : undefined
  }
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2))
  const outOpts = { pretty: Boolean(flags.pretty) }

  if (!cmd || cmd === '--help' || cmd === '-h' || flags.help) {
    process.stdout.write(HELP)
    process.exit(cmd ? 0 : 2)
  }
  if (!COMMANDS.includes(cmd)) {
    fail('BadCommand', `未知命令：${cmd}`, `可用：${COMMANDS.join(' / ')}`)
  }

  switch (cmd) {
    case 'preflight':
      return preflight(ctxOpts(flags), outOpts)
    case 'devices': {
      const list = adb.devices()
      return ok({ devices: list, adb: adb.resolveAdb() }, {}, outOpts)
    }
    case 'channel':
      return channelReport(ctxOpts(flags), outOpts)
    case 'pages':
      return pages(flags, ctxOpts(flags), outOpts)
    case 'open':
      return openPage(flags, ctxOpts(flags), outOpts)
    case 'close':
      return closeTargets(flags, ctxOpts(flags), outOpts)
    case 'snapshot':
      return snapshot(flags, ctxOpts(flags), outOpts)
    case 'act':
      return act(flags, ctxOpts(flags), outOpts)
    case 'expect':
      return expectCmd(flags, ctxOpts(flags), outOpts)
    case 'run':
      return runFlowCmd(flags, ctxOpts(flags), outOpts)
    default:
      return fail('BadCommand', `未实现：${cmd}`)
  }
}

/* ------------------------------- preflight ------------------------------- */

async function preflight(opts, outOpts) {
  const checks = []
  const add = (name, passed, detail, fix) => checks.push({ name, ok: passed, detail, ...(fix ? { fix } : {}) })

  add('platform', ['darwin', 'win32', 'linux'].includes(process.platform), process.platform)

  const adbBin = adb.resolveAdb()
  add(
    'adb',
    Boolean(adbBin),
    adbBin || '未找到',
    adbBin
      ? null
      : process.platform === 'win32'
        ? '装 Android SDK Platform-Tools，把 platform-tools 加入 PATH，或设 ADB 环境变量指向 adb.exe'
        : 'brew install --cask android-platform-tools，或设 ADB 环境变量指向 adb'
  )

  let device = null
  if (adbBin) {
    try {
      const list = adb.devices()
      device = list.find((d) => d.state === 'device') ?? null
      add(
        'device',
        Boolean(device),
        device ? `${device.serial}${device.model ? ` (${device.model})` : ''}` : list.length ? JSON.stringify(list) : '未连接',
        device ? null : '插线 + 手机开 USB 调试；`adb devices` 应显示 device'
      )
    } catch (e) {
      add('device', false, e.message, e.hint)
    }

    if (device) {
      try {
        const power = adb.adb(['-s', device.serial, 'shell', 'dumpsys power'])
        const awake = /mWakefulness=Awake/.test(power.stdout) || /state=ON/.test(power.stdout)
        add('screen_on', awake, awake ? 'awake' : '息屏/锁屏', awake ? null : '点亮并解锁屏幕，否则所有点击都会落空')
      } catch {
        add('screen_on', true, 'unknown')
      }
    }
  }

  let sockets = []
  if (device) {
    try {
      sockets = adb.devtoolsSockets({ serial: device.serial })
      add(
        'webview_debug',
        sockets.length > 0,
        sockets.length ? sockets.join(', ') : '没有 devtools socket',
        sockets.length ? null : '微信里打开 http://debugxweb.qq.com/?inspector=true → 弹框点「确定」，再重新打开目标页'
      )
    } catch (e) {
      add('webview_debug', false, e.message)
    }
  }

  let targets = []
  if (device && sockets.length) {
    try {
      const cdp = await ensureCdp({ port: opts.port, serial: device.serial, autoForward: opts.autoForward })
      targets = await listTargets(cdp.port)
      add('cdp', true, `127.0.0.1:${cdp.port}${cdp.forwarded ? ` → ${cdp.forwarded}` : '（已连通）'}`)
      add('target', targets.length > 0, `${targets.length} 个页面`, targets.length ? null : '在设备上打开要操作的那一页')
    } catch (e) {
      add('cdp', false, e.message, e.hint)
    }
  }

  const critical = ['adb', 'device']
  const failed = checks.filter((c) => critical.includes(c.name) && !c.ok)
  const channels = []
  if (targets.length) channels.push('webview')
  if (device) channels.push('device')

  const payload = {
    channels,
    preferred: channels[0] ?? null,
    checks,
    next: failed.length
      ? checks.filter((c) => !c.ok && c.fix).map((c) => c.fix)
      : ['可以开始：node cli.mjs snapshot --url <页面片段>']
  }

  if (failed.length) {
    emit(
      {
        ok: false,
        error: {
          code: failed[0].name === 'adb' ? 'NoAdb' : 'NoDevice',
          message: '前置条件未满足'
        },
        ...payload
      },
      outOpts
    )
    process.exit(2)
  }
  ok(payload, {}, outOpts)
}

/* -------------------------------- channel -------------------------------- */

async function channelReport(opts, outOpts) {
  const result = { adb: adb.resolveAdb(), devices: [] }
  try {
    result.devices = adb.devices()
  } catch (e) {
    result.adbError = { code: e.code, message: e.message, hint: e.hint }
  }

  const dev = result.devices.find((d) => d.state === 'device')
  if (dev) {
    result.serial = dev.serial
    try {
      result.sockets = adb.devtoolsSockets({ serial: dev.serial })
    } catch (e) {
      result.socketsError = e.message
    }
  }

  try {
    const cdp = await ensureCdp({ port: opts.port, serial: dev?.serial, autoForward: opts.autoForward })
    result.cdp = { ok: true, port: cdp.port, forwarded: cdp.forwarded ?? null }
    const targets = await listTargets(cdp.port)
    result.cdp.targets = targets.map((t) => ({
      id: t.id,
      title: (t.title || '').slice(0, 40),
      url: (t.url || '').slice(0, 120)
    }))
  } catch (e) {
    result.cdp = { ok: false, code: e.code, message: e.message, hint: e.hint }
  }

  result.preferred = result.cdp?.ok && result.cdp.targets?.length ? 'webview' : result.serial ? 'device' : null
  if (!result.preferred) {
    emit({ ok: false, error: { code: 'NoChannel', message: '没有可用通道' }, ...result }, outOpts)
    process.exit(2)
  }
  ok(result, {}, outOpts)
}

/* --------------------------------- pages --------------------------------- */

async function pages(flags, opts, outOpts) {
  const cdp = await ensureCdp({
    port: opts.port,
    serial: opts.serial,
    autoForward: opts.autoForward,
    urlPart: opts.urlPart
  })
  const targets = await listTargets(cdp.port)
  if (targets.length === 0) {
    fail('NoTarget', '调试列表为空：WebView 可能已被回收', '在设备上重新打开目标页，再跑一次')
  }

  // 默认只报 /json/list 的元数据（快）；加 --live 才连上去读真实 location.href。
  // 实测元数据会滞后，且后台标签页可能被冻结 —— 两种都要如实报出来。
  const pages = await Promise.all(
    targets.map(async (t) => {
      const base = { id: t.id, title: (t.title || '').slice(0, 60), url: t.url }
      if (!flags.live) return base
      try {
        const { session, liveUrl } = await attach([t], undefined, { verify: true })
        session.close()
        return {
          ...base,
          url: liveUrl || t.url,
          urlStale: Boolean(liveUrl) && liveUrl !== t.url
        }
      } catch (e) {
        // 只把「通道类」错误当成数据；编程错误必须冒出去，不能被静默吞掉
        if (!e.code) throw e
        return { ...base, error: e.code }
      }
    })
  )
  ok({ port: cdp.port, pages }, {}, outOpts)
}

/* --------------------------------- open ---------------------------------- */

async function openPage(flags, opts, outOpts) {
  const url = flags.to
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    fail('BadArgs', 'open 需要 --to <http(s) 地址>', '例：node cli.mjs open --to https://example.com')
  }
  const ctx = await openContext({ ...opts, force: 'device' })
  try {
    const r = await ctx.act({ op: 'navigate', url })
    ok({ channel: ctx.kind, url, detail: r.detail }, {}, outOpts)
  } finally {
    ctx.close()
  }
}

/* --------------------------------- close --------------------------------- */

async function closeTargets(flags, opts, outOpts) {
  const cdp = await ensureCdp({ port: opts.port, serial: opts.serial, autoForward: opts.autoForward })
  const targets = await listTargets(cdp.port)
  let victims = null
  if (flags.all) victims = targets
  else if (typeof flags.id === 'string') victims = targets.filter((t) => t.id === flags.id)
  else if (typeof flags.url === 'string') victims = targets.filter((t) => (t.url || '').includes(flags.url))

  if (!victims) fail('BadArgs', 'close 需要 --all / --id <id> / --url <片段> 之一')
  if (victims.length === 0) ok({ closed: [], remaining: targets.length }, {}, outOpts)

  const v = await cdpVersion(cdp.port)
  const browser = await CdpSession.open(v.webSocketDebuggerUrl)
  const closed = []
  try {
    for (const t of victims) {
      try {
        await browser.call('Target.closeTarget', { targetId: t.id }, 5000)
        closed.push({ id: t.id, url: t.url })
      } catch (e) {
        closed.push({ id: t.id, url: t.url, error: e.code || e.message })
      }
    }
  } finally {
    browser.close()
  }
  ok({ closed, remaining: targets.length - closed.filter((c) => !c.error).length }, {}, outOpts)
}

/* -------------------------------- snapshot ------------------------------- */

async function snapshot(flags, opts, outOpts) {
  const ctx = await openContext(opts)
  try {
    const page = await ctx.snapshot()
    ok({ channel: ctx.kind, page: trimSnapshot(page, { full: Boolean(flags.full) }) }, {}, outOpts)
  } finally {
    ctx.close()
  }
}

/* ---------------------------------- act ---------------------------------- */

async function act(flags, opts, outOpts) {
  const op = flags.op
  if (typeof op !== 'string') fail('BadArgs', 'act 需要 --op click|type|navigate|swipe|press|eval')

  const action = {
    op,
    ref: typeof flags.ref === 'string' ? flags.ref : undefined,
    text: typeof flags.text === 'string' ? flags.text : undefined,
    url: typeof flags.to === 'string' ? flags.to : typeof flags.url === 'string' ? flags.url : undefined,
    key: typeof flags.key === 'string' ? flags.key : undefined,
    js: typeof flags.js === 'string' ? flags.js : undefined,
    touch: Boolean(flags.touch),
    xy: typeof flags.xy === 'string' ? flags.xy.split(',').map(Number) : undefined
  }
  if (op === 'navigate' && !action.url) fail('BadArgs', 'navigate 需要 --to <完整地址>')

  const ctx = await openContext(opts)
  try {
    const r = await ctx.act(action)
    const expectText = typeof flags['expect-text'] === 'string' ? flags['expect-text'] : null

    if (expectText) {
      const cond = normalizeCond({ text: expectText }, { timeout: Number(flags.timeout ?? 8) })
      let exp = await ctx.expect(cond, cond.timeout)

      // 有些 H5 只绑 touch 事件，el.click() 一点反应都没有（实测抽奖轮盘就是这样）。
      // 后置条件不成立时自动补一次 touch 序列，比直接放弃或让用户怀疑工具要靠谱。
      let retriedWithTouch = false
      if (!exp.ok && op === 'click' && !action.touch) {
        await ctx.act({ ...action, touch: true })
        const retry = await ctx.expect(cond, cond.timeout)
        if (retry.ok) {
          retriedWithTouch = true
          exp = retry
        } else {
          exp = retry
        }
      }
      if (!exp.ok) {
        emit(
          {
            ok: false,
            error: {
              code: 'ExpectTimeout',
              message: `动作已执行，但 "${expectText}" 在 ${cond.timeout}s 内没有出现`,
              hint: '看 snapshot 确认页面是否变化；也可能是点到了外层容器，换成更精确的 ref'
            },
            channel: ctx.kind,
            detail: r.detail,
            last: exp.last ? { url: exp.last.url, text: (exp.last.text || '').slice(0, 300) } : null
          },
          outOpts
        )
        process.exit(3)
      }
      return ok(
        { channel: ctx.kind, detail: r.detail, verified: true, ms: exp.ms, ...(retriedWithTouch ? { retriedWithTouch: true } : {}) },
        {},
        outOpts
      )
    }

    ok(
      {
        channel: ctx.kind,
        detail: r.detail,
        verified: false,
        hint: '动作已投递但没有后置条件。用 --expect-text 或 expect 命令确认它真的生效'
      },
      {},
      outOpts
    )
  } finally {
    ctx.close()
  }
}

/* --------------------------------- expect -------------------------------- */

async function expectCmd(flags, opts, outOpts) {
  const timeout = Number(flags.timeout ?? 8)
  let cond
  if (typeof flags.text === 'string') cond = normalizeCond({ text: flags.text })
  else if (typeof flags['text-matches'] === 'string') cond = normalizeCond({ kind: 'textMatches', value: flags['text-matches'] })
  else if (typeof flags['url-matches'] === 'string') cond = normalizeCond({ kind: 'urlMatches', value: flags['url-matches'] })
  else if (typeof flags.ref === 'string') cond = normalizeCond({ ref: flags.ref })
  else if (typeof flags.js === 'string') cond = normalizeCond({ kind: 'js', value: flags.js })
  else fail('BadArgs', 'expect 需要 --text / --text-matches / --url-matches / --ref / --js 之一')

  const ctx = await openContext(opts)
  try {
    const exp = await ctx.expect(cond, timeout)
    const payload = {
      channel: ctx.kind,
      cond,
      ms: exp.ms,
      ...(exp.ok ? {} : { last: exp.last ? { url: exp.last.url, text: (exp.last.text || '').slice(0, 300) } : null })
    }
    if (!exp.ok) {
      emit({ ok: false, error: { code: 'ExpectTimeout', message: `条件 ${timeout}s 内未成立` }, ...payload }, outOpts)
      process.exit(3)
    }
    ok(payload, {}, outOpts)
  } finally {
    ctx.close()
  }
}

/* ---------------------------------- run ---------------------------------- */

async function runFlowCmd(flags, opts, outOpts) {
  if (typeof flags.flow !== 'string') fail('BadArgs', 'run 需要 --flow <文件>')
  const flow = loadFlow(flags.flow)
  const ctx = await openContext({
    ...opts,
    force: opts.force ?? flow.channel,
    urlPart: opts.urlPart ?? flow.target?.urlPart
  })
  const started = Date.now()
  try {
    const result = await runFlow(ctx, flow)
    const payload = { channel: ctx.kind, flow: flow.name ?? null, wallMs: Date.now() - started, ...result }
    if (!result.ok) {
      // 流程失败必须反映到退出码，否则调用方会以为整条链路成功
      emit(
        {
          ok: false,
          error: {
            code: 'FlowFailed',
            message: `第 ${result.failedAt} 步没有达成预期状态`,
            hint: '看 steps[].error 里的 last.text 判断停在哪；不要盲目重跑整条流程'
          },
          ...payload
        },
        outOpts
      )
      process.exit(3)
    }
    ok(payload, {}, outOpts)
  } finally {
    ctx.close()
  }
}

main().catch((e) => {
  fail(e.code || 'Unhandled', e.message, e.hint)
})
