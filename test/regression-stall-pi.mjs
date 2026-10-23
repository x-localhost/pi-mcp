#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('1.4.0\n');
  process.exit(0);
}
setInterval(() => {}, 1000);
