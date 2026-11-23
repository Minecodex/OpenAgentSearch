import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTimestamp, localOffset } from '../src/date-time.ts';

test('calendar values retain their written date and fractional UTC offset', () => {
  for (const offset of ['+05:45', '-03:30', '+08:00']) {
    assert.deepEqual(splitTimestamp('2026-05-01T00:30:00'+offset), {date:'2026-05-01T00:30:00',offset});
  }
  assert.deepEqual(splitTimestamp('2026-04-30T16:30:00Z'), {date:'2026-04-30T16:30:00',offset:'+00:00'});
  assert.equal(splitTimestamp('').date, '');
  assert.match(localOffset(), /^[+-][0-9]{2}:[0-9]{2}$/);
});
