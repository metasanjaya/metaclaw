# MetaClaw 🐾

![Version](https://img.shields.io/badge/version-3.0.0-blue)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Personal AI assistant running on Telegram via GramJS (MTProto).

## Features

### Core
- 🤖 **Smart AI Chat** — GPT-5.2 (simple) + Claude Opus 4.6 (complex) with auto-routing
- 🧭 **AI-Powered Routing** — Gemini Flash intent classifier for smart model selection
- 📬 **Message Batching** — DM=5s, Group=30s per user, typing detection resets timer
- 🔧 **Native Function Calling** — Shell, web search, file R/W via provider-native tool APIs
- 🧠 **Memory + RAG** — Auto-memory, semantic search, knowledge base with embeddings
- 💬 **Conversation Persistence** — History with embedding-based relevance filtering & auto-compaction
- 📨 **Message Queue** — Rate-limited sending with flood wait protection (no Telegram bans)

### Native Tools (17 Built-in)

| Category | Tools |
|----------|-------|
| **Execution** | `shell`, `async_shell` |
| **Web** | `search`, `fetch` |
| **Files** | `read`, `write`, `ls` |
| **Media** | `image` |
| **Scheduling** | `schedule` |
| **Agents** | `spawn_subagent`, `active_tasks` |
| **Knowledge** | `knowledge`, `remember` |
| **Communication** | `send_file`, `send_voice`, `send_sticker` |
| **Planning** | `task_plan` |

### Anti-Duplicate System
Multi-layered protection against runaway task loops:

- **System prompt awareness** — AI always sees active tasks, warned not to duplicate
- **`active_tasks` tool** — Check running tasks/agents/schedules before spawning
- **Spawn dedup** — Fuzzy goal matching blocks similar sub-agents (>50% word overlap)
- **Schedule dedup** — Same message + within 5 min window = blocked
- **AsyncTask dedup** — Same command running = returns existing ID
- **AsyncTask cooldown** — Same command completed <60s ago = skipped
- **Max concurrent** — Max 3 async tasks simultaneously
- **Isolated context restrictions** — No schedule/spawn tools in background processing
- **Emergency commands** — `/stoptasks`, `/stopagents`, `/stopall`, `/clearall`

### Sub-Agents
- 🤖 **Autonomous AI Workers** — Spawn background agents with plan & execute phases
- 📋 **Dual-Model Architecture** — GPT-5.2 (planning, reasoning: high) + MiniMax M2.5 (execution)
- ⏱️ **Configurable Turns** — Max 100 turns per task (configurable)
- 🔄 **Auto-Retry** — 3 retries with 10-30s exponential backoff
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
