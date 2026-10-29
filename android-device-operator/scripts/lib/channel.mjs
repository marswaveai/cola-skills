/**
 * 统一通道层：WebView(CDP) 与 Device(ADB) 两种实现，对外同一个接口。
 *
 *   ctx.snapshot()            -> PageState
 *   ctx.act(action)           -> {ok, channel, detail}
 *   ctx.expect(cond, timeout) -> {ok, ms, last}
 *   ctx.close()
 */
import {
  CdpSession,
  ChannelError,
  listTargets,
  version as cdpVersion
} from './cdp.mjs'
import * as adb from './adb.mjs'
import { SNAPSHOT_JS, checkCond, findElement, normText, signature } from './page.mjs'

const DEFAULT_PORT = Number(process.env.CDP_PORT || 9223)

/** 尽力让 CDP 可用：先测端口，失败再逐个 socket 试，按「是否命中目标 URL」打分。 */
export async function ensureCdp({ port = DEFAULT_PORT, serial, autoForward = true, urlPart } = {}) {
  let initialError = null
  let sawDebugger = false
  try {
    const v = await cdpVersion(port)
    sawDebugger = true
    const targets = await listTargets(port)
    // 端口通但一个页面都没有 = 页面被回收。继续试别的 socket，
    // 机器上经常同时挂着几个空的 debugger。
    if (targets.length > 0) return { port, version: v, targets }
  } catch (first) {
    initialError = first
    if (!autoForward) throw first
  }

  let sockets
  try {
    sockets = adb.devtoolsSockets({ serial })
  } catch (e) {
    throw new ChannelError('NoAdb', `CDP 不通，且无法查 devtools socket：${e.message}`, initialError?.hint)
  }

  const candidates = sockets.filter((s) => s.includes('devtools'))
  if (candidates.length === 0) {
    throw new ChannelError(
      'GateClosed',
      '没找到 WebView 调试 socket',
      '微信里打开 http://debugxweb.qq.com/?inspector=true → 弹框点「确定」；然后重新打开目标页'
    )
  }

  // 同一端口可以被反复 forward 覆盖，所以逐个试并打分：
  // 命中目标 URL +10，有任何页面 +1。机器上经常同时存在几个 socket，
  // 其中大部分是空的（比如桌面壳的 WebView），必须靠「有没有页面」筛掉。
  const tried = []
  let best = null
  for (const sock of candidates) {
    try {
      adb.forward(port, sock, { serial })
      const v = await cdpVersion(port)
      sawDebugger = true
      let targets = []
      try {
        targets = await listTargets(port)
      } catch {
        /* 没有页面不算失败 */
      }
      const hit = Boolean(urlPart) && targets.some((t) => (t.url || '').includes(urlPart))
      const score = (hit ? 10 : 0) + (targets.length ? 1 : 0)
      tried.push(`${sock}=${targets.length}页${hit ? '(命中)' : ''}`)
      if (score > 0 && (!best || score > best.score)) {
        best = { port, version: v, forwarded: sock, score, targets }
      }
      if (score >= 10) break
    } catch (e) {
      tried.push(`${sock}=失败(${e.code || e.message})`)
    }
  }

  if (best) return best

  if (sawDebugger) {
    throw new ChannelError(
      'NoTarget',
      '调试端口在，但没有任何可操作的页面',
      '目标 App 的 WebView 很可能被系统回收了：在设备上重新打开那一页'
    )
  }

  throw new ChannelError(
    'NoCdp',
    `${port} 端口没有可用的调试页面（试过：${tried.join('; ') || '无 socket'}）`,
    candidates.length
      ? '页面可能已被回收：在设备上重新打开目标页；或换个端口 --port 9230'
      : '确认目标 App 的 WebView 调试开关已打开'
  )
}

