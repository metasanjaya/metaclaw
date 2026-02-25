#!/usr/bin/env node
/**
 * MetaClaw Auth CLI - Authentication management
 * Usage: metaclaw auth <provider> <instance>
 */

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import yaml from 'js-yaml';
import { spawn } from 'node:child_process';

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

async function authTelegram(instanceId) {
  const instanceDir = getInstanceDir(instanceId);
  const sessionFile = join(instanceDir, 'sessions', 'telegram.session');
  
  console.log(`🔐 Reconnecting Telegram for instance: ${instanceId}`);
  console.log(`   Session file: ${sessionFile}`);
  
  // Backup old session if exists
  if (existsSync(sessionFile)) {
    const backupFile = `${sessionFile}.backup-${Date.now()}`;
    console.log(`📦 Backing up old session to: ${backupFile}`);
    import('node:fs').then(fs => fs.copyFileSync(sessionFile, backupFile));
    unlinkSync(sessionFile);
  }
  
  console.log('\n🔄 Please restart MetaClaw to trigger new authentication:');
  console.log(`   pm2 restart metaclaw`);
  console.log('\n📱 Then check logs for phone number prompt:');
  console.log(`   pm2 logs metaclaw`);
  console.log('\n✅ Done! The bot will ask for phone number on next start.');
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

export async function authChannel(provider, instanceId) {
  if (!provider || !instanceId) {
    console.log('Usage: metaclaw auth <telegram|whatsapp> <instance>');
    console.log('');
    console.log('Examples:');
    console.log('  metaclaw auth telegram agent1    # Reconnect Telegram');
    console.log('  metaclaw auth whatsapp agent1    # Reconnect WhatsApp');
    process.exit(1);
  }
  
  // Validate instance exists
  loadInstanceConfig(instanceId);
  
  switch (provider.toLowerCase()) {
    case 'telegram':
    case 'tg':
      await authTelegram(instanceId);
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
  const [provider, instanceId] = process.argv.slice(2);
  authChannel(provider, instanceId).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
