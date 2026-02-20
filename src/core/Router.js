import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

/**
 * AI model router — wraps existing UnifiedAIClient with instance-aware routing.
 */
export class Router {
  constructor({ eventBus, globalConfig = {} }) {
    this.eventBus = eventBus;
    this.globalConfig = globalConfig;
    /** @type {any} */
    this._client = null;
  }

  /**
   * Initialize the underlying AI client.
   * Tries to load config from metaclaw-main's config.yaml for provider keys.
   */
  async init() {
    try {
      const { UnifiedAIClient } = await import('../ai/UnifiedAIClient.js');

      // Load AI config from the metaclaw v2 config.yaml (has provider API keys)
      let aiConfig = {};
      const configPaths = [
        join(process.cwd(), 'config.yaml'),
        '/root/metaclaw-main/config.yaml',
        '/root/metaclaw/config.yaml',
      ];
      for (const p of configPaths) {
        if (existsSync(p)) {
          const raw = yaml.load(readFileSync(p, 'utf8')) || {};
          // v2 format: llm.remote.providers
          if (raw.llm?.remote) {
            aiConfig = { remote: raw.llm.remote };
            break;
          }
          // alt format: ai.remote
          if (raw.ai?.remote) {
            aiConfig = { remote: raw.ai.remote };
            break;
          }
          // top-level remote
          if (raw.remote) {
            aiConfig = { remote: raw.remote };
            break;
          }
        }
      }

      this._client = new UnifiedAIClient(aiConfig);
      console.log('[Router] AI client initialized');
    } catch (e) {
      console.error('[Router] Failed to init AI client:', e.message);
    }
  }

  /**
   * Send messages to AI.
   * @param {Object} opts
   * @param {string} opts.instanceId
   * @param {string} opts.model — model name (e.g., 'anthropic/claude-sonnet-4-6')
   * @param {Array<{role:string, content:string}>} opts.messages
   * @param {Object} [opts.options]
   * @returns {Promise<{text:string, usage?:Object}>}
   */
  async chat({ instanceId, model, messages, options = {} }) {
    if (!this._client) throw new Error('Router not initialized');

    const start = Date.now();

    try {
      // Detect provider from model name
      const modelName = model.includes('/') ? model.split('/').pop() : model;

      // Use provider.chat() directly for full multi-turn support
      const provider = this._resolveProvider(modelName);

      let response;
      if (provider) {
        response = await provider.chat(messages, {
          model: modelName,
          maxTokens: options.maxTokens || 4096,
          temperature: options.temperature || 0.7,
        });
      } else {
        // Fallback to generate() (single-turn)
        const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
        const lastMsg = messages.filter(m => m.role !== 'system').pop();
        response = await this._client.generate(lastMsg?.content || '', {
          model: modelName,
          systemPrompt,
          maxTokens: options.maxTokens || 4096,
          temperature: options.temperature || 0.7,
        });
      }

      const latency = Date.now() - start;
      this.eventBus.emit('ai.response', {
        instanceId, model, latency,
        tokens: response.usage || { inputTokens: 0, outputTokens: 0 },
      });

      return response;
    } catch (e) {
      this.eventBus.emit('ai.error', { instanceId, model, error: e.message });
      throw e;
    }
  }

  /**
   * Resolve provider from model name
   * @param {string} modelName
   * @returns {Object|null}
   */
  _resolveProvider(modelName) {
    if (!this._client?.providers) return null;
    const MODEL_PROVIDER_MAP = {
      'gpt-': 'openai', 'o1-': 'openai', 'o3-': 'openai',
      'claude-': 'anthropic',
      'gemini-': 'google',
      'grok-': 'grok',
      'deepseek-': 'deepseek',
      'glm-': 'zai',
      'MiniMax-': 'minimax',
      'kimi-': 'kimi',
    };
    for (const [prefix, providerName] of Object.entries(MODEL_PROVIDER_MAP)) {
      if (modelName.startsWith(prefix) || modelName.includes(prefix)) {
        return this._client.providers[providerName] || null;
      }
    }
    return null;
  }
}
