import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

const CODEX_GPT_56_EFFORT_VALUES = [
  { value: 'none' },
  { value: 'low' },
  { value: 'medium' },
  { value: 'high' },
  { value: 'xhigh' },
  { value: 'max' },
];

const CODEX_LEGACY_EFFORT_VALUES = [
  { value: 'low' },
  { value: 'medium' },
  { value: 'high' },
  { value: 'xhigh' },
];

export const CODEX_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-5.6',
      label: 'gpt-5.6',
      description: 'Alias for gpt-5.6-sol.',
      effort: {
        default: 'medium',
        values: CODEX_GPT_56_EFFORT_VALUES,
      },
    },
    {
      value: 'gpt-5.6-sol',
      label: 'gpt-5.6-sol',
      description: 'GPT-5.6 frontier model for complex professional work.',
      effort: {
        default: 'medium',
        values: CODEX_GPT_56_EFFORT_VALUES,
      },
    },
    {
      value: 'gpt-5.6-terra',
      label: 'gpt-5.6-terra',
      description: 'GPT-5.6 model balancing intelligence and cost.',
      effort: {
        default: 'medium',
        values: CODEX_GPT_56_EFFORT_VALUES,
      },
    },
    {
      value: 'gpt-5.6-luna',
      label: 'gpt-5.6-luna',
      description: 'GPT-5.6 model for cost-sensitive workloads.',
      effort: {
        default: 'medium',
        values: CODEX_GPT_56_EFFORT_VALUES,
      },
    },
    {
      value: 'gpt-5.5',
      label: 'gpt-5.5',
      effort: {
        default: 'medium',
        values: CODEX_LEGACY_EFFORT_VALUES,
      },
    },
    {
      value: 'gpt-5.4',
      label: 'gpt-5.4',
      effort: {
        default: 'medium',
        values: CODEX_LEGACY_EFFORT_VALUES,
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'gpt-5.4-mini',
      effort: {
        default: 'medium',
        values: CODEX_LEGACY_EFFORT_VALUES,
      },
    },
  ],
  DEFAULT: 'gpt-5.6',
};

type CodexCachedModel = {
  slug?: string;
  display_name?: string;
  description?: string;
  priority?: number;
  visibility?: string;
  supported_in_api?: boolean;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string;
  }>;
};

const CODEX_MODELS_CACHE_PATH = path.join(os.homedir(), '.codex', 'models_cache.json');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const isCodexCachedModel = (value: unknown): value is CodexCachedModel => {
  const record = readObjectRecord(value);
  return Boolean(record && readOptionalString(record.slug));
};

const readCodexPriority = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
);

const mapCodexModel = (model: CodexCachedModel): ProviderModelOption => {
  const effortValues = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
      .map((level) => {
        const value = readOptionalString(level?.effort);
        if (!value) {
          return null;
        }

        return {
          value,
          description: readOptionalString(level?.description),
        };
      })
      .filter((level): level is NonNullable<typeof level> => Boolean(level))
    : [];

  return {
    value: model.slug as string,
    label: readOptionalString(model.display_name) ?? (model.slug as string),
    description: readOptionalString(model.description),
    effort: effortValues.length > 0
      ? {
          default: readOptionalString(model.default_reasoning_level) ?? undefined,
          values: effortValues,
        }
      : undefined,
  };
};

/**
 * Provider tests use this builder to verify Codex cache parsing and fallback
 * merging without reading a real `~/.codex/models_cache.json` file.
 */
export const buildCodexModelsDefinition = (models: CodexCachedModel[]): ProviderModelsDefinition => {
  const sortedModels = [...models]
    .filter((model) => model.visibility === 'list' && model.supported_in_api !== false)
    .sort((left, right) => readCodexPriority(left.priority) - readCodexPriority(right.priority));

  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const model of sortedModels) {
    const mappedModel = mapCodexModel(model);
    if (seenValues.has(mappedModel.value)) {
      continue;
    }

    seenValues.add(mappedModel.value);
    options.push(mappedModel);
  }

  for (const fallbackModel of CODEX_FALLBACK_MODELS.OPTIONS) {
    if (seenValues.has(fallbackModel.value)) {
      continue;
    }

    seenValues.add(fallbackModel.value);
    options.push(fallbackModel);
  }

  if (options.length === 0) {
    return CODEX_FALLBACK_MODELS;
  }

  const defaultValue = options.find((option) => option.value === CODEX_FALLBACK_MODELS.DEFAULT)?.value
    ?? options[0]?.value
    ?? CODEX_FALLBACK_MODELS.DEFAULT;

  return {
    OPTIONS: options,
    DEFAULT: defaultValue,
  };
};

export class CodexProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const raw = await readFile(CODEX_MODELS_CACHE_PATH, 'utf8');
      const parsed = readObjectRecord(JSON.parse(raw));
      const models = Array.isArray(parsed?.models)
        ? parsed.models.filter(isCodexCachedModel)
        : [];

      return buildCodexModelsDefinition(models);
    } catch {
      return CODEX_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }
}
