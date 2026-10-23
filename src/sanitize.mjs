export function sanitize(value, env = process.env, extraSecrets = []) {
  const secrets = [...Object.entries(env).filter(([key, val]) => /(?:token|key|secret|password|proxy|auth|credential)/i.test(key) && typeof val === 'string' && val.length >= 6).map(([, val]) => val), ...extraSecrets].filter(v => typeof v === 'string' && v.length >= 6);
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
  const clean = item => {
    if (typeof item === 'string') {
      let result = item.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@').replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]');
      for (const secret of secrets) result = result.split(secret).join('[redacted]');
      return result;
    }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, val]) => [key,
      /(?:^|[_-])(?:password|secret|token|key|authorization|credential)(?:$|[_-])|^(?:access|refresh|id|auth)Token$|apiKey/i.test(key) ? '[redacted]' : clean(val)]));
    return item;
  };
  return clean(value);
}
