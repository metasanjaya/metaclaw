/**
 * BaseProvider - Abstract base class for AI provider adapters
 */
export class BaseProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = 'base';
  }

  async chat(messages, options = {}) {
    throw new Error(`${this.name}: chat() not implemented`);
  }

  /**
   * Chat with tools/function calling support
   * @param {Array} messages - Conversation messages
   * @param {Array} tools - Tool definitions
   * @param {object} options - Chat options (model, maxTokens, temperature, etc)
   * @returns {Promise<{ text: string, toolCalls?: Array<{id: string, name: string, input: object}>, tokensUsed: number, model: string, provider: string }>}
   */
  async chatWithTools(messages, tools, options = {}) {
    // Default implementation: call regular chat (backward compatibility)
    // Providers that support native function calling should override this
    return await this.chat(messages, options);
  }

  /**
   * Normalize response to unified format
   * @returns {{ text: string, tokensUsed: number, model: string, provider: string }}
   */
  _normalize(text, tokensUsed, model) {
    return { text, tokensUsed, model: `${this.name}:${model}`, provider: this.name };
  }
}
