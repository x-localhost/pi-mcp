#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const [destination] = process.argv.slice(2);
  if (!destination) throw new Error('usage: save-artifact-export.mjs <new-output-file>');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 192 * 1024 * 1024) throw new Error('export size limit'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks), bundle = JSON.parse(bytes);
  if (bundle.version !== 1 || !bundle.manifest || !bundle.blobs || typeof bundle.blobs !== 'object') throw new Error('invalid bundle');
  const { manifest, blobs } = bundle;
  const digestCopy = { ...manifest }; delete digestCopy.manifestSha256;
  if (sha(JSON.stringify(digestCopy)) !== manifest.manifestSha256) throw new Error('manifest integrity failure');
  const expected = new Set();
  for (const entry of manifest.entries) {
    if (!['utf8', 'base64'].includes(entry.encoding)) continue;
    if (!/^a\d{6}$/.test(entry.id) || typeof blobs[entry.id] !== 'string') throw new Error('missing artifact blob');
    const content = Buffer.from(blobs[entry.id], 'base64');
    if (content.length !== entry.size || sha(content) !== entry.sha256) throw new Error('artifact integrity failure');
    expected.add(entry.id);
  }
  if (Object.keys(blobs).some(id => !expected.has(id))) throw new Error('unexpected artifact blob');
  await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ destination, manifestSha256: manifest.manifestSha256, complete: manifest.exportComplete, artifactCount: manifest.entries.length }));
} catch (error) {
  console.error(`artifact export save refused: ${error.message}`);
  process.exitCode = 1;
}
