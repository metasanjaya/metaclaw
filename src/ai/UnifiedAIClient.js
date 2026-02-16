/**
 * UnifiedAIClient v2 - Multi-provider AI client with adapter pattern
 * 
 * Supports: OpenAI, Anthropic (Claude), Google (Gemini), Grok (xAI), DeepSeek
 * Plus local models via Ollama.
 * 
 * @module UnifiedAIClient
 */

import { Ollama } from 'ollama';
import {
  OpenAIProvider,
  AnthropicProvider,
  GoogleProvider,
  OpenAICompatibleProvider,
  MiniMaxProvider,
} from './providers/index.js';

// Auto-detect provider from model name
const MODEL_PROVIDER_MAP = {
  'gpt-': 'openai',
  'o1-': 'openai',
  'o3-': 'openai',
  'claude-': 'anthropic',
  'gemini-': 'google',
  'grok-': 'grok',
  'deepseek-': 'deepseek',
  'glm-': 'zai',
  'MiniMax-': 'minimax',
};

function detectProvider(model) {
  for (const [prefix, provider] of Object.entries(MODEL_PROVIDER_MAP)) {
    if (model.startsWith(prefix)) return provider;
  }
  return null;
}

export class UnifiedAIClient {
  /**
   * @param {object} config - Configuration object
   * @param {string} [config.provider] - Default provider: openai|anthropic|grok|google|deepseek
   * @param {string} [config.model] - Default model name
   * @param {string} [config.fallbackProvider] - Fallback provider
   * @param {string} [config.fallbackModel] - Fallback model
   * @param {object} [config.local] - Ollama config { provider, endpoint, models }
   * @param {object} [config.remote] - Legacy remote config
   * @param {string} [config.apiKey] - Legacy OpenAI API key
   */
  constructor(config = {}) {
    this.config = config;
    this.providers = {};
    this.localModel = null;

    this.systemPrompt = config.systemPrompt || `You are a helpful assistant. Be concise.
Only provide what's asked, no extra explanation unless requested.
If a simple answer suffices, give it without elaboration.`;

    this._initializeProviders();
  }

  /** @private */
  _initializeProviders() {
    // --- Local (Ollama) ---
    if (this.config.local?.provider === 'ollama') {
      this.localModel = new Ollama({ host: this.config.local.endpoint });
      console.log(`✅ Ollama initialized (${this.config.local.endpoint})`);
    }

    // --- Remote providers ---
    const remoteProviders = this.config.remote?.providers || {};

    // OpenAI
    const openaiKey = remoteProviders.openai?.api_key || this.config.apiKey || process.env.OPENAI_API_KEY;
    if (openaiKey) {
      this.providers.openai = new OpenAIProvider({ apiKey: openaiKey });
      console.log('✅ OpenAI initialized');
    }

    // Anthropic
    const anthropicKey = remoteProviders.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      this.providers.anthropic = new AnthropicProvider({ apiKey: anthropicKey });
      console.log('✅ Anthropic (Claude) initialized');
    }

    // Google Gemini
    const googleKey = remoteProviders.google?.api_key || process.env.GOOGLE_API_KEY;
    if (googleKey) {
      this.providers.google = new GoogleProvider({ apiKey: googleKey });
      console.log('✅ Google (Gemini) initialized');
    }

    // Grok (xAI) - OpenAI-compatible
    const grokKey = remoteProviders.grok?.api_key || process.env.GROK_API_KEY;
    if (grokKey) {
      this.providers.grok = new OpenAICompatibleProvider('grok', { apiKey: grokKey });
      console.log('✅ Grok (xAI) initialized');
    }

    // DeepSeek - OpenAI-compatible
    const deepseekKey = remoteProviders.deepseek?.api_key || process.env.DEEPSEEK_API_KEY;
    if (deepseekKey) {
      this.providers.deepseek = new OpenAICompatibleProvider('deepseek', { apiKey: deepseekKey });
      console.log('✅ DeepSeek initialized');
    }

    // Z.AI - OpenAI-compatible
    const zaiKey = remoteProviders.zai?.api_key || process.env.ZAI_API_KEY;
    if (zaiKey) {
      this.providers.zai = new OpenAICompatibleProvider('zai', { apiKey: zaiKey });
      console.log('✅ Z.AI initialized');
    }

