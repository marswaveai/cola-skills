// X post / thread (FxTwitter status JSON) → Markdown body + meta. Pure: no network, so it is unit-tested.

/** `st` is the status, `data` the whole FxTwitter response (for the thread), `meta` the fields fetch already knows. */
export function postToMarkdown(st, data, meta) {
  const parts = [];
  const videos = [];
  const pushPost = (p) => {
    let text = p.raw_text?.text || p.text || '';
    // Facets: the trailing pic.x.com link is the attached media itself (drop it); t.co links expand to their target.
    for (const f of p.raw_text?.facets || []) {
      if (!f.original) continue;
      if (f.type === 'media') text = text.split(f.original).join('');
      else if (f.replacement && /^https?:/.test(f.replacement)) text = text.split(f.original).join(f.replacement);
    }
    parts.push(text.replace(/[ \t　]+$/gm, '').trim());
    // Videos are not images: show the poster frame, then a link to the video itself.
    for (const m of p.media?.all || p.media?.photos || []) {
      if (!m.url) continue;
      if (m.type === 'video' || m.type === 'gif') {
        videos.push({ url: m.url, duration: m.duration || 0 });
        if (m.thumbnail_url) parts.push(`![图](${m.thumbnail_url})`);
        parts.push(`[▶ 视频${m.duration ? `（${Math.round(m.duration)} 秒）` : ''}](${m.url})`);
      } else parts.push(`![图](${m.url})`);
    }
    if (p.quote) parts.push(`> 引用 @${p.quote.author?.screen_name}：${(p.quote.text || '').replace(/\n/g, '\n> ')}`);
  };
  const thread = Array.isArray(data.thread) ? data.thread : data.thread?.statuses;
  if (Array.isArray(thread) && thread.length > 1) thread.forEach(pushPost);
  else pushPost(st);
  const firstLine = (st.raw_text?.text || st.text || '').split('\n')[0].trim();
  const first = firstLine.slice(0, 60);
  // A post's title is its first line; when the whole line became the title, the body starts after it.
  if (first === firstLine && parts[0]?.startsWith(firstLine)) parts[0] = parts[0].slice(firstLine.length).trim();
  return { meta: { ...meta, platform: thread?.length > 1 ? 'X 线程' : 'X 帖子', title: first, ...(videos.length ? { videos } : {}) }, body: parts.filter(Boolean).join('\n\n') };
}
