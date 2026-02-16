# MetaClaw 🐾

Personal AI assistant running on Telegram via GramJS (MTProto).

## Features

### Core
- 🤖 **Smart AI Chat** — Claude Sonnet 4.5 (simple) + Opus 4.6 (complex) with auto-routing
- 🔧 **Native Function Calling** — Shell, web search, fetch, file R/W via provider-native tool APIs
- 🧠 **Memory + RAG** — Auto-memory, semantic search, knowledge base with embeddings
- 💬 **Conversation Persistence** — History with embedding-based relevance filtering & auto-compaction

### Sub-Agents
- 🤖 **Autonomous AI Workers** — Spawn background agents that plan & execute goals independently
- 📋 **Planning Phase** — Dual-model: expensive model plans, cheap model executes
- 🧠 **Knowledge Scoping** — Sub-agents query only relevant knowledge, not entire context
- 💬 **Communication** — Progress reports, mid-task clarification, abort support
- ⚡ **Background Tasks** — Sub-agents delegate long commands to AsyncTaskManager (0 tokens)
- 🔗 **Task Chaining** — Output of task A feeds into task B

### Session Management
- 📑 **Isolated Sessions** — Multiple conversation contexts per chat (main/task/branch)
- 🔀 **Session Switching** — Switch between active sessions without losing context
- 🌿 **Session Branching** — Fork sessions with embedding-based relevant context transfer
- 💾 **Persistent** — Sessions survive restarts with lazy-loading
- 🤖 **AI Compaction** — Smart summarization when sessions get long

### Skills (Plugin System)
- 🔌 **Code-Driven Skills** — Skills register as native function calling tools
- 🎯 **Trigger-Based Loading** — Auto-load skills when user query matches trigger words
- 📦 **Install from Git/Local** — `installSkill()` from any source
- ⚙️ **3-Tier Config** — Global config > env vars > skill defaults
- 🔄 **Hot Reload** — Load/unload/reload skills without restart

### Monitoring
- ❤️ **Heartbeat System** — Periodic checks via HEARTBEAT.md (hot-reloadable)
- 💰 **Zero-Token Monitoring** — Shell checks run first, AI only when conditions trigger
- 📊 **Batched Alerts** — Multiple issues in one notification
- ⏰ **Smart Scheduler** — 3-tier (direct/check/agent) with conditional triggers

### Browser Automation
- 🌐 **Browser Skill** — Headless browser via MetaPower or Puppeteer
- 🔍 **Auto-Detect** — Uses MetaPower (antidetect) if available, falls back to Puppeteer
- 🖱️ **Full Automation** — Click, type, scroll, screenshot, PDF, multi-step scripts

### Communication
- 🎤 **Voice Support** — Transcribe voice notes, TTS reply
- 📎 **File Handling** — Receive & process documents, send files
- 🔀 **Concurrent Chat** — Multiple chats in parallel
- 🎯 **Group Intent Detection** — AI decides if group message needs response
- 👍 **Smart Reactions** — Acknowledgment detection with configurable patterns

### Infrastructure
- 🛡️ **Access Control** — Whitelist, auto-reject calls, auto-leave unauthorized groups
- 📊 **Stats & Cost Tracking** — /stats, /dailyusage with $ estimates
- 🔄 **Model Fallback** — Auto-switch provider on failure
- 💾 **Everything Persists** — Conversations, schedules, sessions, sub-agent state

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

> Step 3 is only needed once. Session saved to `data/session.txt`.

## Commands

### General
| Command | Description |
|---------|-------------|
| `/stats` | Usage statistics |
| `/dailyusage` | Daily stats with cost estimate |
| `/clear` | Delete messages & reset conversation |
| `/remember <text>` | Save to memory |
| `/memory` | Show recent memories |
| `/forget` | Clear today's memory |

### Sub-Agents
| Command | Description |
|---------|-------------|
| `/subagent <goal>` | Spawn autonomous AI worker |
| `/subagent:status [id]` | Check task status (all or specific) |
| `/subagent:abort <id>` | Abort a running task |
| `/subagent:answer <id> <text>` | Answer a clarification question |

