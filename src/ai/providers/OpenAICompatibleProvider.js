/**
 * OpenAI-Compatible Provider - For Grok (xAI), DeepSeek, and Z.AI
 */
import OpenAI from 'openai';
import { BaseProvider } from './BaseProvider.js';

const PROVIDER_CONFIGS = {
  grok: { baseURL: 'https://api.x.ai/v1', envKey: 'GROK_API_KEY', defaultModel: 'grok-2' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' },
  zai: { baseURL: 'https://api.z.ai/api/paas/v4', envKey: 'ZAI_API_KEY', defaultModel: 'glm-5' },
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
    const completion = await this.client.chat.completions.create({ model, messages, max_tokens: maxTokens, temperature });
    return this._normalize(completion.choices[0].message.content, completion.usage?.total_tokens || 0, model);
  }

  async chatWithTools(messages, tools, options = {}) {
    const { model = this.defaultModel, maxTokens = 1000, temperature = 0.7 } = options;

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
        return (msg.toolResults || [msg]).map(tr => ({ role: 'tool', tool_call_id: tr.id, content: String(tr.result || tr.content) }));
      }
      return msg;
    }).flat();

    const completion = await this.client.chat.completions.create({
      model, messages: openaiMessages, tools: openaiTools, tool_choice: 'auto', max_tokens: maxTokens, temperature,
    });

    const message = completion.choices[0].message;
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
