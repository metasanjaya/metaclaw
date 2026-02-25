#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const program = new Command();

program
  .name('metaclaw')
  .description('🐾 MetaClaw — Modular AI Platform')
  .version(pkg.version);

// metaclaw start [instance]
program
  .command('start [instance]')
  .description('Start MetaClaw (all instances or a specific one)')
  .option('--base-dir <path>', 'Personal directory (default: ~/.metaclaw)')
  .action(async (instance, opts) => {
    const { Engine } = await import('../src/core/Engine.js');
    const engine = new Engine({ baseDir: opts.baseDir, instanceId: instance });
    await engine.start();
  });

// metaclaw stop
program
  .command('stop')
  .description('Stop MetaClaw')
  .action(() => {
    console.log('Send SIGTERM to the running process, or use PM2/systemd.');
  });

// metaclaw init [name]
program
  .command('init [name]')
  .description('Initialize MetaClaw or create a new instance')
  .option('--base-dir <path>', 'Personal directory (default: ~/.metaclaw)')
  .action(async (name, opts) => {
    const { initWizard } = await import('../src/cli/init.js');
    await initWizard(name, opts);
  });

// metaclaw doctor
program
  .command('doctor')
  .description('Health check all instances and channels')
  .option('--base-dir <path>', 'Personal directory (default: ~/.metaclaw)')
  .action(async (opts) => {
    const { runDoctor } = await import('../src/cli/doctor.js');
    await runDoctor(opts);
  });

// metaclaw instances
program
  .command('instances')
  .description('List all instances')
  .option('--base-dir <path>', 'Personal directory (default: ~/.metaclaw)')
  .action(async (opts) => {
    const { ConfigManager } = await import('../src/core/ConfigManager.js');
    const config = new ConfigManager(opts.baseDir);
    config.load();
    const ids = config.getInstanceIds();
    if (ids.length === 0) {
      console.log('No instances found. Run "metaclaw init <name>" to create one.');
      return;
    }
    for (const id of ids) {
      const inst = config.getInstance(id);
      const identity = inst._identity || {};
      console.log(`  ${identity.emoji || '🤖'} ${id} — ${identity.name || id} (model: ${inst.model?.primary || 'default'})`);
    }
  });

// metaclaw skill <action> [args]
program
  .command('skill <action> [url]')
  .description('Manage skills: add <git-url>, update <name>, remove <name>, list')
  .option('--instance <id>', 'Target instance')
  .action(async (action, url, opts) => {
    const { manageSkill } = await import('../src/cli/skill.js');
    await manageSkill(action, url, opts);
  });

// metaclaw auth <provider> <instance>
program
  .command('auth <provider> <instance>')
  .description('Authenticate/reconnect a channel (telegram, whatsapp)')
  .option('-i, --interactive', 'Interactive authentication (prompts for phone/code)')
  .action(async (provider, instance, opts) => {
    const { authChannel } = await import('../src/cli/auth.js');
    await authChannel(provider, instance, { interactive: opts.interactive });
  });

// metaclaw terminal <instance>
program
  .command('terminal <instance>')
  .description('Start interactive terminal for an instance')
  .action(async (instance) => {
    const { startTerminal } = await import('../src/cli/terminal.js');
    await startTerminal(instance);
  });

program.parse();