/**
 * 连上目标页，并用页面里的 location.href 复核。
 *
 * 为什么要复核：Chrome / XWeb 的 /json/list 元数据会滞后 ——
 * 实测点击跳转后列表里仍是旧 URL。只信 metadata 会选错页或误报 NoTarget。
 */
export async function attach(targets, urlPart, { verify = false } = {}) {
  // 只有一个页面且没指定 urlPart 时不需要探测：直接连上就用，省一次往返。
  // verify=true 强制探测（pages --live 用）。
  if (targets.length === 1 && !urlPart && !verify) {
    try {
      const session = await CdpSession.open(targets[0].webSocketDebuggerUrl, { timeout: 5000 })
      return { session, target: targets[0], liveUrl: targets[0].url }
    } catch (e) {
      throw new ChannelError('NoTarget', `连不上页面：${e.code || e.message}`)
    }
  }

  // 元数据会滞后，所以必须连上去读真实的 location.href 再判重。
  // 并行探测 + 短超时：串行时后台标签页会让每条命令多花十几秒。
  const probes = await Promise.all(
    targets.map(async (t) => {
      try {
        const session = await CdpSession.open(t.webSocketDebuggerUrl, { timeout: 2500 })
        let live = ''
        let responsive = true
        try {
          live = String(await session.evaluate('location.href', { timeout: 3000 }))
        } catch {
          // 后台标签被 Chrome 冻结/丢弃时，socket 能连上但 JS 不执行。
          // 这种情况必须记下来，否则后面 snapshot 会挂满整个超时。
          responsive = false
          live = t.url || ''
        }
        return { t, live, session, responsive }
      } catch (e) {
        return { t, live: null, session: null, err: e.code || e.message }
      }
    })
  )

  const closeAll = () => probes.forEach((p) => p.session?.close())
  const seen = probes.map((p) => p.live || `(不可达:${p.err})`).join(' | ')

  const open = probes.filter((p) => p.session)
  if (open.length === 0) throw new ChannelError('NoTarget', '所有页面都连不上', seen)

  const matched = urlPart ? open.filter((p) => p.live.includes(urlPart)) : open
  if (matched.length === 0) {
    closeAll()
    throw new ChannelError('NoTarget', `没有 URL 包含 "${urlPart}" 的页面`, `实际打开的页面：${seen}`)
  }

  // 只在「有响应」的页面里挑；全都被冻结就直接报错，别让调用方等 25 秒。
  const responsive = matched.filter((p) => p.responsive)
  if (responsive.length === 0) {
    closeAll()
    throw new ChannelError(
      'PageFrozen',
      `${matched.length} 个页面里没有能响应 JS 的（都可能在后台被冻结）`,
      '在手机上把目标标签切到前台停一秒，或关掉没用的标签页，再跑一次'
    )
  }
  if (responsive.length > 1) {
    closeAll()
    throw new ChannelError(
      'TargetAmbiguous',
      `有 ${responsive.length} 个页面都匹配 "${urlPart}"`,
      `用更长的 URL 片段区分：${responsive.map((p) => p.live).join(' | ')}`
    )
  }

  const keep = responsive[0]
  probes.forEach((p) => p !== keep && p.session?.close())
  return { session: keep.session, target: { ...keep.t, url: keep.live }, liveUrl: keep.live }
}

class WebviewChannel {
  constructor(session, target, port) {
    this.kind = 'webview'
    this.session = session
    this.target = target
    this.port = port
    this.targetId = target.id
  }

  async snapshot() {
    let raw
    try {
      raw = await this.session.evaluate(SNAPSHOT_JS, { timeout: 8000 })
    } catch (e) {
      if (e.code === 'CdpTimeout') {
        throw new ChannelError(
          'PageFrozen',
          '页面 8 秒内没有响应',
          '标签页可能在后台被冻结：切到前台再试，或刷新页面'
        )
      }
      throw e
    }
    if (!raw || typeof raw !== 'object') {
      throw new ChannelError('BadSnapshot', '页面快照为空，可能正在跳转')
    }
    return { ...raw, signature: signature(raw), channel: 'webview' }
  }

