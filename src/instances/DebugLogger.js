/**
 * DebugLogger - Simple file logger for instance debugging
 * Logs to <instanceDir>/logs/debug.log
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class DebugLogger {
  /**
   * @param {string} instanceDir - Instance data directory
   * @param {boolean} enabled - Whether logging is enabled
   */
  constructor(instanceDir, enabled = false) {
    this.enabled = enabled;
    if (enabled) {
      this.logDir = join(instanceDir, 'logs');
      this.logFile = join(this.logDir, 'debug.log');
      // Ensure log directory exists
      if (!existsSync(this.logDir)) {
        mkdirSync(this.logDir, { recursive: true });
      }
    }
  }

  /**
   * Log API request
   * @param {string} provider - Provider name
   * @param {string} model - Model name
   * @param {Array} messages - Messages sent
   * @param {Object} options - Request options
   */
  logRequest(provider, model, messages, options = {}) {
    if (!this.enabled) return;
    const entry = {
      timestamp: new Date().toISOString(),
      type: 'REQUEST',
      provider,
      model,
      messageCount: messages.length,
      messages: messages.map(m => ({
        role: m.role,
        content: this._truncate(m.content || m.text, 500),
        hasToolCalls: !!(m.tool_calls || m.toolCalls),
        toolCallCount: (m.tool_calls || m.toolCalls)?.length,
      })),
      options: {
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        toolCount: options.tools?.length,
      },
    };
    this._write(entry);
  }

  /**
   * Log API response
   * @param {string} provider - Provider name
   * @param {string} model - Model name
   * @param {Object} response - Response object
   * @param {number} durationMs - Request duration
   */
  logResponse(provider, model, response, durationMs) {
    if (!this.enabled) return;
    const entry = {
      timestamp: new Date().toISOString(),
      type: 'RESPONSE',
      provider,
      model,
      durationMs,
      text: this._truncate(response.text, 1000),
      hasToolCalls: !!(response.toolCalls && response.toolCalls.length > 0),
      toolCallCount: response.toolCalls?.length,
      toolCalls: response.toolCalls?.map(tc => ({
        name: tc.name,
        id: tc.id,
      })),
      reasoningContent: this._truncate(response.reasoningContent, 500),
    };
    this._write(entry);
  }

  /**
   * Log API error
   * @param {string} provider - Provider name
   * @param {string} model - Model name
   * @param {Error} error - Error object
   * @param {number} durationMs - Request duration
   */
  logError(provider, model, error, durationMs) {
    if (!this.enabled) return;
    const entry = {
      timestamp: new Date().toISOString(),
      type: 'ERROR',
      provider,
      model,
      durationMs,
      error: error.message,
      stack: error.stack,
    };
    this._write(entry);
  }

  _write(entry) {
    try {
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.logFile, line);
    } catch (e) {
      // Silent fail - don't break app if logging fails
      console.error(`[DebugLogger] Failed to write: ${e.message}`);
    }
  }

  _truncate(str, maxLen) {
    if (!str) return str;
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen) + '... [truncated]';
  }
}
