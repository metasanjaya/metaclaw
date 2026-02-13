/**
 * GramJS Entry Point
 * Loads config, initializes GramJS client + bridge, starts listening.
 */

import dotenv from 'dotenv';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GramJSClient } from './GramJSClient.js';
import { GramJSBridge } from './GramJSBridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '../..');

// Load env
dotenv.config({ path: path.join(projectRoot, '.env') });

// Load config (config.local.yaml > config.yaml)
const localConfigPath = path.join(projectRoot, 'config.local.yaml');
const defaultConfigPath = path.join(projectRoot, 'config.yaml');
const configPath = fs.existsSync(localConfigPath) ? localConfigPath : defaultConfigPath;
const rawConfig = fs.readFileSync(configPath, 'utf-8');
const config = yaml.load(rawConfig.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || ''));
console.log(`📋 Config loaded from ${path.basename(configPath)}`);

// Build gramjs config
const gramConfig = {
  api_id: config.gramjs?.api_id || process.env.TELEGRAM_API_ID,
  api_hash: config.gramjs?.api_hash || process.env.TELEGRAM_API_HASH,
  session_file: config.gramjs?.session_file || 'data/session.txt',
  whitelist: config.gramjs?.whitelist || [],
  group_mode: config.gramjs?.group_mode || 'mention_only',
};

if (!gramConfig.api_id || !gramConfig.api_hash) {
  console.error('❌ TELEGRAM_API_ID and TELEGRAM_API_HASH required in .env or config.yaml');
  process.exit(1);
}

console.log(`📋 Whitelist: ${gramConfig.whitelist.length ? gramConfig.whitelist.join(', ') : 'none (all allowed)'}`);

async function main() {
  console.log('🚀 Starting MetaClaw GramJS Bridge...');

  const client = new GramJSClient(gramConfig);
  await client.connect();

  const bridge = new GramJSBridge(config, client);
  bridge.start();

  console.log('✅ MetaClaw GramJS Bridge running. Press Ctrl+C to stop.');

  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    await client.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
