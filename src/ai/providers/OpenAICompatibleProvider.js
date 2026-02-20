/**
 * OpenAI-Compatible Provider - For Grok (xAI), DeepSeek, and Z.AI
 */
import OpenAI from 'openai';
import { BaseProvider } from './BaseProvider.js';

const PROVIDER_CONFIGS = {
  grok: { baseURL: 'https://api.x.ai/v1', envKey: 'GROK_API_KEY', defaultModel: 'grok-2' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' },
  zai: { baseURL: 'https://api.z.ai/api/paas/v4', envKey: 'ZAI_API_KEY', defaultModel: 'glm-5' },
  kimi: { baseURL: 'https://api.moonshot.ai/v1', envKey: 'KIMI_API_KEY', defaultModel: 'kimi-k2.5' },
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
    let { model = this.defaultModel, maxTokens = 1000, temperature = 0.7 } = options;
    if (this.name === 'kimi') temperature = 1;
    const completion = await this.client.chat.completions.create({ model, messages, max_tokens: maxTokens, temperature });
    return this._normalize(completion.choices[0].message.content, completion.usage?.total_tokens || 0, model);
  }

  async chatWithTools(messages, tools, options = {}) {
    let { model = this.defaultModel, maxTokens = 1000, temperature = 0.7, toolChoice } = options;
    if (this.name === 'kimi') temperature = 1;

    // Map toolChoice from internal format to OpenAI format
    // Kimi: tool_choice 'required' is incompatible with thinking — fall back to 'auto'
    let openaiToolChoice = 'auto';
    if (toolChoice && !(this.name === 'kimi' && toolChoice.type === 'any')) {
      if (toolChoice.type === 'any') openaiToolChoice = 'required';
      else if (toolChoice.type === 'none') openaiToolChoice = 'none';
      else if (toolChoice.type === 'tool' && toolChoice.name) openaiToolChoice = { type: 'function', function: { name: toolChoice.name } };
      else openaiToolChoice = 'auto';
    }

    const openaiTools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.params, required: Object.keys(t.params) } }
    }));

    const openaiMessages = messages.map(msg => {
      if (msg.role === 'assistant' && msg.toolCalls) {
        const assistantMsg = {
          role: 'assistant', content: msg.text || null,
          tool_calls: msg.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } }))
        };
        // Kimi requires reasoning_content in assistant tool call messages when thinking is enabled
        if (msg.reasoningContent) assistantMsg.reasoning_content = msg.reasoningContent;
        return assistantMsg;
      } else if (msg.role === 'tool' || (msg.role === 'user' && msg.toolResults)) {
        return (msg.toolResults || [msg]).map(tr => ({ role: 'tool', tool_call_id: tr.id, content: String(tr.result || tr.content) }));
      }
      return msg;
    }).flat();

    const createOpts = { model, messages: openaiMessages, tools: openaiTools, tool_choice: openaiToolChoice, max_tokens: maxTokens, temperature };
    // Kimi: ALL assistant messages need reasoning_content when thinking is enabled (avoid 400 error)
    if (this.name === 'kimi') {
      for (const msg of openaiMessages) {
        if (msg.role === 'assistant' && !msg.reasoning_content) {
          msg.reasoning_content = '';
        }
      }
    }
    const completion = await this.client.chat.completions.create(createOpts);

    const message = completion.choices[0].message;
    const toolCalls = message.tool_calls?.map(tc => {
      let input;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch (e) {
        // Truncated JSON from maxTokens — try to repair
        let fixed = tc.function.arguments;
        // Close any open strings and objects/arrays
        const openBraces = (fixed.match(/{/g) || []).length - (fixed.match(/}/g) || []).length;
        const openBrackets = (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
        // If we're inside a string value, close it
        if ((fixed.match(/"/g) || []).length % 2 !== 0) fixed += '"';
        for (let i = 0; i < openBrackets; i++) fixed += ']';
        for (let i = 0; i < openBraces; i++) fixed += '}';
        try { input = JSON.parse(fixed); } catch { input = { raw: tc.function.arguments }; }
        console.warn(`  ⚠️ Repaired truncated JSON for tool ${tc.function.name}`);
      }
      return { id: tc.id, name: tc.function.name, input };
    });

    const result = {
      text: message.content || '', toolCalls,
      tokensUsed: completion.usage?.total_tokens || 0,
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      model: `${this.name}:${model}`, provider: this.name,
    };
    // Preserve reasoning_content for Kimi thinking mode
    if (message.reasoning_content) result.reasoningContent = message.reasoning_content;
    return result;
  }
}
