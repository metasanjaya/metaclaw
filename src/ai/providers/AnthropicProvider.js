/**
 * Anthropic Provider - Claude models via api.anthropic.com
 * 
 * Anthropic uses a different API format:
 * - System prompt is a separate top-level field (not in messages array)
 * - Messages array only contains user/assistant roles
 * - Response format differs from OpenAI
 */
import axios from 'axios';
import { BaseProvider } from './BaseProvider.js';

export class AnthropicProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'anthropic';
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    this.baseURL = config.baseURL || 'https://api.anthropic.com';
    this.apiVersion = config.apiVersion || '2023-06-01';
  }

  async chat(messages, options = {}) {
    const { model = 'claude-sonnet-4-20250514', maxTokens = 1000, temperature = 0.7 } = options;

    // Extract system message and convert to Anthropic format
    let system = undefined;
    const anthropicMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = system ? `${system}\n${msg.content}` : msg.content;
      } else {
        anthropicMessages.push({ role: msg.role, content: msg.content });
      }
    }

    // Ensure first message is from user (Anthropic requirement)
    while (anthropicMessages.length > 0 && anthropicMessages[0].role !== 'user') {
      anthropicMessages.shift();
    }
    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: 'user', content: 'Hello' });
    }

    // Merge consecutive same-role messages (Anthropic requirement)
    const merged = [];
    for (const msg of anthropicMessages) {
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        merged[merged.length - 1].content += '\n' + msg.content;
      } else {
        merged.push({ ...msg });
      }
    }
    const finalMessages = merged;

    const response = await axios.post(`${this.baseURL}/v1/messages`, {
      model,
      max_tokens: maxTokens,
      temperature,
      ...(system && { system }),
      messages: finalMessages,
    }, {
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
        'content-type': 'application/json',
      },
    });

    const data = response.data;
    const text = data.content.map(block => block.text).join('');
    const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

    return this._normalize(text, tokensUsed, model);
  }
}