    // MiniMax - Anthropic-compatible
    const minimaxKey = remoteProviders.minimax?.api_key || process.env.MINIMAX_API_KEY;
    if (minimaxKey) {
      this.providers.minimax = new MiniMaxProvider({
        apiKey: minimaxKey,
        baseURL: remoteProviders.minimax?.base_url || remoteProviders.minimax?.baseURL
      });
      console.log('✅ MiniMax initialized');
    }
  }

  /**
   * Get a provider instance by name, throw if unavailable
   * @private
   */
  _getProvider(name) {
    const p = this.providers[name];
    if (!p) throw new Error(`Provider "${name}" not configured. Check API key.`);
    return p;
  }

  /**
   * Resolve which provider + model to use
   * @private
   */
  _resolve(options = {}) {
    let provider = options.provider || this.config.provider || process.env.AI_PROVIDER || 'openai';
    let model = options.model || this.config.model || process.env.AI_MODEL || 'gpt-4';

    // Auto-detect provider from model name
    const detected = detectProvider(model);
    if (detected) provider = detected;

    return { provider, model };
  }

  /**
   * Build messages array from prompt + system prompt
   * @private
   */
  _buildMessages(prompt, systemPrompt) {
    const sys = systemPrompt || this.systemPrompt;
    return [
      { role: 'system', content: sys },
      { role: 'user', content: prompt },
    ];
  }

  /**
   * Generate a response using the configured (or specified) provider
   * 
   * @param {string} prompt - Input prompt
   * @param {object} options
   * @param {string} [options.provider] - Provider override
   * @param {string} [options.model] - Model override (auto-detects provider from model name)
   * @param {string} [options.prefer] - 'local' or 'remote'
   * @param {number} [options.maxTokens=1000]
   * @param {number} [options.temperature=0.7]
   * @param {object} [options.metadata] - Request metadata for model selection
   * @param {string} [options.systemPrompt] - Override system prompt
   * @returns {Promise<{ text: string, model: string, tokensUsed: number, provider: string }>}
   */
  async generate(prompt, options = {}) {
    const { maxTokens = 1000, temperature = 0.7, metadata = {} } = options;

    // Handle explicit local preference
    if (options.prefer === 'local' && this.localModel) {
      return await this._generateLocal(prompt, options);
    }

    // Handle legacy "provider:model" format
    if (options.model && options.model.includes(':')) {
      const [prov, modelName] = options.model.split(':');
      if (prov === 'local') return this._generateLocal(prompt, { ...options, model: modelName });
      return this._getProvider(prov).chat(
        this._buildMessages(prompt, options.systemPrompt),
        { model: modelName, maxTokens, temperature }
      ).then(r => ({ ...r, text: this._postProcess(r.text) }));
    }

    const { provider, model } = this._resolve(options);

    // Smart model selection based on metadata (legacy behavior)
    const finalModel = options.model || this._selectModel(metadata, model);

    try {
      const result = await this._getProvider(provider).chat(
        this._buildMessages(prompt, options.systemPrompt),
        { model: finalModel, maxTokens, temperature }
      );
      return { ...result, text: this._postProcess(result.text) };
    } catch (error) {
      // Try fallback
      const fbProvider = this.config.fallbackProvider || process.env.AI_FALLBACK_PROVIDER;
      const fbModel = this.config.fallbackModel || process.env.AI_FALLBACK_MODEL;
      if (fbProvider && this.providers[fbProvider]) {
        console.warn(`⚠️ ${provider} failed, falling back to ${fbProvider}: ${error.message}`);
        const result = await this._getProvider(fbProvider).chat(
          this._buildMessages(prompt, options.systemPrompt),
          { model: fbModel || finalModel, maxTokens, temperature }
        );
        return { ...result, text: this._postProcess(result.text) };
      }
      throw error;
    }
  }

  /**
   * Complete a structured context request (legacy AIClient interface)
   */
  async complete(context) {
    try {
      const metadata = context.metadata || {};
      const result = await this.generate(context.prompt, {
        maxTokens: this._getMaxTokens(metadata),
        temperature: 0.3,
        metadata,
      });
      return { response: result.text, tokensUsed: result.tokensUsed, model: result.model };
    } catch (error) {
      return { response: `AI Error: ${error.message}`, tokensUsed: 0 };
    }
  }

  /**
   * Chat with tools/function calling
   * 
   * @param {Array} messages - Conversation messages
   * @param {Array} tools - Tool definitions with { name, description, params }
   * @param {object} options - Chat options (model, maxTokens, temperature, etc)
   * @returns {Promise<{ text: string, toolCalls?: Array<{id: string, name: string, input: object}>, model: string, tokensUsed: number, provider: string }>}
   */
  async chatWithTools(messages, tools, options = {}) {
    const { maxTokens = 1000, temperature = 0.7 } = options;

    const { provider, model } = this._resolve(options);
    const finalModel = options.model || model;

    try {
      const p = this._getProvider(provider);
      
      // If provider doesn't support chatWithTools, use regular chat
      if (!p.chatWithTools || typeof p.chatWithTools !== 'function') {
        console.warn(`⚠️ Provider ${provider} doesn't support native tool calling, falling back to chat()`);
        return await p.chat(messages, { model: finalModel, maxTokens, temperature });
      }
      
      const result = await p.chatWithTools(
        messages, 
        tools,
        { model: finalModel, maxTokens, temperature, ...(options.reasoning && { reasoning: options.reasoning }), ...(options.toolChoice && { toolChoice: options.toolChoice }) }
      );
      
      // Post-process text but preserve tool calls
      return { ...result, text: this._postProcess(result.text) };
    } catch (error) {
      const fbProvider = this.config.fallbackProvider || process.env.AI_FALLBACK_PROVIDER;
      const fbModel = this.config.fallbackModel || process.env.AI_FALLBACK_MODEL;
      if (fbProvider && this.providers[fbProvider]) {
        console.warn(`⚠️ ${provider} failed, falling back to ${fbProvider}: ${error.message}`);
        const p = this._getProvider(fbProvider);
        
        // Check if fallback supports tools
        if (!p.chatWithTools || typeof p.chatWithTools !== 'function') {
          return await p.chat(messages, { model: fbModel, maxTokens, temperature });
        }
        
        const result = await p.chatWithTools(
          messages,
          tools,
          { model: fbModel, maxTokens, temperature }
        );
        return { ...result, text: this._postProcess(result.text) };
      }
      throw error;
    }
  }

  /** @private */
  async _generateLocal(prompt, options = {}) {
    if (!this.localModel) throw new Error('Local LLM not available');
    const { model = this.config.local?.models?.[0] || 'llama2', maxTokens = 1000, temperature = 0.7 } = options;
    const response = await this.localModel.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      options: { num_predict: maxTokens, temperature },
    });
    return {
      text: this._postProcess(response.message.content),
      model: `local:${model}`,
      tokensUsed: 0,
      provider: 'ollama',
    };
  }

  /** @private */
  _selectModel(metadata, defaultModel = 'gpt-4') {
    if (!metadata.intent) return defaultModel;
    if (metadata.intent === 'debug' || metadata.intent === 'explain') return defaultModel;
    return defaultModel;
  }

  /** @private */
  _getMaxTokens(metadata) {
    const limits = { general: 150, explain: 300, create: 500, debug: 300, analyze: 400 };
    return limits[metadata.intent] || 200;
  }

  /** @private */
  _postProcess(response) {
    const fillerPhrases = [
      /^(Sure|Certainly|Of course|I'd be happy to help)[,!.]\s*/i,
      /^Here's? (?:the|a|an|your)\s+/i,
      /\s*Let me know if you need (?:anything|help|more info).*$/i,
      /\s*(?:I hope|Hope) this helps.*$/i,
      /\s*Is there anything else.*$/i,
    ];
    let processed = response;
    fillerPhrases.forEach(p => { processed = processed.replace(p, ''); });
    return processed.trim();
  }

  /**
   * Get all available/configured providers and models
   */
  getAvailableModels() {
    const available = { local: this.config.local?.models || [], remote: {} };
    const remoteProviders = this.config.remote?.providers || {};
    for (const [name] of Object.entries(this.providers)) {
      available.remote[name] = remoteProviders[name]?.models || ['configured'];
    }
    return available;
  }

  /**
   * Get list of configured provider names
   */
  getConfiguredProviders() {
    return Object.keys(this.providers);
  }
}

// Backwards-compatible exports
export { UnifiedAIClient as AIClient };
export { UnifiedAIClient as ModelManager };
