import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexModelsDefinition,
  CODEX_FALLBACK_MODELS,
} from '@/modules/providers/list/codex/codex-models.provider.js';

test('Codex fallback models include the GPT-5.6 family with current effort values', () => {
  assert.equal(CODEX_FALLBACK_MODELS.DEFAULT, 'gpt-5.6');
  assert.deepEqual(
    CODEX_FALLBACK_MODELS.OPTIONS.slice(0, 4).map((option) => option.value),
    ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  );

  const gpt56 = CODEX_FALLBACK_MODELS.OPTIONS.find((option) => option.value === 'gpt-5.6');
  assert.deepEqual(
    gpt56?.effort?.values.map((value) => value.value),
    ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('Codex model cache results are merged with current fallback models', () => {
  const definition = buildCodexModelsDefinition([
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5 from cache',
      description: 'Cached model metadata',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      default_reasoning_level: 'high',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'high' },
      ],
    },
    {
      slug: 'hidden-model',
      visibility: 'hidden',
      priority: 0,
    },
  ]);

  assert.equal(definition.DEFAULT, 'gpt-5.6');
  assert.equal(
    definition.OPTIONS.find((option) => option.value === 'gpt-5.5')?.label,
    'GPT-5.5 from cache',
  );
  assert.ok(definition.OPTIONS.some((option) => option.value === 'gpt-5.6'));
  assert.ok(!definition.OPTIONS.some((option) => option.value === 'hidden-model'));
  assert.equal(new Set(definition.OPTIONS.map((option) => option.value)).size, definition.OPTIONS.length);
});
