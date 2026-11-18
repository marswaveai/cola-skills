#!/usr/bin/env node
// Fetch an article (X/Twitter post or long-form article, web page, WeChat article, or local file) — or a video
// (Douyin, YouTube, Bilibili, a local video/audio file, an .srt/.vtt file) turned into a verbatim transcript —
// and save it as Markdown with YAML front matter.
//
//   node fetch.mjs <url|file|分享口令> [--out DIR] [--no-proxy] [--kind article|video]
//   --kind article: articles only (article-fetch skill); --kind video: videos only (video-transcript skill).
//   video options: [--lang auto|zh|en] [--terms terms.txt] [--prompt "人名 术语"] [--cookies-from-browser chrome] [--keep-video] [--force]
//   any source:    [--title "标题"] [--author "作者"]
//
// Output: DIR/article.md and DIR/meta.json (videos also DIR/transcript/); prints a JSON summary to stdout.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { launchBrowser } from './lib/chrome.mjs';
import { detectVideoInput } from './lib/media/transcript.mjs';
import { fetchVideo } from './lib/media/source.mjs';
import { postToMarkdown } from './lib/x-post.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    'no-proxy': { type: 'boolean', default: false },
    lang: { type: 'string', default: 'auto' },
    terms: { type: 'string' },
    prompt: { type: 'string' },
    'cookies-from-browser': { type: 'string' },
    'keep-video': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    title: { type: 'string' },
    author: { type: 'string' },
    kind: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const CLI = process.env.A2M_CLI || 'fetch.mjs';
if (opt.help || !positionals[0]) {
  console.error([
    `用法：node ${CLI} <url|文件|分享口令> [--out 目录] [--no-proxy]`,
    '',
    '文章：X 长文 / 帖子 / 线程、网页、微信公众号、本地 Markdown / 文本',
    '视频（转成逐字稿文章）：抖音、YouTube、B 站链接，本地视频 / 音频，.srt / .vtt 字幕',
    '  --lang auto|zh|en              语音识别语言（抖音、B 站默认 zh）',
    '  --terms 词表.txt               识别后替换：每行 错词=>正词',
    '  --prompt "人名 术语"           提示 Whisper 的专有名词',
    '  --cookies-from-browser chrome  复用本机浏览器登录态（只在用户同意时用）',
    '  --keep-video                   保留下载的 MP4（截图用）',
    '  --force                        重新下载、重新识别',
    '  --title "标题" --author "作者"  覆盖标题和作者（本地视频只能从文件名取标题时用）',
  ].join('\n'));
  process.exit(opt.help ? 0 : 2);
}

const input = positionals[0];
const log = (...a) => console.error('[fetch]', ...a);

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': 'article2media/0.1', ...headers }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function getText(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

const isoDate = (d) => {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 10);
};

// ---------- X / Twitter (via FxTwitter public API) ----------

function draftInline(block, entities) {
  const text = block.text || '';
  const n = text.length;
  const bold = new Array(n).fill(false);
  const ital = new Array(n).fill(false);
  const link = new Array(n).fill(null);
  for (const r of block.inlineStyleRanges || []) {
    for (let i = r.offset; i < Math.min(n, r.offset + r.length); i++) {
      if (/bold/i.test(r.style)) bold[i] = true;
      if (/italic/i.test(r.style)) ital[i] = true;
    }
  }
  for (const r of block.entityRanges || []) {
    const ent = entities.get(String(r.key));
    if (ent?.type === 'LINK' && ent.data?.url) for (let i = r.offset; i < Math.min(n, r.offset + r.length); i++) link[i] = ent.data.url;
  }
  let out = '';
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && bold[j] === bold[i] && ital[j] === ital[i] && link[j] === link[i]) j++;
    let run = text.slice(i, j);
    const lead = run.match(/^\s*/)[0];
    const trail = run.slice(lead.length).match(/\s*$/)[0];
    let core = run.slice(lead.length, run.length - trail.length);
    if (core) {
      if (ital[i]) core = `*${core}*`;
      if (bold[i]) core = `**${core}**`;
      if (link[i]) core = `[${core}](${link[i]})`;
    }
    out += lead + core + trail;
    i = j;
  }
  return out;
}

