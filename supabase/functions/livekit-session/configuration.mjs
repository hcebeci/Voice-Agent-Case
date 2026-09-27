export const implementedTools = new Set(['verify_identity', 'evaluate_offer', 'create_payment_commitment', 'request_callback']);

export function assignedExecutionKeys(assignments) {
  const tools = assignments.map(row => row.tools).filter(tool => tool?.is_enabled);
  const keys = [...new Set(tools.map(tool => tool.execution_key))];
  if (keys.some(key => !implementedTools.has(key))) throw new Error('This agent has an enabled tool without a worker implementation. Remove that assignment before testing.');
  if (keys.some(key => ['evaluate_offer', 'create_payment_commitment'].includes(key)) && !keys.includes('verify_identity')) {
    throw new Error('Payment tools require verify_identity to be assigned to this agent.');
  }
  if (keys.includes('create_payment_commitment') && !keys.includes('evaluate_offer')) throw new Error('create_payment_commitment requires evaluate_offer.');
  return keys;
}

export function callDirection(value = 'user_calls_agent') {
  if (!['agent_calls_user', 'user_calls_agent'].includes(value)) throw new Error('Invalid call direction.');
  return value;
}
