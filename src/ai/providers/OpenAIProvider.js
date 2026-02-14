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

  async chatWithTools(messages, tools, options = {}) {
    const { model = 'gpt-4', maxTokens = 1000, temperature = 0.7 } = options;

    // Convert tools to OpenAI format
    const openaiTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: t.params,
          required: Object.keys(t.params)
        }
      }
    }));

    // Convert messages with tool calls/results
    const openaiMessages = messages.map(msg => {
      if (msg.role === 'assistant' && msg.toolCalls) {
        return {
          role: 'assistant',
          content: msg.text || null,
          tool_calls: msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input)
            }
          }))
        };
      } else if (msg.role === 'tool' || (msg.role === 'user' && msg.toolResults)) {
        // Convert tool results to individual tool messages
        const toolMessages = [];
        const results = msg.toolResults || [msg];
        for (const tr of results) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: tr.id,
            content: String(tr.result || tr.content)
          });
        }
        return toolMessages;
      }
      return msg;
    }).flat();

    const completion = await this.client.chat.completions.create({
      model,
      messages: openaiMessages,
      tools: openaiTools,
      tool_choice: 'auto',
      max_tokens: maxTokens,
      temperature,
    });

    const choice = completion.choices[0];
    const message = choice.message;

    // Parse tool calls
    const toolCalls = message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments)
    }));

    return {
      text: message.content || '',
      toolCalls,
      tokensUsed: completion.usage?.total_tokens || 0,
      model: `${this.name}:${model}`,
      provider: this.name
    };
  }
}