function draftToMarkdown(article) {
  const blocks = article.content?.blocks || [];
  const rawMap = article.content?.entityMap || [];
  const entities = new Map(
    Array.isArray(rawMap) ? rawMap.map((e) => [String(e.key), e.value]) : Object.entries(rawMap).map(([k, v]) => [String(k), v]),
  );
  const media = new Map((article.media_entities || []).map((m) => [String(m.media_id), m.media_info?.original_img_url]));
  const images = [];
  const out = [];
  const unknown = new Set();
  let ol = 0;
  for (const b of blocks) {
    if (b.type !== 'ordered-list-item') ol = 0;
    const t = draftInline(b, entities);
    switch (b.type) {
      case 'header-one': out.push(`# ${t}`); break;
      case 'header-two': out.push(`## ${t}`); break;
      case 'header-three': out.push(`### ${t}`); break;
      case 'unordered-list-item': out.push(`- ${t.replace(/\n+/g, '\n  ')}`); break;
      case 'ordered-list-item': out.push(`${++ol}. ${t.replace(/\n+/g, '\n   ')}`); break;
      case 'blockquote': out.push(t.split('\n').map((l) => `> ${l}`).join('\n')); break;
      case 'code-block': out.push('```\n' + b.text + '\n```'); break;
      case 'atomic': {
        for (const r of b.entityRanges || []) {
          const ent = entities.get(String(r.key));
          if (!ent) continue;
          if (ent.type === 'MEDIA') {
            for (const it of ent.data?.mediaItems || []) {
              const url = media.get(String(it.mediaId));
              if (url) { images.push(url); out.push(`![图](${url})`); }
            }
          } else if (ent.type === 'DIVIDER') out.push('---');
          // Tables and code/prompt blocks arrive as raw Markdown.
          else if (typeof ent.data?.markdown === 'string') out.push(ent.data.markdown.trim());
          else if (ent.data?.url) out.push(`<${ent.data.url}>`);
          else {
            unknown.add(ent.type);
            out.push(`<!-- 未识别的内容块：${ent.type} -->`);
          }
        }
        break;
      }
      default: if (t.trim()) out.push(t);
    }
  }
  if (unknown.size) log(`警告：有未识别的内容块类型 ${[...unknown].join(', ')}，已在正文中标注，可能缺内容`);
  return { markdown: out.join('\n\n'), images };
}

async function fetchX(url) {
  // x.com/<user>/status/<id> and x.com/<user>/article/<id> both carry the post (status) id.
  // x.com/i/article/<id> carries the article's internal id, which FxTwitter cannot resolve.
  const id = url.pathname.match(/(?:status(?:es)?|article)\/(\d+)/)?.[1];
  if (!id) throw new Error('无法从链接中识别推文 ID');
  let data;
  try {
    data = await getJSON(`https://api.fxtwitter.com/2/status/${id}`);
  } catch (e) {
    log('FxTwitter v2 失败，改用 v1：', e.message);
    try {
      data = await getJSON(`https://api.fxtwitter.com/status/${id}`);
    } catch (e2) {
      if (/\/i\/article\//.test(url.pathname)) {
        throw new Error('这是文章的内部链接（/i/article/…），无法直接解析。请改用作者主页里那条发布文章的推文链接（x.com/<用户>/status/<id>）。');
      }
      throw e2;
    }
  }
  const st = data.status || data.tweet;
  if (!st) throw new Error(`FxTwitter 未返回内容：${JSON.stringify(data).slice(0, 200)}`);
  const author = st.author || data.author || {};
  const meta = {
    source: 'x',
    fetcher: 'fxtwitter',
    url: st.url || url.href,
    id,
    author: author.name || '',
    handle: author.screen_name ? `@${author.screen_name}` : '',
    date: isoDate(st.created_at),
  };
  if (st.article) {
    const a = st.article;
    const { markdown, images } = draftToMarkdown(a);
    const cover = a.cover_media?.media_info?.original_img_url;
    return { meta: { ...meta, platform: 'X 文章', title: a.title || '', cover, images }, body: markdown };
  }
  // Plain post / long post / thread
  return postToMarkdown(st, data, meta);
}

