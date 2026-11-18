// Video → transcript article: the I/O half (network, yt-dlp, ffmpeg, Whisper).
//
// Sources, best first:
//   Douyin            mobile share page (_ROUTER_DATA) → MP4 (no-watermark address first) → audio → local Whisper
//   YouTube / Bilibili  yt-dlp metadata → manual subtitles → original-language auto captions → audio → local Whisper
//   local video/audio   ffmpeg → audio → local Whisper
//   .srt / .vtt         parsed directly
// Every run leaves <out>/transcript/: segments.json, segments.md (timestamps), raw.txt, plus the audio/subtitle used.
// Nothing is installed or downloaded implicitly: yt-dlp, ffmpeg and the Whisper model are detected, never fetched.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { detectVoice } from '../video/voice.mjs';
import * as T from './transcript.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY = path.join(HERE, '..', 'video', 'py');
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PLATFORM = { douyin: '抖音视频', youtube: 'YouTube 视频', bilibili: 'B 站视频' };

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 1800000, ...opts });

/** yt-dlp command, version and whether it can solve YouTube's JS challenge with a JS runtime. Never installs it. */
export function detectYtdlp() {
  const cands = [];
  if (process.env.ARTICLE2MEDIA_YTDLP) cands.push(process.env.ARTICLE2MEDIA_YTDLP.split(/\s+/).filter(Boolean));
  cands.push(['yt-dlp'], ['python3', '-m', 'yt_dlp']);
  for (const c of cands) {
    const v = run(c[0], [...c.slice(1), '--version'], { timeout: 30000 });
    if (v.status !== 0) continue;
    const help = run(c[0], [...c.slice(1), '--help'], { timeout: 30000 });
    return { cmd: c, version: v.stdout.trim(), jsRuntimes: /--js-runtimes/.test(help.stdout || '') };
  }
  return null;
}

export const ffmpegOk = () => run('ffmpeg', ['-version'], { timeout: 20000 }).status === 0;

function ffmpegAudio(src, dst) {
  if (!ffmpegOk()) throw new Error('需要 ffmpeg 把视频转成音频（macOS：brew install ffmpeg）');
  const r = run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', dst]);
  if (r.status !== 0 || !fs.existsSync(dst)) throw new Error(`ffmpeg 抽取音频失败：${(r.stderr || '').slice(-400)}`);
}

function probeDuration(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30000 });
  return r.status === 0 ? Math.round(Number(r.stdout.trim()) || 0) : 0;
}

/** Local Whisper transcription of a whole file. */
function transcribe(audio, { lang = 'auto', prompt = '', log }) {
  const det = detectVoice();
  if (!det.whisper) throw new Error('这条视频没有可用字幕，需要本地语音识别：Apple Silicon 上安装 mlx-whisper 并下载 whisper-large-v3-turbo 模型（node video.mjs doctor 查看）');
  const initial = [lang === 'zh' ? '以下是普通话的句子。' : '', prompt].filter(Boolean).join(' ');
  const dur = probeDuration(audio);
  log(`本地语音识别（Whisper ${det.whisper.model.split('/').pop()}）：${dur ? `${Math.round(dur / 60)} 分钟音频，` : ''}大约要音频时长的 1/10 到 1/30…`);
  const t0 = Date.now();
  const r = run(det.whisper.python, [path.join(PY, 'transcribe.py'), det.whisper.model, audio, lang, initial], {
    timeout: 4 * 3600000, env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
  if (r.status !== 0) throw new Error(`语音识别失败：${(r.stderr || '').slice(-600)}`);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  log(`识别完成：${out.segments.length} 段，用时 ${Math.round((Date.now() - t0) / 1000)}s，语言 ${out.language || lang}`);
  return out;
}

async function download(urls, dst, headers) {
  const errors = [];
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers, redirect: 'follow', signal: AbortSignal.timeout(600000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (!/video|octet-stream|mp4/.test(ct)) throw new Error(`不是视频（${ct || '无 content-type'}）`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dst + '.part'));
      fs.renameSync(dst + '.part', dst);
      return u;
    } catch (e) {
      errors.push(`${u.split('?')[0]}：${e.message}`);
      fs.rmSync(dst + '.part', { force: true });
    }
  }
  throw new Error(`视频下载失败：\n  ${errors.join('\n  ')}`);
}

// ---------- Douyin ----------

