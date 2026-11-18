// Tiny inline markup: escape everything, then allow **bold** and \n line breaks.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function md(s) {
  return esc(s)
    .replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}

export const plain = (s) => String(s ?? '').replace(/\*\*/g, '');

// Approximate visual width in "CJK characters": wide glyphs count 1, Latin/digits ~0.55.
export function vlen(s) {
  let n = 0;
  for (const ch of plain(s).replace(/\n/g, '')) n += /[⺀-鿿豈-﫿＀-￯　-〿]/.test(ch) ? 1 : 0.55;
  return Math.round(n * 10) / 10;
}

export const pad2 = (n) => String(n).padStart(2, '0');
