import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withOwnershipLock } from './ownership.mjs';

const MAX_EVENTS = 1000, MAX_BYTES = 1024 * 1024, MAX_EVENT_BYTES = 4096;
const fileFor = jobDir => path.join(jobDir, 'events.json');
async function read(jobDir) {
  try {
    const data = JSON.parse(await fs.readFile(fileFor(jobDir), 'utf8'));
    if (!Array.isArray(data.events) || !Number.isSafeInteger(data.nextCursor) || !Number.isSafeInteger(data.dropped)) throw new Error('Invalid event store');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, events: [], nextCursor: 0, dropped: 0 };
    throw error;
  }
}
export async function appendJobEvent(jobDir, event) {
  const encoded = JSON.stringify(event);
  if (Buffer.byteLength(encoded) > MAX_EVENT_BYTES) throw new Error('Event too large');
  return withOwnershipLock(path.join(jobDir, 'events.lock'), async () => {
    const store = await read(jobDir);
    const cursor = ++store.nextCursor;
    store.events.push({ cursor, at: new Date().toISOString(), ...event });
    while (store.events.length > MAX_EVENTS || Buffer.byteLength(JSON.stringify(store)) > MAX_BYTES) { store.events.shift(); store.dropped++; }
    const temp = `${fileFor(jobDir)}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(store), { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, fileFor(jobDir));
    return cursor;
  });
}
export async function readJobEvents(jobDir, { cursor = 0, limit = 50 } = {}) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid event cursor or limit');
  const store = await read(jobDir);
  const earliest = store.events[0]?.cursor ?? store.nextCursor + 1;
  const gap = cursor < earliest - 1 ? { from: cursor + 1, through: earliest - 1 } : null;
  const events = store.events.filter(item => item.cursor > cursor).slice(0, limit);
  return { events, nextCursor: events.at(-1)?.cursor ?? Math.max(cursor, earliest - 1), gap, dropped: store.dropped, latestCursor: store.nextCursor };
}
