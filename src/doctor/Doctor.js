import crypto from 'node:crypto';
import { Heartbeat } from './Heartbeat.js';
import { Recovery } from './Recovery.js';

/**
 * Health monitoring & self-healing coordinator.
 */
export class Doctor {
  constructor({ eventBus, channelManager, instanceManager, config = {} }) {
    this.eventBus = eventBus;
    this.channelManager = channelManager;
    this.instanceManager = instanceManager;

    this.heartbeat = new Heartbeat({ eventBus, channelManager, instanceManager, config });
    this.recovery = new Recovery({ eventBus, channelManager, instanceManager, config });

    /** @type {Array<Object>} */
    this.incidents = [];
    this._maxIncidents = config.maxIncidents || 500;
    this._startTime = Date.now();

    /** @type {Array<{ts: number, scope: string, results: Object}>} */
    this._checkHistory = [];
    this._maxHistory = 200;
  }

  start() {
    this.heartbeat.start();

    this.eventBus.on('health.incident', (incident) => {
      const full = {
        ...incident,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        resolved: incident.resolved || false,
      };
      this.incidents.push(full);
      if (this.incidents.length > this._maxIncidents) {
        this.incidents = this.incidents.slice(-this._maxIncidents);
      }
      this.recovery.handle(full);
      // Broadcast to WS clients
      this.eventBus.emit('doctor.incident', full);
    });

    this.eventBus.on('health.check', ({ scope, results }) => {
      this._checkHistory.push({ ts: Date.now(), scope, results });
      if (this._checkHistory.length > this._maxHistory) {
        this._checkHistory = this._checkHistory.slice(-this._maxHistory);
      }
    });

    console.log('[Doctor] Monitoring started');
  }

  stop() {
    this.heartbeat.stop();
    console.log('[Doctor] Monitoring stopped');
  }

  /**
   * Full health report with system stats
   */
  async report() {
    const os = await import('node:os');
    const totalMem = os.default.totalmem();
    const freeMem = os.default.freemem();
    const cpus = os.default.cpus();
    const cpuUsage = cpus.reduce((a, c) => {
      const total = Object.values(c.times).reduce((s, t) => s + t, 0);
      return a + (1 - c.times.idle / total);
    }, 0) / cpus.length * 100;

    const channels = await this.channelManager.healthCheckAll();
    const instances = this.instanceManager.healthCheckAll();

    const allHealthy = Object.values({ ...channels, ...instances })
      .every(h => h.status === 'healthy');

    const activeIncidents = this.incidents.filter(i => !i.resolved);
    const recentIncidents = this.incidents.slice(-50);

    return {
      overall: allHealthy && activeIncidents.length === 0 ? 'healthy' : 'degraded',
      system: {
        memory: {
          total: totalMem,
          free: freeMem,
          used: totalMem - freeMem,
          pct: Math.round((1 - freeMem / totalMem) * 100),
        },
        cpu: { cores: cpus.length, usage: Math.round(cpuUsage) },
        uptime: Math.round(process.uptime()),
        appUptime: Math.round((Date.now() - this._startTime) / 1000),
        platform: os.default.platform(),
        nodeVersion: process.version,
        pid: process.pid,
        memoryUsage: process.memoryUsage(),
      },
      channels,
      instances,
      incidents: {
        active: activeIncidents.length,
        total: this.incidents.length,
        recent: recentIncidents,
      },
      recovery: this.recovery.getState(),
      timestamp: Date.now(),
    };
  }

  /**
   * Get incidents with optional filtering
   */
  getIncidents({ limit = 50, type, resolved, since } = {}) {
    let filtered = this.incidents;
    if (type) filtered = filtered.filter(i => i.type === type);
    if (resolved !== undefined) filtered = filtered.filter(i => i.resolved === resolved);
    if (since) filtered = filtered.filter(i => i.timestamp >= since);
    return filtered.slice(-limit);
  }

  /**
   * Resolve an incident manually
   */
  resolveIncident(id) {
    const inc = this.incidents.find(i => i.id === id);
    if (inc) {
      inc.resolved = true;
      inc.resolvedAt = Date.now();
      this.eventBus.emit('doctor.resolved', inc);
      return true;
    }
    return false;
  }
}
