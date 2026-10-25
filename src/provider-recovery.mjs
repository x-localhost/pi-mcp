// Classifies the final assistant message of a Pi agent run after
// `agent_settled`, and computes the backoff delay before a bounded
// continuation prompt. See docs/provider-resilience.md and the Unit A
// contract in docs/llm-resilience-plan.md.
//
// classifyFinalMessage(message) -> { healthy: true }
//   | { healthy: false, recoverable: boolean, reason }
// reason is one of: empty_response, truncated_empty, malformed_response,
// provider_unavailable, provider_error.

// Strips control characters (except the newline/tab kept inside otherwise
// visible text), DEL, and the Unicode replacement character U+FFFD, then
// trims surrounding whitespace, so a reply made only of junk bytes counts
// as empty the same way a reply with no content at all does.
const JUNK_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F�]/g;

function visibleText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
    .replace(JUNK_PATTERN, '')
    .trim();
}

function hasToolCalls(content) {
  return Array.isArray(content) && content.some(part => part && part.type === 'toolCall');
}

function buildPattern(parts) {
  return new RegExp(parts.join('|'), 'i');
}

// Parse/protocol failures surfaced as a stopReason "error" message, not a
// provider outage. Matches malformed SSE JSON, truncated streams, and
// generic "invalid response"/"empty response" gateway wording.
const MALFORMED_RESPONSE_PATTERN = buildPattern([
  'JSON parse',
  'Could not parse',
  'Unexpected token',
  'Unexpected end of JSON',
  'invalid response',
  'Stream ended without finish_reason',
  'empty response',
]);

// Transient availability failures. Reached only after Pi's own auto-retry
// (pi-ai dist/utils/retry.js transient pattern) has already run out and
// given up, since Pi retries these itself first.
const PROVIDER_UNAVAILABLE_PATTERN = buildPattern([
  '(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])',
  'overloaded',
  'rate.?limit',
  'too many requests',
  'service.?(?:is.?)?(?:temporarily.?)?unavailable',
  'server.?error',
  'internal.?error',
  'timed? out',
  'timeout',
  'terminated',
  'connection.?reset',
  'connection.?refused',
  'connection.?lost',
  'network.?error',
  'socket hang up',
]);

export function classifyFinalMessage(message) {
  const stopReason = message?.stopReason;
  const text = visibleText(message?.content);
  const toolCalls = hasToolCalls(message?.content);

  if ((stopReason === 'stop' || stopReason === 'end_turn') && text) {
    return { healthy: true };
  }
  if ((stopReason === 'stop' || stopReason === 'end_turn' || stopReason === 'toolUse') && !text && !toolCalls) {
    return { healthy: false, recoverable: true, reason: 'empty_response' };
  }
  if (stopReason === 'length' && !text && !toolCalls) {
    return { healthy: false, recoverable: true, reason: 'truncated_empty' };
  }
  if (stopReason === 'error') {
    const errorMessage = typeof message?.errorMessage === 'string' ? message.errorMessage : '';
    if (MALFORMED_RESPONSE_PATTERN.test(errorMessage)) return { healthy: false, recoverable: true, reason: 'malformed_response' };
    if (PROVIDER_UNAVAILABLE_PATTERN.test(errorMessage)) return { healthy: false, recoverable: true, reason: 'provider_unavailable' };
    return { healthy: false, recoverable: false, reason: 'provider_error' };
  }
  // Everything else: length with text (or stray tool calls), aborted,
  // content filter, context overflow, auth/quota/billing, or an unmapped
  // stop reason. Not recoverable; callers keep today's error semantics.
  return { healthy: false, recoverable: false, reason: 'provider_error' };
}

export function recoveryDelayMs(policy, attempt) {
  const base = Number.isFinite(policy?.baseDelayMs) ? policy.baseDelayMs : 0;
  const max = Number.isFinite(policy?.maxDelayMs) ? policy.maxDelayMs : base;
  const delay = base * 2 ** Math.max(0, attempt - 1);
  const safe = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
  return Math.min(safe, max);
}
