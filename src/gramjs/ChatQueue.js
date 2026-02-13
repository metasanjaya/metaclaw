/**
 * ChatQueue - Per-chat concurrent message processing
 * Each chat gets its own queue, so Chat A doesn't block Chat B.
 * Messages within the same chat are still sequential (preserves conversation order).
 */

export class ChatQueue {
  constructor() {
    /** @type {Map<string, { queue: Array, processing: boolean }>} */
    this.chats = new Map();
  }

  /**
   * Enqueue a task for a specific chat
   * @param {string} chatId
   * @param {() => Promise<void>} task
   */
  enqueue(chatId, task) {
    if (!this.chats.has(chatId)) {
      this.chats.set(chatId, { queue: [], processing: false });
    }
    const chat = this.chats.get(chatId);

    return new Promise((resolve, reject) => {
      chat.queue.push({ task, resolve, reject });
      this._process(chatId);
    });
  }

  async _process(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat || chat.processing || chat.queue.length === 0) return;

    chat.processing = true;

    while (chat.queue.length > 0) {
      const { task, resolve, reject } = chat.queue.shift();
      try {
        const result = await task();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }

    chat.processing = false;

    // Cleanup empty queues
    if (chat.queue.length === 0) {
      this.chats.delete(chatId);
    }
  }
}
