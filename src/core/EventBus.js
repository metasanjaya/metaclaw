import { EventEmitter } from 'node:events';

/**
 * Internal pub/sub event system for MetaClaw modules.
 * 
 * Events:
 * - message.in          — inbound message from any channel
 * - message.out         — outbound message to channel
 * - channel.connect     — channel connected
 * - channel.disconnect  — channel disconnected
 * - channel.error       — channel error
 * - instance.spawn      — instance started
 * - instance.stop       — instance stopped
 * - instance.crash      — instance crashed
 * - skill.execute       — skill invoked
 * - skill.result        — skill execution result
 * - health.check        — health check triggered
 * - health.incident     — health incident detected
 * - config.reload       — config hot-reloaded
 */
export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    /** @type {Map<string, number>} */
    this._eventCounts = new Map();
  }

  /**
   * Emit with tracking
   * @param {string} event
   * @param  {...any} args
   */
  emit(event, ...args) {
    this._eventCounts.set(event, (this._eventCounts.get(event) || 0) + 1);
    return super.emit(event, ...args);
  }

  /**
   * Get event statistics
   * @returns {Record<string, number>}
   */
  stats() {
    return Object.fromEntries(this._eventCounts);
  }

  /**
   * Subscribe to event once with timeout
   * @param {string} event
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  waitFor(event, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener(event, handler);
        reject(new Error(`Timeout waiting for event: ${event}`));
      }, timeoutMs);

      const handler = (...args) => {
        clearTimeout(timer);
        resolve(args.length === 1 ? args[0] : args);
      };

      this.once(event, handler);
    });
  }
}
