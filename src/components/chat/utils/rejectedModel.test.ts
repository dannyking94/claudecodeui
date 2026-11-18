import assert from 'node:assert/strict';
import test from 'node:test';

import { decideRejectedModelReset } from './rejectedModel';

test('a rejected stored model is replaced by the catalog default', () => {
  assert.deepEqual(
    decideRejectedModelReset({
      rejectedModel: 'gpt-5.4',
      catalogDefault: 'gpt-6-astra',
      storedModel: 'gpt-5.4',
      sessionModel: null,
    }),
    { replacement: 'gpt-6-astra', resetStored: true, resetSession: false },
  );
});

test('a session recorded on the rejected model is reset without touching a different stored pick', () => {
  assert.deepEqual(
    decideRejectedModelReset({
      rejectedModel: 'gpt-5.4',
      catalogDefault: 'gpt-6-astra',
      storedModel: 'gpt-5.6-sol',
      sessionModel: 'gpt-5.4',
    }),
    { replacement: 'gpt-6-astra', resetStored: false, resetSession: true },
  );
});

test('nothing changes when the default itself was rejected, or no choice holds the model', () => {
  assert.equal(decideRejectedModelReset({
    rejectedModel: 'gpt-6-astra',
    catalogDefault: 'gpt-6-astra',
    storedModel: 'gpt-6-astra',
    sessionModel: null,
  }), null);
  assert.equal(decideRejectedModelReset({
    rejectedModel: 'gpt-5.4',
    catalogDefault: undefined,
    storedModel: 'gpt-5.4',
    sessionModel: null,
  }), null);
  assert.equal(decideRejectedModelReset({
    rejectedModel: 'gpt-5.4',
    catalogDefault: 'gpt-6-astra',
    storedModel: 'gpt-5.6-sol',
    sessionModel: 'gpt-5.6-sol',
  }), null);
});
