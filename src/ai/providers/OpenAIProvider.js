/**
 * OpenAI Provider - GPT models via api.openai.com
 * Supports both Chat Completions API and Responses API (for codex models)
 */
import OpenAI from 'openai';
import axios from 'axios';
import { BaseProvider } from './BaseProvider.js';

// Models that require the Responses API instead of Chat Completions
const RESPONSES_API_MODELS = [
  'gpt-5.2-codex', 'gpt-5.1-codex', 'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini', 'codex-mini-latest', 'codex-mini',
  'o3-pro', 'o4-mini',
];

function isResponsesModel(model) {
  return RESPONSES_API_MODELS.some(m => model.includes(m)) || model.includes('codex');
}

export class OpenAIProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'openai';
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    this.baseURL = config.baseURL || 'https://api.openai.com';
    this.client = new OpenAI({
      apiKey: this.apiKey,
      ...(config.baseURL && { baseURL: config.baseURL }),
    });
  }

  // ─── Responses API (codex models) ───

  async _responsesChat(messages, options = {}) {
    const { model = 'gpt-5.2-codex', maxTokens = 16384, reasoning } = options;

    const input = messages.map(msg => ({
      role: msg.role === 'system' ? 'developer' : msg.role,
      content: msg.content || '',
    }));

    const body = {
      model, input, max_output_tokens: maxTokens,
      ...(reasoning && { reasoning: { effort: reasoning } }),
    };

    const response = await axios.post(`${this.baseURL}/v1/responses`, body, {
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 120000,
    });

    const data = response.data;
    const outputText = (data.output || [])
      .filter(item => item.type === 'message')
      .flatMap(item => (item.content || []).map(c => c.text || ''))
      .join('') || data.output_text || '';

    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    return this._normalize(outputText, inputTokens + outputTokens, model, inputTokens, outputTokens);
  }

  async _responsesChatWithTools(messages, tools, options = {}) {
    const { model = 'gpt-5.2-codex', maxTokens = 16384, reasoning } = options;

    const input = [];
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          input.push({ type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.input) });
        }
      } else if (msg.role === 'tool' || (msg.role === 'user' && msg.toolResults)) {
        const results = msg.toolResults || [msg];
        for (const tr of results) {
          input.push({ type: 'function_call_output', call_id: tr.id, output: String(tr.result || tr.content) });
        }
      } else {
        input.push({ role: msg.role === 'system' ? 'developer' : msg.role, content: msg.content || '' });
      }
    }

    const responsesTools = tools.map(t => ({
      type: 'function', name: t.name, description: t.description,
      parameters: { type: 'object', properties: t.params, required: Object.keys(t.params) },
    }));

    const body = {
      model, input, max_output_tokens: maxTokens,
      ...(responsesTools.length > 0 && { tools: responsesTools }),
      ...(reasoning && { reasoning: { effort: reasoning } }),
    };

    const response = await axios.post(`${this.baseURL}/v1/responses`, body, {
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 120000,
    });

    const data = response.data;
    const outputItems = data.output || [];
    console.log(`  🔍 Responses API output: ${outputItems.length} items, types: [${outputItems.map(i => i.type).join(', ')}]`);

    const outputText = outputItems
      .filter(item => item.type === 'message')
      .flatMap(item => (item.content || []).map(c => c.text || ''))
      .join('') || data.output_text || '';

    const toolCalls = outputItems
      .filter(item => item.type === 'function_call')
      .map(item => ({
        id: item.call_id || item.id,
        name: item.name,
        input: typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments,
      }));

    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;

    return {
      text: outputText, toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: inputTokens + outputTokens, inputTokens, outputTokens,
      model: `${this.name}:${model}`, provider: this.name,
    };
  }

  // ─── Chat Completions API (standard models) ───

  async chat(messages, options = {}) {
    const { model = 'gpt-4', maxTokens = 1000, temperature = 0.7 } = options;

    if (isResponsesModel(model)) return this._responsesChat(messages, options);

    const tokenParam = model.startsWith('gpt-5') || model.startsWith('o4')
      ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };

    const completion = await this.client.chat.completions.create({
      model, messages, ...tokenParam, temperature,
    });

    const inputTokens = completion.usage?.prompt_tokens || 0;
    const outputTokens = completion.usage?.completion_tokens || 0;
    return this._normalize(completion.choices[0].message.content, completion.usage?.total_tokens || 0, model, inputTokens, outputTokens);
  }

  async chatWithTools(messages, tools, options = {}) {
    const { model = 'gpt-4', maxTokens = 1000, temperature = 0.7 } = options;

    if (isResponsesModel(model)) return this._responsesChatWithTools(messages, tools, options);

    const openaiTools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.params, required: Object.keys(t.params) } }
    }));

    const openaiMessages = messages.map(msg => {
      if (msg.role === 'assistant' && msg.toolCalls) {
        return {
          role: 'assistant', content: msg.text || null,
          tool_calls: msg.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } }))
        };
      } else if (msg.role === 'tool' || (msg.role === 'user' && msg.toolResults)) {
        const results = msg.toolResults || [msg];
        return results.map(tr => ({ role: 'tool', tool_call_id: tr.id, content: String(tr.result || tr.content) }));
      }
      return msg;
    }).flat();

    const tokenParam = model.startsWith('gpt-5') || model.startsWith('o4')
      ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };

    const completion = await this.client.chat.completions.create({
      model, messages: openaiMessages, tools: openaiTools, tool_choice: 'auto', ...tokenParam, temperature,
    });

    const choice = completion.choices[0];
    const message = choice.message;
    const toolCalls = message.tool_calls?.map(tc => ({ id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) }));

    return {
      text: message.content || '', toolCalls,
      tokensUsed: completion.usage?.total_tokens || 0,
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      model: `${this.name}:${model}`, provider: this.name,
    };
  }
}
