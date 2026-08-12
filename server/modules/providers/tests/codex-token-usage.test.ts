import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCodexTokenBudget } from '@/shared/utils.js';

test('Codex token usage includes a weekly-only account percentage', () => {
  const result = extractCodexTokenBudget({
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49 },
      model_context_window: 250_000,
    },
    rate_limits: {
      primary: { used_percent: 23, window_minutes: 10_080, resets_at: 1_800_000_000 },
      secondary: null,
      plan_type: 'pro',
    },
  });

  assert.deepEqual(result, {
    used: 49,
    total: 250_000,
    inputTokens: 40,
    outputTokens: 9,
    breakdown: { input: 40, output: 9 },
    accountUsage: {
      fiveHour: null,
      sevenDay: {
        utilization: 23,
        resetsAt: 1_800_000_000_000,
        severity: 'normal',
      },
      limits: [{
        kind: 'weekly_all',
        utilization: 23,
        resetsAt: 1_800_000_000_000,
        severity: 'normal',
        scopeLabel: null,
        isActive: false,
      }],
      plan: 'pro',
    },
  });
});

test('Codex token usage classifies five-hour and weekly pressure independently', () => {
  const result = extractCodexTokenBudget({
    info: {
      total_token_usage: { input_tokens: 1, output_tokens: 2 },
    },
    rate_limits: {
      primary: { used_percent: 82, window_minutes: 300, resets_at: 2_000_000_000 },
      secondary: { used_percent: 100, window_minutes: 10_080, resets_at: 2_100_000_000 },
    },
  });

  assert.equal(result?.accountUsage?.fiveHour?.severity, 'warning');
  assert.equal(result?.accountUsage?.sevenDay?.severity, 'critical');
  assert.equal(result?.used, 3);
});

test('Codex token usage remains available when a rate-limit snapshot is absent', () => {
  assert.deepEqual(extractCodexTokenBudget({
    usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 },
  }), {
    used: 10,
    total: 200_000,
    inputTokens: 6,
    outputTokens: 4,
    breakdown: { input: 6, output: 4 },
  });
});

test('Codex token usage accepts the current app-server camel-case shape', () => {
  assert.deepEqual(extractCodexTokenBudget({
    tokenUsage: {
      total: { inputTokens: 70, outputTokens: 11, totalTokens: 81 },
      modelContextWindow: 258_400,
    },
    rateLimits: {
      primary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_900_000_000 },
      secondary: null,
      planType: 'pro',
    },
  }), {
    used: 81,
    total: 258_400,
    inputTokens: 70,
    outputTokens: 11,
    breakdown: { input: 70, output: 11 },
    accountUsage: {
      fiveHour: null,
      sevenDay: {
        utilization: 42,
        resetsAt: 1_900_000_000_000,
        severity: 'normal',
      },
      limits: [{
        kind: 'weekly_all',
        utilization: 42,
        resetsAt: 1_900_000_000_000,
        severity: 'normal',
        scopeLabel: null,
        isActive: false,
      }],
      plan: 'pro',
    },
  });
});