  async act(action) {
    const { op } = action
    if (op === 'eval') {
      const value = await this.session.evaluate(action.js)
      return { ok: true, channel: this.kind, detail: value }
    }
    if (op === 'navigate') {
      // 用 Page.navigate 而不是 location.href：
      // 后者会在跳转瞬间破坏执行上下文，evaluate 直接抛 JsError，看起来像动作失败。
      const before = await this.session.evaluate('location.href').catch(() => '')
      try {
        const r = await this.session.call('Page.navigate', { url: action.url }, 15000)
        if (r?.errorText) throw new ChannelError('NavigateFail', r.errorText)
      } catch (e) {
        if (e.code === 'CdpClosed') throw e
        await this.session.evaluate(`location.href=${JSON.stringify(action.url)}`)
      }
      // 有的浏览器（实测 Chrome/Android）会把导航开进新标签，
      // 当前会话就永远停在旧页。这里 3 秒内没变就直接报错，别让它拖成 ExpectTimeout。
      const host = safeHost(action.url)
      const startedAt = Date.now()
      while (Date.now() - startedAt < 3000) {
        const now = await this.session.evaluate('location.href').catch(() => '')
        if (now && (now === action.url || (host && now.includes(host)))) {
          return { ok: true, channel: this.kind, detail: action.url }
        }
        await sleep(200)
      }
      throw new ChannelError(
        'NavigateNewTab',
        `导航后当前会话仍停在 ${before || '(空)'}`,
        '目标页可能开在了新标签：先跑 pages 看新页面，再用 --url 重新指定'
      )
    }
    if (op === 'click') {
      const r = await this.session.evaluate(clickJs(action.ref, { touch: Boolean(action.touch) }))
      if (!r?.ok) throw new ChannelError('RefNotFound', `点不到元素：${action.ref}`, '先跑 snapshot 看 ref 是否存在')
      return { ok: true, channel: this.kind, detail: r }
    }
    if (op === 'type') {
      const r = await this.session.evaluate(typeJs(action.ref, action.text ?? ''))
      if (!r?.ok) throw new ChannelError('RefNotFound', `找不到输入框：${action.ref}`, '先跑 snapshot')
      return { ok: true, channel: this.kind, detail: r }
    }
    if (op === 'swipe') {
      const r = await this.session.evaluate(
        `window.scrollBy(${Number(action.dx || 0)}, ${Number(action.dy || 600)}), true`
      )
      return { ok: true, channel: this.kind, detail: r }
    }
    throw new ChannelError('BadOp', `webview 通道不支持动作：${op}`)
  }

  async expect(cond, timeoutSeconds) {
    const started = Date.now()
    const deadline = started + Number(timeoutSeconds ?? 8) * 1000 // 对外是秒
    let last = null
    while (Date.now() < deadline) {
      try {
        if (cond.kind === 'js') {
          const v = await this.session.evaluate(cond.value)
          if (v) return { ok: true, ms: Date.now() - started, last: v }
        } else {
          last = await this.snapshot()
          if (checkCond(cond, last)) return { ok: true, ms: Date.now() - started, last }
        }
      } catch (e) {
        last = { error: e.message }
      }
      await sleep(350)
    }
    return { ok: false, ms: Date.now() - started, last }
  }

  close() {
    this.session.close()
  }
}

class DeviceChannel {
  constructor(serial) {
    this.kind = 'device'
    this.serial = serial
  }

  async snapshot() {
    const xml = adb.uiXml({ serial: this.serial })
    const nodes = adb.parseUiNodes(xml)
    const elements = nodes.map((n) => ({
      ref: n.ref,
      role: n.role,
      text: n.text,
      value: null,
      id: null,
      clickable: n.clickable,
      box: n.box
    }))
    const lines = elements.map((e) => e.text).filter(Boolean).slice(0, 400)
    const page = {
      url: '',
      title: '',
      focus: adb.currentFocus({ serial: this.serial }),
      text: normText(lines.join(' ')),
      lines,
      elements,
      channel: 'device'
    }
    page.signature = signature(page)
    return page
  }

