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
    console.log(`[KimiProvider] Base URL: ${this.baseURL}`);
    this.temperature = config.temperature ?? 0.6;
    this.reasoning = config.reasoning ?? false;
    this.debugLogger = config.debugLogger || null;
    console.log(`[KimiProvider] Initialized with key: ${this.apiKey ? this.apiKey.slice(0, 10) + '...' + this.apiKey.slice(-4) : 'MISSING'}`);
  }

  /**
   * Set debug logger for API request/response logging
   * @param {import('../../instances/DebugLogger.js').DebugLogger} logger
   */
  setDebugLogger(logger) {
    this.debugLogger = logger;
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

    // Debug logging
    const startTime = Date.now();
    this.debugLogger?.logRequest(this.name, model, messages, options);

    let res;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
      res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch (fetchErr) {
      this.debugLogger?.logError(this.name, model, fetchErr, Date.now() - startTime);
      throw new Error(`Kimi fetch failed: ${fetchErr.message} (${fetchErr.code || fetchErr.cause?.code || 'unknown'})`);
    }

    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`Kimi API error: ${res.status} ${errText}`);
      this.debugLogger?.logError(this.name, model, err, Date.now() - startTime);
      throw err;
    }

    const data = await res.json();
    const response = {
      text: data.choices?.[0]?.message?.content || '',
      reasoningContent: data.choices?.[0]?.message?.reasoning_content,
    };
    this.debugLogger?.logResponse(this.name, model, response, Date.now() - startTime);
    return response;
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

    // Debug logging
    const startTime = Date.now();
    const optsWithTools = { ...options, tools };
    this.debugLogger?.logRequest(this.name, model, messages, optsWithTools);

    let res;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
      res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch (fetchErr) {
      this.debugLogger?.logError(this.name, model, fetchErr, Date.now() - startTime);
      throw new Error(`Kimi fetch failed: ${fetchErr.message} (${fetchErr.code || fetchErr.cause?.code || 'unknown'})`);
    }

    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`Kimi API error: ${res.status} ${errText}`);
      this.debugLogger?.logError(this.name, model, err, Date.now() - startTime);
      throw err;
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message;

    const response = {
      text: msg?.content || '',
      toolCalls: msg?.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      })) || [],
      reasoningContent: msg?.reasoning_content,
    };
    this.debugLogger?.logResponse(this.name, model, response, Date.now() - startTime);
    return response;
  }
}
