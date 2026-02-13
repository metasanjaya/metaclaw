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
   * Normalize response to unified format
   * @returns {{ text: string, tokensUsed: number, model: string, provider: string }}
   */
  _normalize(text, tokensUsed, model) {
    return { text, tokensUsed, model: `${this.name}:${model}`, provider: this.name };
  }
}
