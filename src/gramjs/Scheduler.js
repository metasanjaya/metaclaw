/**
 * Persistent Scheduler for MetaClaw
 * Saves reminders/tasks to JSON file, survives restarts.
 * Supports one-shot and repeating schedules.
 * 
 * Job types:
 * - "direct" (default): Send message directly to chat (0 tokens)
 * - "agent": Route through AI pipeline with tools (burns tokens, smart)
 * - "check": Run a shell command first, feed output to AI for analysis (efficient)
 *   Supports conditions: only triggers AI if condition matches (silent otherwise)
 *   Conditions: ==, !=, >, <, >=, <=, contains:, !contains:
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const DATA_FILE = path.join(process.cwd(), 'data', 'schedules.json');
const CHECK_INTERVAL = 10_000; // check every 10 seconds

export class Scheduler {
  /**
   * @param {Function} sendFn - Direct message sender (peerId, message, replyTo)
   * @param {Function|null} agentFn - AI pipeline processor (peerId, chatId, message) → processes through AI with tools
   * @param {Function|null} checkFn - Run command + feed to AI (peerId, chatId, command, prompt)
   */
  constructor(sendFn, agentFn = null, checkFn = null) {
    this.sendFn = sendFn;
    this.agentFn = agentFn;
    this.checkFn = checkFn;
    this.jobs = [];
    this.timer = null;
    this._load();
  }

  /**
   * Set the agent function (called after bridge is ready)
   */
  setAgentFn(fn) {
    this.agentFn = fn;
  }

  /**
   * Add a job
   * @param {object} opts
   * @param {string} opts.peerId - Telegram peer to send to
   * @param {string} opts.chatId - Chat identifier
   * @param {string} opts.message - Reminder text or agent prompt
   * @param {number} opts.triggerAt - Unix ms when to fire
   * @param {number|null} opts.repeatMs - If set, reschedule with this interval
   * @param {number|null} opts.replyTo - Message ID to reply to
   * @param {string} opts.type - "direct" (default), "agent", or "check"
   * @param {string|null} opts.command - Shell command to run first (for type "check")
   * @param {string|null} opts.condition - Condition to evaluate (for type "check"), e.g. "!=200", ">8", "contains:error"
   * @returns {string} job id
   */
  add({ peerId, chatId, message, triggerAt, repeatMs = null, replyTo = null, type = 'direct', command = null, condition = null }) {
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
      type,
      command,
      condition,
      createdAt: Date.now(),
    };
    this.jobs.push(job);
    this._save();
    const typeLabel = type === 'agent' ? ' [agent]' : '';
    console.log(`  📅 Scheduled${typeLabel}: "${message}" at ${new Date(triggerAt).toISOString()}${repeatMs ? ` (repeat every ${repeatMs / 1000}s)` : ''}`);
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
        if (job.type === 'check' && this.checkFn && job.command) {
          // Run command first, evaluate condition, then feed to AI if condition matches
          console.log(`  🔍 Check job firing: "${job.command}"${job.condition ? ` [if ${job.condition}]` : ''}`);
          await this.checkFn(job.peerId, job.chatId, job.command, job.message, job.condition);
          console.log(`  ✅ Check job completed: "${job.message}"`);
        } else if (job.type === 'agent' && this.agentFn) {
          // Route through AI pipeline — AI will process and reply
          console.log(`  🤖 Agent job firing: "${job.message}"`);
          await this.agentFn(job.peerId, job.chatId, job.message);
          console.log(`  ✅ Agent job completed: "${job.message}"`);
        } else {
          // Direct send — no AI involved
          await this.sendFn(job.peerId, `⏰ Reminder: ${job.message}`, job.replyTo);
          console.log(`  ✅ Reminder sent: "${job.message}"`);
        }
      } catch (e) {
        console.error(`  ❌ ${job.type === 'agent' ? 'Agent job' : 'Reminder'} failed: ${e.message}`);
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
        this.jobs = (data.jobs || []).map(j => ({
          ...j,
          type: j.type || 'direct', // backward compat
        }));
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
