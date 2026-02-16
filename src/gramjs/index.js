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
import { validateConfig } from '../core/ConfigValidator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(ROOT, '.env') });

/**
 * Load and merge config files with env var substitution
 */
function loadConfig() {
  const mainPath = path.join(ROOT, 'config.yaml');
  const localPath = path.join(ROOT, 'config.local.yaml');

  let raw = fs.readFileSync(mainPath, 'utf8');

  // Env var substitution: ${VAR_NAME}
  raw = raw.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || '');

  let config = yaml.load(raw);

  // Merge local overrides if exists
  if (fs.existsSync(localPath)) {
    let localRaw = fs.readFileSync(localPath, 'utf8');
    localRaw = localRaw.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || '');
    const localConfig = yaml.load(localRaw);
    config = deepMerge(config, localConfig);
  }

  // Validate config with Zod
  return validateConfig(config);
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

async function main() {
  console.log('🚀 Starting MetaClaw GramJS...');

  const config = loadConfig();

  const client = new GramJSClient(config.gramjs);
  await client.connect();
  const bridge = new GramJSBridge(config, client);
  bridge.start();

  console.log('✅ MetaClaw GramJS is running');

  // Graceful shutdown
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
