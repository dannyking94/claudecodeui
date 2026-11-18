import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexModelsDefinition,
  CODEX_FALLBACK_MODELS,
} from '@/modules/providers/list/codex/codex-models.provider.js';

test('Codex fallback models include GPT-6 Astra and the GPT-5.6 family with current effort values', () => {
  assert.equal(CODEX_FALLBACK_MODELS.DEFAULT, 'gpt-5.6');
  assert.deepEqual(
    CODEX_FALLBACK_MODELS.OPTIONS.slice(0, 5).map((option) => option.value),
    ['gpt-6-astra', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  );

  const astra = CODEX_FALLBACK_MODELS.OPTIONS.find((option) => option.value === 'gpt-6-astra');
  assert.deepEqual(
    astra?.effort?.values.map((value) => value.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
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
  assert.ok(definition.OPTIONS.some((option) => option.value === 'gpt-6-astra'));
  assert.ok(!definition.OPTIONS.some((option) => option.value === 'hidden-model'));
  assert.equal(new Set(definition.OPTIONS.map((option) => option.value)).size, definition.OPTIONS.length);
});

test('the model in ~/.codex/config.toml becomes the Codex default', () => {
  const definition = buildCodexModelsDefinition([
    { slug: 'gpt-5.6-sol', visibility: 'list', priority: 1 },
  ], 'gpt-6-astra');

  assert.equal(definition.DEFAULT, 'gpt-6-astra');
  const astra = definition.OPTIONS.filter((option) => option.value === 'gpt-6-astra');
  assert.equal(astra.length, 1, 'the bundled gpt-6-astra entry is reused, not duplicated');
  assert.equal(astra[0]?.label, 'GPT-6 Astra', 'and keeps its bundled metadata and efforts');
  assert.ok(astra[0]?.effort?.values.some((value) => value.value === 'max'));
  assert.ok(
    definition.OPTIONS.some((option) => option.value === 'gpt-5.4'),
    'models are not removed just because a default was configured',
  );
});

test('a configured model neither the cache nor the fallbacks know is offered first', () => {
  const definition = buildCodexModelsDefinition([
    { slug: 'gpt-5.6-sol', visibility: 'list', priority: 1 },
  ], 'gpt-7-preview');

  assert.equal(definition.DEFAULT, 'gpt-7-preview');
  assert.equal(definition.OPTIONS[0]?.value, 'gpt-7-preview');
  assert.ok(definition.OPTIONS.some((option) => option.value === 'gpt-5.6-sol'));
});

test('a configured model already in the cache keeps its cached metadata', () => {
  const definition = buildCodexModelsDefinition([
    { slug: 'gpt-5.6-terra', display_name: 'Terra', visibility: 'list', priority: 1 },
  ], '  gpt-5.6-terra  ');

  assert.equal(definition.DEFAULT, 'gpt-5.6-terra');
  assert.equal(definition.OPTIONS.filter((option) => option.value === 'gpt-5.6-terra').length, 1);
  assert.equal(definition.OPTIONS.find((option) => option.value === 'gpt-5.6-terra')?.label, 'Terra');
});

test('without a configured model the default stays gpt-5.6', () => {
  assert.equal(buildCodexModelsDefinition([], null).DEFAULT, 'gpt-5.6');
  assert.equal(buildCodexModelsDefinition([], '   ').DEFAULT, 'gpt-5.6');
});
