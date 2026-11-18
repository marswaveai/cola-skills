// Minimal, dependency-free headless Chrome driver over the DevTools Protocol.
// Needs Node >= 22 (global WebSocket) and any Chrome/Chromium/Edge build.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localizeHtmlFile, readManifest } from './fonts.mjs';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
export const CACHE_DIR =
  process.env.ARTICLE2MEDIA_CACHE ||
  path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'article2media');

const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

function systemCandidates() {
  if (process.platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ];
    return apps.flatMap((a) => [`/Applications/${a}`, path.join(HOME, 'Applications', a)]);
  }
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((r) => [
      path.join(r, 'Google/Chrome/Application/chrome.exe'),
      path.join(r, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(r, 'Chromium/Application/chrome.exe'),
    ]);
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  return names.flatMap((n) => dirs.map((d) => path.join(d, n)));
}

const PW_EXEC = {
  darwin: [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-headless-shell-mac-arm64/chrome-headless-shell',
    'chrome-headless-shell-mac-x64/chrome-headless-shell',
  ],
  linux: ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell'],
  win32: ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-headless-shell-win64/chrome-headless-shell.exe'],
};

function playwrightCandidates() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH];
  if (process.platform === 'darwin') roots.push(path.join(HOME, 'Library/Caches/ms-playwright'));
  else if (process.platform === 'win32') roots.push(path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'));
  else roots.push(path.join(HOME, '.cache/ms-playwright'));
  const out = [];
  for (const root of roots.filter(Boolean)) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    const builds = entries
      .map((e) => ({ e, m: e.match(/^chromium(_headless_shell)?-(\d+)$/) }))
      .filter((x) => x.m)
      // Prefer full Chromium over headless shell, then newest build.
      .sort((a, b) => (a.m[1] ? 1 : 0) - (b.m[1] ? 1 : 0) || Number(b.m[2]) - Number(a.m[2]));
    for (const { e } of builds) for (const rel of PW_EXEC[process.platform] || []) out.push(path.join(root, e, rel));
  }
  return out;
}

export function findChrome() {
  const env = process.env.ARTICLE2MEDIA_CHROME || process.env.CHROME_PATH;
  if (env) {
    if (isFile(env)) return env;
    throw new Error(`ARTICLE2MEDIA_CHROME/CHROME_PATH 指向的文件不存在：${env}`);
  }
  return [...systemCandidates(), ...playwrightCandidates()].find(isFile) || null;
}

export const NO_CHROME_HELP =
  '没有找到 Chrome / Chromium。任选其一：\n' +
  '  1) 安装 Google Chrome；\n' +
  '  2) 运行 `npx playwright install chromium`（会下载到 Playwright 缓存目录，本工具能自动找到）；\n' +
  '  3) 设置环境变量 ARTICLE2MEDIA_CHROME=/path/to/chrome。';

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.waiters = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
        return;
      }
      for (const w of this.waiters) {
        if (w.method === msg.method && (!w.sessionId || w.sessionId === msg.sessionId)) {
          this.waiters.delete(w);
          w.resolve(msg.params);
        }
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Chrome 连接已关闭'));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  waitForEvent(method, sessionId, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const w = { method, sessionId, resolve: (p) => { clearTimeout(t); resolve(p); } };
      const t = setTimeout(() => { this.waiters.delete(w); reject(new Error(`等待 ${method} 超时`)); }, timeout);
      this.waiters.add(w);
    });
  }
}