  async act(action) {
    const { op } = action
    if (op === 'navigate') {
      adb.shell(`am start -a android.intent.action.VIEW -d ${JSON.stringify(action.url)}`, { serial: this.serial })
      return { ok: true, channel: this.kind, detail: action.url }
    }
    if (op === 'swipe') {
      const { width, height } = adb.screenSize({ serial: this.serial }) ?? { width: 1080, height: 1920 }
      let x1 = Math.round(width / 2)
      let y1 = Math.round(height * 0.75)
      let x2 = x1
      let y2 = Math.round(height * 0.35)
      if (action.xy) [x1, y1, x2, y2] = action.xy
      adb.swipe(x1, y1, x2, y2, 300, { serial: this.serial })
      return { ok: true, channel: this.kind, detail: { x1, y1, x2, y2 } }
    }
    if (op === 'press') {
      adb.keyevent(action.key, { serial: this.serial })
      return { ok: true, channel: this.kind, detail: action.key }
    }

    // click / type 都需要先定位
    const page = await this.snapshot()
    let el = findElement(page, action.ref)
    if (!el && action.xy) {
      const [x, y] = action.xy
      el = { box: { x: x - 1, y: y - 1, w: 2, h: 2 }, text: action.ref ?? '(坐标)' }
    }
    if (!el?.box) {
      throw new ChannelError('RefNotFound', `在无障碍树里找不到：${action.ref}`, '先跑 snapshot 看可用元素')
    }
    const cx = el.box.x + el.box.w / 2
    const cy = el.box.y + el.box.h / 2
    adb.tap(cx, cy, { serial: this.serial })
    if (op === 'type') {
      await sleep(250)
      adb.inputText(action.text ?? '', { serial: this.serial })
    }
    return { ok: true, channel: this.kind, detail: { tapped: [Math.round(cx), Math.round(cy)], text: el.text } }
  }

  async expect(cond, timeoutSeconds) {
    if (cond.kind === 'js') {
      throw new ChannelError('BadOp', 'device 通道不能执行 JS，请改用页面对应条件')
    }
    const started = Date.now()
    const deadline = started + Number(timeoutSeconds ?? 8) * 1000 // 对外是秒
    let last = null
    while (Date.now() < deadline) {
      try {
        last = await this.snapshot()
        if (checkCond(cond, last)) return { ok: true, ms: Date.now() - started, last }
      } catch (e) {
        last = { error: e.message }
      }
      await sleep(500)
    }
    return { ok: false, ms: Date.now() - started, last }
  }

