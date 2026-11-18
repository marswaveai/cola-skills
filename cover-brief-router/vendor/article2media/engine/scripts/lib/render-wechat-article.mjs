// Pipeline for 公众号排版 (wechat-layout): article.md → paste-ready HTML + covers + publishing notes.
// The article is laid out verbatim: every text block is read back from the page and must equal the source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser } from './chrome.mjs';
import { loadArticle, readbackInPage, compareLedger, localizeImages, sha256 } from './layout-full.mjs';
import { buildArticleSource, articleWechatMeta, pseudoContent } from './layout-wechat-article.mjs';
import { buildWechatCovers, buildWechatPreview, buildWechatNotes, inlineInPage } from './layout-wechat.mjs';
import { loadBrand } from './brand.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const unescapeAttr = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export async function renderWechatArticle(input, { opt, THEMES_DIR, readCss, listThemes }) {
  if (/\.json$/i.test(input)) {
    console.error('✗ 公众号排版只接受文章（.md）。改写稿（content.json）请先导出成文章：\n  node <article-rewrite>/scripts/export.mjs <目录>/content.json   # → <目录>/rewrite.md，再排 rewrite.md');
    return 2;
  }
  const src = fs.existsSync(input) && fs.statSync(input).isDirectory() ? path.join(input, 'article.md') : input;
  if (!fs.existsSync(src)) { console.error(`[wechat] 找不到文章：${src}`); return 2; }
  const dir = path.dirname(src);
  const art = loadArticle(src);
  const { meta, blocks } = art;
  // The title goes into the 公众号 title field; the body starts after it.
  const ledger = blocks.filter((b) => b.kind !== 'figure' && b.kind !== 'break' && !b.isTitle).map((b) => ({ id: b.id, text: b.text }));

  const available = listThemes().map((t) => t.name);
  const themeArg = opt.theme || meta.theme || 'editorial';
  const themes = themeArg === 'all' ? listThemes().filter((t) => !t.legacy).map((t) => t.name) : themeArg.split(',').map((s) => s.trim()).filter(Boolean);
  for (const t of themes) if (!available.includes(t)) { console.error(`[wechat] 没有主题 "${t}"。可用：${available.join(', ')}`); return 2; }
  if (!opt.theme) console.log(`主题：${themes.join(', ')}${meta.theme ? '（文章 front matter 指定）' : '（默认）'}`);

  const wm = articleWechatMeta(meta, blocks, opt);
  // Links to video files (e.g. an X post's attached videos) cannot play inside a 公众号 article: say where they are.
  // (Blocks keep only link text, so read the Markdown: [text](url) whose url is a video file.)
  const videoLinks = [...art.body.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g)]
    .filter((m) => /\.(mp4|mov|m4v|webm)(\?|#|$)|^https?:\/\/video\.twimg\.com\//i.test(m[2])).map((m) => ({ text: m[1], url: m[2] }));
  const kind = meta.kind === 'rewrite' ? '改写稿' : meta.translated_from ? '译文' : '原文';
  console.log(`公众号排版：${path.basename(src)}（${kind}），${ledger.length} 个正文块，${blocks.filter((b) => b.kind === 'figure').length} 张图`);
  if (opt.check) {
    for (const x of art.issues) console.log(`  ✗ ${x.where}：${x.msg}`);
    if (wm.title.length > 64) console.log(`  ✗ 公众号标题：最多 64 字，当前 ${wm.title.length} 字；用 --title 指定`);
    return art.issues.length || wm.title.length > 64 ? 1 : 0;
  }

  const images = await localizeImages(blocks, path.join(dir, 'source-images'), dir);
  const heroPath = opt.hero ? path.resolve(opt.hero) : meta.hero ? path.resolve(dir, meta.hero) : '';
  const heroSrc = heroPath && fs.existsSync(heroPath) ? pathToFileURL(heroPath).href : '';
  const brand = loadBrand({ file: opt.brand, dir });
  const componentsCss = readCss('components.css');
  const report = [];
  let browser;
  try {
    browser = await launchBrowser();
    for (const theme of themes) {
      const themeCss = fs.readFileSync(path.join(THEMES_DIR, `${theme}.css`), 'utf8');
      const outDir = path.resolve(themes.length === 1 && opt.out ? opt.out : path.join(opt.out || dir, `${theme}-wechat`));
      fs.mkdirSync(outDir, { recursive: true });
      const issues = [...art.issues];
      if (videoLinks.length) issues.push({ level: 'warn', where: '视频', msg: `正文有 ${videoLinks.length} 处视频链接（「${videoLinks[0].text.slice(0, 20)}」），公众号正文里点不开：粘贴后在这些位置用编辑器插入视频（先把视频下载到本地）` });
      const srcPath = path.join(outDir, 'source.html');
      fs.writeFileSync(srcPath, buildArticleSource({ blocks, meta, images, themeCss, componentsCss, articleCss: readCss('wechat-article.css'), brand, heroSrc }));
      fs.writeFileSync(path.join(outDir, 'ledger.json'), JSON.stringify({ version: 1, source: src, source_sha256: art.sha, blocks: ledger }, null, 1));
      const entry = { theme, label: `公众号排版（${kind}）`, html: srcPath };
      const page = await browser.newPage();
      try {
        await page.setViewport(375, 900, 3);
        await page.goto(pathToFileURL(srcPath).href);
        const fontStatus = await page.settle(25000);
        if (fontStatus === 'timeout') issues.push({ level: 'warn', where: '字体', msg: '等待网络字体超时' });

        // 1) Verbatim: every block of the article, once, in order (line breaks become <br>).
        const rb = await page.evaluate(readbackInPage, { root: '.wx-doc' });
        for (const f of compareLedger(ledger, rb, { looseBreaks: true })) issues.push({ level: 'error', where: '全文校验', msg: f });
        const broken = await page.evaluate(() => [...document.images].filter((i) => !i.complete || !i.naturalWidth).map((i) => i.getAttribute('src').slice(0, 80)));
        if (broken.length) issues.push({ level: 'error', where: '配图', msg: `${broken.length} 张图没有加载出来：${broken.join('，')}` });

        // 2) Inline styles; local images → base64 (the editor uploads them on paste).
        let html = await page.evaluate(inlineInPage);
        let embedded = 0, remote = 0;
        html = html.replace(/src="([^"]+)"/g, (m, raw) => {
          const url = unescapeAttr(raw);
          if (url.startsWith('file:')) {
            const file = fileURLToPath(url);
            const mime = MIME[path.extname(file).toLowerCase()] || 'image/png';
            if (!fs.existsSync(file)) return m;
            embedded++;
            return `src="data:${mime};base64,${fs.readFileSync(file).toString('base64')}"`;
          }
          if (/^https?:/.test(url)) remote++;
          return m;
        });
        if (remote) issues.push({ level: 'warn', where: '配图', msg: `${remote} 张图没能下载到本地，仍是外链；粘贴后检查是否显示，缺的从原文保存后拖进编辑器` });
        if (/\sclass=|<style|<script|data-source-block|data-deco/.test(html)) issues.push({ level: 'error', where: '公众号正文', msg: '仍有 class / style 标签 / 标记属性，粘贴后会丢样式' });
        if (/url\(/.test(html.replace(/src="data:[^"]+"/g, ''))) issues.push({ level: 'warn', where: '公众号正文', msg: '样式里有 url()，公众号会过滤掉' });
        const mb = Buffer.byteLength(html) / 1048576;
        if (mb > 8) issues.push({ level: 'warn', where: '公众号正文', msg: `正文连同内嵌图片约 ${mb.toFixed(1)} MB，粘贴可能较慢；图片太多时可以只粘文字再手动插图` });
        fs.writeFileSync(path.join(outDir, 'article-body.html'), html);
        const c = pseudoContent(meta, wm, { heroSrc });
        const articlePath = path.join(outDir, 'article.html');
        fs.writeFileSync(articlePath, buildWechatPreview({ content: c, articleHtml: html }));
        const imgDir = path.join(outDir, 'images');
        fs.mkdirSync(imgDir, { recursive: true });
        for (const [i, b] of blocks.filter((x) => x.kind === 'figure').entries()) {
          const u = images[b.src] || b.src;
          if (u.startsWith('file:') && fs.existsSync(fileURLToPath(u))) fs.copyFileSync(fileURLToPath(u), path.join(imgDir, `img-${String(i + 1).padStart(2, '0')}${path.extname(fileURLToPath(u)) || '.png'}`));
        }

        // 3) Covers: 2.35:1 头图 + 1:1, drawn with the theme's card cover style.
        const nAcc = Math.max(1, new Set(themeCss.match(/--accent-\d+\s*:/g) || []).size);
        const coverPath = path.join(outDir, 'covers.html');
        fs.writeFileSync(coverPath, buildWechatCovers({ content: c, themeCss, componentsCss, cardCss: readCss('card.css'), nAcc }));
        await page.setViewport(1400, 480, 2);
        await page.goto(pathToFileURL(coverPath).href);
        await page.settle(25000);
        const boxes = await page.evaluate(() => ['cv-wide', 'cv-square'].map((id) => {
          const el = document.getElementById(id);
          const r = el.getBoundingClientRect();
          const body = el.querySelector('.c-body');
          return { x: r.left, y: r.top, width: r.width, height: r.height, over: body.scrollHeight - body.clientHeight };
        }));
        const files = { wide: path.join(outDir, 'cover-2.35x1.png'), square: path.join(outDir, 'cover-1x1.png') };
        const [wide, square] = boxes;
        fs.writeFileSync(files.wide, await page.screenshot({ clip: { x: wide.x, y: wide.y, width: wide.width, height: wide.height } }));
        fs.writeFileSync(files.square, await page.screenshot({ clip: { x: square.x, y: square.y, width: square.width, height: square.height } }));
        for (const [b, name] of [[wide, '头图'], [square, '1:1 封面']]) {
          if (b.over > 1) issues.push({ level: 'error', where: name, msg: `标题放不下（超出 ${b.over}px），用 --cover-title "两行\\n标题" 缩短` });
        }
        const notesPath = path.join(outDir, 'wechat.md');
        let notes = buildWechatNotes(c, { wide: path.basename(files.wide), square: path.basename(files.square) }).replace('（文件名就是图号，如 fig-1A.png）', '（按文中顺序编号）');
        if (videoLinks.length) notes = notes.trimEnd() + `\n6. 正文里有 ${videoLinks.length} 处视频链接（${videoLinks.map((b) => `「${b.text}」`).join('、')}），公众号里点不开：把视频下载到本地，在编辑器里对应位置插入视频，再删掉这行链接文字。\n${videoLinks.map((b) => `   - ${b.url}`).join('\n')}\n`;
        fs.writeFileSync(notesPath, notes);
        if (!/\n/.test(wm.coverTitle) && wm.coverTitle.length > 24) issues.push({ level: 'warn', where: '封面', msg: `封面标题 ${wm.coverTitle.length} 字，挤在头图上偏小；用 --cover-title "两行\\n短标题" 另写一个` });
        if (!wm.title) issues.push({ level: 'error', where: '公众号标题', msg: '文章没有标题；用 --title 指定' });
        if (wm.title.length > 64) issues.push({ level: 'error', where: '公众号标题', msg: `最多 64 字，当前 ${wm.title.length} 字；用 --title 指定` });
        Object.assign(entry, { image: articlePath, notes: notesPath, covers: `${files.wide}、${path.basename(files.square)}`, size: `${blocks.filter((b) => b.kind === 'figure').length} 张图${heroSrc ? ' + 题图' : ''}，内嵌 ${embedded} 张`, kb: Math.round(Buffer.byteLength(html) / 1024), issues, verify: issues.some((x) => x.where === '全文校验' || x.where === '原文解析') ? 'fail' : 'pass' });
      } finally {
        await page.close();
      }
      if (sha256(fs.readFileSync(src)) !== art.sha) entry.issues.push({ level: 'error', where: '原文', msg: '渲染期间文章文件被改动' });
      fs.writeFileSync(path.join(outDir, 'qa.json'), JSON.stringify({ source: src, source_sha256: art.sha, blocks: ledger.length, ...entry }, null, 2));
      report.push(entry);
    }
  } finally {
    if (browser) await browser.close();
  }

  let nErr = 0, nWarn = 0;
  for (const r of report) {
    console.log(`\n[${r.theme}] ${r.label} → ${r.image || r.html}  (${r.size}, ${r.kb} KB)`);
    console.log(`  封面：${r.covers}`);
    console.log(`  发布信息：${r.notes}`);
    console.log(`  全文校验：${r.verify === 'pass' ? `通过（${ledger.length} / ${ledger.length} 块逐字一致）` : '未通过'}`);
    for (const i of r.issues || []) {
      if (i.level === 'error') nErr++; else nWarn++;
      console.log(`  ${i.level === 'error' ? '✗' : '⚠'} ${i.where}：${i.msg}`);
    }
  }
  console.log(`\n版面检查：${nErr} 个错误，${nWarn} 个提示。${nErr ? '错误必须修复后重新渲染。' : ''}`);
  return nErr ? 1 : 0;
}
