/**
 * OpenAI Provider - GPT models via api.openai.com
 */
import OpenAI from 'openai';
import { BaseProvider } from './BaseProvider.js';

export class OpenAIProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'openai';
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      ...(config.baseURL && { baseURL: config.baseURL }),
    });
  }

  async chat(messages, options = {}) {
    const { model = 'gpt-4', maxTokens = 1000, temperature = 0.7 } = options;
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
