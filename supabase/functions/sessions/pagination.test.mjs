import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeCursor,pageSessions} from './pagination.mjs';
const row = id => ({id:`00000000-0000-4000-8000-${String(id).padStart(12,'0')}`,created_at:'2026-11-05T12:00:00+00:00'});
test('pagination includes a deterministic tie breaker and no cursor on final page',()=>{
  const result=pageSessions([row(3),row(2),row(1)],2);
  assert.equal(result.sessions.length,2);
  assert.deepEqual(decodeCursor(result.next_cursor),row(2));
  assert.equal(pageSessions([row(1)],2).next_cursor,null);
});
test('invalid or filter-injecting cursors are rejected',()=>{
  assert.throws(()=>decodeCursor('not-json'));
  const unsafe=btoa(JSON.stringify({created_at:'2026-11-05T12:00:00Z',id:'x),status.eq.failed'})).replaceAll('=','');
  assert.throws(()=>decodeCursor(unsafe));
});
