import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ConfigManager } from '../core/ConfigManager.js';

/**
 * Manage skills: add, update, remove, list
 */
export async function manageSkill(action, urlOrName, opts = {}) {
  const config = new ConfigManager(opts.baseDir);
  config.load();

  const instanceId = opts.instance;
  let skillsDir;

  if (instanceId) {
    const inst = config.getInstance(instanceId);
    if (!inst) { console.error(`Instance not found: ${instanceId}`); return; }
    skillsDir = path.join(inst._dir, 'skills');
  } else {
    // Default to first instance
    const ids = config.getInstanceIds();
    if (ids.length === 0) { console.error('No instances. Run "metaclaw init" first.'); return; }
    skillsDir = path.join(config.getInstance(ids[0])._dir, 'skills');
  }

  switch (action) {
    case 'add': {
      if (!urlOrName) { console.error('Usage: metaclaw skill add <git-url>'); return; }
      const name = urlOrName.split('/').pop().replace('.git', '');
      const dest = path.join(skillsDir, name);
      if (existsSync(dest)) { console.error(`Skill "${name}" already exists`); return; }
      console.log(`Cloning ${urlOrName} → ${dest}`);
      execSync(`git clone ${urlOrName} ${dest}`, { stdio: 'inherit' });
      console.log(`✅ Skill "${name}" installed`);
      break;
    }
    case 'update': {
      if (!urlOrName) { console.error('Usage: metaclaw skill update <name>'); return; }
      const dest = path.join(skillsDir, urlOrName);
      if (!existsSync(dest)) { console.error(`Skill "${urlOrName}" not found`); return; }
      console.log(`Updating ${urlOrName}...`);
      execSync(`cd ${dest} && git pull`, { stdio: 'inherit' });
      console.log(`✅ Skill "${urlOrName}" updated`);
      break;
    }
    case 'remove': {
      if (!urlOrName) { console.error('Usage: metaclaw skill remove <name>'); return; }
      const dest = path.join(skillsDir, urlOrName);
      if (!existsSync(dest)) { console.error(`Skill "${urlOrName}" not found`); return; }
      execSync(`rm -rf ${dest}`);
      console.log(`✅ Skill "${urlOrName}" removed`);
      break;
    }
    case 'list': {
      if (!existsSync(skillsDir)) { console.log('No skills installed.'); return; }
      const entries = readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory());
      if (entries.length === 0) { console.log('No skills installed.'); return; }
      console.log('Installed skills:\n');
      for (const e of entries) {
        console.log(`  📦 ${e.name}`);
      }
      break;
    }
    default:
      console.error(`Unknown action: ${action}. Use: add, update, remove, list`);
  }
}
