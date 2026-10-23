import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';

export class RpcClient extends EventEmitter {
  constructor(input, output) {
    super(); this.input = input; this.output = output; this.nextId = 0; this.pending = new Map(); this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    input.on('data', chunk => this.feed(this.decoder.write(chunk)));
    input.on('end', () => this.fail(new Error('RPC stream ended')));
    input.on('error', error => this.fail(error));
  }
  feed(text) {
    this.buffer += text;
    if (this.buffer.length > 1024 * 1024) { this.fail(new Error('RPC line exceeds 1 MiB')); this.input.destroy(); return; }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let event; try { event = JSON.parse(line); } catch { this.emit('malformed', line); continue; }
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') { this.emit('malformed', line); continue; }
      if (event.type === 'response' && this.pending.has(event.id)) {
        const { resolve, reject, command, timer } = this.pending.get(event.id); this.pending.delete(event.id); clearTimeout(timer);
        if (event.command !== command || !event.success) reject(new Error(event.error || `RPC ${command} failed`));
        else resolve(event);
      }
      this.emit('event', event); this.emit(event.type === 'error' ? 'rpc_error' : event.type, event);
    }
  }
  request(type, fields = {}, timeoutMs = 15000) {
    const id = `rpc-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${type} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, command: type, timer });
      this.output.write(JSON.stringify({ id, type, ...fields }) + '\n', error => {
        if (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }
  waitFor(type, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.off(type, done); this.off('closed', closed); };
      const done = event => { cleanup(); resolve(event); };
      const closed = error => { cleanup(); reject(error); };
      this.once(type, done);
      this.once('closed', closed);
    });
  }
  fail(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); this.emit('closed', error); }
  close() { this.input.removeAllListeners('data'); this.input.removeAllListeners('end'); this.input.removeAllListeners('error'); this.fail(new Error('RPC closed')); }
}
