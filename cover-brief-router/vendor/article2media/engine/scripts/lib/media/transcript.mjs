// Video → transcript article: pure helpers (no I/O), so they can be tested offline.
//
//   detectVideoInput(input)   → { kind: 'douyin'|'youtube'|'bilibili'|'media'|'subtitle', … } | null
//   parseVtt / parseSrt       → segments [{ start, end, text }] (rolling auto-caption lines removed)
//   cleanSegments             → Traditional → Simplified (Chinese), whitespace, term replacements, hallucination loops
//   toParagraphs              → readable paragraphs for article.md
//   segmentsMarkdown          → "- [00:12.30 - 00:15.80] text" for timestamp checks
import { t2s } from './zh-t2s.mjs';

export const MEDIA_EXT = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.flv', '.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.opus'];
export const AUDIO_EXT = ['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.opus'];
export const SUBTITLE_EXT = ['.srt', '.vtt'];

const URL_RE = /https?:\/\/[^\s"'<>，。！？、）)】]+/;

/** First http(s) URL inside a pasted share text ("7.94 复制打开抖音，看看【…】 https://v.douyin.com/abc/ …"). */
export function firstUrl(text) {
  return String(text ?? '').match(URL_RE)?.[0] || null;
}

/** Which video source an input is, or null when it is an ordinary article URL / text file. */
export function detectVideoInput(input, { isFile = false } = {}) {
  const raw = String(input ?? '').trim();
  if (isFile) {
    const ext = raw.slice(raw.lastIndexOf('.')).toLowerCase();
    if (MEDIA_EXT.includes(ext)) return { kind: 'media', file: raw, audioOnly: AUDIO_EXT.includes(ext) };
    if (SUBTITLE_EXT.includes(ext)) return { kind: 'subtitle', file: raw };
    return null;
  }
  if (/^BV[0-9A-Za-z]{10}$/.test(raw)) return { kind: 'bilibili', url: `https://www.bilibili.com/video/${raw}` };
  if (/^\d{15,20}$/.test(raw)) return { kind: 'douyin', url: `https://www.douyin.com/video/${raw}`, id: raw };
  const url = /^https?:\/\//.test(raw) ? raw : firstUrl(raw);
  if (!url) return null;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return { kind: 'youtube', url };
  if (/(^|\.)(bilibili\.com|b23\.tv)$/.test(host)) return { kind: 'bilibili', url };
  if (/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(host)) return { kind: 'douyin', url, id: douyinId(url) };
  return null;
}

/** Douyin video id from a URL (null for short links like v.douyin.com/xxx — resolve the redirect first). */
export function douyinId(value) {
  const v = String(value ?? '').trim();
  if (/^\d{15,20}$/.test(v)) return v;
  try {
    const u = new URL(v);
    for (const k of ['modal_id', 'video_id', 'item_id', 'aweme_id']) if (/^\d{10,}$/.test(u.searchParams.get(k) || '')) return u.searchParams.get(k);
    const m = u.pathname.match(/\/(?:share\/)?(?:video|note|slides)\/(\d{10,})/);
    if (m) return m[1];
  } catch {}
  return null;
}

/** The first video item in a Douyin mobile share page (window._ROUTER_DATA). Throws with a clear reason. */
export function douyinItem(html) {
  const m = String(html).match(/window\._ROUTER_DATA\s*=\s*(\{.*?\})<\/script>/s);
  if (!m) throw new Error('抖音分享页里没有找到 _ROUTER_DATA（页面结构可能变了，或请求被拦截）');
  const data = JSON.parse(m[1]);
  for (const [key, page] of Object.entries(data.loaderData || {})) {
    if (!page || typeof page !== 'object' || !(page.videoInfoRes || key.endsWith('/page'))) continue;
    const item = page.videoInfoRes?.item_list?.[0];
    if (item) return item;
  }
  throw new Error('抖音分享页里没有视频信息（页面没带数据，或作品是图文、已删除、仅自己可见）');
}

/** Prefer the no-watermark /play/ address over /playwm/, keep the original as a fallback. */
export function playUrlCandidates(url) {
  return [...new Set([url.includes('/playwm/') ? url.replace('/playwm/', '/play/') : null, url].filter(Boolean))];
}

// ---------- subtitles ----------

const stamp = (v) => {
  const p = String(v).trim().replace(',', '.').split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
};
const decode = (s) => s
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

/**
 * Cue blocks → segments. YouTube auto-captions repeat the previous line at the top of every cue and add
 * 10 ms "transition" cues; keep only lines that are new relative to the last line emitted.
 */
function cuesToSegments(cues) {
  const out = [];
  let lastLine = '';
  for (const c of cues) {
    if (c.end - c.start < 0.05) continue;
    const lines = c.lines.map(decode).filter(Boolean);
    const fresh = [];
    for (const line of lines) {
      if (line === lastLine || fresh.includes(line)) continue;
      // A rolling cue can also carry the previous line as a prefix of the new one.
      fresh.push(lastLine && line.startsWith(lastLine + ' ') ? line.slice(lastLine.length + 1) : line);
      lastLine = line;
    }
    const text = fresh.join(' ').trim();
    if (text) out.push({ start: +c.start.toFixed(2), end: +c.end.toFixed(2), text });
  }
  return out;
}

export function parseVtt(text) {
  const cues = [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([\d:.]+)\s+-->\s+([\d:.]+)/);
    if (!m) continue;
    const cue = { start: stamp(m[1]), end: stamp(m[2]), lines: [] };
    while (++i < lines.length && lines[i].trim()) cue.lines.push(lines[i]);
    cues.push(cue);
  }
  return cuesToSegments(cues);
}

