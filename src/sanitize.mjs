export function sanitize(value, env = process.env, extraSecrets = []) {
  // Generic env-named secrets keep a length floor so common short strings
  // elsewhere aren't globally treated as secret; explicit extraSecrets (e.g.
  // values resolved from a models.json "headers" map) are known by context to
  // be secret and are masked at any length, including 1-5 characters.
  const secrets = [
    ...Object.entries(env).filter(([key, val]) => /(?:token|key|secret|password|proxy|auth|credential)/i.test(key) && typeof val === 'string' && val.length >= 6).map(([, val]) => val),
    ...extraSecrets.filter(v => typeof v === 'string' && v.length >= 1),
  ];
  for (const [key, raw] of Object.entries(env)) {
    if (!/proxy/i.test(key) || typeof raw !== 'string') continue;
    try {
      const url = new URL(raw);
      for (const part of [url.username, url.password]) {
        if (!part) continue;
        const decoded = decodeURIComponent(part);
        if (decoded.length >= 3) secrets.push(decoded);
        if (part.length >= 3) secrets.push(part);
      }
    } catch {}
  }
  // Also redact each secret's JSON-escaped form (e.g. embedded quotes/newlines)
  // so a secret surviving inside a JSON.stringify'd message is still caught,
  // and sort longest-first so a short secret can never partially consume a
  // longer overlapping one and leave a fragment of it exposed.
  for (const secret of [...secrets]) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) secrets.push(escaped);
  }
  const ordered = [...new Set([...secrets, '[redacted]'])].sort((a, b) => b.length - a.length);
  const escapedPattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const secretPattern = new RegExp(ordered.map(escapedPattern).join('|'), 'g');
  const clean = item => {
    if (typeof item === 'string') {
      // Locate every span in the original string. Replacing a one-character
      // known secret first could break a Bearer token or URL before the
      // generic matcher sees it, leaving the rest of that credential exposed.
      const spans = [];
      for (const match of item.matchAll(secretPattern)) {
        if (match[0] !== '[redacted]') spans.push([match.index, match.index + match[0].length]);
      }
      for (const match of item.matchAll(/\bBearer\s+([^\s"']+)/gi)) {
        const start = match.index + match[0].length - match[1].length;
        spans.push([start, start + match[1].length]);
      }
      for (const match of item.matchAll(/https?:\/\/([^\s/@]+:[^\s/@]+)@/gi)) {
        const start = match.index + match[0].indexOf(match[1]);
        spans.push([start, start + match[1].length]);
      }
      if (!spans.length) return item;
      spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      const merged = [];
      for (const span of spans) {
        const last = merged.at(-1);
        if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
        else merged.push([...span]);
      }
      let result = '', cursor = 0;
      for (const [start, end] of merged) {
        result += item.slice(cursor, start) + '[redacted]';
        cursor = end;
      }
      return result + item.slice(cursor);
    }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, val]) => [key,
      /(?:^|[_-])(?:password|secret|token|key|authorization|credential)(?:$|[_-])|^(?:access|refresh|id|auth)Token$|apiKey/i.test(key) ? '[redacted]' : clean(val)]));
    return item;
  };
  return clean(value);
}
