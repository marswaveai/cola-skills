#!/usr/bin/env node
// Environment check: Node version, Chrome, a real headless launch, fonts (local copies / reachability), and optional capabilities
// (AI illustrations, video → transcript input).
import { fileURLToPath } from 'node:url';
import { findChrome, launchBrowser, NO_CHROME_HELP, CACHE_DIR } from './lib/chrome.mjs';

const out = { ok: true, node: process.versions.node, checks: [] };
const add = (name, ok, detail) => { out.checks.push({ name, ok, detail }); if (!ok) out.ok = false; };

const major = Number(process.versions.node.split('.')[0]);
add('node>=22', major >= 22 && typeof WebSocket === 'function', major >= 22 ? `v${process.versions.node}` : `当前 v${process.versions.node}，需要 Node 22+（内置 WebSocket）`);

let exe = null;
try { exe = findChrome(); } catch (e) { add('chrome', false, e.message); }
if (exe !== null || !out.checks.some((c) => c.name === 'chrome')) add('chrome', !!exe, exe || NO_CHROME_HELP);

if (exe) {
  try {
    const b = await launchBrowser();
    const p = await b.newPage();
    await p.goto('about:blank');
    const ua = await p.evaluate(() => navigator.userAgent);
    await b.close();
    add('headless-launch', true, ua.match(/Chrome\/[\d.]+/)?.[0] || 'ok');
  } catch (e) {
    add('headless-launch', false, e.message);
  }
}

// Fonts. Local copies (fonts.mjs) make rendering independent of the network; without them the themes load their
// fonts from Google Fonts / jsDelivr on every render and fall back to system CJK fonts when that fails. Never fatal.
{
  const { fontsStatus, fmtSize } = await import('./lib/fonts.mjs');
  const st = fontsStatus();
  const cmd = `node ${fileURLToPath(new URL('../../scripts/fonts.mjs', import.meta.url))}`;
  out.checks.push({
    name: 'local-fonts', ok: !st.missing.length,
    detail: st.missing.length
      ? `本地字体：${st.covered} / ${st.wanted} 组已安装${st.covered ? `（${st.families.length} 个字体家族，${fmtSize(st.bytes)}）` : ''}，其余出图时联网加载。下载到本地（约 65 MB，之后出图不依赖网络）：${cmd}`
      : `本地字体已安装：${st.families.length} 个字体家族，${st.files} 个文件，${fmtSize(st.bytes)}（${st.dir}）`,
  });
  out.fonts = { dir: st.dir, installed: st.covered, wanted: st.wanted, families: st.families.length, bytes: st.bytes };
  if (st.missing.length) {
    try {
      const r = await fetch('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400&display=block', { signal: AbortSignal.timeout(8000) });
      add('web-fonts', r.ok, r.ok ? 'fonts.googleapis.com 可访问' : `HTTP ${r.status}`);
    } catch (e) {
      // Not fatal: themes fall back to system CJK fonts.
      out.checks.push({ name: 'web-fonts', ok: false, detail: `无法访问 Google Fonts（${e.cause?.code || e.message}），没装到本地的字体会回退到系统中文字体，效果会打折扣。下载时可以换镜像：${cmd} --mirror <主机>` });
    }
  } else out.checks.push({ name: 'web-fonts', ok: true, detail: '字体都在本地，出图不需要访问 Google Fonts' });
}

// Optional: AI illustrations (illustrations, video covers, comics). Not a failure when missing.
{
  const { describeImageSetup } = await import('./lib/imagegen.mjs');
  let detail;
  try {
    const d = describeImageSetup();
    out.image = { provider: d.provider, model: d.model, forced: d.forced, models: d.models, available: d.available, config: d.config };
    const override = `模型和服务可以用 ARTICLE2MEDIA_IMAGE_MODEL_CODEX|OPENAI|GEMINI、ARTICLE2MEDIA_IMAGE_PROVIDER 或 ${d.configPath} 覆盖`;
    const codexNote = d.codex === 'logged-out' ? '；Codex CLI 已安装但没有登录（codex login）' : '';
    detail = d.available.length || d.forced
      ? `出图：${d.text}${codexNote}。${override}（AI 插画、视频封面插画、漫画）`
      : `没有出图能力：不能生成 AI 插画和漫画（登录 Codex CLI，或设置 OPENAI_API_KEY / GEMINI_API_KEY；其余功能不受影响）${codexNote}`;
  } catch (e) { detail = e.message; }
  out.checks.push({ name: 'ai-illustration', ok: true, detail });
}

// Optional: video input (fetch.mjs turns Douyin / YouTube / Bilibili / local media into a transcript article).
{
  const { detectYtdlp, ffmpegOk } = await import('./lib/media/source.mjs');
  const { detectVoice } = await import('./lib/video/voice.mjs');
  const yt = detectYtdlp(), ff = ffmpegOk(), asr = detectVoice().whisper;
  const parts = [
    yt ? `yt-dlp ${yt.version}${yt.jsRuntimes ? '' : '（版本偏旧，YouTube 可能过不了 JS 校验：brew upgrade yt-dlp）'}` : '没有 yt-dlp：YouTube、B 站链接用不了（brew install yt-dlp）',
    ff ? 'ffmpeg ✓' : '没有 ffmpeg：视频转音频用不了（brew install ffmpeg）',
    asr ? `本地语音识别 ✓（${asr.model.split('/').pop()}）` : '没有本地语音识别：只能用平台字幕或 .srt / .vtt（Apple Silicon 上装 mlx-whisper 和 whisper-large-v3-turbo 模型）',
  ];
  out.checks.push({ name: 'video-input', ok: true, detail: `视频转逐字稿（可选功能）：${parts.join('；')}` });
}

out.cache = CACHE_DIR;
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
