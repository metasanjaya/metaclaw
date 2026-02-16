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
  }

  async chat(messages, options = {}) {
    const model = options.model || this.config.defaultModel || 'claude-sonnet-4-20250514';
    const maxTokens = options.maxTokens || 8192;
    
    // Separate system message from conversation
    let systemPrompt = '';
    const conversationMessages = [];
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
      } else {
        conversationMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content
        });
      }
    }

    // Ensure messages alternate user/assistant (Anthropic requirement)
    const cleanMessages = this._ensureAlternating(conversationMessages);

    const requestBody = {
      model,
      max_tokens: maxTokens,
      messages: cleanMessages,
    };

    if (systemPrompt) {
      requestBody.system = systemPrompt;
    }

    if (options.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }

    try {
      const response = await axios.post(
        `${this.baseURL}/v1/messages`,
        requestBody,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01'
          },
          timeout: options.timeout || 120000
        }
      );

      const data = response.data;
      const text = data.content?.map(block => {
        if (block.type === 'text') return block.text;
        return '';
      }).join('') || '';

      const inputTokens = data.usage?.input_tokens || 0;
      const outputTokens = data.usage?.output_tokens || 0;

      return this.validateResponse({
        text,
        inputTokens,
        outputTokens,
        model: `${this.name}:${model}`,
        provider: this.name
      });
    } catch (err) {
      if (err.response) {
        const status = err.response.status;
        const errData = err.response.data;
        throw new Error(`Anthropic API error ${status}: ${JSON.stringify(errData)}`);
      }
      throw err;
    }
  }

  async chatWithTools(messages, tools, options = {}) {
    const model = options.model || this.config.defaultModel || 'claude-sonnet-4-20250514';
    const maxTokens = options.maxTokens || 8192;

    // Separate system message
    let systemPrompt = '';
    const conversationMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
      } else if (msg.role === 'tool') {
        // Anthropic uses tool_result blocks
        conversationMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content
          }]
        });
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        // Convert tool_calls to Anthropic format
        const content = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === 'string' 
              ? JSON.parse(tc.function.arguments) 
              : tc.function.arguments
          });
        }
        conversationMessages.push({ role: 'assistant', content });
      } else {
        conversationMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content
        });
      }
    }

    // Convert tools to Anthropic format (supports both MetaClaw and OpenAI formats)
    const anthropicTools = tools.map(t => {
      if (t.function) {
        // OpenAI format: { type, function: { name, description, parameters } }
        return { name: t.function.name, description: t.function.description, input_schema: t.function.parameters };
      }
      // MetaClaw format: { name, description, params }
      return {
        name: t.name,
        description: t.description,
        input_schema: { type: 'object', properties: t.params, required: Object.keys(t.params) },
      };
    });

    const cleanMessages = this._ensureAlternating(conversationMessages);

    const requestBody = {
      model,
      max_tokens: maxTokens,
      messages: cleanMessages,
      tools: anthropicTools,
    };

    if (systemPrompt) {
      requestBody.system = systemPrompt;
    }

    if (options.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }

    // Force tool use when requested (e.g. retry after unfulfilled promise)
    if (options.toolChoice) {
      requestBody.tool_choice = options.toolChoice;
    }

    try {
      const response = await axios.post(
        `${this.baseURL}/v1/messages`,
        requestBody,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01'
          },
          timeout: options.timeout || 120000
        }
      );

      const data = response.data;
      if (this.config?.debug) console.log(`  🔍 Anthropic raw response: stop_reason=${data.stop_reason}, content_blocks=${data.content?.length}, usage=${JSON.stringify(data.usage)}`);
      if (data.content) {
        for (const b of data.content) {
          console.log(`    📦 Block: type=${b.type}${b.type === 'tool_use' ? `, name=${b.name}` : ''}${b.type === 'text' ? `, text=${(b.text||'').substring(0,60)}` : ''}`);
        }
      }
      let text = '';
      const toolCalls = [];

      for (const block of (data.content || [])) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input)
            }
          });
        }
      }

      const inputTokens = data.usage?.input_tokens || 0;
      const outputTokens = data.usage?.output_tokens || 0;

      return this.validateResponse({
        text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        inputTokens,
        outputTokens,
        model: `${this.name}:${model}`,
        provider: this.name
      });
    } catch (err) {
      if (err.response) {
        const status = err.response.status;
        const errData = err.response.data;
        throw new Error(`Anthropic API error ${status}: ${JSON.stringify(errData)}`);
      }
      throw err;
    }
  }

  /**
   * Ensure messages alternate between user and assistant
   * Anthropic requires strict alternation
   */
  _ensureAlternating(messages) {
    if (messages.length === 0) return messages;
    
    const result = [];
    let lastRole = null;

    for (const msg of messages) {
      if (msg.role === lastRole) {
        // Merge with previous if same role
        if (typeof result[result.length - 1].content === 'string' && typeof msg.content === 'string') {
          result[result.length - 1].content += '\n\n' + msg.content;
        } else {
          // For complex content blocks, just add separator
          result.push({ role: msg.role === 'user' ? 'assistant' : 'user', content: '...' });
          result.push(msg);
        }
      } else {
        result.push(msg);
      }
      lastRole = msg.role;
    }

    // Must start with user
    if (result.length > 0 && result[0].role !== 'user') {
      result.unshift({ role: 'user', content: '...' });
    }

    return result;
  }
}
