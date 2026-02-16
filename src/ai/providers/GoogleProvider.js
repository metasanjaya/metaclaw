/**
 * Google Gemini Provider - via generativelanguage.googleapis.com
 */
import axios from 'axios';
import { BaseProvider } from './BaseProvider.js';

export class GoogleProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'google';
    this.apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
    this.baseURL = config.baseURL || 'https://generativelanguage.googleapis.com/v1beta';
    this.defaultModel = config.defaultModel || 'gemini-2.5-flash';
  }

  convertMessages(messages) {
    return messages
      .filter(m => m.role !== 'system')
      .map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content || '' }]
      }));
  }

  async chat(messages, options = {}) {
    const model = options.model || this.defaultModel;
    const systemMsg = messages.find(m => m.role === 'system');
    const contents = this.convertMessages(messages);

    const requestBody = {
      contents,
      generationConfig: {
        maxOutputTokens: options.maxTokens || 8192,
        temperature: options.temperature ?? 0.7,
      }
    };

    if (systemMsg) {
      requestBody.systemInstruction = {
        parts: [{ text: systemMsg.content }]
      };
    }

    const response = await axios.post(
      `${this.baseURL}/models/${model}:generateContent?key=${this.apiKey}`,
      requestBody,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: options.timeout || 120000
      }
    );

    const data = response.data;
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map(p => p.text).join('') || '';

    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    const tokensUsed = data.usageMetadata?.totalTokenCount || inputTokens + outputTokens;

    return this._normalize(text, tokensUsed, model, inputTokens, outputTokens);
  }

  async chatWithTools(messages, tools, options = {}) {
    const model = options.model || this.defaultModel;
    const systemMsg = messages.find(m => m.role === 'system');

    // Convert messages, handling tool call/result history
    const contents = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue;
      if (msg.role === 'assistant' && msg.toolCalls) {
        contents.push({
          role: 'model',
          parts: msg.toolCalls.map(tc => ({
            functionCall: { name: tc.name, args: tc.input }
          }))
        });
      } else if (msg.role === 'tool' || (msg.role === 'user' && msg.toolResults)) {
        const results = msg.toolResults || [msg];
        contents.push({
          role: 'user',
          parts: results.map(tr => ({
            functionResponse: { name: tr.name || 'tool', response: { result: String(tr.result || tr.content) } }
          }))
        });
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content || '' }]
        });
      }
    }

    // Convert tools to Google format
    const googleTools = tools.length > 0 ? [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: t.params,
          required: Object.keys(t.params),
        }
      }))
    }] : undefined;

    const requestBody = {
      contents,
      generationConfig: {
        maxOutputTokens: options.maxTokens || 8192,
        temperature: options.temperature ?? 0.7,
      },
      ...(googleTools && { tools: googleTools }),
    };

    if (systemMsg) {
      requestBody.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    const response = await axios.post(
      `${this.baseURL}/models/${model}:generateContent?key=${this.apiKey}`,
      requestBody,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: options.timeout || 120000
      }
    );

    const data = response.data;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const text = parts.filter(p => p.text).map(p => p.text).join('') || '';
    const toolCalls = parts.filter(p => p.functionCall).map(p => ({
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: p.functionCall.name,
      input: p.functionCall.args || {},
    }));

    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    const tokensUsed = data.usageMetadata?.totalTokenCount || inputTokens + outputTokens;

    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed,
      inputTokens,
      outputTokens,
      model: `${this.name}:${model}`,
      provider: this.name,
    };
  }
}
