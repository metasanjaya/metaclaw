/**
 * MiniMax Provider - Anthropic-compatible API for MiniMax M2.5
 * 
 * MiniMax provides an Anthropic-compatible API at https://api.minimax.io/anthropic
 * It works exactly like the Anthropic API but uses x-api-key header.
 */
import { AnthropicProvider } from './AnthropicProvider.js';

export class MiniMaxProvider extends AnthropicProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'minimax';
    this.apiKey = config.apiKey || process.env.MINIMAX_API_KEY;
    this.baseURL = config.baseURL || 'https://api.minimax.io/anthropic';
  }
}
