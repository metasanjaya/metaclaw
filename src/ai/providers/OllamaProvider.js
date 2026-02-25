/**
 * OllamaProvider - Connect to remote/local Ollama instance via OpenAI-compatible API
 * Supports reasoning extraction for DeepSeek-R1 and other thinking models
 */
import { BaseProvider } from './BaseProvider.js';

export class OllamaProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'ollama';
    this.defaultModel = config.defaultModel || 'deepseek-r1:70b';
    // Ollama OpenAI-compatible endpoint (no API key needed by default)
    this.temperature = config.temperature ?? 0.7;
    this.reasoning = config.reasoning ?? true; // Extract <think> blocks
    this.timeout = config.timeout || 120000; // 2 min default for large models
    this.debugLogger = config.debugLogger || null;
    
    // Parse baseURL to extract credentials (fetch doesn't allow credentials in URL)
    const rawUrl = config.baseURL || 'http://localhost:11434/v1';
    const url = new URL(rawUrl);
    this.baseURL = `${url.protocol}//${url.host}${url.pathname}`;
    
    // Extract credentials from URL or use provided apiKey
    if (url.username && url.password) {
      this.authHeader = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
    } else if (config.apiKey) {
      this.authHeader = `Bearer ${config.apiKey}`;
    } else {
      this.authHeader = 'Bearer ollama';
    }
    
    console.log(`[OllamaProvider] Initialized: ${this.baseURL}, model: ${this.defaultModel}, timeout: ${this.timeout}ms`);
  }

  setDebugLogger(logger) {
    this.debugLogger = logger;
  }

  _logRequest(model, body) {
    if (!this.debugLogger?.enabled) return Date.now();
    const timestamp = Date.now();
    const filename = `${timestamp}-${this.name}-${model}-request.json`;
    this.debugLogger._writeFile(filename, body);
    return timestamp;
  }

  _logResponse(timestamp, model, data, durationMs) {
    if (!this.debugLogger?.enabled) return;
    const filename = `${timestamp}-${this.name}-${model}-response.json`;
    const entry = {
      ...data,
      _meta: {
        receivedAt: new Date().toISOString(),
        durationMs,
      }
    };
    this.debugLogger._writeFile(filename, entry);
  }

  _logError(timestamp, model, error, durationMs) {
    if (!this.debugLogger?.enabled) return;
    const filename = `${timestamp}-${this.name}-${model}-error.json`;
    const entry = {
      error: error.message,
      code: error.code,
      status: error.status || error.response?.status,
      _meta: {
        receivedAt: new Date().toISOString(),
        durationMs,
      }
    };
    this.debugLogger._writeFile(filename, entry);
  }

  /**
   * Extract reasoning content from DeepSeek-R1 style <think> blocks
   * @param {string} text - Raw response text
   * @returns {{ text: string, reasoningContent?: string }}
   */
  _extractReasoning(text) {
    if (!text || !this.reasoning) return { text: text || '' };
    
    // DeepSeek-R1 format: <think>...</think>
    const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      const reasoningContent = thinkMatch[1].trim();
      const cleanedText = text.replace(/<think>[\s\S]*?<\/think>/, '').trim();
      return { text: cleanedText, reasoningContent };
    }
    
    // Alternative format: [Thinking...] or similar patterns
    const altMatch = text.match(/\[?(?:Thinking|Reasoning|Thought)[:\.]?\]?([\s\S]*?)(?:\n\n|\[?Output[:\.]?\]?)/i);
    if (altMatch) {
      return { 
        text: text.replace(/\[?(?:Thinking|Reasoning|Thought)[:\.]?\]?[\s\S]*?(?:\n\n|\[?Output[:\.]?\]?)/i, '').trim(),
        reasoningContent: altMatch[1].trim()
      };
    }
    
    return { text };
  }

  async chat(messages, options = {}) {
    const model = options.model || this.defaultModel;
    const maxTokens = options.maxTokens || 4000;
    const temperature = options.temperature ?? this.temperature;
    
    const startTime = Date.now();
    
    const body = {
      model,
      messages: messages.map(m => ({ 
        role: m.role, 
        content: m.content || m.text || '' 
      })),
      max_tokens: maxTokens,
      temperature,
      stream: false,
    };
    
    const reqTimestamp = this._logRequest(model, body);
    
    let res;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeout);
      
      res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
    } catch (fetchErr) {
      if (reqTimestamp) this._logError(reqTimestamp, model, fetchErr, Date.now() - startTime);
      throw new Error(`Ollama fetch failed: ${fetchErr.message} (${fetchErr.code || fetchErr.cause?.code || 'unknown'})`);
    }
    
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`Ollama API error: ${res.status} ${errText}`);
      if (reqTimestamp) this._logError(reqTimestamp, model, err, Date.now() - startTime);
      throw err;
    }
    
    const data = await res.json();
    if (reqTimestamp) this._logResponse(reqTimestamp, model, data, Date.now() - startTime);
    
    const rawContent = data.choices?.[0]?.message?.content || '';
    const { text, reasoningContent } = this._extractReasoning(rawContent);
    
    const result = {
      text,
      tokensUsed: data.usage?.total_tokens || 0,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      model: `${this.name}:${model}`,
      provider: this.name,
    };
    
    if (reasoningContent) {
      result.reasoningContent = reasoningContent;
    }
    
    return this.validateResponse(result);
  }

  async chatWithTools(messages, tools, options = {}) {
    const model = options.model || this.defaultModel;
    const maxTokens = options.maxTokens || 4000;
    const temperature = options.temperature ?? this.temperature;
    
    const startTime = Date.now();
    
    // Convert messages to OpenAI format
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
      return { role: msg.role, content: msg.content || msg.text || '' };
    });
    
    // Convert tools to OpenAI format
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
      stream: false,
    };
    
    const reqTimestamp = this._logRequest(model, body);
    
    let res;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeout);
      
      res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
    } catch (fetchErr) {
      if (reqTimestamp) this._logError(reqTimestamp, model, fetchErr, Date.now() - startTime);
      throw new Error(`Ollama fetch failed: ${fetchErr.message} (${fetchErr.code || fetchErr.cause?.code || 'unknown'})`);
    }
    
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`Ollama API error: ${res.status} ${errText}`);
      if (reqTimestamp) this._logError(reqTimestamp, model, err, Date.now() - startTime);
      throw err;
    }
    
    const data = await res.json();
    if (reqTimestamp) this._logResponse(reqTimestamp, model, data, Date.now() - startTime);
    
    const msg = data.choices?.[0]?.message;
    const rawContent = msg?.content || '';
    
    // Parse tool calls
    const toolCalls = msg?.tool_calls?.map(tc => {
      let input;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch (e) {
        // Fix malformed JSON
        let fixed = tc.function.arguments;
        if ((fixed.match(/"/g) || []).length % 2 !== 0) fixed += '"';
        const openBraces = (fixed.match(/{/g) || []).length - (fixed.match(/}/g) || []).length;
        const openBrackets = (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
        for (let i = 0; i < openBrackets; i++) fixed += ']';
        for (let i = 0; i < openBraces; i++) fixed += '}';
        try { input = JSON.parse(fixed); } catch { input = { raw: tc.function.arguments }; }
      }
      return { id: tc.id, name: tc.function.name, input };
    }) || [];
    
    // Extract reasoning from content (if any non-tool text)
    const { text, reasoningContent } = this._extractReasoning(rawContent);
    
    const result = {
      text: text || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: data.usage?.total_tokens || 0,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      model: `${this.name}:${model}`,
      provider: this.name,
    };
    
    if (reasoningContent) {
      result.reasoningContent = reasoningContent;
    }
    
    return this.validateResponse(result);
  }
}
