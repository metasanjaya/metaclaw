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
}
