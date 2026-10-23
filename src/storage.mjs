import fs from 'node:fs/promises';
import path from 'node:path';

export async function scanState(root, { maxStateBytes = 4 * 1024 * 1024 * 1024, maxScanEntries = 100000 } = {}) {
  if (await fs.realpath(root) !== root) throw new Error('State root must be canonical');
  let bytes = 0, entries = 1;
  const pending = [{ file: root, depth: 0 }];
  while (pending.length) {
    const { file, depth } = pending.pop();
    if (entries > maxScanEntries || depth > 64) throw new Error('State scan bound exceeded');
    let st;
    try { st = await fs.lstat(file); }
    catch (error) {
      if (depth > 0 && error?.code === 'ENOENT') continue;
      throw error;
    }
    if (st.isSymbolicLink() || !st.isDirectory() && !st.isFile()) throw new Error('Unsafe state entry');
    if (st.isFile()) { bytes += st.size; if (!Number.isSafeInteger(bytes)) throw new Error('State size overflow'); continue; }
    try {
      for await (const item of await fs.opendir(file)) {
        if (++entries > maxScanEntries) throw new Error('State scan bound exceeded');
        pending.push({ file: path.join(file, item.name), depth: depth + 1 });
      }
    } catch (error) {
      if (depth > 0 && error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return { bytes, entries, maxStateBytes, maxScanEntries, withinLimit: bytes < maxStateBytes, softLimit: true };
}
