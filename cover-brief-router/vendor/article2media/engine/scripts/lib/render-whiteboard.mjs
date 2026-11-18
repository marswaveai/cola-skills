// Pipeline for the whiteboard layout (-w).
//   render.mjs <article.md> --layout whiteboard   → writes the source inventory (whiteboard-source.json)
//   render.mjs <whiteboard.json> --layout whiteboard → checks the ledger, renders, verifies the DOM, captures PNG(s)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './chrome.mjs';
import { inventory, checkWhiteboard, buildWhiteboard, domCheckInPage } from './layout-whiteboard.mjs';
import { frontMatter } from './layout-full.mjs';

const MAX_PAGE = 7400;

export async function renderWhiteboard(input, { opt, THEMES_DIR, readCss }) {
  if (input.endsWith('.md')) {
    const inv = inventory(fs.readFileSync(input, 'utf8'));
    const out = path.join(path.dirname(input), 'whiteboard-source.json');
    fs.writeFileSync(out, JSON.stringify({ ...inv, source: input }, null, 1));
    console.log(`来源清单：${out}（${inv.sections.length} 段，source_sha256 ${inv.source_sha256.slice(0, 12)}…）`);
    console.log('下一步：按 references/whiteboard-guide.md 写 whiteboard.json，source_sections 必须逐段覆盖这份清单。');
    return 0;
  }
  const wbPath = input;
  const wb = JSON.parse(fs.readFileSync(wbPath, 'utf8'));
  const dir = path.dirname(wbPath);
  const invPath = path.resolve(dir, wb.inventory || 'whiteboard-source.json');
  const inv = fs.existsSync(invPath) ? JSON.parse(fs.readFileSync(invPath, 'utf8')) : null;
  // The inventory must still match the article it was built from.
  if (inv?.source && fs.existsSync(inv.source)) {
    const fresh = inventory(fs.readFileSync(inv.source, 'utf8'));
    if (fresh.source_sha256 !== inv.source_sha256) { console.error('✗ 原文在建立来源清单后被改动：重新运行 render.mjs <article.md> --layout whiteboard'); return 1; }
  }
  const { errors, warnings } = checkWhiteboard(wb, inv);
  for (const w of warnings) console.log(`⚠ ${w}`);
  for (const e of errors) console.log(`✗ ${e}`);
  if (!inv) console.log('⚠ 没有来源清单：无法核对每段原文的去向（先对 article.md 运行一次 --layout whiteboard）');
  if (errors.length) return 1;
  const rendered = (wb.source_sections || []).filter((s) => s.disposition === 'rendered').length;
  console.log(`✓ 论证账本：${wb.steps.length} 步，${(wb.relations || []).filter((r) => r.visibility === 'visible').length} 处可见转折${inv ? `；来源 ${inv.sections.length} 段：${rendered} 段进入白板，${inv.sections.length - rendered} 段写明省略理由` : ''}`);
  if (opt.check) return 0;

  const useTheme = !!opt.theme;
  const themeCss = useTheme ? fs.readFileSync(path.join(THEMES_DIR, `${opt.theme}.css`), 'utf8') : '';
  let credit = '';
  if (inv?.source && fs.existsSync(inv.source)) {
    const { meta } = frontMatter(fs.readFileSync(inv.source, 'utf8'));
    credit = `来源：${[meta.author && `${meta.author}${meta.handle ? `（${meta.handle}）` : ''}`, meta.title && `《${meta.title}》`, meta.platform, meta.date].filter(Boolean).join('，')}。论证结构由编者整理。`;
  }
  const images = {};
  // Local images resolve against whiteboard.json's directory (the page itself is written one level down).
  for (const s of wb.steps) if (s.image?.src) images[s.id] = /^(https?|data|file):/i.test(s.image.src) ? s.image.src : pathToFileURL(path.resolve(dir, s.image.src)).href;
  const outDir = path.resolve(opt.out || path.join(dir, useTheme ? `${opt.theme}-whiteboard` : 'whiteboard'));
  fs.mkdirSync(path.join(outDir, 'review'), { recursive: true });
  const htmlPath = path.join(outDir, 'whiteboard.html');
  fs.writeFileSync(htmlPath, buildWhiteboard(wb, { css: readCss('whiteboard.css'), themeCss, useTheme, images, credit }));

  const issues = [];
  const pages = [];
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport(540, 960, 2);
    await page.goto(pathToFileURL(htmlPath).href);
    if ((await page.settle(30000)) === 'timeout') issues.push({ level: 'warn', where: '字体', msg: '网络字体加载超时' });
    for (const f of await page.evaluate(domCheckInPage, { steps: wb.steps.map((s) => s.id) })) issues.push({ level: 'error', where: '账本与页面', msg: f });
    const m = await page.evaluate(() => {
      const kids = [...document.querySelectorAll('.wb-head, .logic-step, .logic-relation.is-visible, .wb-closing, .wb-foot')].map((e) => { const r = e.getBoundingClientRect(); return [r.top + scrollY, r.bottom + scrollY]; });
      const over = [...document.querySelectorAll('.wb-page *')].filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== 'visible').length;
      return { kids, height: Math.ceil(document.querySelector('.wb-page').getBoundingClientRect().height), wide: document.documentElement.scrollWidth > 541, over, broken: [...document.images].filter((i) => !i.complete || !i.naturalWidth).length };
    });
    if (m.wide) issues.push({ level: 'error', where: '版面', msg: '有内容横向溢出' });
    if (m.broken) issues.push({ level: 'error', where: '图片', msg: `${m.broken} 张图片没有加载` });
    const cuts = [0];
    let start = 0;
    for (let i = 1; i < m.kids.length; i++) if (m.kids[i][1] - start > MAX_PAGE) { const c = Math.round((m.kids[i - 1][1] + m.kids[i][0]) / 2); cuts.push(c); start = c; }
    cuts.push(m.height);
    await page.setViewport(540, Math.min(m.height, 16000), 2);
    for (let k = 0; k < cuts.length - 1; k++) {
      const name = cuts.length === 2 ? 'whiteboard.png' : `whiteboard-${String(k + 1).padStart(2, '0')}.png`;
      fs.writeFileSync(path.join(outDir, name), await page.screenshot({ clip: { x: 0, y: cuts[k], width: 540, height: cuts[k + 1] - cuts[k] } }));
      pages.push({ file: path.join(outDir, name), height: (cuts[k + 1] - cuts[k]) * 2 });
    }
    let i = 0;
    for (let y = 0; y < m.height; y += 1050) {
      const h = Math.min(1200, m.height - y);
      fs.writeFileSync(path.join(outDir, 'review', `slice-${String(++i).padStart(2, '0')}.jpg`), await page.screenshot({ clip: { x: 0, y, width: 540, height: h, scale: 0.5 }, format: 'jpeg', quality: 80 }));
      if (y + h >= m.height) break;
    }
    await page.close();
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(outDir, 'qa.json'), JSON.stringify({ steps: wb.steps.length, pages, issues }, null, 2));
  for (const p of pages) console.log(`→ ${p.file}（1080×${p.height}）`);
  console.log(`审片切片：${path.join(outDir, 'review')}`);
  let nErr = 0, nWarn = 0;
  for (const x of issues) { if (x.level === 'error') nErr++; else nWarn++; console.log(`  ${x.level === 'error' ? '✗' : '⚠'} ${x.where}：${x.msg}`); }
  console.log(`\n版面检查：${nErr} 个错误，${nWarn} 个提示。`);
  return nErr ? 1 : 0;
}
