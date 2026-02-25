#!/usr/bin/env node
/**
 * MetaClaw Terminal Client
 * Connects to running Mission Control instance via WebSocket
 */

import WebSocket from 'ws';
import { createInterface } from 'node:readline';

const MC_URL = process.env.METACLAW_MC_URL || 'ws://localhost:3100/ws';
const instance = process.argv[2] || 'default';

// ANSI colors
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const gray = (s) => `\x1b[90m${s}\x1b[0m`;

console.log(gray('Connecting...'));

const ws = new WebSocket(MC_URL);
let rl = null;
let waitingResponse = false;

ws.on('open', () => {
  // Print header
  console.log('');
  console.log(cyan('╔══════════════════════════════════════╗'));
  console.log(cyan('║       🤖 MetaClaw Terminal           ║'));
  console.log(cyan('╚══════════════════════════════════════╝'));
  console.log(gray(`Instance: ${instance}`));
  console.log(gray('Type /quit to exit'));
  console.log('');
  
  // Join chat for this instance
  ws.send(JSON.stringify({ type: 'join_chat', instanceId: instance }));
  
  // Setup readline after connected
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: cyan('❯ '),
  });
  
  rl.on('line', (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    
    if (trimmed === '/quit' || trimmed === '/exit') {
      ws.close();
      return;
    }
    
    if (trimmed === '/clear') {
      console.clear();
      rl.prompt();
      return;
    }
    
    // Show user message
    console.log(cyan('You:   ') + trimmed);
    waitingResponse = true;
    
    ws.send(JSON.stringify({
      type: 'chat_message',
      instanceId: instance,
      text: trimmed,
    }));
  });
  
  rl.on('close', () => {
    ws.close();
  });
  
  rl.prompt();
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.type === 'chat_message') {
    const m = msg.message;
    if (m.role === 'assistant') {
      console.log('\n' + green(`${instance}: `) + m.text);
      waitingResponse = false;
      if (rl) rl.prompt();
    }
  } else if (msg.type === 'error') {
    console.log('\n⚠️  ' + msg.error);
    waitingResponse = false;
    if (rl) rl.prompt();
  }
});

ws.on('error', (err) => {
  console.error('❌ Connection failed:', err.message);
  console.log(gray('\nMake sure MetaClaw is running:'));
  console.log(gray('  pm2 start ecosystem.config.cjs'));
  process.exit(1);
});

ws.on('close', () => {
  console.log(gray('\nDisconnected'));
  process.exit(0);
});
