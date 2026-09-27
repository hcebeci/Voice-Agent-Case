import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignedExecutionKeys, callDirection } from './configuration.mjs';
const row = (execution_key, is_enabled = true) => ({ tools: { execution_key, is_enabled } });
test('only explicitly assigned enabled tools are dispatched', () => {
  assert.deepEqual(assignedExecutionKeys([]), []);
  assert.deepEqual(assignedExecutionKeys([row('request_callback'), row('verify_identity', false)]), ['request_callback']);
});
test('unknown implementations cannot run and payment prerequisites are explicit', () => {
  assert.throws(() => assignedExecutionKeys([row('arbitrary_code')]));
  assert.throws(() => assignedExecutionKeys([row('evaluate_offer')]));
  assert.throws(() => assignedExecutionKeys([row('verify_identity'), row('create_payment_commitment')]));
  assert.deepEqual(assignedExecutionKeys([row('verify_identity'), row('evaluate_offer')]), ['verify_identity', 'evaluate_offer']);
});
test('both call directions are accepted and invalid directions rejected', () => {
  assert.equal(callDirection(), 'user_calls_agent');
  assert.equal(callDirection('agent_calls_user'), 'agent_calls_user');
  assert.throws(() => callDirection('anything'));
});
