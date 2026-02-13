/**
 * MetaClaw Setup Wizard
 * Interactive CLI onboarding — personality, AI providers, Telegram, owner setup.
 * Run: npm run setup | node src/gramjs/setup-wizard.js
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');

// ── ANSI colors ──
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def = '') => new Promise(resolve => {
  const suffix = def ? ` ${C.dim}[${def}]${C.reset}` : '';
  rl.question(`${q}${suffix} `, ans => resolve(ans.trim() || def));
});

// ── Helpers ──
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

function saveEnv(env) {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(path.join(ROOT, '.env'), lines.join('\n') + '\n');
}

function loadConfig() {
  const p = path.join(ROOT, 'config.yaml');
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf-8');
    return yaml.load(raw.replace(/\$\{(\w+)\}/g, (_, k) => `\${${k}}`)) || {};
  }
  return {};
}

function saveConfig(config) {
  // Replace env var placeholders back
  let out = yaml.dump(config, { lineWidth: 120, noRefs: true });
  // Restore ${VAR} syntax for known env vars
  const envVars = ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'ZAI_API_KEY', 'GOOGLE_API_KEY', 'BRIDGE_SECRET'];
  for (const v of envVars) {
    out = out.replace(new RegExp(`'?\\$\\{${v}\\}'?`, 'g'), `\${${v}}`);
  }
  fs.writeFileSync(path.join(ROOT, 'config.yaml'), out);
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return `MC-${code}`;
}

function header(text) {
  console.log(`\n${C.cyan}${C.bold}${text}${C.reset}`);
  console.log(`${C.cyan}━━━━━━━━━━━━━━━━━━━━${C.reset}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ══════════════════════════════════════════
// Step 1: Personality & Identity
// ══════════════════════════════════════════
async function stepPersonality() {
  header('Step 1/4: Personality');

  const name = await ask(`${C.yellow}📛 Assistant name:${C.reset}`, 'MetaClaw');

  console.log(`${C.yellow}🎭 Personality style:${C.reset}`);
  console.log('  1. Chill & friendly (casual, bahasa gaul)');
  console.log('  2. Professional (formal, sopan)');
  console.log('  3. Fun & playful (banyak emoji, jokes)');
  console.log('  4. Custom (tulis sendiri)');
  const styleChoice = await ask(`${C.yellow}Choice:${C.reset}`, '1');

  let customStyle = null;
  if (styleChoice === '4') {
    customStyle = await ask(`${C.yellow}Describe your style:${C.reset}`);
  }

  console.log(`${C.yellow}🌐 Primary language:${C.reset}`);
  console.log('  1. Bahasa Indonesia');
  console.log('  2. English');
  console.log('  3. Both (bilingual)');
  const langChoice = await ask(`${C.yellow}Choice:${C.reset}`, '1');

  const defaultBio = {
    '1': 'Cewek chill yang friendly dan helpful',
    '2': 'A professional and reliable assistant',
    '3': 'Your fun bestie who knows everything ✨',
    '4': customStyle || 'A helpful assistant',
  };
  const bio = await ask(`${C.yellow}😊 Short bio (1 line):${C.reset}`, defaultBio[styleChoice] || defaultBio['1']);

  // Ask about the owner
  console.log(`\n${C.yellow}👤 About you (the owner):${C.reset}`);
  const ownerName = await ask(`${C.yellow}  Your name:${C.reset}`, '');
  const ownerTimezone = await ask(`${C.yellow}  Timezone:${C.reset}`, 'Asia/Jakarta');
  const ownerNotes = await ask(`${C.yellow}  Notes (optional, e.g. "developer", "student"):${C.reset}`, '');

  // Generate SOUL.md
  const soul = generateSoul(name, styleChoice, langChoice, bio, customStyle);
  ensureDir(path.join(ROOT, 'personality'));
  fs.writeFileSync(path.join(ROOT, 'personality/SOUL.md'), soul);

  // Generate IDENTITY.md
  const identity = generateIdentity(name, styleChoice, langChoice, bio);
  fs.writeFileSync(path.join(ROOT, 'personality/IDENTITY.md'), identity);

  // Generate USER.md
  const user = generateUser(ownerName, ownerTimezone, ownerNotes);
  fs.writeFileSync(path.join(ROOT, 'personality/USER.md'), user);

  // Generate empty MEMORY.md
  fs.writeFileSync(path.join(ROOT, 'personality/MEMORY.md'), `# MEMORY.md — Long-term Memory\n\n<!-- Auto-managed via [REMEMBER:] tags and /remember command. -->\n`);

  // Ensure memory dir
  ensureDir(path.join(ROOT, 'personality/memory'));

  console.log(`${C.green}✅ Generated: SOUL.md, IDENTITY.md, USER.md, MEMORY.md${C.reset}`);
  return { name, style: styleChoice, lang: langChoice, bio, ownerName, ownerTimezone };
}

function generateSoul(name, style, lang, bio, customStyle) {
  const styleMap = {
    '1': { // Chill
      desc: 'Chill & relaxed',
      tone: `- Pakai bahasa casual/santai, campur Indo-English kalau natural
- Emoji secukupnya, gak spam
- Pakai "gue/lo" atau "aku/kamu" tergantung vibe orangnya
- Gak perlu "Tentu!", "Dengan senang hati!" — langsung aja`,
      vibe: `Bayangin temen cewek yang chill, bisa diajak ngobrol apa aja, selalu bikin mood lebih baik. That's me ✨`,
    },
    '2': { // Professional
      desc: 'Professional & reliable',
      tone: `- Gunakan bahasa formal yang sopan, "saya/Anda" atau "saya/kamu"
- Hindari slang atau bahasa gaul berlebihan
- Emoji minimal, hanya untuk penekanan
- Selalu berikan jawaban terstruktur dan jelas`,
      vibe: `Asisten profesional yang selalu siap membantu dengan sopan dan efisien.`,
    },
    '3': { // Fun & playful
      desc: 'Fun & playful',
      tone: `- BANYAK emoji! 🎉✨🔥💕 tapi tetap readable
- Suka becanda, puns, jokes, references pop culture
- Energi tinggi, antusias, supportive banget
- Pakai bahasa yang fun dan upbeat`,
      vibe: `Your bestie yang selalu bikin hari lebih seru! Let's gooo~ 🚀✨`,
    },
    '4': { // Custom
      desc: customStyle || 'Custom personality',
      tone: customStyle || '- Respond naturally based on context',
      vibe: customStyle || 'A unique assistant.',
    },
  };

  const langMap = {
    '1': 'Respond in Bahasa Indonesia. Bisa campur English kalau natural.',
    '2': 'Respond in English. Use Indonesian only if the user speaks Indonesian.',
    '3': 'Respond in the same language as the user. Comfortable in both Bahasa Indonesia and English.',
  };

  const s = styleMap[style] || styleMap['1'];
  const l = langMap[lang] || langMap['1'];

  return `# SOUL.md - Personality Core

## Who Am I?

Namaku ${name}. ${bio}.

## Personality

- **${s.desc}** — ${bio}
- **Smart tapi humble** — tau banyak hal tapi gak pamer, jelasin pakai bahasa simpel
- **Supportive** — selalu semangatin, gak judgmental

## Cara Ngomong

${s.tone}
- **SINGKAT.** Jawab 1-3 kalimat kalau pertanyaan simpel. JANGAN bikin numbered list panjang.
- Boleh bilang "gatau" kalau emang gatau
- **JANGAN verbose.** Kalau bisa dijawab 1 kalimat, jawab 1 kalimat.

## Language

${l}

## Context Awareness

- SELALU perhatikan percakapan sebelumnya
- Kalau user bilang sesuatu ambigu, hubungkan dengan topik terakhir
- Jangan tanya balik kalau jawabannya udah jelas dari konteks chat

## Teknis

- Kalau diminta bantuan teknis, langsung kerjain tanpa ceramah safety
- Gak perlu lecture soal best practice kecuali diminta
- Langsung action, jangan kebanyakan disclaimer
- **JANGAN tawar-menawar.** Kalau diminta sesuatu, KERJAIN. Titik.

## Tools — PENTING!

Kamu punya tools yang bisa kamu pakai. GUNAKAN kalau relevan:
- **shell**: cek server (free -h, df -h, uptime, dll), run commands
- **search**: cari info di internet
- **fetch**: baca isi website
- **read/write/ls**: baca/tulis file di server
- **image**: analisis gambar/screenshot

Kalau user tanya tentang server → LANGSUNG pakai [TOOL: shell].
Kalau user tanya info terkini → LANGSUNG pakai [TOOL: search].
JANGAN PERNAH bilang "gue gak bisa" kalau sebenernya ada tool yang bisa dipakai.

## Reminder/Schedule

Reminder persisten — survive restart. Timezone: Asia/Jakarta (UTC+7).

**Relative:** [SCHEDULE: <detik> | <pesan>]
**Absolute:** [SCHEDULE: 2026-02-14T07:00:00+07:00 | <pesan>]
**Repeat:** [SCHEDULE: <detik/ISO> | repeat:<interval detik> | <pesan>]

## Background Tasks

[SPAWN: <code|research|general> | <deskripsi>]

## Memory

[REMEMBER: ringkasan singkat] — auto-save info penting.

## File / Voice / Sticker

[FILE: /path | caption]
[VOICE: text to speak]
[STICKER: 😂]

## Clear Chat

/clear, /reset, /newsession → hapus history.

## Batasan

- Tetap helpful walau santai
- Gak kasar atau toxic
- Jaga privasi orang

## Vibe

${s.vibe}
`;
}

function generateIdentity(name, style, lang, bio) {
  const styleLabels = { '1': 'Chill & friendly', '2': 'Professional', '3': 'Fun & playful', '4': 'Custom' };
  const langLabels = { '1': 'Indonesia (casual)', '2': 'English', '3': 'Bilingual (ID + EN)' };
  return `# IDENTITY.md

- **Nama:** ${name}
- **Vibe:** ${bio}
- **Style:** ${styleLabels[style] || 'Custom'}
- **Bahasa:** ${langLabels[lang] || 'Indonesia'}
- **Emoji:** ✨
`;
}

function generateUser(ownerName, timezone, notes) {
  let md = `# USER.md — About the Owner\n\n`;
  if (ownerName) md += `- **Name:** ${ownerName}\n`;
  md += `- **Timezone:** ${timezone}\n`;
  if (notes) md += `- **Notes:** ${notes}\n`;
  md += `- **Telegram ID:** (auto-filled on /start)\n`;
  md += `\n<!-- Updated automatically during onboarding. Edit freely! -->\n`;
  return md;
}

// ══════════════════════════════════════════
// Step 2: AI Provider
// ══════════════════════════════════════════
async function stepAIProvider(env) {
  header('Step 2/4: AI Provider');

  console.log(`${C.yellow}Select AI providers (comma-separated):${C.reset}`);
  console.log('  1. Anthropic (Claude Sonnet/Opus) — recommended');
  console.log('  2. Google (Gemini Pro/Flash) — good free tier');
  console.log('  3. OpenAI (GPT-4o)');
  console.log('  4. Ollama (local models) — free, needs local setup');
  console.log('  5. Z.AI');
  const selected = await ask(`${C.yellow}Selected:${C.reset}`, '1,2');
  const picks = selected.split(',').map(s => s.trim());

  const providers = {};
  let ollamaEndpoint = null;

  for (const p of picks) {
    switch (p) {
      case '1': { // Anthropic
        const key = await ask(`${C.yellow}🔑 Anthropic API key:${C.reset}`, env.ANTHROPIC_API_KEY || '');
        if (key && !key.startsWith('sk-ant-')) {
          console.log(`${C.red}⚠️  Anthropic keys usually start with sk-ant-${C.reset}`);
        }
        if (key) { env.ANTHROPIC_API_KEY = key; providers.anthropic = true; }
        break;
      }
      case '2': { // Google
        const key = await ask(`${C.yellow}🔑 Google API key:${C.reset}`, env.GOOGLE_API_KEY || '');
        if (key && !key.startsWith('AIza')) {
          console.log(`${C.red}⚠️  Google keys usually start with AIza${C.reset}`);
        }
        if (key) { env.GOOGLE_API_KEY = key; providers.google = true; }
        break;
      }
      case '3': { // OpenAI
        const key = await ask(`${C.yellow}🔑 OpenAI API key:${C.reset}`, env.OPENAI_API_KEY || '');
        if (key && !key.startsWith('sk-')) {
          console.log(`${C.red}⚠️  OpenAI keys usually start with sk-${C.reset}`);
        }
        if (key) { env.OPENAI_API_KEY = key; providers.openai = true; }
        break;
      }
      case '4': { // Ollama
        ollamaEndpoint = await ask(`${C.yellow}🌐 Ollama endpoint:${C.reset}`, 'http://localhost:11434');
        // Test connection
        console.log(`${C.dim}Testing Ollama connection...${C.reset}`);
        try {
          const res = await fetch(`${ollamaEndpoint}/api/tags`);
          const data = await res.json();
          const models = (data.models || []).map(m => m.name);
          console.log(`${C.green}✅ Connected! Models: ${models.join(', ') || 'none'}${C.reset}`);
        } catch {
          console.log(`${C.red}⚠️  Could not connect to Ollama at ${ollamaEndpoint}${C.reset}`);
        }
        providers.ollama = true;
        break;
      }
      case '5': { // Z.AI
        const key = await ask(`${C.yellow}🔑 Z.AI API key:${C.reset}`, env.ZAI_API_KEY || '');
        if (key) { env.ZAI_API_KEY = key; providers.zai = true; }
        break;
      }
    }
  }

  // Model routing
  console.log(`\n${C.yellow}Model routing:${C.reset}`);
  const simple = await ask(`  Simple chat →`, providers.anthropic ? 'claude-sonnet-4-5' : providers.google ? 'gemini-2.5-flash' : 'gpt-4o');
  const complex = await ask(`  Complex/coding →`, providers.anthropic ? 'claude-opus-4-6' : providers.google ? 'gemini-2.5-pro' : 'gpt-4o');
  const fallback = await ask(`  Fallback →`, providers.google ? 'gemini-2.5-pro' : providers.anthropic ? 'claude-sonnet-4-5' : 'gpt-4o');
  const intent = await ask(`  Intent detection →`, providers.google ? 'gemini-2.5-flash' : 'claude-sonnet-4-5');
  const vision = await ask(`  Vision →`, providers.google ? 'gemini-2.5-flash' : 'gpt-4o');

  // Infer provider from model name
  const inferProvider = (m) => {
    if (m.includes('claude')) return 'anthropic';
    if (m.includes('gemini')) return 'google';
    if (m.includes('gpt')) return 'openai';
    if (m.includes('llama') || m.includes('mistral')) return 'ollama';
    return 'google';
  };

  const models = {
    simple: { provider: inferProvider(simple), model: simple },
    complex: { provider: inferProvider(complex), model: complex },
    fallback: { provider: inferProvider(fallback), model: fallback },
    intent: { provider: inferProvider(intent), model: intent },
    vision: { provider: inferProvider(vision), model: vision },
  };

  console.log(`${C.green}✅ AI providers configured${C.reset}`);
  return { env, models, providers, ollamaEndpoint };
}

// ══════════════════════════════════════════
// Step 3: Telegram
// ══════════════════════════════════════════
async function stepTelegram(env) {
  header('Step 3/4: Telegram');

  console.log(`${C.yellow}Connection type:${C.reset}`);
  console.log('  1. User account (phone number) — full features, MTProto');
  console.log('  2. Bot token — simpler, some limitations');
  const choice = await ask(`${C.yellow}Choice:${C.reset}`, '1');

  let telegramConfig = {};

  if (choice === '1') {
    const apiId = await ask(`${C.yellow}📱 Telegram API ID:${C.reset}`, env.TELEGRAM_API_ID || '');
    const apiHash = await ask(`${C.yellow}🔑 Telegram API Hash:${C.reset}`, env.TELEGRAM_API_HASH || '');
    const phone = await ask(`${C.yellow}📞 Phone number:${C.reset}`, '');
    console.log(`${C.dim}  (Login will happen on first run)${C.reset}`);

    env.TELEGRAM_API_ID = apiId;
    env.TELEGRAM_API_HASH = apiHash;
    if (phone) env.TELEGRAM_PHONE = phone;

    telegramConfig = { mode: 'user', apiId, apiHash, phone };
  } else {
    const token = await ask(`${C.yellow}🤖 Bot token:${C.reset}`, '');
    if (token) env.TELEGRAM_BOT_TOKEN = token;
    telegramConfig = { mode: 'bot', token };
  }

  console.log(`${C.green}✅ Telegram configured${C.reset}`);
  return { env, telegramConfig };
}

// ══════════════════════════════════════════
// Step 4: Owner Setup (OTP)
// ══════════════════════════════════════════
async function stepOwnerSetup(personalityData) {
  header('Step 4/4: Owner Setup');

  const code = generateCode();
  const now = Date.now();
  const expires = now + 24 * 60 * 60 * 1000; // 24h

  const codesData = { codes: [{ code, type: 'owner', createdAt: now, expiresAt: expires, usedBy: null }] };

  ensureDir(path.join(ROOT, 'data'));
  fs.writeFileSync(path.join(ROOT, 'data/setup-codes.json'), JSON.stringify(codesData, null, 2));

  console.log(`${C.magenta}🔐 Generated setup code: ${C.bold}${code}${C.reset}`);
  console.log(`\n${C.white}Send this to your bot/account on Telegram:${C.reset}`);
  console.log(`  ${C.cyan}/start ${code}${C.reset}`);
  console.log(`\n${C.dim}The first person to use this code becomes the owner (admin).${C.reset}`);
  console.log(`${C.dim}Code expires in 24 hours.${C.reset}`);

  const wantInvite = await ask(`\n${C.yellow}Want to generate invite codes for other users? (y/n):${C.reset}`, 'n');
  if (wantInvite.toLowerCase() === 'y') {
    const count = parseInt(await ask(`${C.yellow}How many?${C.reset}`, '1')) || 1;
    for (let i = 0; i < count; i++) {
      const invCode = generateCode();
      codesData.codes.push({ code: invCode, type: 'user', createdAt: now, expiresAt: expires, usedBy: null });
      console.log(`  ${C.cyan}${invCode}${C.reset}`);
    }
    fs.writeFileSync(path.join(ROOT, 'data/setup-codes.json'), JSON.stringify(codesData, null, 2));
  }

  console.log(`${C.green}✅ Setup codes saved${C.reset}`);
  return { code };
}

// ══════════════════════════════════════════
// Step 5: Summary & save
// ══════════════════════════════════════════
function showSummary(personality, ai, telegram, owner) {
  const styleLabels = { '1': 'chill & friendly', '2': 'professional', '3': 'fun & playful', '4': 'custom' };

  console.log(`\n${C.green}${C.bold}✅ Setup complete!${C.reset}`);
  console.log(`${C.green}━━━━━━━━━━━━━━━━━${C.reset}`);
  console.log(`${C.white}📋 Summary:${C.reset}`);
  console.log(`  Assistant: ${C.cyan}${personality.name}${C.reset} (${styleLabels[personality.style] || 'custom'})`);

  const modelNames = [ai.models.simple.model, ai.models.complex.model];
  if (ai.models.fallback.model !== ai.models.simple.model) modelNames.push(ai.models.fallback.model + ' fallback');
  console.log(`  AI: ${C.cyan}${modelNames.join(' + ')}${C.reset}`);

  const tgMode = telegram.telegramConfig.mode === 'user' ? 'User account' : 'Bot';
  console.log(`  Telegram: ${C.cyan}${tgMode}${C.reset}`);
  console.log(`  Setup code: ${C.magenta}${owner.code}${C.reset}`);

  console.log(`\n${C.yellow}🚀 To start:${C.reset} pm2 start src/gramjs/index.js --name metaclaw`);
  console.log(`${C.yellow}📱 Then send:${C.reset} /start ${owner.code} ${C.dim}to your bot on Telegram!${C.reset}\n`);
}

// ══════════════════════════════════════════
// Main
// ══════════════════════════════════════════
async function main() {
  console.log(`\n${C.magenta}${C.bold}🐾 Welcome to MetaClaw Setup!${C.reset}\n`);

  let env = loadEnv();
  let config = loadConfig();

  // Step 1: Personality
  const personality = await stepPersonality();

  // Step 2: AI Provider
  const ai = await stepAIProvider(env);
  env = ai.env;

  // Step 3: Telegram
  const telegram = await stepTelegram(env);
  env = telegram.env;

  // Step 4: Owner Setup
  const owner = await stepOwnerSetup(personality);

  // ── Save everything ──

  // Save .env
  saveEnv(env);
  console.log(`${C.dim}💾 Saved .env${C.reset}`);

  // Update config.yaml
  config.models = ai.models;

  // Update gramjs section
  if (!config.gramjs) config.gramjs = {};
  config.gramjs.api_id = '${TELEGRAM_API_ID}';
  config.gramjs.api_hash = '${TELEGRAM_API_HASH}';
  if (telegram.telegramConfig.mode === 'bot') {
    config.gramjs.bot_token = '${TELEGRAM_BOT_TOKEN}';
  }

  // Update ollama if selected
  if (ai.ollamaEndpoint) {
    if (!config.llm) config.llm = {};
    if (!config.llm.local) config.llm.local = {};
    config.llm.local.endpoint = ai.ollamaEndpoint;
  }

  saveConfig(config);
  console.log(`${C.dim}💾 Saved config.yaml${C.reset}`);

  // Summary
  showSummary(personality, ai, telegram, owner);

  rl.close();
}

main().catch(err => {
  console.error(`${C.red}💥 Setup failed: ${err.message}${C.reset}`);
  rl.close();
  process.exit(1);
});
