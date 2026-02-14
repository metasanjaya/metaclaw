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

  async chatWithTools(messages, tools, options = {}) {
    const { model = 'claude-sonnet-4-20250514', maxTokens = 1000, temperature = 0.7 } = options;

    // Convert tools to Anthropic format
    const anthropicTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: t.params,
        required: Object.keys(t.params)
      }
    }));

    // Extract system message and convert to Anthropic format
    let system = undefined;
    const anthropicMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = system ? `${system}\n${msg.content}` : msg.content;
      } else if (msg.role === 'assistant' && msg.toolCalls) {
        // Convert assistant message with tool calls
        const content = [];
        if (msg.text) {
          content.push({ type: 'text', text: msg.text });
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input
          });
        }
        anthropicMessages.push({ role: 'assistant', content });
      } else if (msg.role === 'user' && msg.toolResults) {
        // Convert tool results message
        const content = msg.toolResults.map(tr => ({
          type: 'tool_result',
          tool_use_id: tr.id,
          content: String(tr.result)
        }));
        anthropicMessages.push({ role: 'user', content });
      } else {
        // Regular text message — ensure content is always string
        const textContent = msg.content || '(empty)';
        anthropicMessages.push({ 
          role: msg.role, 
          content: [{ type: 'text', text: String(textContent) }] 
        });
      }
    }

    // Ensure first message is from user (Anthropic requirement)
    while (anthropicMessages.length > 0 && anthropicMessages[0].role !== 'user') {
      anthropicMessages.shift();
    }
    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
    }

    // Merge consecutive same-role messages (Anthropic requirement)
    const merged = [];
    for (const msg of anthropicMessages) {
      const msgContent = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || '') }];
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        const prev = merged[merged.length - 1];
        prev.content = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: String(prev.content || '') }];
        prev.content.push(...msgContent);
      } else {
        merged.push({ ...msg, content: [...msgContent] });
      }
    }

    const response = await axios.post(`${this.baseURL}/v1/messages`, {
      model,
      max_tokens: maxTokens,
      temperature,
      tools: anthropicTools,
      ...(system && { system }),
      messages: merged,
    }, {
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
        'content-type': 'application/json',
      },
    });

    const data = response.data;
    const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

    // Parse response content
    let text = '';
    const toolCalls = [];

    for (const block of (data.content || [])) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input
        });
      }
    }

    return {
      text: text.trim(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed,
      model: `${this.name}:${model}`,
      provider: this.name
    };
  }
}
