import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * SQLite-backed chat history per instance.
 */
export class ChatStore {
  /**
   * @param {string} dataDir — instance data directory
   */
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'data.db'));
    this.db.pragma('journal_mode = WAL');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT,
        sender_id TEXT,
        timestamp INTEGER NOT NULL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
    `);

    this._insertStmt = this.db.prepare(
      'INSERT OR REPLACE INTO messages (id, chat_id, role, text, sender_id, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    this._getStmt = this.db.prepare(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?'
    );
    this._getConvStmt = this.db.prepare(
      'SELECT role, text as content FROM messages WHERE chat_id = ? ORDER BY timestamp ASC LIMIT ?'
    );
  }

  /**
   * Save a message
   */
  save(msg) {
    this._insertStmt.run(
      msg.id,
      msg.chatId || msg.chat_id || 'default',
      msg.role,
      msg.text || msg.content || '',
      msg.senderId || msg.sender_id || '',
      msg.timestamp || Date.now(),
      msg.metadata ? JSON.stringify(msg.metadata) : null
    );
  }

  /**
   * Get recent messages for a chat (newest first)
   * @param {string} chatId
   * @param {number} limit
   * @returns {Array}
   */
  getHistory(chatId, limit = 100) {
    return this._getStmt.all(chatId, limit).reverse();
  }

  /**
   * Get conversation messages for AI context (oldest first)
   * @param {string} chatId
   * @param {number} limit
   * @returns {Array<{role:string, content:string}>}
   */
  getConversation(chatId, limit = 50) {
    return this._getConvStmt.all(chatId, limit);
  }

  close() {
    this.db.close();
  }
}
