// Pipeline for original-text cards: lock the source, build the ledger, flow into cards, verify verbatim, capture.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './chrome.mjs';
import { loadArticle, articlePath, readbackInPage, compareLedger, localizeImages, sha256, bylineOf, contrastInPage } from './layout-full.mjs';
import { buildCardsArticle, flowInPage } from './layout-cards-article.mjs';
import { loadBrand } from './brand.mjs';

function captionMd({ meta, blocks, count, spec }) {
  const title = (meta.title || blocks.find((b) => b.isTitle)?.text || '').replace(/\s+/g, ' ').trim();
  let excerpt = '';
  for (const b of blocks.filter((x) => x.kind === 'p')) {
    if (excerpt.length > 160) break;
    excerpt += (excerpt ? '\n\n' : '') + b.text.trim();
  }
  if (excerpt.length > 260) excerpt = excerpt.slice(0, 257) + '……';
  const byline = bylineOf(meta);
  return `# 发帖文案（原文卡片 · ${spec.name}）

## 标题（${title.length} 字${title.length > 20 ? '，小红书最多 20 字，发帖前缩短' : ''}）

${title}

## 正文

${excerpt}

全文 ${count} 张${byline ? `，原文：${byline}` : ''}。${meta.url ? `\n${meta.url}` : ''}

## 标签

（按内容补 3–6 个话题标签）
`;
}

