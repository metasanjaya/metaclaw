/**
 * DebugLogger - Per-instance API logging to timestamped JSON files
 * Logs to <instanceDir>/logs/YYYY-MM-DD/
 * Files: <timestamp>-request.json, <timestamp>-response.json
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class DebugLogger {
  /**
   * @param {string} instanceDir - Instance data directory
   * @param {boolean} enabled - Whether logging is enabled
   */
  constructor(instanceDir, enabled = false) {
    this.enabled = enabled;
    if (enabled) {
      this.baseLogDir = join(instanceDir, 'logs');
      this.pendingRequests = new Map(); // Track request start times
      // Ensure base log directory exists
      if (!existsSync(this.baseLogDir)) {
        mkdirSync(this.baseLogDir, { recursive: true });
      }
    }
  }

  _getLogDir() {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const logDir = join(this.baseLogDir, date);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    return logDir;
  }

  _getTimestamp() {
    return Date.now(); // Unix timestamp in ms
  }

  _writeFile(filename, data) {
    try {
      const logDir = this._getLogDir();
      const filepath = join(logDir, filename);
      console.log(`[DebugLogger] Writing to ${filepath}`);
      writeFileSync(filepath, JSON.stringify(data, null, 2));
      console.log(`[DebugLogger] Successfully wrote ${filename}`);
    } catch (e) {
      console.error(`[DebugLogger] Failed to write ${filename}: ${e.message}`);
    }
  }

  /**
   * Log API request
   * @param {string} provider - Provider name
   * @param {string} model - Model name
   * @param {Array} messages - Messages sent
   * @param {Object} options - Request options
   * @returns {number} requestId - Timestamp used for request file
   */
  logRequest(provider, model, messages, options = {}) {
    console.log(`[DebugLogger] logRequest called: enabled=${this.enabled}, provider=${provider}, model=${model}`);
    if (!this.enabled) return null;
    const requestId = this._getTimestamp();
    const entry = {
      timestamp: new Date().toISOString(),
      unixTime: requestId,
      provider,
      model,
      messageCount: messages.length,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content || m.text || null,
        hasToolCalls: !!(m.tool_calls || m.toolCalls),
        toolCalls: m.tool_calls || m.toolCalls || null,
      })),
      options: {
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        toolCount: options.tools?.length,
        hasTools: !!(options.tools && options.tools.length > 0),
        tools: options.tools || null,
      },
    };
    this.pendingRequests.set(`${provider}:${model}`, requestId);
    this._writeFile(`${requestId}-request.json`, entry);
    return requestId;
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
    // Try to match with request, otherwise use current timestamp
    const key = `${provider}:${model}`;
    const requestId = this.pendingRequests.get(key) || this._getTimestamp();
    this.pendingRequests.delete(key);
    
    const entry = {
      timestamp: new Date().toISOString(),
      unixTime: this._getTimestamp(),
      requestId,
      provider,
      model,
      durationMs,
      response: {
        text: response.text || null,
        hasToolCalls: !!(response.toolCalls && response.toolCalls.length > 0),
        toolCallCount: response.toolCalls?.length || 0,
        toolCalls: response.toolCalls?.map(tc => ({
          name: tc.name,
          id: tc.id,
          input: tc.input,
        })) || null,
        reasoningContent: response.reasoningContent || null,
      },
    };
    this._writeFile(`${requestId}-response.json`, entry);
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
    const key = `${provider}:${model}`;
    const requestId = this.pendingRequests.get(key) || this._getTimestamp();
    this.pendingRequests.delete(key);
    
    const entry = {
      timestamp: new Date().toISOString(),
      unixTime: this._getTimestamp(),
      requestId,
      provider,
      model,
      durationMs,
      error: {
        message: error.message,
        code: error.code,
        status: error.status,
        stack: error.stack,
      },
    };
    this._writeFile(`${requestId}-error.json`, entry);
  }
}