  close() {}
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 打开上下文。默认优先 webview（更快更准），失败降到 device。
 * force='device' 可跳过 CDP。
 */
export async function openContext({
  urlPart,
  port = DEFAULT_PORT,
  serial,
  force,
  autoForward = true,
  prefer = 'webview'
} = {}) {
  const errors = []

  if (force !== 'device' && prefer === 'webview') {
    try {
      await ensureCdp({ port, serial, autoForward, urlPart })
      const targets = await listTargets(port)
      if (targets.length === 0) {
        throw new ChannelError('NoTarget', '调试列表为空：WebView 可能已被回收', '在设备上重新打开目标页')
      }
      const { session, target } = await attach(targets, urlPart)
      return new WebviewChannel(session, target, port)
    } catch (e) {
      errors.push(`webview: ${e.code || ''} ${e.message}`)
      if (force === 'webview') {
        if (!e.hint) e.hint = '用 --channel device 回落到无障碍树'
        throw e
      }
      // 用户点名了某一页，就不许换通道 —— device 通道根本读不到 URL，
      // 换成它只会在「不知道当前是什么页」的情况下按坐标点，比失败更危险。
      if (urlPart) throw e
    }
  }

  try {
    const dev = adb.requireDevice(serial)
    const channel = new DeviceChannel(dev.serial)
    if (errors.length) channel.fallbackFrom = errors
    return channel
  } catch (e) {
    errors.push(`device: ${e.code || ''} ${e.message}`)
    const err = new ChannelError(
      'NoChannel',
      '两条通道都不可用',
      [e.hint, ...errors].filter(Boolean).join(' / ')
    )
    throw err
  }
}

function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function clickJs(ref, { touch = false } = {}) {
  return `(() => {
  const ref = ${JSON.stringify(String(ref ?? ''))};
  const norm = (s) => String(s == null ? '' : s).replace(/[\s\u00a0\u3000]+/g, ' ').trim();
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };

  const fire = (el, withTouch) => {
    if (!withTouch) return el.click();
    // 有些 H5（vant / 自研轮盘）只绑 touchstart/touchend，el.click() 完全没反应。
    const r = el.getBoundingClientRect();
    const xy = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    try {
      const t = (type, list) => el.dispatchEvent(new TouchEvent(type, { ...xy, [list]: [new Touch({ identifier: 1, target: el, ...xy })] }));
      t('touchstart', 'touches');
      t('touchend', 'changedTouches');
    } catch (e) {}
    el.click();
  };

  if (ref.startsWith('css:')) {
    const el = document.querySelector(ref.slice(4));
    if (!el) return { ok: false, reason: 'not-found' };
    el.scrollIntoView({ block: 'center' });
    fire(el, ${touch ? 'true' : 'false'});
    return { ok: true, tag: el.tagName, text: norm(el.innerText).slice(0, 40) };
  }
  if (ref.startsWith('id:')) {
    const el = document.getElementById(ref.slice(3));
    if (!el) return { ok: false, reason: 'not-found' };
    fire(el, ${touch ? 'true' : 'false'});
    return { ok: true, tag: el.tagName };
  }

  // text: / text~: / 裸串
  const want = norm(ref.replace(/^text~?:/, ''));
  const exactOnly = !ref.startsWith('text~:');
  const all = [...document.querySelectorAll(
    'a,button,label,input,select,textarea,[role=button],[onclick],div,span,li,p')];
  const hit = (n) => {
    const t = norm(n.innerText);
    if (!t) return false;
    return exactOnly ? t === want : t.includes(want);
  };
  let hits = all.filter(hit);
  if (hits.length === 0 && exactOnly) hits = all.filter((n) => norm(n.innerText).includes(want));
  if (hits.length === 0) return { ok: false, reason: 'not-found' };

  // 关键：同名文本往往嵌在多层容器里。表单控件/链接优先，其次取面积最小的那个，
  // 否则会点到外层 div —— 那就是「点了没反应」的真正原因。
  const control = hits.filter((n) =>
    /^(LABEL|A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(n.tagName) || n.getAttribute('role') === 'button');
  const pool = (control.length ? control : hits).slice().sort((a, b) => area(a) - area(b));
  const el = pool[0];

  try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
  fire(el, ${touch ? 'true' : 'false'});
  return { ok: true, tag: el.tagName, text: norm(el.innerText).slice(0, 40), matches: hits.length };
})()`
}

function typeJs(ref, text) {
  return `(() => {
  const ref = ${JSON.stringify(String(ref ?? ''))};
  const text = ${JSON.stringify(String(text))};
  const el = ref.startsWith('css:') ? document.querySelector(ref.slice(4))
           : ref.startsWith('id:') ? document.getElementById(ref.slice(3))
           : [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].find(
               (n) => (n.getAttribute('placeholder') || '').includes(ref.replace(/^text~?:/, '')));
  if (!el) return { ok: false, reason: 'not-found' };
  el.focus();
  if (el.isContentEditable) {
    el.textContent = text;
  } else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, text);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, tag: el.tagName };
})()`
}
