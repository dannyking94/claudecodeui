import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CLAUDE_CONTEXT_WINDOW,
  resolveClaudeContextWindow,
  resolveClaudeModelContextWindow,
} from '@/shared/claude-context-window.js';

test('resolveClaudeModelContextWindow reports the 1M window for current models', () => {
  for (const modelId of [
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-mythos-5-1',
    'claude-mythos-5',
  ]) {
    assert.equal(resolveClaudeModelContextWindow(modelId), 1_000_000, modelId);
  }
});

test('resolveClaudeModelContextWindow reports the 200K window for Haiku and older models', () => {
  for (const modelId of [
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-opus-4-5',
    'claude-opus-4-1',
    'claude-3-7-sonnet',
    'claude-3-5-haiku-20241022',
  ]) {
    assert.equal(resolveClaudeModelContextWindow(modelId), 200_000, modelId);
  }
});

test('resolveClaudeModelContextWindow matches ids that carry a release date suffix', () => {
  assert.equal(resolveClaudeModelContextWindow('claude-haiku-4-5-20251001'), 200_000);
  assert.equal(resolveClaudeModelContextWindow('claude-opus-5-20260101'), 1_000_000);
});

test('resolveClaudeModelContextWindow maps bare family aliases to the current family member', () => {
  assert.equal(resolveClaudeModelContextWindow('opus'), 1_000_000);
  assert.equal(resolveClaudeModelContextWindow('sonnet'), 1_000_000);
  assert.equal(resolveClaudeModelContextWindow('haiku'), 200_000);
});

test('resolveClaudeModelContextWindow refuses to guess for unusable model ids', () => {
  for (const modelId of ['<synthetic>', 'gpt-5', 'claude-does-not-exist', '', '   ', null, undefined, 42]) {
    assert.equal(resolveClaudeModelContextWindow(modelId), null, String(modelId));
  }
});

test('resolveClaudeContextWindow keeps CONTEXT_WINDOW as the operator override', () => {
  assert.equal(resolveClaudeContextWindow('250000', 'claude-opus-5'), 250_000);
  assert.equal(resolveClaudeContextWindow(500_000, 'claude-haiku-4-5'), 500_000);
});

test('resolveClaudeContextWindow ignores a CONTEXT_WINDOW that is not a positive number', () => {
  assert.equal(resolveClaudeContextWindow('not-a-number', 'claude-opus-5'), 1_000_000);
  assert.equal(resolveClaudeContextWindow('0', 'claude-opus-5'), 1_000_000);
  assert.equal(resolveClaudeContextWindow('-1', 'claude-opus-5'), 1_000_000);
  assert.equal(resolveClaudeContextWindow('', 'claude-opus-5'), 1_000_000);
});

test('resolveClaudeContextWindow falls back to the shared default for an unknown model', () => {
  assert.equal(resolveClaudeContextWindow(undefined, 'claude-does-not-exist'), DEFAULT_CLAUDE_CONTEXT_WINDOW);
  assert.equal(resolveClaudeContextWindow(undefined, '<synthetic>'), DEFAULT_CLAUDE_CONTEXT_WINDOW);
  assert.equal(resolveClaudeContextWindow(undefined, undefined), DEFAULT_CLAUDE_CONTEXT_WINDOW);
  assert.equal(DEFAULT_CLAUDE_CONTEXT_WINDOW, 160_000);
});
