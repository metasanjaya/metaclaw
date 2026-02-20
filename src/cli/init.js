import { ConfigManager } from '../core/ConfigManager.js';
import readline from 'node:readline';

/**
 * Interactive setup wizard.
 * @param {string} [name] — instance name (if provided, creates instance only)
 * @param {Object} opts
 */
export async function initWizard(name, opts = {}) {
  const config = new ConfigManager(opts.baseDir);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  try {
    if (!name) {
      // Full init — create base dir + first instance
      console.log('🐾 MetaClaw Setup Wizard\n');
      config.ensureBaseDir();
      console.log(`✅ Created ${config.baseDir}\n`);

      name = await ask('Instance name (e.g., nayla): ');
      if (!name.trim()) { console.log('Cancelled.'); return; }
      name = name.trim().toLowerCase();
    } else {
      config.load();
    }

    const displayName = await ask(`Display name [${name}]: `) || name;
    const personality = await ask('Personality (short description): ');
    const emoji = await ask('Emoji [🤖]: ') || '🤖';
    const model = await ask('Primary model [anthropic/claude-sonnet-4-6]: ') || 'anthropic/claude-sonnet-4-6';

    const dir = config.createInstance(name, {
      name: displayName,
      personality,
      emoji,
      model,
    });

    console.log(`\n✅ Instance "${name}" created at ${dir}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Edit ${dir}/config.yaml to configure channels`);
    console.log(`  2. Add API keys to ${dir}/config.local.yaml`);
    console.log(`  3. Run: metaclaw start ${name}\n`);
  } finally {
    rl.close();
  }
}
