import { loadAndValidateProfile } from './profile.mjs';
import { startRelay } from './relay.mjs';
import { assertSandbox } from './sandbox.mjs';

try {
  if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000) throw new Error('UID/GID 1000 required');
  await assertSandbox();
  await loadAndValidateProfile();
  const relay = await startRelay({ socketPath: '/run/pi-internal/gateway.sock', port: 18080 });
  const stop = async () => { await relay.close(); process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.error('internal relay listening on container loopback');
} catch (error) {
  console.error(`internal agent startup refused: ${error.message}`);
  process.exitCode = 1;
}
