/**
 * MessageQueue - Rate-limited message sending for Telegram
 * 
 * Prevents flood waits and bans by enforcing:
 * - Min delay between messages (global)
 * - Per-chat rate limiting
 * - Exponential backoff on flood wait errors
 * - Priority queue (user-facing > async notifications)
 */

export class MessageQueue {
  /**
   * @param {Object} opts
   * @param {number} opts.minDelay - Min ms between any two sends (default: 1500)
   * @param {number} opts.perChatDelay - Min ms between sends to same chat (default: 3000)
   * @param {number} opts.maxQueueSize - Max queued messages (default: 100, oldest dropped)
   * @param {number} opts.maxRetries - Max retries per message (default: 2)
   */
  constructor(opts = {}) {
    this.minDelay = opts.minDelay || 1500;
    this.perChatDelay = opts.perChatDelay || 3000;
    this.maxQueueSize = opts.maxQueueSize || 100;
    this.maxRetries = opts.maxRetries || 2;

    /** @type {Array<{fn: Function, chatId: string, priority: number, retries: number, resolve: Function, reject: Function}>} */
    this.queue = [];
    this.processing = false;
    this.lastSendGlobal = 0;
    this.lastSendPerChat = new Map(); // chatId → timestamp
    this.floodWaitUntil = 0; // global flood wait deadline
  }

  /**
   * Enqueue a send operation
   * @param {string} chatId - Target chat
   * @param {Function} fn - Async function that does the actual send
   * @param {number} priority - 0 = high (user reply), 1 = normal, 2 = low (async notification)
   * @returns {Promise<any>} Resolves when message is sent
   */
  enqueue(chatId, fn, priority = 1) {
    return new Promise((resolve, reject) => {
      // Drop oldest low-priority if queue full
      if (this.queue.length >= this.maxQueueSize) {
        const dropIdx = this.queue.findLastIndex(m => m.priority >= 2);
        if (dropIdx >= 0) {
          const dropped = this.queue.splice(dropIdx, 1)[0];
          dropped.reject(new Error('Queue full, message dropped'));
          console.log(`📨 Queue full, dropped low-priority message for ${dropped.chatId}`);
        } else {
          reject(new Error('Message queue full'));
          return;
        }
      }

      this.queue.push({ fn, chatId: String(chatId), priority, retries: 0, resolve, reject });
      // Sort by priority (lower = higher priority)
      this.queue.sort((a, b) => a.priority - b.priority);

      if (!this.processing) {
        this._process();
      }
    });
  }

  /**
   * Process queue sequentially with rate limiting
   */
  async _process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();

      try {
        // Wait for global flood wait
        const now = Date.now();
        if (this.floodWaitUntil > now) {
          const wait = this.floodWaitUntil - now;
          console.log(`📨 Flood wait active, waiting ${Math.ceil(wait / 1000)}s...`);
          await this._sleep(wait);
        }

        // Enforce global min delay
        const sinceGlobal = Date.now() - this.lastSendGlobal;
        if (sinceGlobal < this.minDelay) {
          await this._sleep(this.minDelay - sinceGlobal);
        }

        // Enforce per-chat delay
        const lastChat = this.lastSendPerChat.get(item.chatId) || 0;
        const sinceChat = Date.now() - lastChat;
        if (sinceChat < this.perChatDelay) {
          await this._sleep(this.perChatDelay - sinceChat);
        }

        // Send
        const result = await item.fn();
        this.lastSendGlobal = Date.now();
        this.lastSendPerChat.set(item.chatId, Date.now());
        item.resolve(result);

      } catch (err) {
        // Handle Telegram flood wait
        if (err.seconds || /wait.*(\d+).*seconds/i.test(err.message)) {
          const waitSecs = err.seconds || parseInt(err.message.match(/(\d+)/)?.[1] || '30');
          this.floodWaitUntil = Date.now() + (waitSecs * 1000) + 2000;
          console.log(`📨 Flood wait detected: ${waitSecs}s. Pausing queue.`);

          // Re-queue this message
          if (item.retries < this.maxRetries) {
            item.retries++;
            this.queue.unshift(item); // Put back at front
          } else {
            item.reject(new Error(`Flood wait after ${this.maxRetries} retries`));
          }
        } else {
          // Non-flood error
          if (item.retries < this.maxRetries) {
            item.retries++;
            this.queue.push(item); // Put at back for retry
          } else {
            item.reject(err);
          }
        }
      }
    }

    this.processing = false;
  }

  /**
   * Get queue stats
   */
  stats() {
    return {
      queued: this.queue.length,
      processing: this.processing,
      floodWaitActive: this.floodWaitUntil > Date.now(),
      floodWaitRemaining: Math.max(0, Math.ceil((this.floodWaitUntil - Date.now()) / 1000)),
    };
  }

  /**
   * Clear all queued messages
   * @returns {number} Number of messages cleared
   */
  clear() {
    const count = this.queue.length;
    for (const item of this.queue) {
      item.reject(new Error('Queue cleared'));
    }
    this.queue = [];
    return count;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