export function parseSrt(text) {
  const cues = [];
  for (const block of String(text).replace(/\r/g, '').split(/\n\s*\n/)) {
    const ls = block.split('\n').filter((l) => l.trim());
    const t = ls.findIndex((l) => /-->/.test(l));
    if (t < 0) continue;
    const m = ls[t].match(/([\d:,.]+)\s+-->\s+([\d:,.]+)/);
    if (m) cues.push({ start: stamp(m[1]), end: stamp(m[2]), lines: ls.slice(t + 1) });
  }
  return cuesToSegments(cues);
}

/**
 * Pick a subtitle track from yt-dlp metadata. Manual subtitles first; among automatic captions only the
 * original-language track (machine-translated tracks are not a transcript). Bilibili danmaku is never a subtitle.
 */
export function pickSubtitleTrack(info, prefer = ['zh-Hans', 'zh-CN', 'zh', 'ai-zh', 'zh-Hant', 'zh-TW', 'zh-HK', 'en', 'en-US', 'en-GB']) {
  const usable = (o) => Object.keys(o || {}).filter((k) => k !== 'danmaku' && !/live_chat/.test(k));
  const rank = (keys) => {
    for (const p of prefer) { const hit = keys.find((k) => k === p) || keys.find((k) => k.toLowerCase().startsWith(p.toLowerCase() + '-')); if (hit) return hit; }
    return keys[0] || null;
  };
  const manual = usable(info.subtitles);
  if (manual.length) return { lang: rank(manual), auto: false };
  const auto = usable(info.automatic_captions);
  const orig = auto.find((k) => k.endsWith('-orig')) || (info.language && auto.find((k) => k === info.language));
  return orig ? { lang: orig, auto: true } : null;
}

// ---------- cleaning ----------

/** "wrong=>right" lines; other lines (plain reference terms, # comments) are ignored. */
export function parseTerms(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('=>'))
    .map((l) => l.split('=>').map((s) => s.trim())).filter(([a, b]) => a && b);
}

// Lines Whisper is known to invent over silence or music; dropped only when a segment is exactly one of these.
const HALLUCINATIONS = [/^(请不吝)?点赞\s*订阅\s*转发\s*打赏/, /字幕(由|by)\s*\S+\s*(社区)?提供/i, /^谢谢(大家)?(观看|收看)[。！!]?$/, /Amara\.org/i, /^优优独播剧场/, /^\(?(音乐|music|掌声|applause)\)?$/i];

export const isChinese = (text) => (String(text).match(/[㐀-鿿]/g) || []).length > String(text).replace(/\s/g, '').length * 0.3;