// ---------- Generic web pages ----------

async function viaJina(href) {
  const txt = await getText(`https://r.jina.ai/${href}`, { Accept: 'text/plain', 'X-Return-Format': 'markdown' });
  const head = txt.split('Markdown Content:')[0];
  const body = txt.includes('Markdown Content:') ? txt.split('Markdown Content:').slice(1).join('Markdown Content:').trim() : txt.trim();
  const pick = (k) => head.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim() || '';
  return { meta: { title: pick('Title'), date: isoDate(pick('Published Time')), fetcher: 'r.jina.ai' }, body };
}

async function viaDefuddle(href) {
  const txt = await getText(`https://defuddle.md/${href.replace(/^https?:\/\//, '')}`);
  const fm = txt.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = { fetcher: 'defuddle.md' };
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
      if (m && ['title', 'author', 'published'].includes(m[1])) meta[m[1] === 'published' ? 'date' : m[1]] = m[1] === 'published' ? isoDate(m[2]) : m[2];
    }
  }
  return { meta, body: (fm ? txt.slice(fm[0].length) : txt).trim() };
}

// Runs inside the page: find the main content node and convert it to Markdown.
function extractInPage() {
  const $ = (s) => document.querySelector(s);
  const metaC = (sel) => document.querySelector(sel)?.getAttribute('content') || '';
  const pickRoot = () => {
    for (const s of ['#js_content', '.rich_media_content', 'article', 'main article', '[itemprop="articleBody"]', '.post-content', '.entry-content', '.article-content', '.markdown-body', 'main', '#content']) {
      const el = $(s);
      if (el && el.innerText.trim().length > 300) return el;
    }
    let best = document.body, bestLen = 0;
    for (const el of document.querySelectorAll('div, section')) {
      const len = [...el.querySelectorAll(':scope > p')].reduce((n, p) => n + p.innerText.length, 0);
      if (len > bestLen) { best = el; bestLen = len; }
    }
    return best;
  };
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'IFRAME', 'SVG']);
  const inline = (node) => {
    let s = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { s += c.data.replace(/\s+/g, ' '); continue; }
      if (c.nodeType !== 1 || skip.has(c.tagName)) continue;
      const t = c.tagName;
      if (t === 'BR') s += '\n';
      else if (t === 'STRONG' || t === 'B') { const x = inline(c).trim(); if (x) s += `**${x}**`; }
      else if (t === 'EM' || t === 'I') { const x = inline(c).trim(); if (x) s += `*${x}*`; }
      else if (t === 'A') { const x = inline(c).trim(); const h = c.href; s += x && h && !h.startsWith('javascript') ? `[${x}](${h})` : x; }
      else if (t === 'IMG') { const src = c.getAttribute('data-src') || c.currentSrc || c.src; if (src && !src.startsWith('data:')) s += `![图](${src})`; }
      else if (t === 'CODE') s += '`' + c.innerText + '`';
      else s += inline(c);
    }
    return s;
  };
  const out = [];
  const walk = (node) => {
    for (const c of node.children) {
      if (skip.has(c.tagName)) continue;
      const style = getComputedStyle(c);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const t = c.tagName;
      if (/^H[1-6]$/.test(t)) { const x = inline(c).trim(); if (x) out.push('#'.repeat(Math.min(3, Number(t[1]) + 1)) + ' ' + x); }
      else if (t === 'P') { const x = inline(c).trim(); if (x) out.push(x); }
      else if (t === 'UL' || t === 'OL') {
        [...c.children].filter((li) => li.tagName === 'LI').forEach((li, i) => {
          const x = inline(li).trim();
          if (x) out.push(`${t === 'OL' ? `${i + 1}.` : '-'} ${x}`);
        });
      } else if (t === 'BLOCKQUOTE') { const x = c.innerText.trim(); if (x) out.push(x.split('\n').map((l) => `> ${l}`).join('\n')); }
      else if (t === 'PRE') out.push('```\n' + c.innerText + '\n```');
      else if (t === 'IMG') { const src = c.getAttribute('data-src') || c.currentSrc || c.src; if (src && !src.startsWith('data:')) out.push(`![图](${src})`); }
      else {
        // Any other container (div, section, table, td, font, center…): recurse if it holds blocks,
        // otherwise treat it as one paragraph; <br><br> inside it separates paragraphs.
        const hasBlocks = c.querySelector('p, h1, h2, h3, h4, ul, ol, blockquote, pre, img, section, div, table, tr, td');
        if (hasBlocks) walk(c);
        else inline(c).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean).forEach((x) => out.push(x));
      }
    }
  };
  const root = pickRoot();
  walk(root);
  // Last resort for unusual markup: if structured extraction captured too little, use plain paragraphs.
  const got = out.join('').replace(/\s/g, '').length;
  const all = root.innerText.replace(/\s/g, '').length;
  if (got < all * 0.5) {
    out.length = 0;
    root.innerText.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean).forEach((x) => out.push(x));
  }
  const title = ($('#activity-name')?.innerText || metaC('meta[property="og:title"]') || $('h1')?.innerText || document.title || '').trim();
  const author = ($('#js_name')?.innerText || metaC('meta[name="author"]') || metaC('meta[property="article:author"]') || '').trim();
  const date = metaC('meta[property="article:published_time"]') || $('#publish_time')?.innerText || $('time')?.getAttribute('datetime') || '';
  return { title, author, date, body: out.join('\n\n') };
}

