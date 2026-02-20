import { ConfigManager } from '../core/ConfigManager.js';
import { EventBus } from '../core/EventBus.js';
import { ChannelManager } from '../channels/ChannelManager.js';
import { InstanceManager } from '../instances/InstanceManager.js';

/**
 * CLI doctor — health check all instances.
 */
export async function runDoctor(opts = {}) {
  console.log('🐾 MetaClaw Doctor\n');

  const config = new ConfigManager(opts.baseDir);
  try {
    config.load();
  } catch (e) {
    console.error('❌ Config not found. Run "metaclaw init" first.');
    return;
  }

  const ids = config.getInstanceIds();
  if (ids.length === 0) {
    console.log('No instances found. Run "metaclaw init <name>" to create one.');
    return;
  }

  const eventBus = new EventBus();
  const channelManager = new ChannelManager(eventBus);
  const instanceManager = new InstanceManager(config, eventBus);
  instanceManager.loadAll();

  console.log(`Found ${ids.length} instance(s):\n`);

  for (const info of instanceManager.list()) {
    const health = info.status === 'stopped' ? '⏸️  stopped' : 
                   info.status === 'running' ? '✅ healthy' : `⚠️  ${info.status}`;
    console.log(`  ${info.emoji} ${info.name} (${info.id})`);
    console.log(`    Model: ${info.model}`);
    console.log(`    Channels: ${info.channels?.join(', ') || 'none'}`);
    console.log(`    Status: ${health}`);
    console.log();
  }

  console.log('Tip: Run "metaclaw start" to boot all instances.\n');
}
