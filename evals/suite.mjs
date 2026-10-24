import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTask } from './schema.mjs';
import { sha256Hex, stableStringify } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SUITE_VERSION = 'v1';
let cached = null;

export async function loadSuite() {
  if (cached) return cached;
  const file = path.join(here, 'suite', SUITE_VERSION, 'tasks.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  const tasks = raw.map(parseTask);
  const ids = tasks.map(task => task.id);
  if (new Set(ids).size !== ids.length) throw new Error('Suite contains duplicate task ids');
  const digest = sha256Hex(stableStringify(tasks));
  cached = { version: SUITE_VERSION, digest, tasks };
  return cached;
}