async function viaBrowser(href) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport(1280, 900, 1);
    await page.goto(href, { timeout: 60000 });
    await page.settle(8000);
    // Trigger lazy content (WeChat lazy-loads images)
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 800) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
      window.scrollTo(0, 0);
    });
    const r = await page.evaluate(extractInPage);
    return { meta: { title: r.title, author: r.author, date: isoDate(r.date) || '', fetcher: 'browser' }, body: r.body };
  } finally {
    await browser.close();
  }
}

const enough = (r) => r && r.body && r.body.replace(/\s/g, '').length > 300;

async function fetchWeb(url) {
  const href = url.href;
  const platform = /mp\.weixin\.qq\.com$/.test(url.hostname) ? '微信公众号' : url.hostname.replace(/^www\./, '');
  const chain = [];
  // WeChat pages are usually blocked for proxies; go straight to the browser.
  if (!opt['no-proxy'] && platform !== '微信公众号') chain.push(['r.jina.ai', viaJina], ['defuddle.md', viaDefuddle]);
  chain.push(['browser', viaBrowser]);
  const errors = [];
  for (const [name, fn] of chain) {
    try {
      log(`尝试 ${name} …`);
      const r = await fn(href);
      if (enough(r)) return { meta: { source: 'web', platform, url: href, ...r.meta }, body: r.body };
      errors.push(`${name}: 正文过短`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(`所有抓取方式都失败了：\n  ${errors.join('\n  ')}`);
}

// ---------- Local files ----------

async function fetchLocal(file) {
  const ext = path.extname(file).toLowerCase();
  const abs = path.resolve(file);
  if (ext === '.html' || ext === '.htm') {
    const r = await viaBrowser('file://' + abs);
    return { meta: { ...r.meta, source: 'file', platform: '本地文件', url: abs }, body: r.body };
  }
  const body = fs.readFileSync(abs, 'utf8');
  const title = body.match(/^#\s+(.+)$/m)?.[1] || path.basename(file, ext);
  return { meta: { source: 'file', platform: '本地文件', url: abs, title, fetcher: 'file' }, body };
}

// ---------- main ----------

function slugify(meta) {
  if (meta.source === 'x') return `x-${meta.id}`;
  const ascii = (meta.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  if (ascii.length >= 8) return ascii;
  const h = [...(meta.url || meta.title || String(Date.now()))].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return `article-${h.toString(36)}`;
}

const yamlStr = (v) => JSON.stringify(String(v ?? ''));

try {
  let result, outDir;
  const video = detectVideoInput(input, { isFile: fs.existsSync(input) });
  if (opt.kind === 'article' && video) {
    console.error(`[fetch] 这是视频（${video.kind === 'subtitle' ? '字幕文件' : video.kind === 'media' ? '本地音视频' : video.kind}），文章抓取不处理视频：请用 video-transcript（视频转文字）把它转成逐字稿文章`);
    process.exit(2);
  }
  if (opt.kind === 'video' && !video) {
    console.error('[fetch] 这不是视频链接或音视频 / 字幕文件。支持：抖音、YouTube、B 站链接（含分享口令），本地视频 / 音频，.srt / .vtt；文章请用 article-fetch（文章抓取）');
    process.exit(2);
  }
  if (video) {
    if (opt.terms && !fs.existsSync(opt.terms)) throw new Error(`词表文件不存在：${opt.terms}`);
    const r = await fetchVideo(video, { out: opt.out, lang: opt.lang, terms: opt.terms, prompt: opt.prompt, cookies: opt['cookies-from-browser'], keepVideo: opt['keep-video'], force: opt.force, log });
    result = { meta: r.meta, body: r.body };
    outDir = r.outDir;
  } else if (fs.existsSync(input)) result = await fetchLocal(input);
  else {
    let url;
    try { url = new URL(input); } catch { throw new Error(`既不是存在的文件，也不是合法 URL：${input}`); }
    const host = url.hostname.replace(/^(www|mobile)\./, '');
    if (/^(x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com$/.test(host)) result = await fetchX(url);
    else result = await fetchWeb(url);
  }
  const { meta, body } = result;
  if (opt.title) meta.title = opt.title;
  if (opt.author) meta.author = opt.author;
  meta.fetched_at = new Date().toISOString();
  meta.chars = body.replace(/\s/g, '').length;
  meta.words = (body.match(/[A-Za-z0-9’'-]+/g) || []).length;
  meta.cjk = (body.match(/[一-鿿]/g) || []).length;
  // Short text + attached media: the substance is probably in the pictures or videos, which fetching does not read.
  const textChars = body.replace(/!?\[[^\]]*\]\([^)]*\)/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s/g, '').length;
  const nImg = (body.match(/!\[[^\]]*\]\(/g) || []).length - (meta.videos?.length || 0);
  let mediaHint = '';
  if (textChars < 300 && (meta.videos?.length || nImg > 0)) {
    mediaHint = `正文只有 ${textChars} 字，主要内容可能在${meta.videos?.length ? ` ${meta.videos.length} 段视频` : ''}${meta.videos?.length && nImg > 0 ? '和' : ''}${nImg > 0 ? ` ${nImg} 张图` : ''}里：先看图 / 视频画面把文字整理进 article.md，有配音的视频用 video-transcript 转逐字稿`;
    console.error(`⚠ ${mediaHint}`);
  }

  outDir ||= path.resolve(opt.out || path.join('article2media-out', slugify(meta)));
  fs.mkdirSync(outDir, { recursive: true });
  const fmKeys = ['title', 'author', 'handle', 'platform', 'date', 'url', 'cover', 'duration', 'transcript', 'fetcher'];
  const fmVal = (k) => (k === 'duration' ? `${Math.floor(meta.duration / 60)}:${String(meta.duration % 60).padStart(2, '0')}` : meta[k]);
  const fm = fmKeys.filter((k) => meta[k]).map((k) => `${k}: ${yamlStr(fmVal(k))}`).join('\n');
  const md = `---\n${fm}\n---\n\n${meta.title ? `# ${meta.title}\n\n` : ''}${body.trim()}\n`;
  fs.writeFileSync(path.join(outDir, 'article.md'), md);
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(JSON.stringify({
    ok: true,
    out: outDir,
    article: path.join(outDir, 'article.md'),
    title: meta.title,
    author: meta.author,
    platform: meta.platform,
    date: meta.date,
    fetcher: meta.fetcher,
    ...(meta.transcript ? { transcript: meta.transcript, segments: meta.segments, timeline: path.join(outDir, 'transcript', 'segments.md') } : {}),
    words: meta.words,
    cjk_chars: meta.cjk,
    ...(mediaHint ? { media_hint: mediaHint } : {}),
  }, null, 2));
} catch (e) {
  console.error('[fetch] 失败：' + e.message);
  process.exit(1);
}
