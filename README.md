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
- **Node.js:** v18+
- **npm:** v9+

## Quick Start

```bash
# 1. Clone & install
git clone https://github.com/metasanjaya/metaclaw
cd metaclaw
npm run install-all

# 2. Run the setup wizard
npm run setup

# 3. First-time login (interactive)
node src/gramjs/index.js
# → Enter phone, code, 2FA → wait for "listening" → Ctrl+C

# 4. Start with pm2
pm2 start src/gramjs/index.js --name metaclaw
pm2 save && pm2 startup
```

## Default Model Configuration

```yaml
models:
  # Simple tasks (casual chat, quick answers)
  simple:
    provider: openai
    model: gpt-5.2
    reasoning: medium

  # Complex tasks (analysis, debugging, multi-step)
  complex:
    provider: anthropic
    model: claude-opus-4-6

  # Intent classification & vision
  intent:
    provider: google
    model: gemini-2.5-flash
  vision:
    provider: google
    model: gemini-2.5-flash

  # Fallback
  fallback:
    provider: google
    model: gemini-3

# Sub-Agent models
subagent:
  planner:
    provider: openai
    model: gpt-5.2
    reasoning: high
  executor:
    provider: minimax
    model: MiniMax-M2.5
```

## Commands

| Command | Description |
|---------|-------------|
| `/stats` | Usage statistics |
| `/dailyusage` | Daily stats with cost estimate |
| `/clear` | Delete messages & reset conversation |
| `/remember <text>` | Save to memory |
| `/memory` | Show recent memories |
| `/forget` | Clear today's memory |
| `/subagent <goal>` | Spawn autonomous AI worker |
| `/subagent:status [id]` | Check task status |
| `/subagent:abort <id>` | Abort a running task |
| `/sessions` | List all sessions |
| `/skills` | List installed skills |
| `/heartbeat` | Heartbeat status |
| `/stoptasks` | Stop all async tasks |
| `/stopagents` | Abort all sub-agents |
| `/stopall` | Stop all tasks + agents |
| `/clearall` | Stop + delete all tasks & agents |

## HEARTBEAT.md

```markdown
## interval: 300
## notify: <telegram_user_id>

## Checks
- disk: `df -h / | awk 'NR==2{print $5}' | tr -d %` | if >85 | Disk usage high
- mem: `free -m | awk '/Mem/{printf "%.0f", $3/$2*100}'` | if >90 | Memory high

## Tasks
- email: Check inbox for urgent emails | every 4h
```

## Architecture

```
src/gramjs/
├── GramJSBridge.js        # Main orchestrator
├── GramJSClient.js        # MTProto connection
├── MessageQueue.js        # Rate-limited message sending
├── SubAgent.js            # Autonomous AI workers
├── AsyncTaskManager.js    # Background shell tasks (dedup + rate limit)
├── Scheduler.js           # Persistent job scheduler (dedup)
├── SessionManager.js      # Structured session contexts
├── SkillManager.js        # Plugin system
├── HeartbeatManager.js    # Periodic monitoring
├── ConversationManager.js # Chat history + embeddings
├── KnowledgeManager.js    # Dynamic knowledge base
├── MemoryManager.js       # Memory system
├── RAGEngine.js           # Retrieval-augmented generation
├── InstanceManager.js     # Multi-instance communication
├── StatsTracker.js        # Usage statistics
└── ChatQueue.js           # Concurrent chat processing

src/ai/
├── UnifiedAIClient.js     # Multi-provider AI client
└── providers/             # Anthropic, Google, OpenAI, MiniMax
```

## Providers

- **Kimi (Moonshot)** — K2.5 (OpenAI-compatible)
- **Anthropic** — Claude Opus 4.6, Sonnet 4.5
- **Google** — Gemini Flash/Pro/3
- **OpenAI** — GPT-5.2, Codex (Responses API)
- **MiniMax** — M2.5
- **DeepSeek** — DeepSeek Chat
- **Grok (xAI)** — Grok-2
- **Z.AI** — GLM-5

## Configuration

### Per-Model Temperature
```yaml
models:
  simple:
    provider: kimi
    model: kimi-k2.5
    temperature: 1    # Kimi only accepts 1
```

### Response Delay
```yaml
response_delay:
  dm: 3       # seconds before replying in DM
  group: 5    # seconds before replying in group
```

### Config Validation
Startup validates `config.yaml` against schema (Zod). Invalid configs fail fast with clear error messages.

## License
MIT

---
**MetaClaw** — Built by Meta Sanjaya 🐾
