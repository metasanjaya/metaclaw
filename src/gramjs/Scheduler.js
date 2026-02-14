/**
 * Persistent Scheduler for MetaClaw
 * Saves reminders/tasks to JSON file, survives restarts.
 * Supports one-shot and repeating schedules.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const DATA_FILE = path.join(process.cwd(), 'data', 'schedules.json');
const CHECK_INTERVAL = 10_000; // check every 10 seconds

export class Scheduler {
  constructor(sendFn) {
    /** @param {string} peerId @param {string} message @param {number|null} replyTo */
    this.sendFn = sendFn;
    this.jobs = [];
    this.timer = null;
    this._load();
  }

  /**
   * Add a job
   * @param {object} opts
   * @param {string} opts.peerId - Telegram peer to send to
   * @param {string} opts.chatId - Chat identifier
   * @param {string} opts.message - Reminder text
   * @param {number} opts.triggerAt - Unix ms when to fire
   * @param {number|null} opts.repeatMs - If set, reschedule with this interval
   * @param {number|null} opts.replyTo - Message ID to reply to
   * @returns {string} job id
   */
  add({ peerId, chatId, message, triggerAt, repeatMs = null, replyTo = null }) {
    // Dedup: skip if same chat + same message + trigger within 5 minutes
    const dominated = this.jobs.find(j =>
      j.chatId === chatId &&
      j.message === message &&
      Math.abs(j.triggerAt - triggerAt) < 300_000
    );
    if (dominated) {
      console.log(`  📅 Duplicate skipped: "${message}" (existing job ${dominated.id})`);
      return dominated.id;
    }

    const job = {
      id: randomUUID(),
      peerId,
      chatId,
      message,
      triggerAt,
      repeatMs,
      replyTo,
      createdAt: Date.now(),
    };
    this.jobs.push(job);
    this._save();
    console.log(`  📅 Scheduled: "${message}" at ${new Date(triggerAt).toISOString()}${repeatMs ? ` (repeat every ${repeatMs / 1000}s)` : ''}`);
    return job.id;
  }

  /**
   * Remove a job by id
   */
  remove(jobId) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter(j => j.id !== jobId);
    if (this.jobs.length < before) {
      this._save();
      return true;
    }
    return false;
  }

  /**
   * List jobs for a chat
   */
  listForChat(chatId) {
    return this.jobs.filter(j => j.chatId === chatId);
  }

  /**
   * List all jobs
   */
  listAll() {
    return [...this.jobs];
  }

  /**
   * Start the check loop
   */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), CHECK_INTERVAL);
    // Run immediately to catch any overdue jobs after restart
    this._tick();
    console.log(`📅 Scheduler started (${this.jobs.length} pending jobs)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _tick() {
    const now = Date.now();
    const due = this.jobs.filter(j => j.triggerAt <= now);
    if (due.length === 0) return;

    for (const job of due) {
      try {
        await this.sendFn(job.peerId, `⏰ Reminder: ${job.message}`, job.replyTo);
        console.log(`  ✅ Reminder sent: "${job.message}"`);
      } catch (e) {
        console.error(`  ❌ Reminder failed: ${e.message}`);
      }

      if (job.repeatMs) {
        // Reschedule to next trigger time (skip missed intervals)
        while (job.triggerAt <= now) {
          job.triggerAt += job.repeatMs;
        }
        console.log(`  🔄 Rescheduled: "${job.message}" → ${new Date(job.triggerAt).toISOString()}`);
      } else {
        // One-shot: remove
        this.jobs = this.jobs.filter(j => j.id !== job.id);
      }
    }
    this._save();
  }

  _load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        this.jobs = data.jobs || [];
        console.log(`📅 Loaded ${this.jobs.length} scheduled jobs`);
      }
    } catch (e) {
      console.error(`📅 Failed to load schedules: ${e.message}`);
      this.jobs = [];
    }
  }

  _save() {
    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ jobs: this.jobs }, null, 2));
    } catch (e) {
      console.error(`📅 Failed to save schedules: ${e.message}`);
    }
  }
}
