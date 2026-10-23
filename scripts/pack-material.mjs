#!/usr/bin/env node
import { packMaterial } from '../src/offline-materials.mjs';

try {
  const [sourceDir, sourceCommit, expectedOriginalDir] = process.argv.slice(2);
  if (!sourceDir || !sourceCommit) throw new Error('usage: pack-material.mjs <source-directory> <40-char-source-commit> [original-LFS-pointer-tree]');
  process.stdout.write(await packMaterial({ sourceDir, sourceCommit, expectedOriginalDir }));
} catch (error) {
  console.error(`material pack refused: ${error.message}`);
  process.exitCode = 1;
}
