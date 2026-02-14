/**
 * Google Gemini Provider - via generativelanguage.googleapis.com
 * 
 * Google uses a completely different API format:
 * - Uses contents/parts structure instead of messages
 * - System instruction is a separate field
 * - Different response format
 */
import axios from 'axios';
import { BaseProvider } from './BaseProvider.js';

export class GoogleProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'google';
    this.apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
    this.baseURL = config.baseURL || 'https://generativelanguage.googleapis.com/v1beta';
  }

  async chat(messages, options = {}) {
    const { model = 'gemini-2.5-flash', maxTokens = 1000, temperature = 0.7 } = options;

    // Convert OpenAI-style messages to Gemini format
    let systemInstruction = undefined;
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = {
          parts: [{ text: msg.content }],
        };
      } else {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        contents.push({
          role,
          parts: [{ text: msg.content }],
        });
      }
    }

    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
      },
      ...(systemInstruction && { systemInstruction }),
    };

    const url = `${this.baseURL}/models/${model}:generateContent?key=${this.apiKey}`;
    const response = await axios.post(url, body, {
      headers: { 'content-type': 'application/json' },
    });

    const data = response.data;
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('Google: No response candidate returned');

    const text = candidate.content?.parts?.map(p => p.text).join('') || '';
    const tokensUsed = (data.usageMetadata?.promptTokenCount || 0) +
                       (data.usageMetadata?.candidatesTokenCount || 0);

    return this._normalize(text, tokensUsed, model);
  }

  async chatWithTools(messages, tools, options = {}) {
    const { model = 'gemini-2.5-flash', maxTokens = 1000, temperature = 0.7 } = options;

    // Convert tools to Gemini format
    const geminiFunctionDeclarations = tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: t.params,
        required: Object.keys(t.params)
      }
    }));

    // Convert OpenAI-style messages to Gemini format
    let systemInstruction = undefined;
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = {
          parts: [{ text: msg.content }],
        };
      } else if (msg.role === 'assistant' && msg.toolCalls) {
        // Convert assistant message with tool calls
        const parts = [];
        if (msg.text) {
          parts.push({ text: msg.text });
        }
        for (const tc of msg.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.name,
              args: tc.input
            }
          });
        }
        contents.push({ role: 'model', parts });
      } else if (msg.role === 'user' && msg.toolResults) {
        // Convert tool results message
        const parts = msg.toolResults.map(tr => ({
          functionResponse: {
            name: tr.name,
            response: { result: tr.result }
          }
        }));
        contents.push({ role: 'user', parts });
      } else {
        // Regular text message
        const role = msg.role === 'assistant' ? 'model' : 'user';
        contents.push({
          role,
          parts: [{ text: msg.content }],
        });
      }
    }

    const body = {
      contents,
      tools: [{
        functionDeclarations: geminiFunctionDeclarations
      }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
      },
      ...(systemInstruction && { systemInstruction }),
    };

    const url = `${this.baseURL}/models/${model}:generateContent?key=${this.apiKey}`;
    const response = await axios.post(url, body, {
      headers: { 'content-type': 'application/json' },
    });

    const data = response.data;
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('Google: No response candidate returned');

    // Parse response parts
    let text = '';
    const toolCalls = [];
    let toolCallIdCounter = 0;

    for (const part of candidate.content?.parts || []) {
      if (part.text) {
        text += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `call_${++toolCallIdCounter}`,
          name: part.functionCall.name,
          input: part.functionCall.args
        });
      }
    }

    const tokensUsed = (data.usageMetadata?.promptTokenCount || 0) +
                       (data.usageMetadata?.candidatesTokenCount || 0);

    return {
      text: text.trim(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed,
      model: `${this.name}:${model}`,
      provider: this.name
    };
  }
}
