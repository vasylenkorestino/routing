/**
 * Adversarial tests for memory privacy validation.
 * Run: node agent/src/agent/memory/validator.test.js
 */
const assert = require('assert');
const { validateMemoryContent, sanitizeMemoryForStorage } = require('../../utils/aiDataPolicy');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

test('rejects email in summary', () => {
  const r = validateMemoryContent({
    category: 'routing_heuristic',
    summary: 'Contact john@example.com before routing',
    content: 'Decline remote adds',
  });
  assert.equal(r.valid, false);
});

test('rejects phone in content', () => {
  const r = validateMemoryContent({
    category: 'user_correction',
    summary: 'Manager preference',
    content: 'Call 555-123-4567 about detours',
  });
  assert.equal(r.valid, false);
});

test('rejects API key pattern', () => {
  const r = validateMemoryContent({
    category: 'optimization_rule',
    summary: 'Maps config',
    content: 'Use sk-abcdefghijklmnopqrstuvwxyz123456',
  });
  assert.equal(r.valid, false);
});

test('rejects invalid category', () => {
  const r = validateMemoryContent({
    category: 'customer_pii',
    summary: 'Allowed rule',
    content: 'Keep VIP stops first',
  });
  assert.equal(r.valid, false);
});

test('allows routing-only operational content', () => {
  const r = validateMemoryContent({
    category: 'yard_rule',
    summary: 'Orlando detour limit',
    content: 'Decline add candidates requiring more than 15 minutes off the route polyline.',
  });
  assert.equal(r.valid, true);
});

test('sanitizeMemoryForStorage redacts email then rejects if unsafe', () => {
  const r = sanitizeMemoryForStorage({
    category: 'account_routing_pattern',
    summary: 'Habit Burger pattern',
    content: 'Max 21-day interval; always service on schedule for account 001xx000003DGbQ',
  });
  assert.equal(r.valid, true);
  assert.ok(!r.record.content.includes('@'));
});

test('sanitizeMemoryForStorage rejects poison after redaction fails', () => {
  const r = sanitizeMemoryForStorage({
    category: 'routing_heuristic',
    summary: 'Credential leak',
    content: 'api_key=supersecretvalue12345',
  });
  assert.equal(r.valid, false);
});

test('redacts phone from comment-like text', () => {
  const r = sanitizeMemoryForStorage({
    category: 'user_correction',
    summary: 'Detour policy',
    content: 'Manager said call (407) 555-0199 — prefer shorter detours instead',
  });
  assert.equal(r.valid, true);
  assert.ok(r.record.content.includes('[phone-redacted]'));
});

console.log('\nAll memory validator tests passed.');