export async function renderCardsArticle(input, { opt, THEMES_DIR, readCss, spec }) {
  const src = articlePath(input);
  if (!fs.existsSync(src)) { console.error(`[cards] 原文卡片需要文章：找不到 ${src}`); return 2; }
  const art = loadArticle(src);
  const { meta, blocks, ledger } = art;
  const issues = [...art.issues];
  const dir = path.dirname(src);
  const theme = opt.theme || '';
  if (theme && (theme.includes(',') || theme === 'all')) { console.error('[cards] 原文卡片一次只用一个主题'); return 2; }
  if (theme && !fs.existsSync(path.join(THEMES_DIR, `${theme}.css`))) { console.error(`[cards] 没有主题 "${theme}"`); return 2; }
  console.log(`原文卡片：${path.basename(src)}，${ledger.length} 个原文块，${spec.name}${theme ? `，主题 ${theme}` : '，白底阅读面'}`);
  if (opt.check) {
    for (const x of issues) console.log(`  ✗ ${x.where}：${x.msg}`);
    return issues.length ? 1 : 0;
  }
  const outDir = path.resolve(opt.out || path.join(dir, `${theme ? `${theme}-` : ''}full-${spec.slug}`));
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (/^card-\d+\.(png|jpg)$/.test(f)) fs.rmSync(path.join(outDir, f));
  const images = await localizeImages(blocks, path.join(dir, 'source-images'), dir);
  const html = buildCardsArticle({
    blocks, meta, spec, images, brand: loadBrand({ file: opt.brand, dir }), useTheme: !!theme,
    themeCss: theme ? fs.readFileSync(path.join(THEMES_DIR, `${theme}.css`), 'utf8') : '',
    fullCss: readCss('full.css'), cardsCss: readCss('cards-article.css'),
  });
  const htmlPath = path.join(outDir, 'cards.html');
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(path.join(outDir, 'ledger.json'), JSON.stringify({ version: 1, source: src, source_sha256: art.sha, blocks: ledger }, null, 1));

  const browser = await launchBrowser();
  let flow, files = [];
  try {
    const page = await browser.newPage();
    const deckW = 3 * spec.w + 4 * 24;
    await page.setViewport(deckW, 1200, 2);
    await page.goto(pathToFileURL(htmlPath).href);
    const fontStatus = await page.settle(30000);
    if (fontStatus === 'timeout') issues.push({ level: 'warn', where: '字体', msg: '网络字体加载超时，部分文字用了回退字体' });
    flow = await page.evaluate(flowInPage);
    await page.settle(10000);
    fs.writeFileSync(path.join(outDir, 'cards.html'), await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML));

    const rb = await page.evaluate(readbackInPage, { root: '.ac-body', merge: true });
    for (const f of compareLedger(ledger, rb)) issues.push({ level: 'error', where: '全文校验', msg: f });
    const contrast = await page.evaluate(contrastInPage, { text: '.ac-body p', bg: '.ac-card' });
    if (contrast !== null && contrast < 4.5) issues.push({ level: 'error', where: '对比度', msg: `正文和底色对比度只有 ${contrast}:1（至少 4.5:1）` });
    for (const x of flow.issues) issues.push({ level: 'error', where: `第 ${x.card} 张`, msg: `一个${{ figure: '配图', table: '表格', pre: '代码块' }[x.what] || '块'}单独一张也放不下（「${x.text}」）` });
    for (const b of flow.boxes) if (b.over > 1 && !flow.issues.some((x) => x.card === b.idx)) issues.push({ level: 'error', where: `第 ${b.idx} 张`, msg: `内容超出 ${Math.round(b.over)}px` });
    const broken = await page.evaluate(() => [...document.images].filter((i) => !i.complete || !i.naturalWidth).length);
    if (broken) issues.push({ level: 'error', where: '配图', msg: `${broken} 张原文配图没有加载出来` });
    const n = flow.boxes.length;
    if (n > spec.limit) issues.push({ level: 'warn', where: '张数', msg: `共 ${n} 张，超过单篇上限 ${spec.limit} 张：分成两篇发，或改用原文长图` });

    await page.setViewport(deckW, flow.deck.height + 48, 2);
    for (const b of flow.boxes) {
      const f = path.join(outDir, `card-${String(b.idx).padStart(2, '0')}.png`);
      fs.writeFileSync(f, await page.screenshot({ clip: { x: b.x, y: b.y, width: b.width, height: b.height } }));
      files.push(f);
    }
    fs.writeFileSync(path.join(outDir, 'overview.jpg'), await page.screenshot({ clip: { x: 0, y: 0, width: deckW, height: flow.deck.height + 48, scale: 0.3 }, format: 'jpeg', quality: 82 }));
    await page.close();
  } finally {
    await browser.close();
  }
  if (sha256(fs.readFileSync(src)) !== art.sha) issues.push({ level: 'error', where: '原文', msg: '渲染期间原文文件被改动' });
  fs.writeFileSync(path.join(outDir, 'caption.md'), captionMd({ meta, blocks, count: files.length, spec }));
  const verify = issues.some((x) => x.where === '全文校验' || x.where === '原文解析') ? 'fail' : 'pass';
  fs.writeFileSync(path.join(outDir, 'qa.json'), JSON.stringify({ source: src, source_sha256: art.sha, blocks: ledger.length, cards: files.length, verify, generated_images: 0, issues }, null, 2));

  console.log(`\n[${theme || 'full'}] ${files.length} 张 ${spec.key} 原文卡片 → ${path.join(outDir, 'card-01.png')} … card-${String(files.length).padStart(2, '0')}.png  (${spec.w * 2}×${spec.h * 2}px)`);
  console.log(`  总览：${path.join(outDir, 'overview.jpg')}`);
  console.log(`  文案：${path.join(outDir, 'caption.md')}`);
  console.log(`  全文校验：${verify === 'pass' ? `通过（${ledger.length} / ${ledger.length} 块逐字一致）` : '未通过'}`);
  let nErr = 0, nWarn = 0;
  for (const x of issues) { if (x.level === 'error') nErr++; else nWarn++; console.log(`  ${x.level === 'error' ? '✗' : '⚠'} ${x.where}：${x.msg}`); }
  console.log(`\n版面检查：${nErr} 个错误，${nWarn} 个提示。${nErr ? '错误必须修复后重新渲染。' : ''}`);
  return nErr ? 1 : 0;
}
