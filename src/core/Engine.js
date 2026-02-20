import { EventBus } from './EventBus.js';
import { ConfigManager } from './ConfigManager.js';
import { Router } from './Router.js';
import { ChannelManager } from '../channels/ChannelManager.js';
import { SkillRegistry } from '../skills/SkillRegistry.js';
import { InstanceManager } from '../instances/InstanceManager.js';
import { Doctor } from '../doctor/Doctor.js';
import { MeshManager } from '../mesh/MeshManager.js';
import { MCChannel } from '../channels/mission-control/MCChannel.js';
import { TelegramChannel } from '../channels/telegram/TelegramChannel.js';
import { join } from 'node:path';

/**
 * MetaClaw v3 Engine — main orchestrator.
 * Boot sequence: config → eventBus → instances → channels → skills → doctor → mesh → start
 */
export class Engine {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.baseDir] — personal directory (~/.metaclaw)
   * @param {string} [opts.instanceId] — start only a specific instance
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.eventBus = new EventBus();
    this.config = new ConfigManager(opts.baseDir);
    this.router = new Router({ eventBus: this.eventBus });
    this.channelManager = new ChannelManager(this.eventBus);
    this.skillRegistry = new SkillRegistry(this.eventBus);
    this.instanceManager = new InstanceManager(this.config, this.eventBus, this.router);
    this.doctor = null;
    this.mesh = null;
    this._running = false;
  }

  /**
   * Boot MetaClaw
   */
  async start() {
    console.log('🐾 MetaClaw v3 starting...\n');

    // 1. Load config
    this.config.load();
    console.log(`[Engine] Config loaded from ${this.config.baseDir}`);
    console.log(`[Engine] Instances found: ${this.config.getInstanceIds().join(', ') || 'none'}`);

    // 2. Init AI router
    await this.router.init(this.config.global);

    // 3. Load instances
    this.instanceManager.loadAll();

    // 4. Load built-in skills
    // TODO: load from code dir + instance skill dirs

    // 5. Register channels
    // Mission Control (always on)
    const mcConfig = this.config.global.missionControl || { port: 3100 };
    const mc = new MCChannel({
      config: mcConfig,
      eventBus: this.eventBus,
      instanceManager: this.instanceManager,
    });
    this.channelManager.register(mc);

    // Telegram channels (per-instance)
    for (const [id, instance] of this.instanceManager.instances) {
      const instConfig = this.config.getInstance(id);
      const tgConfig = instConfig?.telegram || instConfig?.channels?.telegram;
      if (tgConfig && tgConfig.enabled !== false) {
        const channelId = `telegram-${id}`;
        const tg = new TelegramChannel({
          id: channelId,
          config: {
            ...tgConfig,
            sessionFile: join(instConfig._dir, 'sessions', 'telegram.session'),
          },
          eventBus: this.eventBus,
        });
        this.channelManager.register(tg);
        instance.channelIds.push(channelId);
      }
    }

    // 6. Start instances
    if (this.opts.instanceId) {
      await this.instanceManager.start(this.opts.instanceId);
    } else {
      await this.instanceManager.startAll();
    }

    // 7. Connect channels
    await this.channelManager.connectAll();

    // 8. Start doctor
    this.doctor = new Doctor({
      eventBus: this.eventBus,
      channelManager: this.channelManager,
      instanceManager: this.instanceManager,
      config: this.config.global.doctor || {},
    });
    this.doctor.start();

    // 8b. Wire doctor to Mission Control
    const mcChannel = this.channelManager.get('mission-control');
    if (mcChannel?.server) {
      mcChannel.server.doctor = this.doctor;
    }

    // 9. Start mesh
    this.mesh = new MeshManager({
      eventBus: this.eventBus,
      config: this.config.global.mesh || {},
    });
    await this.mesh.start();

    // 10. Hot-reload config
    this.config.watch((file) => {
      console.log(`[Engine] Config changed: ${file}`);
      this.eventBus.emit('config.reload', { file });
    });

    // 11. Wire message routing
    this.eventBus.on('message.in', (msg) => this._routeMessage(msg));

    this._running = true;
    console.log('\n🐾 MetaClaw v3 is running!\n');

    // Graceful shutdown
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => this.stop());
    }
  }

  /**
   * Route inbound message to the correct instance and send response
   * @param {import('./types.js').InboundMessage} msg
   */
  async _routeMessage(msg) {
    // For Mission Control: chatId = instanceId
    if (msg.channelId === 'mission-control') {
      const instance = this.instanceManager.get(msg.chatId);
      if (instance) {
        const response = await instance.handleMessage(msg);
        if (response) {
          this.channelManager.sendText(msg.channelId, msg.chatId, response);
        }
        return;
      }
    }

    // For other channels: route by channel assignment
    for (const [, inst] of this.instanceManager.instances) {
      if (inst.channelIds.includes(msg.channelId)) {
        const response = await inst.handleMessage(msg);
        if (response) {
          // Split long messages for Telegram (4096 char limit)
          const channel = this.channelManager.get(msg.channelId);
          const maxLen = channel?.capabilities().maxMessageLength || 4096;
          if (response.length > maxLen) {
            const chunks = response.match(new RegExp(`.{1,${maxLen}}`, 'gs')) || [response];
            for (const chunk of chunks) {
              await this.channelManager.sendText(msg.channelId, msg.chatId, chunk, { replyTo: msg.id });
            }
          } else {
            await this.channelManager.sendText(msg.channelId, msg.chatId, response, { replyTo: msg.id });
          }
        }
        return;
      }
    }
    console.warn(`[Engine] No instance handles channel: ${msg.channelId}`);
  }

  /**
   * Graceful shutdown
   */
  async stop() {
    if (!this._running) return;
    console.log('\n🐾 MetaClaw shutting down...');
    this._running = false;
    this.doctor?.stop();
    this.config.unwatch();
    await this.mesh?.stop();
    await this.channelManager.disconnectAll();
    await this.instanceManager.stopAll();
    console.log('🐾 Goodbye!\n');
    process.exit(0);
  }
}