async function douyin(src, ctx) {
  let id = src.id;
  if (!id) {
    // Short links (v.douyin.com/xxx) redirect to the share page that carries the id.
    const res = await fetch(src.url, { headers: { 'User-Agent': MOBILE_UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    id = T.douyinId(res.url);
    if (!id) throw new Error(`没能从抖音链接里解析出视频 id：${src.url}`);
  }
  const share = `https://www.iesdouyin.com/share/video/${id}/`;
  const headers = { 'User-Agent': MOBILE_UA, Referer: 'https://www.douyin.com/', Accept: 'text/html,*/*' };
  let item, plays;
  try {
    const res = await fetch(share, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`抖音分享页打不开：HTTP ${res.status}`);
    item = T.douyinItem(await res.text());
    plays = item.video?.play_addr?.url_list || [];
    if (!plays.length) throw new Error('抖音分享页里没有播放地址（可能是图文作品）');
  } catch (e) {
    // The share page sometimes ships without the video data; yt-dlp's own Douyin support is the fallback.
    ctx.log(`⚠ ${e.message}，改用 yt-dlp`);
    return viaYtdlp({ kind: 'douyin', url: `https://www.douyin.com/video/${id}` }, ctx);
  }
  const dir = ctx.dirFor(`douyin-${id}`);
  const meta = {
    source: 'douyin', id, platform: PLATFORM.douyin, fetcher: 'douyin-share',
    title: T.titleFromDesc(item.desc, `抖音视频 ${id}`), author: item.author?.nickname || '',
    date: T.isoDay(item.create_time), url: `https://www.douyin.com/video/${id}`,
    cover: item.video?.cover?.url_list?.[0] || item.video?.origin_cover?.url_list?.[0] || '',
    duration: Math.round((item.video?.duration || 0) / 1000), description: item.desc || '',
  };
  return { meta, dir, getSegments: async () => {
    const audio = path.join(dir.t, 'audio.mp3');
    if (!fs.existsSync(audio) || ctx.force) {
      const video = path.join(dir.t, 'video.mp4');
      if (!fs.existsSync(video) || ctx.force) {
        ctx.log('下载视频（优先无水印地址）…');
        meta.downloaded_from = (await download(T.playUrlCandidates(plays[0]), video, { 'User-Agent': MOBILE_UA, Referer: 'https://www.iesdouyin.com/', Accept: '*/*' })).split('?')[0];
      }
      ffmpegAudio(video, audio);
      if (!ctx.keepVideo) fs.rmSync(video, { force: true });
    }
    const asr = transcribe(audio, { lang: ctx.lang === 'auto' ? 'zh' : ctx.lang, prompt: ctx.prompt, log: ctx.log });
    meta.caption_source = '本地语音识别';
    return asr.segments;
  } };
}

// ---------- YouTube / Bilibili via yt-dlp ----------

async function viaYtdlp(src, ctx) {
  const yt = detectYtdlp();
  if (!yt) throw new Error(`${PLATFORM[src.kind]}需要 yt-dlp（macOS：brew install yt-dlp；或 pip install -U yt-dlp）`);
  const base = ['--ignore-config', '--no-warnings', '--no-playlist', '--socket-timeout', '30'];
  // Newer YouTube pages need a JS runtime to solve signature challenges; this script already runs on Node.
  // The challenge solver (yt-dlp-ejs) ships with Homebrew's yt-dlp and with `pip install "yt-dlp[default]"`. Fetching it
  // from GitHub at run time is a download, so it only happens when the user opts in.
  if (src.kind === 'youtube' && yt.jsRuntimes) {
    base.push('--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`);
    if (process.env.ARTICLE2MEDIA_YTDLP_REMOTE_EJS === '1') base.push('--remote-components', 'ejs:github');
  }
  if (ctx.cookies) base.push('--cookies-from-browser', ctx.cookies);
  const ytdlp = (args, timeout) => run(yt.cmd[0], [...yt.cmd.slice(1), ...base, ...args, src.url], { timeout });
  const explain = (stderr, what) => {
    const s = (stderr || '').trim();
    if (/Sign in to confirm|not a bot|cookies/i.test(s) && !ctx.cookies) return `${what}：平台要求浏览器 cookie（${s.split('\n').at(-1).slice(0, 140)}）。两个办法：确认可以复用本机浏览器的状态后加 --cookies-from-browser chrome 重试；或者把视频保存到本地，直接传文件路径`;
    if (/ejs|challenge solver|n challenge|signature solving/i.test(s) && process.env.ARTICLE2MEDIA_YTDLP_REMOTE_EJS !== '1') return `${what}：yt-dlp 缺少 YouTube 的 JS 校验组件（${s.split('\n').at(-1).slice(0, 140)}）。安装它：pip install -U "yt-dlp[default]"（Homebrew 版已自带，brew upgrade yt-dlp）；或设置 ARTICLE2MEDIA_YTDLP_REMOTE_EJS=1，允许 yt-dlp 运行时从 GitHub 下载该组件`;
    return `${what}：${s.slice(-500) || '未知错误'}`;
  };

  const r = ytdlp(['--dump-json', '--skip-download'], 180000);
  if (r.status !== 0) throw new Error(explain(r.stderr, `${PLATFORM[src.kind]}信息读取失败`));
  const info = JSON.parse(r.stdout.trim().split('\n').at(-1));
  const dir = ctx.dirFor(`${src.kind}-${info.id}`);
  const meta = {
    source: src.kind, id: info.id, platform: PLATFORM[src.kind], fetcher: `yt-dlp ${yt.version}`,
    title: info.title || info.id, author: info.uploader || info.channel || '',
    handle: /^@/.test(info.uploader_id || '') ? info.uploader_id : '',
    date: T.isoDay(info.upload_date || info.timestamp), url: info.webpage_url || src.url, cover: info.thumbnail || '',
    duration: Math.round(info.duration || 0), description: info.description || '',
    metrics: { views: info.view_count ?? null, likes: info.like_count ?? null, comments: info.comment_count ?? null },
  };
  return { meta, dir, getSegments: async () => {
    const track = T.pickSubtitleTrack(info);
    if (track) {
      for (const f of fs.readdirSync(dir.t)) if (f.startsWith('subtitle.')) fs.rmSync(path.join(dir.t, f));
      const s = ytdlp(['--skip-download', track.auto ? '--write-auto-subs' : '--write-subs', '--sub-format', 'vtt/srt/best', '--sub-langs', track.lang, '-o', path.join(dir.t, 'subtitle.%(ext)s')], 180000);
      const file = fs.readdirSync(dir.t).find((f) => /^subtitle\..*\.(vtt|srt)$/.test(f));
      if (s.status === 0 && file) {
        const text = fs.readFileSync(path.join(dir.t, file), 'utf8');
        const segs = file.endsWith('.srt') ? T.parseSrt(text) : T.parseVtt(text);
        if (segs.length) {
          meta.caption_source = track.auto ? '平台自动字幕' : /^ai-/.test(track.lang) ? '平台 AI 字幕' : '人工字幕';
          meta.subtitle = { lang: track.lang, file: path.join('transcript', file) };
          return segs;
        }
      }
      meta.subtitle_status = s.status === 0 ? `字幕 ${track.lang} 为空` : explain(s.stderr, `字幕 ${track.lang} 下载失败`);
      ctx.log(`⚠ ${meta.subtitle_status}，改用本地语音识别`);
    } else meta.subtitle_status = '没有人工字幕或原语言自动字幕';
    const audio = path.join(dir.t, 'audio.mp3');
    if (!fs.existsSync(audio) || ctx.force) {
      if (!ffmpegOk()) throw new Error('需要 ffmpeg 提取音频（macOS：brew install ffmpeg）');
      ctx.log(`${meta.subtitle_status}：下载音频做本地语音识别…`);
      const a = ytdlp(['-f', 'ba/bestaudio/b', '-x', '--audio-format', 'mp3', '--audio-quality', '64K', '-o', path.join(dir.t, 'audio.%(ext)s')], 3600000);
      if (a.status !== 0 || !fs.existsSync(audio)) throw new Error(explain(a.stderr, '音频下载失败'));
    }
    const lang = ctx.lang !== 'auto' ? ctx.lang : src.kind === 'youtube' ? 'auto' : 'zh';
    const asr = transcribe(audio, { lang, prompt: ctx.prompt, log: ctx.log });
    meta.caption_source = '本地语音识别';
    return asr.segments;
  }, after: () => {
    if (!ctx.keepVideo) return;
    const v = ytdlp(['-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', path.join(dir.t, 'video.%(ext)s')], 3600000);
    if (v.status !== 0) ctx.log('⚠ 视频下载失败，逐字稿已保留：' + (v.stderr || '').trim().split('\n').at(-1));
  } };
}

// ---------- local files ----------

const fileSlug = (file) => {
  const base = path.basename(file, path.extname(file));
  const ascii = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return ascii.length >= 6 ? ascii : `media-${crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 8)}`;
};

async function localMedia(src, ctx) {
  const abs = path.resolve(src.file);
  const dir = ctx.dirFor(fileSlug(abs));
  const meta = {
    source: 'file', platform: src.audioOnly ? '本地音频' : '本地视频', fetcher: 'file',
    title: path.basename(abs, path.extname(abs)), url: abs, duration: probeDuration(abs),
  };
  return { meta, dir, getSegments: async () => {
    const audio = path.join(dir.t, 'audio.mp3');
    if (!fs.existsSync(audio) || ctx.force) ffmpegAudio(abs, audio);
    const asr = transcribe(audio, { lang: ctx.lang, prompt: ctx.prompt, log: ctx.log });
    meta.caption_source = '本地语音识别';
    return asr.segments;
  } };
}

async function subtitleFile(src, ctx) {
  const abs = path.resolve(src.file);
  const text = fs.readFileSync(abs, 'utf8');
  return {
    meta: { source: 'file', platform: '字幕文件', fetcher: 'file', title: path.basename(abs, path.extname(abs)), url: abs, caption_source: '字幕文件' },
    dir: ctx.dirFor(fileSlug(abs)),
    getSegments: async () => (abs.toLowerCase().endsWith('.srt') ? T.parseSrt(text) : T.parseVtt(text)),
  };
}

// ---------- entry ----------

/**
 * Turn a detected video input into { meta, body, outDir }: body is the transcript as paragraphs (Markdown),
 * transcript artifacts are written under outDir/transcript/.
 * opts: { out, lang: 'auto'|'zh'|'en'…, terms: 'wrong=>right' file, prompt, cookies, keepVideo, force, log }
 */
export async function fetchVideo(src, opts = {}) {
  const log = opts.log || ((...a) => console.error('[fetch]', ...a));
  const ctx = {
    lang: opts.lang || 'auto', prompt: opts.prompt || '', cookies: opts.cookies || '', keepVideo: !!opts.keepVideo, force: !!opts.force, log,
    dirFor: (slug) => {
      const o = path.resolve(opts.out || path.join('article2media-out', slug));
      const t = path.join(o, 'transcript');
      fs.mkdirSync(t, { recursive: true });
      return { o, t };
    },
  };
  const terms = opts.terms ? T.parseTerms(fs.readFileSync(opts.terms, 'utf8')) : [];
  const handler = { douyin, youtube: viaYtdlp, bilibili: viaYtdlp, media: localMedia, subtitle: subtitleFile }[src.kind];
  const { meta, dir, getSegments, after } = await handler(src, ctx);
  log(`${meta.platform}：${meta.title}${meta.author ? ` · ${meta.author}` : ''}${meta.duration ? ` · ${T.fmtTime(meta.duration).replace(/\.\d+$/, '')}` : ''}`);

  // Reuse a finished transcript unless --force (ASR on a long video takes minutes).
  const segFile = path.join(dir.t, 'segments.json');
  let raw, reused = false;
  if (fs.existsSync(segFile) && !ctx.force) {
    const prev = JSON.parse(fs.readFileSync(segFile, 'utf8'));
    raw = prev.raw; meta.caption_source = prev.caption_source; reused = true;
    log(`复用已有逐字稿（${raw.length} 段）；要重新识别加 --force`);
  } else {
    raw = await getSegments();
    if (!raw.length) throw new Error('没有得到任何文字：视频可能没有人声，或字幕为空');
  }
  const segments = T.cleanSegments(raw, { terms });
  const zh = T.isChinese(segments.map((s) => s.text).join(''));
  const paragraphs = T.toParagraphs(segments, { zh });
  if (!reused) fs.writeFileSync(segFile, JSON.stringify({ caption_source: meta.caption_source, raw }, null, 1));
  fs.writeFileSync(path.join(dir.t, 'segments.md'), T.segmentsMarkdown(segments, meta.title));
  fs.writeFileSync(path.join(dir.t, 'raw.txt'), raw.map((s) => s.text).join('\n') + '\n');
  after?.();

  meta.transcript = meta.caption_source;
  meta.segments = segments.length;
  meta.terms = terms.length ? path.resolve(opts.terms) : undefined;
  meta.files = { segments: 'transcript/segments.md', raw: 'transcript/raw.txt', ...(fs.existsSync(path.join(dir.t, 'audio.mp3')) ? { audio: 'transcript/audio.mp3' } : {}), ...(fs.existsSync(path.join(dir.t, 'video.mp4')) ? { video: 'transcript/video.mp4' } : {}) };
  log(`逐字稿：${segments.length} 段 → ${paragraphs.length} 个自然段（来源：${meta.caption_source}）`);
  return { meta, body: paragraphs.join('\n\n'), outDir: dir.o };
}
