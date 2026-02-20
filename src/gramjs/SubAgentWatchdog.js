/**
 * SubAgentWatchdog - Monitors SubAgents and respawns stuck ones
 * 
 * Tracks active subagents, detects stalls (no activity for 5+ min),
 * and respawns from the failed step if a plan exists.
 */

const CHECK_INTERVAL = 5 * 60 * 1000;    // 5 minutes
const STUCK_THRESHOLD = 5 * 60 * 1000;    // 5 minutes no activity
const CLEANUP_AFTER = 30 * 60 * 1000;     // 30 minutes

export class SubAgentWatchdog {
  /**
   * @param {Object} opts
   * @param {import('./SubAgent.js').SubAgent} opts.subAgent - SubAgent instance
   * @param {Function} [opts.sendFn] - (peerId, message, replyTo) => Promise
   */
  constructor({ subAgent, sendFn }) {
    this.subAgent = subAgent;
    this.sendFn = sendFn || (() => {});

    /** @type {Map<string, Object>} */
    this.tracked = new Map();

    this._interval = setInterval(() => this._check(), CHECK_INTERVAL);
    console.log('🐕 SubAgentWatchdog initialized (check every 5m)');
  }

  /**
   * Register a subagent for monitoring
   */
  register({ id, task, plan, chatId, peerId, replyTo, spawnOpts }) {
    this.tracked.set(id, {
      id,
      task,
      plan: plan || null,
      currentStep: 0,
      startTime: Date.now(),
      lastActivity: Date.now(),
      chatId,
      peerId,
      replyTo,
      status: 'running',
      respawnCount: 0,
      spawnOpts: spawnOpts || null,
    });
    console.log(`🐕 Watchdog tracking [${id}]: "${task?.slice(0, 60)}"`);
  }

  /**
   * Report activity (heartbeat) from a subagent
   */
  reportActivity(agentId) {
    const entry = this.tracked.get(agentId);
    if (entry) {
      entry.lastActivity = Date.now();
    }
  }

  /**
   * Report a plan step completed
   */
  stepCompleted(agentId, stepIndex) {
    const entry = this.tracked.get(agentId);
    if (entry) {
      entry.currentStep = stepIndex + 1;
      entry.lastActivity = Date.now();
    }
  }

  /**
   * Mark task as completed — stop tracking
   */
  taskCompleted(agentId, result) {
    const entry = this.tracked.get(agentId);
    if (entry) {
      entry.status = 'completed';
      entry.completedAt = Date.now();
      entry.lastActivity = Date.now();
      console.log(`🐕 Watchdog: [${agentId}] completed`);
    }
  }

  /**
   * Mark task as failed
   */
  taskFailed(agentId, error) {
    const entry = this.tracked.get(agentId);
    if (entry) {
      entry.status = 'failed';
      entry.completedAt = Date.now();
      entry.error = error;
      console.log(`🐕 Watchdog: [${agentId}] failed: ${error}`);
    }
  }

  /**
   * Periodic check — detect stuck agents and respawn
   */
  async _check() {
    const now = Date.now();

    for (const [id, entry] of this.tracked) {
      // Cleanup completed/failed after 30 min
      if ((entry.status === 'completed' || entry.status === 'failed') && entry.completedAt) {
        if (now - entry.completedAt > CLEANUP_AFTER) {
          this.tracked.delete(id);
          console.log(`🐕 Watchdog: cleaned up [${id}]`);
          continue;
        }
        continue;
      }

      // Skip non-running
      if (entry.status !== 'running') continue;

      // Check if stuck
      const idleTime = now - entry.lastActivity;
      if (idleTime < STUCK_THRESHOLD) continue;

      console.log(`🐕 Watchdog: [${id}] stuck (idle ${Math.round(idleTime / 1000)}s)`);
      entry.status = 'stuck';

      // Check actual SubAgent status — maybe it finished while we weren't looking
      const subStatus = this.subAgent.getStatus(id);
      if (subStatus && ['completed', 'failed', 'aborted'].includes(subStatus.status)) {
        entry.status = subStatus.status;
        entry.completedAt = now;
        console.log(`🐕 Watchdog: [${id}] actually ${subStatus.status}, updating`);
        continue;
      }

      // Abort the stuck agent
      this.subAgent.abort(id);

      // Respawn if we have a plan with remaining steps
      if (entry.plan && entry.plan.steps && entry.currentStep < entry.plan.steps.length && entry.respawnCount < 3) {
        entry.respawnCount++;
        const remainingSteps = entry.plan.steps.slice(entry.currentStep);
        const resumeContext = `RESUMING from step ${entry.currentStep + 1}. Previous attempt got stuck.\nRemaining steps:\n${remainingSteps.map((s, i) => `${entry.currentStep + i + 1}. ${s}`).join('\n')}`;

        try {
          const opts = entry.spawnOpts || {};
          const newId = await this.subAgent.spawn({
            ...opts,
            goal: entry.task,
            context: (opts.context || '') + '\n\n' + resumeContext,
            peerId: entry.peerId,
            chatId: entry.chatId,
            replyTo: entry.replyTo,
          });

          // Register the new agent
          this.register({
            id: newId,
            task: entry.task,
            plan: { steps: remainingSteps },
            chatId: entry.chatId,
            peerId: entry.peerId,
            replyTo: entry.replyTo,
            spawnOpts: opts,
          });
          this.tracked.get(newId).respawnCount = entry.respawnCount;

          const msg = `🐕 Watchdog respawned stuck agent [${id}] → [${newId}] (attempt ${entry.respawnCount}/3, from step ${entry.currentStep + 1})`;
          console.log(msg);
          if (entry.peerId) {
            try { await this.sendFn(entry.peerId, msg, entry.replyTo); } catch {}
          }
        } catch (e) {
          console.error(`🐕 Watchdog: respawn failed for [${id}]:`, e.message);
        }
      } else {
        const reason = entry.respawnCount >= 3 ? 'max respawns reached' : 'no plan to resume from';
        console.log(`🐕 Watchdog: [${id}] not respawning (${reason})`);
        entry.status = 'failed';
        entry.completedAt = now;
        if (entry.peerId) {
          try { await this.sendFn(entry.peerId, `🐕 Agent [${id}] stuck and abandoned (${reason})`, entry.replyTo); } catch {}
        }
      }
    }
  }

  /**
   * Get watchdog status summary
   */
  getStatus() {
    const entries = [];
    for (const [id, e] of this.tracked) {
      entries.push({
        id,
        task: e.task?.slice(0, 60),
        status: e.status,
        currentStep: e.currentStep,
        totalSteps: e.plan?.steps?.length || 0,
        idleSec: Math.round((Date.now() - e.lastActivity) / 1000),
        respawns: e.respawnCount,
      });
    }
    return entries;
  }

  destroy() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    console.log('🐕 SubAgentWatchdog destroyed');
  }
}
