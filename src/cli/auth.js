#!/usr/bin/env node
/**
 * MetaClaw Auth CLI - Authentication management
 * Usage: metaclaw auth <provider> <instance>
 */

import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import readline from 'node:readline';

const CONFIG_DIR = join(homedir(), '.metaclaw');

function getInstanceDir(instanceId) {
  return join(CONFIG_DIR, 'instances', instanceId);
}

function loadInstanceConfig(instanceId) {
  const configPath = join(getInstanceDir(instanceId), 'config.yaml');
  if (!existsSync(configPath)) {
    console.error(`❌ Instance "${instanceId}" not found`);
    console.error(`   Expected: ${configPath}`);
    process.exit(1);
  }
  return yaml.load(readFileSync(configPath, 'utf8'));
}

// Helper to prompt user input
function prompt(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function authTelegramInteractive(instanceId) {
  const instanceDir = getInstanceDir(instanceId);
  const config = loadInstanceConfig(instanceId);
  
  console.log(`🔐 Interactive Telegram Authentication for: ${instanceId}`);
  console.log('');
  
  const apiId = config.telegram?.apiId || config.remote?.providers?.telegram?.apiId;
  const apiHash = config.telegram?.apiHash || config.remote?.providers?.telegram?.apiHash;
  
  if (!apiId || !apiHash) {
    console.error('❌ API ID or API Hash not found in config.yaml');
    console.error('   Please add telegram.apiId and telegram.apiHash to your config');
    process.exit(1);
  }
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  try {
    // Import telegram dynamically
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions/index.js');
    
    const sessionFile = join(instanceDir, 'sessions', 'telegram.session');
    
    // Backup old session if exists
    if (existsSync(sessionFile)) {
      const backupFile = `${sessionFile}.backup-${Date.now()}`;
      console.log(`📦 Backing up old session to: ${backupFile}`);
      const { copyFileSync } = await import('node:fs');
      copyFileSync(sessionFile, backupFile);
      unlinkSync(sessionFile);
    }
    
    console.log('📱 Starting Telegram authentication...\n');
    
    const client = new TelegramClient(
      new StringSession(''),
      parseInt(apiId),
      apiHash,
      { connectionRetries: 5 }
    );
    
    await client.start({
      phoneNumber: async () => {
        return await prompt(rl, '📞 Enter phone number (with country code, e.g., +628123456789): ');
      },
      password: async () => {
        return await prompt(rl, '🔑 Enter 2FA password (if enabled): ');
      },
      phoneCode: async () => {
        console.log('\n⏳ Check your Telegram app for the login code...');
        return await prompt(rl, '🔢 Enter login code: ');
      },
      onError: (err) => {
        console.error('Error:', err.message);
      }
    });
    
    const sessionString = client.session.save();
    
    // Ensure sessions directory exists
    const { mkdirSync } = await import('node:fs');
    const sessionsDir = join(instanceDir, 'sessions');
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }
    
    // Save session
    writeFileSync(sessionFile, sessionString);
    
    console.log('\n✅ Authentication successful!');
    console.log(`   Session saved to: ${sessionFile}`);
    
    await client.disconnect();
    
    console.log('\n🔄 You can now restart MetaClaw:');
    console.log('   pm2 restart metaclaw');
    
  } catch (err) {
    console.error('\n❌ Authentication failed:', err.message);
    throw err;
  } finally {
    rl.close();
  }
}

async function authTelegram(instanceId) {
  const instanceDir = getInstanceDir(instanceId);
  const sessionFile = join(instanceDir, 'sessions', 'telegram.session');
  
  console.log(`🔐 Reconnecting Telegram for instance: ${instanceId}`);
  console.log(`   Session file: ${sessionFile}`);
  
  // Backup old session if exists
  if (existsSync(sessionFile)) {
    const backupFile = `${sessionFile}.backup-${Date.now()}`;
    console.log(`📦 Backing up old session to: ${backupFile}`);
    const { copyFileSync } = await import('node:fs');
    copyFileSync(sessionFile, backupFile);
    unlinkSync(sessionFile);
  }
  
  console.log('\n🔄 Please restart MetaClaw to trigger new authentication:');
  console.log(`   pm2 restart metaclaw`);
  console.log('\n📱 Then check logs for phone number prompt:');
  console.log(`   pm2 logs metaclaw`);
  console.log('\n✅ Done! The bot will ask for phone number on next start.');
  console.log('\n💡 Or use interactive mode:');
  console.log(`   metaclaw auth telegram ${instanceId} --interactive`);
}

async function authWhatsApp(instanceId) {
  const instanceDir = getInstanceDir(instanceId);
  const authDir = join(instanceDir, 'sessions', 'whatsapp-auth');
  
  console.log(`🔐 Reconnecting WhatsApp for instance: ${instanceId}`);
  console.log(`   Auth directory: ${authDir}`);
  
  // Remove old auth
  if (existsSync(authDir)) {
    console.log('🗑️  Removing old WhatsApp auth...');
    await import('node:fs').then(fs => fs.rmSync(authDir, { recursive: true, force: true }));
  }
  
  console.log('\n🔄 Please enable WhatsApp in config and restart:');
  console.log(`   1. Edit: ~/.metaclaw/instances/${instanceId}/config.yaml`);
  console.log(`   2. Set: whatsapp.enabled: true`);
  console.log(`   3. Restart: pm2 restart metaclaw`);
  console.log(`   4. Check Mission Control for QR code: http://localhost:3100`);
}

export async function authChannel(provider, instanceId, options = {}) {
  if (!provider || !instanceId) {
    console.log('Usage: metaclaw auth <telegram|whatsapp> <instance> [options]');
    console.log('');
    console.log('Examples:');
    console.log('  metaclaw auth telegram agent1              # Clear session, restart required');
    console.log('  metaclaw auth telegram agent1 -i           # Interactive auth (recommended)');
    console.log('  metaclaw auth whatsapp agent1              # Clear WhatsApp auth');
    process.exit(1);
  }
  
  // Validate instance exists
  loadInstanceConfig(instanceId);
  
  switch (provider.toLowerCase()) {
    case 'telegram':
    case 'tg':
      if (options.interactive) {
        await authTelegramInteractive(instanceId);
      } else {
        await authTelegram(instanceId);
      }
      break;
    case 'whatsapp':
    case 'wa':
      await authWhatsApp(instanceId);
      break;
    default:
      console.error(`❌ Unknown provider: ${provider}`);
      console.error('Supported: telegram, whatsapp');
      process.exit(1);
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const provider = args[0];
  const instanceId = args[1];
  const options = {
    interactive: args.includes('-i') || args.includes('--interactive')
  };
  
  authChannel(provider, instanceId, options).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
