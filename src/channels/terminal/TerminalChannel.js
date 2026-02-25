import { Channel } from '../Channel.js';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// Dynamic import for picocolors (optional dependency)
let pc;
try {
  const mod = await import('picocolors');
  pc = mod.default;
} catch {
  // Fallback if picocolors not installed
  pc = {
    blue: (s) => `\x1b[34m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    magenta: (s) => `\x1b[35m${s}\x1b[0m`,
    gray: (s) => `\x1b[90m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
  };
}

/**
 * Terminal Channel — CLI interface for MetaClaw.
 * Developer-friendly REPL with streaming output, history, and session persistence.
 */
export class TerminalChannel extends Channel {
  /**
   * @param {Object} opts
   * @param {string} [opts.id]
   * @param {Object} opts.config — { prompt, historyFile, sessionFile, theme }
   * @param {import('../../core/EventBus.js').EventBus} opts.eventBus
   */
  constructor({ id, config, eventBus }) {
    super(id || 'terminal', 'terminal', config);
    this.eventBus = eventBus;
    this.prompt = config.prompt || '❯ ';
    this.theme = config.theme || 'dark';
    this.historyFile = config.historyFile || join(homedir(), '.metaclaw', 'terminal-history.txt');
    this.sessionFile = config.sessionFile || join(homedir(), '.metaclaw', 'terminal-session.json');
    this.maxHistory = config.maxHistory || 1000;
    this.streaming = config.streaming !== false;
    
    /** @type {import('node:readline').Interface|null} */
    this.rl = null;
    /** @type {boolean} */
    this.isProcessing = false;
    /** @type {Array<{role: string, content: string}>} */
    this.sessionHistory = [];
    /** @type {string} */
    this.currentStream = '';
  }

  async connect() {
    this.status = 'connecting';
    
    // Add blank lines to separate from initialization logs
    console.log('\n\n');
    
    // Ensure history directory exists
    const historyDir = dirname(this.historyFile);
    if (historyDir) mkdirSync(historyDir, { recursive: true });
    
    // Load session history if exists
    this._loadSession();
    
    // Create readline interface
    this.rl = createInterface({
      input: stdin,
      output: stdout,
      prompt: pc.cyan(this.prompt),
      historySize: this.maxHistory,
      completer: (line) => this._completer(line),
    });
    
    // Load persisted history
    if (existsSync(this.historyFile)) {
      const history = readFileSync(this.historyFile, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .reverse();
      this.rl.history = history;
    }
    
    // Handle input
    this.rl.on('line', (input) => this._handleInput(input));
    this.rl.on('close', () => this._handleClose());
    
    // Handle SIGINT gracefully
    process.on('SIGINT', () => this._handleSigint());
    
    this.status = 'connected';
    
    // Print welcome message
    this._printWelcome();
    this.rl.prompt();
  }

  async disconnect() {
    this._saveSession();
    this._saveHistory();
    
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    
    this.status = 'disconnected';
    console.log(pc.dim('\n👋 Goodbye!'));
  }

  async sendText(chatId, text, opts = {}) {
    const { streaming = this.streaming, streamingDone = true } = opts;
    
    if (streaming && !streamingDone) {
      // Streaming chunk - append to current line
      process.stdout.write(text);
      this.currentStream += text;
    } else if (streaming && streamingDone) {
      // Final chunk - add newline
      const remaining = text.slice(this.currentStream.length);
      if (remaining) process.stdout.write(remaining);
      process.stdout.write('\n');
      this.currentStream = '';
      
      // Add to session history
      this.sessionHistory.push({ role: 'assistant', content: text });
      this._trimSession();
      
      // Show prompt again
      this.rl?.prompt();
      this.isProcessing = false;
    } else {
      // Non-streaming: print with prefix and prompt
      const prefix = pc.green('Nayla: ');
      console.log('\n' + prefix + text.replace(/\n/g, '\n' + ' '.repeat(7)));
      this.sessionHistory.push({ role: 'assistant', content: text });
      this._trimSession();
      this.rl?.prompt();
      this.isProcessing = false;
    }
  }

  async sendMedia(chatId, media, opts) {
    console.log(pc.yellow('📎 Media received:'), media.type || 'unknown');
    if (media.caption) {
      console.log(pc.gray('Caption:'), media.caption);
    }
    this.rl?.prompt();
  }

  capabilities() {
    return {
      reactions: false,
      inlineButtons: false,
      voice: false,
      media: [],
      maxMessageLength: 100000,
      markdown: true,
      threads: false,
      edit: false,
      delete: false,
    };
  }

  async healthCheck() {
    return {
      status: this.status === 'connected' ? 'healthy' : 'unhealthy',
      message: 'Terminal REPL',
      timestamp: Date.now(),
    };
  }

  // --- Private Methods ---

  _printWelcome() {
    console.log('');
    console.log(pc.bold(pc.cyan('╔══════════════════════════════════════╗')));
    console.log(pc.bold(pc.cyan('║       🤖 MetaClaw Terminal           ║')));
    console.log(pc.bold(pc.cyan('╚══════════════════════════════════════╝')));
    console.log(pc.dim('Type /help for commands, /quit to exit'));
    console.log('');
  }

  _completer(line) {
    const commands = ['/help', '/quit', '/exit', '/clear', '/history', '/save', '/load', '/status'];
    const hits = commands.filter(c => c.startsWith(line));
    return [hits.length ? hits : [], line];
  }

  async _handleInput(input) {
    const trimmed = input.trim();
    
    // Skip empty lines
    if (!trimmed) {
      this.rl?.prompt();
      return;
    }
    
    // Handle commands
    if (trimmed.startsWith('/')) {
      await this._handleCommand(trimmed);
      return;
    }
    
    // Check if already processing
    if (this.isProcessing) {
      console.log(pc.yellow('⚠️  Still processing previous message...'));
      this.rl?.prompt();
      return;
    }
    
    // Show user input with prefix
    const userPrefix = pc.cyan('You:   ');
    console.log(userPrefix + trimmed);
    
    // Mark as processing
    this.isProcessing = true;
    
    // Add to session history
    this.sessionHistory.push({ role: 'user', content: trimmed });
    this._trimSession();
    
    // Dispatch message to handlers
    this._dispatch({
      id: `term-${Date.now()}`,
      channelId: this.id,
      chatId: 'terminal',
      senderId: 'user',
      text: trimmed,
      timestamp: Date.now(),
      replyTo: null,
      attachments: [],
    });
    
    // Don't prompt here - wait for response
  }

  async _handleCommand(cmd) {
    const [command, ...args] = cmd.split(' ');
    
    switch (command) {
      case '/help':
        console.log(pc.bold('\n📖 Available Commands:'));
        console.log(pc.gray('  /help     ') + 'Show this help');
        console.log(pc.gray('  /quit     ') + 'Exit terminal');
        console.log(pc.gray('  /exit     ') + 'Alias for /quit');
        console.log(pc.gray('  /clear    ') + 'Clear screen');
        console.log(pc.gray('  /history  ') + 'Show conversation history');
        console.log(pc.gray('  /save     ') + 'Save session to file');
        console.log(pc.gray('  /load     ') + 'Load session from file');
        console.log(pc.gray('  /status   ') + 'Show instance status');
        console.log('');
        break;
        
      case '/quit':
      case '/exit':
        await this.disconnect();
        process.exit(0);
        
      case '/clear':
        console.clear();
        break;
        
      case '/history':
        this._showHistory();
        break;
        
      case '/save':
        this._saveSession();
        console.log(pc.green('✅ Session saved'));
        break;
        
      case '/load':
        this._loadSession();
        console.log(pc.green('✅ Session loaded'));
        break;
        
      case '/status':
        console.log(pc.cyan('Status:'), this.status);
        console.log(pc.cyan('History:'), this.sessionHistory.length, 'messages');
        break;
        
      default:
        console.log(pc.red(`❌ Unknown command: ${command}`));
        console.log(pc.dim('Type /help for available commands'));
    }
    
    this.rl?.prompt();
  }

  _showHistory() {
    if (this.sessionHistory.length === 0) {
      console.log(pc.dim('No conversation history'));
      return;
    }
    
    console.log(pc.bold('\n📜 Conversation History:'));
    console.log(pc.gray('─'.repeat(50)));
    
    for (const msg of this.sessionHistory) {
      const prefix = msg.role === 'user' 
        ? pc.cyan('You:   ')
        : pc.green('Bot:   ');
      const preview = msg.content.slice(0, 100) + (msg.content.length > 100 ? '...' : '');
      console.log(prefix + preview.replace(/\n/g, ' '));
    }
    
    console.log(pc.gray('─'.repeat(50)));
    console.log(pc.dim(`Total: ${this.sessionHistory.length} messages\n`));
  }

  _loadSession() {
    if (existsSync(this.sessionFile)) {
      try {
        const data = JSON.parse(readFileSync(this.sessionFile, 'utf-8'));
        this.sessionHistory = data.messages || [];
      } catch (e) {
        console.error(pc.red('Failed to load session:'), e.message);
        this.sessionHistory = [];
      }
    }
  }

  _saveSession() {
    try {
      const sessionDir = dirname(this.sessionFile);
      if (sessionDir) mkdirSync(sessionDir, { recursive: true });
      
      writeFileSync(this.sessionFile, JSON.stringify({
        messages: this.sessionHistory,
        savedAt: new Date().toISOString(),
      }, null, 2));
    } catch (e) {
      console.error(pc.red('Failed to save session:'), e.message);
    }
  }

  _saveHistory() {
    if (!this.rl?.history) return;
    
    try {
      const historyDir = dirname(this.historyFile);
      if (historyDir) mkdirSync(historyDir, { recursive: true });
      
      const lines = [...this.rl.history].reverse().slice(-this.maxHistory);
      writeFileSync(this.historyFile, lines.join('\n') + '\n');
    } catch (e) {
      // Silent fail for history
    }
  }

  _trimSession() {
    const max = this.config.maxSessionMessages || 100;
    if (this.sessionHistory.length > max) {
      this.sessionHistory = this.sessionHistory.slice(-max);
    }
  }

  _handleClose() {
    this._saveSession();
    this._saveHistory();
    console.log(pc.dim('\n👋 Goodbye!'));
    process.exit(0);
  }

  _handleSigint() {
    if (this.isProcessing) {
      console.log(pc.yellow('\n⚠️  Cancelling...'));
      this.isProcessing = false;
      this.rl?.prompt();
    } else {
      this.disconnect().then(() => process.exit(0));
    }
  }
}
