/**
 * Minimal Kimi provider using native fetch (OpenAI SDK has init issues)
 */
import { BaseProvider } from './BaseProvider.js';

export class KimiProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'kimi';
    this.defaultModel = config.defaultModel || 'kimi-k2.5';
    this.apiKey = config.apiKey || process.env.KIMI_API_KEY;
    this.baseURL = config.baseURL || 'https://api.moonshot.ai/v1';
    this.temperature = config.temperature ?? 0.6;
    this.reasoning = config.reasoning ?? false;
  }

  async chat(messages, options = {}) {
    const model = options.model || this.defaultModel;
    const maxTokens = options.maxTokens || 1000;
    const temperature = options.temperature ?? this.temperature;

    const body = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
      temperature,
    };

    if (!this.reasoning) {
      body.thinking = { type: 'disabled' };
    }

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Kimi API error: ${res.status} ${err}`);
    }

    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content || '',
      reasoningContent: data.choices?.[0]?.message?.reasoning_content,
    };
  }

  async chatWithTools(messages, tools, options = {}) {
    const model = options.model || this.defaultModel;
    const maxTokens = options.maxTokens || 1000;
    const temperature = options.temperature ?? this.temperature;

    const openaiMessages = messages.map(msg => {
      if (msg.role === 'assistant' && (msg.toolCalls || msg.tool_calls)) {
        const toolCalls = msg.toolCalls || msg.tool_calls;
        return {
          role: 'assistant',
          content: msg.content || msg.text || null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name || tc.function?.name,
              arguments: tc.input ? JSON.stringify(tc.input) : (tc.function?.arguments || '{}'),
            },
          })),
        };
      } else if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.id || msg.tool_call_id,
          content: String(msg.result || msg.content || ''),
        };
      }
      return { role: msg.role, content: msg.content };
    });

    const openaiTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.params || { type: 'object', properties: {} },
      },
    }));

    const body = {
      model,
      messages: openaiMessages,
      tools: openaiTools,
      max_tokens: maxTokens,
      temperature,
    };

    if (!this.reasoning) {
      body.thinking = { type: 'disabled' };
    }

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Kimi API error: ${res.status} ${err}`);
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message;

    return {
      text: msg?.content || '',
      toolCalls: msg?.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      })) || [],
      reasoningContent: msg?.reasoning_content,
    };
  }
}
