/**
 * Config Validator using Zod
 * Validates config.yaml structure on startup to catch misconfigurations early.
 */

import { z } from 'zod';

const ModelSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'google', 'ollama', 'minimax']),
  model: z.string().min(1),
  maxTokens: z.number().positive().optional(),
  reasoning: z.enum(['low', 'medium', 'high']).optional(),
});

const ConfigSchema = z.object({
  gramjs: z.object({
    api_id: z.number(),
    api_hash: z.string().min(1),
    session_file: z.string().min(1),
    whitelist: z.array(z.number()).min(1),
    group_mode: z.enum(['mention_only', 'all', 'off']).optional(),
  }),

  models: z.object({
    simple: ModelSchema,
    complex: ModelSchema,
    fallback: ModelSchema,
    intent: ModelSchema,
    vision: ModelSchema.optional(),
  }),

  access_control: z.object({
    reject_calls: z.boolean().optional(),
    auto_leave_unauthorized: z.boolean().optional(),
    allowed_users: z.array(z.number()).min(1),
  }).optional(),

  tools: z.object({
    max_rounds: z.number().positive().optional(),
  }).optional(),

  workspace: z.object({
    path: z.string().min(1),
  }).optional(),

  features: z.object({
    streaming: z.boolean().optional(),
  }).optional(),

  instance: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    scope: z.string().optional(),
    redis: z.object({
      url: z.string().min(1),
      prefix: z.string().min(1),
    }).optional(),
  }).optional(),

  safety: z.object({
    max_tool_rounds: z.number().positive().optional(),
    blocked_commands: z.array(z.string()).optional(),
  }).optional(),

  llm: z.object({
    remote: z.object({
      providers: z.record(z.object({
        api_key: z.string().min(1),
        base_url: z.string().optional(),
      })).optional(),
    }).optional(),
    local: z.any().optional(),
  }).optional(),
}).passthrough();

export function validateConfig(config) {
  const result = ConfigSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `  ❌ ${path || '(root)'}: ${issue.message}`;
    }).join('\n');

    throw new Error(`Config validation failed:\n${errors}`);
  }

  console.log('✅ Config validation passed');
  return result.data;
}

export { ConfigSchema };