/** Simplify Chinese, normalise spaces, apply term fixes, collapse hallucination loops (≥ 3 identical segments in a row). */
export function cleanSegments(segments, { terms = [], zh } = {}) {
  const all = segments.map((s) => s.text).join('');
  const chinese = zh ?? isChinese(all);
  const fix = (t) => {
    let s = String(t).replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
    if (chinese) {
      s = t2s(s);
      // Whisper often writes ASCII punctuation inside Chinese ("大家好,我是…"); use the full-width forms.
      const W = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' };
      s = s.replace(/([㐀-鿿」』”）》])\s*([,?!:;])\s*/g, (_, c, p) => c + W[p]).replace(/\s*([,?!:;])\s*(?=[㐀-鿿「『“（《])/g, (_, p) => W[p]);
    }
    for (const [a, b] of terms) s = s.split(a).join(b);
    return s;
  };
  const out = [];
  for (const seg of segments) {
    const text = fix(seg.text);
    if (!text || HALLUCINATIONS.some((re) => re.test(text))) continue;
    const prev = out.at(-1), prev2 = out.at(-2);
    if (prev && prev2 && prev.text === text && prev2.text === text) { prev.end = seg.end; continue; }
    out.push({ start: seg.start, end: seg.end, text });
  }
  return out;
}

// ---------- article ----------

const END_PUNCT = /[。！？!?…；;：:,，、.」』”"》）)]$/;
const CJK = '\\u3400-\\u9fff';

/**
 * Segments → paragraphs. A paragraph ends at a sentence-final pause (≥ 1.2 s, or ≥ 2 s without punctuation) once it
 * has some length, or when it grows long.
 * Chinese ASR marks pauses with spaces and no punctuation; those become commas and each paragraph ends with 。
 * Only punctuation is added — the words stay exactly as spoken.
 */
export function toParagraphs(segments, { zh } = {}) {
  const chinese = zh ?? isChinese(segments.map((s) => s.text).join(''));
  const paras = [];
  let cur = [], len = 0;
  const flush = () => {
    if (!cur.length) return;
    if (chinese) {
      let p = '';
      for (const raw of cur) {
        const t = raw.replace(new RegExp(`([${CJK}》」”）])\\s+(?=[${CJK}《「“（])`, 'g'), '$1，');
        p += p && !END_PUNCT.test(p) ? `，${t}` : t;
      }
      paras.push(END_PUNCT.test(p) ? p.replace(/[，,、]$/, '。') : p + '。');
    } else paras.push(cur.join(' '));
    cur = []; len = 0;
  };
  segments.forEach((s, i) => {
    cur.push(s.text);
    len += s.text.length;
    const next = segments[i + 1];
    const gap = next ? next.start - s.end : 0;
    const sentenceEnd = /[。！？!?.…]$/.test(s.text);
    // A short pause breaks a paragraph only at a sentence end; without punctuation it takes a longer pause.
    if (!next || (len >= 60 && ((gap >= 1.2 && sentenceEnd) || gap >= 2)) || (len >= 220 && sentenceEnd) || len >= 320) flush();
  });
  flush();
  return paras;
}

export const fmtTime = (sec) => {
  const v = Math.max(0, Number(sec) || 0);
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), s = (v % 60).toFixed(2).padStart(5, '0');
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${s}`;
};

export const segmentsMarkdown = (segments, title = '') =>
  `# 逐字稿时间轴${title ? `：${title}` : ''}\n\n${segments.map((s) => `- [${fmtTime(s.start)} - ${fmtTime(s.end)}] ${s.text}`).join('\n')}\n`;

/** YYYYMMDD or unix seconds → YYYY-MM-DD. */
export function isoDay(v) {
  if (!v) return '';
  const s = String(v);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{9,11}$/.test(s)) return new Date(Number(s) * 1000).toISOString().slice(0, 10);
  return s.slice(0, 10);
}

/** First line of a Douyin description without hashtags, as a title. */
export function titleFromDesc(desc, fallback) {
  const t = String(desc || '').split('\n')[0].replace(/#\S+/g, '').replace(/\s+/g, ' ').trim();
  return t || fallback;
}
