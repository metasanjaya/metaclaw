# MetaClaw 🐾 v3

![Version](https://img.shields.io/badge/version-3.0.0-blue)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Multi-instance AI assistant platform** with native function calling, Mission Control dashboard, and cross-instance delegation.

---

## 🚀 What's New in v3

| Feature | Description |
|---------|-------------|
| **Multi-Instance** | Run multiple AI agents (agent1, agent2, etc.) simultaneously |
| **Mission Control** | Web dashboard for monitoring all instances (uWebSockets.js + vanilla JS) |
| **21 Native Tools** | Shell, web, files, media, scheduling, sub-agents, memory, knowledge |
| **Vision & Voice** | Image analysis (Kimi/Gemini) + voice transcription (Gemini) |
| **Terminal Channel** | CLI/REPL interface for headless servers |
| **WhatsApp Channel** | Baileys integration for WhatsApp Web |
| **Scheduler** | Native cron with Telegram delivery |
| **Session Spawner** | Background AI tasks with auto-announce |
| **Debug Logger** | Per-request/response JSON logs for troubleshooting |
| **Multi-Provider** | Kimi, Claude, Gemini, OpenAI, MiniMax, Ollama support |

---

## ✨ Core Features

### Multi-Instance Architecture
- 🏗️ **Multiple Agents** — Run separate instances with different personalities/purposes
- 🔄 **Cross-Instance Delegation** — Delegate tasks between agents via Redis pub/sub
- 📊 **Centralized Monitoring** — Mission Control dashboard for all instances
- 💾 **Isolated Storage** — Each instance has separate memory, knowledge, and config

### AI Providers
- 🌙 **Kimi k2.5** — Primary model (fast, reliable function calling)
- 🔮 **Claude Opus/Sonnet** — Complex reasoning tasks
- ✨ **Gemini Flash/Pro** — Vision and transcription
- 🤖 **OpenAI / MiniMax / Ollama** — Fallback and local options

### Channels
- 💬 **Telegram** — GramJS MTProto integration
- 📱 **WhatsApp** — Baileys Web integration (on-demand QR login)
- 🖥️ **Mission Control** — Web dashboard with real-time logs
- ⌨️ **Terminal** — CLI/REPL for headless servers

### Native Tools (21 Built-in)

| Category | Tools |
|----------|-------|
| **System** | `time`, `shell`, `async_shell` |
| **Files** | `read`, `write`, `ls` |
| **Web** | `search` (Brave), `fetch` |
| **Media** | `image` (vision analysis) |
| **Memory** | `memory_search`, `memory_get` |
| **Knowledge** | `knowledge_search`, `knowledge_add`, `remember` |
| **Agents** | `spawn_subagent`, `active_tasks`, `spawn_kill` |
| **Background** | `bg_run`, `bg_poll`, `bg_list`, `bg_kill` |
| **Scheduling** | `schedule`, `schedule_list`, `schedule_remove` |
| **Communication** | `send_message` |

### Memory & Knowledge
- 🧠 **Semantic RAG** — Vector search with bge-m3 embeddings
- 📝 **Daily Logs** — Auto-save conversations to dated files
- 🔍 **Memory Search** — Semantic + keyword search across all history
- 📚 **Knowledge Base** — Persistent facts with tag-based retrieval

### Sub-Agents & Background Tasks
- 🤖 **Autonomous Workers** — Spawn AI agents for complex multi-step tasks
- ⏱️ **Configurable** — Max rounds, timeout, model selection per task
- 🔄 **Auto-Retry** — Exponential backoff on failures
- 📈 **Progress Tracking** — Real-time status updates

### Anti-Duplicate & Safety
- **Active Task Awareness** — AI sees running tasks before spawning new ones
- **Spawn Deduplication** — Fuzzy matching blocks similar concurrent agents
- **Schedule Deduplication** — Same message within 5 min = blocked
- **Emergency Commands** — `/stoptasks`, `/stopagents`, `/stopall`
- 📊 **Progress Reporting** — Status updates every 5 turns
- 💬 **Communication** — Progress reports, mid-task clarification, abort support
- 🔗 **Task Chaining** — Output of task A feeds into task B

### Session Management
- 📑 **Isolated Sessions** — Multiple conversation contexts per chat
- 🔀 **Session Switching** — Switch between active sessions
- 🌿 **Session Branching** — Fork with embedding-based context transfer
- 🤖 **AI Compaction** — Smart summarization when sessions get long

### Skills (Plugin System)
- 🔌 **Code-Driven Skills** — Register as native function calling tools
- 🎯 **Trigger-Based Loading** — Auto-load on matching user queries
- 📦 **Install from Git/Local** — `installSkill()` from any source
- 🔄 **Hot Reload** — Load/unload/reload without restart

### Monitoring
- ❤️ **Heartbeat System** — Periodic checks via HEARTBEAT.md (hot-reloadable)
- 💰 **Zero-Token Monitoring** — Shell checks first, AI only when conditions trigger
- ⏰ **Smart Scheduler** — 3-tier (direct/check/agent) with conditional triggers

### Infrastructure
- 🖥️ **Multi-Instance Communication** — Redis pub/sub, delegate_task between instances
- 📨 **Message Queue** — Global rate limiting (1.5s), per-chat throttling (3s), flood wait handling
- 🛡️ **Access Control** — Whitelist, auto-reject calls, auto-leave unauthorized groups
- 📊 **Stats & Cost Tracking** — Per-model cost estimates
- 🔄 **Model Fallback** — Auto-switch provider on failure

## Requirements
- **OS:** Linux (Ubuntu 22.04+ recommended)
- **Node.js:** v20+
- **npm:** v9+

## Quick Start

### Installation

```bash
# 1. Clone & install
git clone https://github.com/metasanjaya/metaclaw.git
cd metaclaw
npm install

# 2. Install PM2 globally (optional but recommended)
npm install -g pm2
```

### Setup

```bash
# Run the setup wizard to create your first instance
npx metaclaw setup

# Or manually create config
mkdir -p ~/.metaclaw/instances/agent1
cp defaults/config.yaml.example ~/.metaclaw/instances/agent1/config.yaml
# Edit config.yaml with your API keys
```

### Start

```bash
# Start all instances
npx metaclaw start

# Or with PM2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup

# View logs
pm2 logs metaclaw
```

### Terminal Mode (Optional)

For headless servers without Telegram:

```bash
# Enable terminal in config
# ~/.metaclaw/instances/agent1/config.yaml
terminal:
  enabled: true

# Start interactive terminal
npx metaclaw terminal agent1
```

---

## Instance Configuration

### Per-Instance Config (`~/.metaclaw/instances/<id>/config.yaml`)

```yaml
# Identity
identity:
  name: Agent
  emoji: 🤖
  personality: Helpful AI assistant

# Model
model:
  primary: kimi/kimi-k2.5

# AI Providers
remote:
  providers:
    kimi:
      apiKey: ${KIMI_API_KEY}
      baseURL: https://api.moonshot.ai/v1

# Channels
telegram:
  enabled: true
  apiId: ${TELEGRAM_API_ID}
  apiHash: ${TELEGRAM_API_HASH}
  whitelist:
    - 123456789

whatsapp:
  enabled: false

terminal:
  enabled: true
  streaming: true

# Response delay (seconds)
response_delay:
  dm: 1
  group: 3
```

### Global Config (`~/.metaclaw/config.yaml`)

```yaml
instances:
  agent1:
    model: kimi/kimi-k2.5
    telegram:
      enabled: true
    terminal:
      enabled: true

  agent2:
    model: kimi/kimi-k2.5
    telegram:
      enabled: false
    terminal:
      enabled: true

redis:
  url: redis://localhost:6379
```

---

## CLI Commands

```bash
# Start/stop/restart
metaclaw start              # Start all instances
metaclaw start --instance agent1   # Start specific instance
metaclaw stop
metaclaw restart

# Status & logs
metaclaw status
metaclaw logs

# Instance management
metaclaw create agent2      # Create new instance
metaclaw terminal agent1    # Interactive terminal

# Help
metaclaw --help
```

---

## Architecture

```
src/
├── core/                      # Core engine
│   ├── Engine.js              # Main orchestrator
│   ├── EventBus.js            # Pub/sub communication
│   ├── Router.js              # AI provider routing
│   └── ConfigManager.js       # YAML config handling
│
├── instances/                 # Instance management
│   ├── Instance.js            # Single AI instance
│   ├── InstanceManager.js     # Multi-instance lifecycle
│   ├── ToolExecutor.js        # 21 native tools
│   ├── RAGEngine.js           # Vector search
│   ├── MemoryManager.js       # Daily logs + memory
│   ├── Scheduler.js           # Cron jobs
│   └── SessionSpawner.js      # Background tasks
│
├── channels/                  # Communication channels
│   ├── telegram/              # GramJS MTProto
│   ├── whatsapp/              # Baileys Web
│   ├── mission-control/       # Web dashboard
│   └── terminal/              # CLI/REPL
│
├── ai/                        # AI providers
│   ├── UnifiedAIClient.js
│   └── providers/             # Kimi, Claude, Gemini, etc.
│
└── skills/                    # Plugin system
```

---

## AI Providers

| Provider | Models | Best For |
|----------|--------|----------|
| **Kimi (Moonshot)** | k2.5 | Primary model, fast function calling |
| **Anthropic** | Opus 4.6, Sonnet 4.5 | Complex reasoning |
| **Google** | Gemini Flash/Pro | Vision, transcription |
| **OpenAI** | GPT-4, o3 | Fallback option |
| **MiniMax** | M2.5 | Sub-agent execution |
| **Ollama** | Local models | Self-hosted |

---

## Directory Structure

```
~/.metaclaw/
├── config.yaml                    # Global config
├── instances/
│   └── agent1/
│       ├── config.yaml            # Instance config
│       ├── SOUL.md                # Personality
│       ├── MEMORY.md              # Long-term memory
│       ├── TOOLS.md               # Environment notes
│       ├── MY_RULES.md            # Learned rules
│       ├── memory/                # Daily logs (YYYY-MM-DD.md)
│       ├── knowledge/             # Knowledge base
│       ├── stats/                 # Usage statistics
│       └── logs/                  # Debug logs
│           └── 2026-02-25/
│               └── *.json
└── skills/                        # Global skills
```

## License
MIT

---
**MetaClaw** — Built by Meta Sanjaya 🐾