export async function launchBrowser() {
  const exe = findChrome();
  if (!exe) throw new Error(NO_CHROME_HELP);
  const headlessShell = /headless[-_]shell/.test(exe);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2i-chrome-'));
  // Remote web fonts: one HTTP cache shared between runs keeps the font slices (two renders at once then share it,
  // which is why parallel renders were discouraged). With local fonts installed (fonts.mjs) nothing needs caching:
  // the cache stays inside this process's own profile and parallel renders are independent.
  const shared = !Object.keys(readManifest().imports).length || process.env.ARTICLE2MEDIA_FONTS === 'remote';
  const diskCache = shared ? path.join(CACHE_DIR, 'http-cache') : path.join(userDataDir, 'http-cache');
  fs.mkdirSync(diskCache, { recursive: true });
  const args = [
    headlessShell ? '--headless' : '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    `--disk-cache-dir=${diskCache}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--allow-file-access-from-files',
  ];
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  args.push('about:blank');

  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  const wsUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Chrome 启动超时（${exe}）\n${log.slice(-800)}`)), 30000);
    proc.stderr.on('data', (d) => {
      log = (log + d).slice(-4000);
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('error', (e) => { clearTimeout(t); reject(e); });
    proc.on('exit', (code) => {
      clearTimeout(t);
      // Agent sandboxes (Codex's workspace-write, macOS seatbelt) commonly forbid launching a browser.
      const hint = process.env.CODEX_SANDBOX || /sandbox|seatbelt|Operation not permitted/i.test(log)
        ? '\n看起来是在沙箱里运行，沙箱不允许启动 Chrome：给这条出图命令单独放行（允许启动浏览器、写缓存目录），或在沙箱外运行出图这一步。'
        : '';
      reject(new Error(`Chrome 意外退出（code ${code}）${hint}\n${log.slice(-800)}`));
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('无法连接 Chrome DevTools')), { once: true });
  });
  const cdp = new CDP(ws);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await Promise.race([cdp.send('Browser.close'), new Promise((r) => setTimeout(r, 2000))]); } catch {}
    try { ws.close(); } catch {}
    try { proc.kill(); } catch {}
    try { proc.stderr?.destroy(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  };

  return { exe, cdp, close, newPage: () => newPage(cdp) };
}

async function newPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  await s('Page.enable');

  const page = {
    async setViewport(width, height, scale = 1) {
      await s('Emulation.setDeviceMetricsOverride', {
        width: Math.ceil(width), height: Math.ceil(height), deviceScaleFactor: scale, mobile: false,
      });
    },
    async setUserAgent(userAgent) {
      await s('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8' });
    },
    async goto(url, { timeout = 60000 } = {}) {
      // Every pipeline loads its built page from disk through here: point the page's font @imports at the local
      // copies (when fonts.mjs installed them) before Chrome reads it. Imports without a local copy stay remote.
      if (/^file:.*\.html?$/i.test(url)) { try { localizeHtmlFile(fileURLToPath(url)); } catch {} }
      const loaded = cdp.waitForEvent('Page.loadEventFired', sessionId, timeout);
      const r = await s('Page.navigate', { url });
      if (r.errorText) throw new Error(`打开页面失败：${r.errorText}（${url}）`);
      try { await loaded; } catch (e) {
        throw new Error(`${e.message}：页面没在 ${Math.round(timeout / 1000)} 秒内加载完，常见原因是网络图片（例如原文配图）加载慢。再运行一次；经常这样就把图下载到工作目录，用相对路径引用`);
      }
    },
    async evaluate(fn, arg) {
      const expression = typeof fn === 'function' ? `(${fn.toString()})(${JSON.stringify(arg ?? null)})` : fn;
      const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(`页面脚本出错：${d.exception?.description || d.text}`);
      }
      return r.result?.value;
    },
    // Wait for web fonts and images, bounded by `timeout` ms.
    async settle(timeout = 25000) {
      return page.evaluate(async (ms) => {
        const deadline = new Promise((r) => setTimeout(() => r('timeout'), ms));
        const work = (async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map((img) =>
            img.complete ? 0 : new Promise((r) => { img.addEventListener('load', r); img.addEventListener('error', r); })));
          await new Promise((r) => setTimeout(r, 120));
          await document.fonts.ready;
          return document.fonts.status;
        })();
        return Promise.race([work, deadline]);
      }, timeout);
    },
    // beyond: capture outside the viewport (tall pages). Video frames pass false: with it on, a seek followed at once
    // by a capture sometimes gets a layer that is not rastered yet (79 of 2116 frames lost their caption).
    async screenshot({ clip, format = 'png', quality, beyond = true } = {}) {
      const params = { format, captureBeyondViewport: beyond, fromSurface: true };
      if (clip) params.clip = { scale: 1, ...clip };
      if (format === 'jpeg' && quality) params.quality = quality;
      const r = await s('Page.captureScreenshot', params);
      return Buffer.from(r.data, 'base64');
    },
    /** Raw DevTools call in this page's session (e.g. CSS.getPlatformFontsForNode). */
    send: (method, params) => s(method, params),
    close: () => cdp.send('Target.closeTarget', { targetId }).catch(() => {}),
  };
  return page;
}
