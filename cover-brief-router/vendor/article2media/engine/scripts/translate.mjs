#!/usr/bin/env node
// Checks for a full translation (article-translate): the translation must keep the article's structure block for
// block — nothing dropped, merged, reordered or summarized — while every text block is actually translated.
//
//   node translate.mjs stats <article.md>                  # blocks, length, what the translation must keep
//   node translate.mjs check <article.md> <article.zh.md>  # structure, code / images untouched, untranslated or
//                                                          # suspiciously short blocks, numbers that went missing
import fs from 'node:fs';
import path from 'node:path';
import { loadArticle } from './lib/layout-full.mjs';

const CLI = process.env.A2M_CLI || 'translate.mjs';
const [cmd, a, b] = process.argv.slice(2);
if (!cmd || !a || (cmd === 'check' && !b) || !['stats', 'check'].includes(cmd)) {
  console.error(`用法：node ${CLI} stats <原文.md>\n      node ${CLI} check <原文.md> <译文.md>`);
  process.exit(2);
}
for (const f of [a, b].filter(Boolean)) if (!fs.existsSync(f)) { console.error(`✗ 找不到 ${f}`); process.exit(2); }

const cjkOf = (s) => (s.match(/[㐀-鿿豈-﫿]/g) || []).length;
const wordsOf = (s) => (s.match(/[A-Za-z][A-Za-z’'-]*/g) || []).length;
// Reading length in "words": an English word ≈ 1.6 Chinese characters.
const units = (s) => wordsOf(s) + cjkOf(s) / 1.6;
const numbersOf = (s) => [...new Set((s.match(/\d[\d,.]*\d|\d/g) || []).map((n) => n.replace(/,/g, '').replace(/\.$/, '')))];
const TEXT = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'quote', 'li', 'th', 'td', 'caption']);
const KIND = { h1: '标题', h2: '小标题', h3: '小标题', h4: '小标题', p: '段落', quote: '引用', li: '列表项', th: '表头', td: '表格', caption: '图注', code: '代码', figure: '图片', break: '分隔线' };

const src = loadArticle(a);
if (cmd === 'stats') {
  const kinds = {};
  for (const x of src.blocks) kinds[KIND[x.kind] || x.kind] = (kinds[KIND[x.kind] || x.kind] || 0) + 1;
  const text = src.ledger.map((x) => x.text).join('\n');
  console.log(`原文：${path.basename(a)}，${src.blocks.length} 块（${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join('，')}）`);
  console.log(`长度：${wordsOf(text)} 个英文词，${cjkOf(text)} 个汉字`);
  console.log('译文必须：块数和顺序不变；标题、列表、引用、表格、图片、分隔线原样保留结构；代码块和图片链接一字不改；front matter 加 lang 和 translated_from。');
  process.exit(0);
}

const dst = loadArticle(b);
const issues = [];
const err = (where, msg) => issues.push({ level: 'error', where, msg });
const warn = (where, msg) => issues.push({ level: 'warn', where, msg });
for (const x of src.issues) err('原文解析', x.msg);
for (const x of dst.issues) err('译文解析', x.msg);

const m = dst.meta;
if (!m.translated_from) warn('front matter', '译文没写 translated_from（原文文件名）：公众号排版靠它标注「中文译文」');
if (!m.lang) warn('front matter', '译文没写 lang（例如 zh）');
for (const k of ['author', 'platform', 'url', 'date']) if (src.meta[k] && !m[k]) warn('front matter', `原文的 ${k} 没有带过来`);
const toZh = (m.lang || 'zh').startsWith('zh');

const S = src.blocks, D = dst.blocks;
if (S.length !== D.length) err('结构', `块数不一致：原文 ${S.length} 块，译文 ${D.length} 块（不能合并、拆分、删减或补写段落）`);
const label = (x, i) => `第 ${i + 1} 块（${KIND[x.kind] || x.kind}）`;
const ratios = [];
const n = Math.min(S.length, D.length);
let structural = 0;
for (let i = 0; i < n; i++) {
  const s = S[i], d = D[i];
  if (s.kind !== d.kind || (s.kind === 'li' && s.ordered !== d.ordered) || ((s.kind === 'th' || s.kind === 'td') && (s.col !== d.col || s.rowIndex !== d.rowIndex))) {
    if (structural++ < 5) err('结构', `${label(s, i)}在译文里是${KIND[d.kind] || d.kind}：原文「${s.text.slice(0, 30)}」，译文「${(d.text || '').slice(0, 30)}」`);
    continue;
  }
  if (s.kind === 'code' && s.text !== d.text) err(label(s, i), '代码块要原样保留，不翻译');
  if (s.kind === 'figure' && s.src !== d.src) err(label(s, i), `图片链接变了：${s.src} → ${d.src}`);
  if (!TEXT.has(s.kind)) continue;
  if (!d.text.trim()) { err(label(s, i), '译文是空的'); continue; }
  const su = units(s.text), du = units(d.text);
  // Untranslated: an English block that is still English (names, URLs and short labels may stay as they are).
  if (toZh && wordsOf(s.text) >= 6 && cjkOf(d.text) < 2 && d.text.trim() !== '') warn(label(s, i), `像是没翻译：「${d.text.slice(0, 40)}」`);
  for (const num of numbersOf(s.text)) if (!d.text.replace(/,/g, '').includes(num)) warn(label(s, i), `数字 ${num} 在译文里没找到（写成了汉字可以忽略）`);
  if (su >= 8) ratios.push({ i, r: du / su, s, d });
}
if (structural > 5) err('结构', `还有 ${structural - 5} 处块类型不一致`);
if (ratios.length >= 4) {
  const sorted = ratios.map((x) => x.r).sort((x, y) => x - y);
  const med = sorted[Math.floor(sorted.length / 2)];
  for (const x of ratios) {
    if (x.r < med * 0.45) warn(label(x.s, x.i), `比其他段短很多，可能漏译或缩写了：原文「${x.s.text.slice(0, 36)}…」`);
    else if (x.r > med * 2.4) warn(label(x.s, x.i), `比其他段长很多，可能加了原文没有的内容：译文「${x.d.text.slice(0, 36)}…」`);
  }
}

const textS = src.ledger.map((x) => x.text).join('\n'), textD = dst.ledger.map((x) => x.text).join('\n');
console.log(`原文 ${path.basename(a)}：${S.length} 块，${wordsOf(textS)} 词 / ${cjkOf(textS)} 字`);
console.log(`译文 ${path.basename(b)}：${D.length} 块，${wordsOf(textD)} 词 / ${cjkOf(textD)} 字`);
const nErr = issues.filter((x) => x.level === 'error').length, nWarn = issues.length - nErr;
if (!nErr) console.log(`✓ 结构一致：${n} / ${S.length} 块一一对应，代码与图片原样保留`);
for (const x of issues) console.log(`  ${x.level === 'error' ? '✗' : '⚠'} ${x.where}：${x.msg}`);
console.log(`\n翻译检查：${nErr} 个错误，${nWarn} 个提示。${nErr ? '错误必须修复。' : nWarn ? '提示逐条看一眼，确认没漏译。' : ''}`);
process.exit(nErr ? 1 : 0);
