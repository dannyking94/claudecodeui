import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatCompactAge, toBrowserReachableUrl } from '@/shared/utils';

test('formatCompactAge buckets an age into now / minutes / hours / days', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatCompactAge(null, now), null);
  assert.equal(formatCompactAge(now - 30_000, now), 'now');
  assert.equal(formatCompactAge(now - 12 * 60_000, now), '12m');
  assert.equal(formatCompactAge(now - 3 * 3_600_000, now), '3h');
  assert.equal(formatCompactAge(now - 5 * 86_400_000, now), '5d');
  assert.equal(formatCompactAge(now + 60_000, now), 'now');
});

test('toBrowserReachableUrl swaps a loopback host for the page host only', () => {
  assert.equal(toBrowserReachableUrl('http://127.0.0.1:8801/x?y=1', 'devbox.example'), 'http://devbox.example:8801/x?y=1');
  assert.equal(toBrowserReachableUrl('http://localhost:5173/', '192.0.2.4'), 'http://192.0.2.4:5173/');
  assert.equal(toBrowserReachableUrl('http://127.0.0.1:8801/', 'localhost'), 'http://127.0.0.1:8801/');
  assert.equal(toBrowserReachableUrl('http://192.0.2.1:8801/', 'devbox.example'), 'http://192.0.2.1:8801/');
  assert.equal(toBrowserReachableUrl('not a url', 'devbox.example'), 'not a url');
});
