/**
 * OpenAI-Compatible Provider - For Grok (xAI), DeepSeek, and Z.AI
 * These providers use the same API format as OpenAI with different base URLs.
 */
import OpenAI from 'openai';
import { BaseProvider } from './BaseProvider.js';

const PROVIDER_CONFIGS = {
  grok: {
    baseURL: 'https://api.x.ai/v1',
    envKey: 'GROK_API_KEY',
    defaultModel: 'grok-2',
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
  },
  zai: {
    baseURL: 'https://api.z.ai/api/paas/v4',
    envKey: 'ZAI_API_KEY',
    defaultModel: 'glm-5',
  },
};

export class OpenAICompatibleProvider extends BaseProvider {
  constructor(providerName, config = {}) {
    super(config);
    const preset = PROVIDER_CONFIGS[providerName];
    if (!preset) throw new Error(`Unknown OpenAI-compatible provider: ${providerName}`);
    
    this.name = providerName;
    this.defaultModel = config.defaultModel || preset.defaultModel;
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env[preset.envKey],
      baseURL: config.baseURL || preset.baseURL,
    });
  }

  async chat(messages, options = {}) {
    const { model = this.defaultModel, maxTokens = 1000, temperature = 0.7 } = options;
    const completion = await this.client.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    });
    return this._normalize(
      completion.choices[0].message.content,
      completion.usage?.total_tokens || 0,
      model
    );
  }
}