### Sessions
| Command | Description |
|---------|-------------|
| `/sessions` | List all sessions |
| `/session new <label>` | Create & switch to new session |
| `/session switch <id>` | Switch to a session |
| `/session close` | Complete active session, back to main |

### Skills
| Command | Description |
|---------|-------------|
| `/skills` | List installed skills |
| `/skill load <name>` | Load a skill |
| `/skill unload <name>` | Unload a skill |
| `/skill reload <name>` | Reload a skill |

### Heartbeat
| Command | Description |
|---------|-------------|
| `/heartbeat` | Heartbeat status |
| `/heartbeat tick` | Manual heartbeat trigger |

## HEARTBEAT.md

Edit `workspace/HEARTBEAT.md` to configure periodic monitoring. Changes apply immediately (hot-reload).

```markdown
## interval: 300
## notify: <telegram_user_id>

## Checks
- disk: `df -h / | awk 'NR==2{print $5}' | tr -d %` | if >85 | Disk usage high
- mem: `free -m | awk '/Mem/{printf "%.0f", $3/$2*100}'` | if >90 | Memory high
- site: `curl -so/dev/null -w '%{http_code}' https://example.com` | if !=200 | Site down

## Tasks
- email: Check inbox for urgent emails | every 4h
- calendar: Any events in next 2h? | every 2h
```

**Checks** = shell command + condition → 0 tokens when normal, AI only on alert.
**Tasks** = AI-powered periodic jobs with independent intervals.

## Skills

Skills are code-driven plugins in `skills/` directory:

```
skills/
├── browser/          # Built-in: headless browser automation
│   ├── skill.json    # Manifest (tools, triggers, config)
│   └── index.js      # Implementation
└── your-skill/
    ├── skill.json
    └── index.js
```

### Creating a Skill

**skill.json:**
```json
{
  "name": "weather",
  "version": "1.0.0",
  "description": "Get weather forecasts",
  "tools": [{
    "name": "get_weather",
    "description": "Get current weather",
    "params": { "location": { "type": "string" } }
  }],
  "triggers": ["weather", "cuaca"],
  "autoload": false
}
```

**index.js:**
```js
export default class WeatherSkill {
  constructor(context) { this.log = context.log; }
  async get_weather({ location }) {
    return { temp: 25, condition: "Sunny" };
  }
}
```

Skills register as native function calling tools — AI uses them seamlessly.

## Architecture

```
src/gramjs/
├── GramJSBridge.js        # Main orchestrator
├── GramJSClient.js        # MTProto connection
├── SubAgent.js            # Autonomous AI workers
├── SessionManager.js      # Structured session contexts
├── SkillManager.js        # Plugin system
├── HeartbeatManager.js    # Periodic monitoring
├── ConversationManager.js # Chat history + embeddings
├── Scheduler.js           # Persistent job scheduler
├── AsyncTaskManager.js    # Background shell tasks
├── TaskRunner.js          # Background AI tasks
├── TaskPlanner.js         # Goal/plan/step tracking
├── KnowledgeManager.js    # Dynamic knowledge base
├── ToolExecutor.js        # Core tool execution
├── ChatQueue.js           # Concurrent chat processing
├── StatsTracker.js        # Usage statistics
├── MemoryManager.js       # Memory system
├── RAGEngine.js           # Retrieval-augmented generation
└── TopicManager.js        # Conversation topic tracking

src/ai/
├── UnifiedAIClient.js     # Multi-provider AI client
└── providers/             # Anthropic, Google, OpenAI, etc.

skills/                    # Pluggable skills
├── browser/               # Browser automation (MetaPower/Puppeteer)
└── ...

personality/               # SOUL.md, IDENTITY.md
workspace/                 # Working directory + HEARTBEAT.md
data/                      # Sessions, stats, conversations, state
```

## Configuration

`config.yaml` (override with `config.local.yaml`):

```yaml
models:
  simple:
    provider: anthropic
    model: claude-sonnet-4-5
  complex:
    provider: anthropic
    model: claude-opus-4-6
  fallback:
    provider: google
    model: gemini-2.5-pro

tools:
  max_rounds: 20

workspace:
  path: ./workspace
```

## License
MIT

---
**MetaClaw** — Built by Meta Sanjaya 🐾
