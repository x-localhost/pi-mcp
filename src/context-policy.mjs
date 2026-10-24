const GATEWAY_MAX_BYTES = 4 * 1024 * 1024;
const GATEWAY_MAX_MESSAGES = 128;
const DEFAULT = Object.freeze({ maxMessages: 112, maxBytes: 3_500_000 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeContext(raw) {
  if (raw === undefined) return { ...DEFAULT };
  if (!object(raw) || Object.keys(raw).some(key => !['maxMessages', 'maxBytes'].includes(key))) throw new Error('Invalid context configuration');
  const value = { maxMessages: raw.maxMessages ?? DEFAULT.maxMessages, maxBytes: raw.maxBytes ?? DEFAULT.maxBytes };
  if (!Number.isInteger(value.maxMessages) || value.maxMessages < 8 || value.maxMessages > 120 || !Number.isInteger(value.maxBytes) || value.maxBytes < 65_536 || value.maxBytes > 3_800_000) throw new Error('Invalid context configuration');
  return value;
}

const bytes = value => { try { return Buffer.byteLength(JSON.stringify(value)); } catch { return Infinity; } };
const isSystem = message => message?.role === 'system' || message?.role === 'developer';
const isToolResult = message => message?.role === 'toolResult' || message?.role === 'tool' ||
  message?.role === 'user' && Array.isArray(message.content) && message.content.length > 0 &&
  message.content.every(part => part?.type === 'tool_result');
const callIds = message => {
  if (message?.role !== 'assistant') return [];
  const calls = message.toolCalls ?? message.tool_calls ?? (Array.isArray(message.content) ? message.content.filter(part => ['toolCall', 'tool_use'].includes(part?.type)) : []);
  return calls.map(call => call?.id).filter(id => typeof id === 'string' && id.length > 0);
};
const resultIds = message => {
  const ids = [];
  if (typeof message?.toolCallId === 'string') ids.push(message.toolCallId);
  if (typeof message?.tool_call_id === 'string') ids.push(message.tool_call_id);
  if (Array.isArray(message?.content)) for (const part of message.content) if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') ids.push(part.tool_use_id);
  return ids;
};
const hasToolCall = message => message?.role === 'assistant' && (
  Array.isArray(message.toolCalls) && message.toolCalls.length > 0 || Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ||
  Array.isArray(message.content) && message.content.some(part => ['toolCall', 'tool_use'].includes(part?.type)));

/** Drop only old completed assistant/tool groups. Never synthesize model content. */
export function reduceContext(messages, rawPolicy, overheadBytes = 0) {
  const policy = normalizeContext(rawPolicy);
  if (!Array.isArray(messages) || !Number.isSafeInteger(overheadBytes) || overheadBytes < 0) return { ok: false, reason: 'context_limit' };
  const kept = messages.map((message, index) => ({ message, index }));
  const mandatory = new Set();
  for (let i = 0; i < messages.length; i++) if (isSystem(messages[i]) || messages[i]?.role === 'user' && !isToolResult(messages[i])) mandatory.add(i);
  // Preserve pending tool state by exact call/result ID, including partial batches.
  for (let i = 0; i < messages.length; i++) if (hasToolCall(messages[i])) {
    const ids = callIds(messages[i]);
    const following = messages.slice(i + 1).flatMap(resultIds);
    if (!ids.length || ids.some(id => !following.includes(id))) {
      mandatory.add(i);
      for (let j = i + 1; j < messages.length && isToolResult(messages[j]); j++) mandatory.add(j);
    }
  }
  const within = () => kept.length <= Math.min(policy.maxMessages, GATEWAY_MAX_MESSAGES) && bytes(kept.map(item => item.message)) + overheadBytes < Math.min(policy.maxBytes, GATEWAY_MAX_BYTES);
  while (!within()) {
    let drop = null;
    for (let i = 0; i < kept.length; i++) {
      const item = kept[i];
      if (mandatory.has(item.index) || isSystem(item.message)) continue;
      if (item.message?.role === 'assistant') {
        const group = [i];
        if (hasToolCall(item.message)) {
          const ids = callIds(item.message);
          const found = new Set();
          for (let j = i + 1; j < kept.length && isToolResult(kept[j].message); j++) { group.push(j); for (const id of resultIds(kept[j].message)) found.add(id); }
          if (!ids.length || ids.some(id => !found.has(id))) continue;
        }
        if (group.some(position => mandatory.has(kept[position].index))) continue;
        drop = group;
        break;
      }
    }
    if (!drop) return { ok: false, reason: 'context_limit', messages: kept.map(item => item.message), droppedMessages: messages.length - kept.length };
    kept.splice(drop[0], drop.length);
  }
  return { ok: true, messages: kept.map(item => item.message), droppedMessages: messages.length - kept.length, serializedBytes: bytes(kept.map(item => item.message)) + overheadBytes };
}

export function guardProviderPayload(payload, policy) {
  if (!object(payload)) return { ok: false, reason: 'context_limit' };
  const key = Array.isArray(payload.messages) ? 'messages' : Array.isArray(payload.input) ? 'input' : Array.isArray(payload.contents) ? 'contents' : null;
  const serialized = bytes(payload);
  const limits = normalizeContext(policy);
  if (!key) return serialized < Math.min(limits.maxBytes, GATEWAY_MAX_BYTES) ? { ok: true, payload, droppedMessages: 0, serializedBytes: serialized } : { ok: false, reason: 'context_limit' };
  const overhead = bytes({ ...payload, [key]: [] });
  const reduced = reduceContext(payload[key], policy, overhead);
  if (!reduced.ok) return reduced;
  const output = { ...payload, [key]: reduced.messages };
  if (output[key].length > GATEWAY_MAX_MESSAGES || bytes(output) >= GATEWAY_MAX_BYTES) return { ok: false, reason: 'context_limit' };
  return { ...reduced, payload: output, serializedBytes: bytes(output) };
}
