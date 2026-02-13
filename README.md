# MetaClaw 🐾

Personal AI assistant running on Telegram via GramJS (MTProto).

## Features
- 🤖 **Smart AI Chat** — Claude Sonnet 4.5 (simple) + Opus 4.6 (complex) with auto-routing
- 🔧 **Tool Execution** — Shell commands, web search, web fetch, file R/W
- 🧠 **Memory System** — Auto-memory via [REMEMBER:] tags, /remember, /forget
- 📚 **RAG Engine** — Semantic search with embeddings for context-aware responses
- ⏰ **Persistent Scheduler** — Reminders with absolute/relative time, repeat support
- 🎤 **Voice Support** — Transcribe incoming voice notes, TTS reply
- 📎 **File Handling** — Receive & read documents (Excel, PDF, etc), send files
- 🚀 **Background Tasks** — Spawn coding/research tasks that run independently
- 🔀 **Concurrent Chat** — Multiple chats processed in parallel
- 💬 **Smart Replies** — DM: plain message, Group: reply to original
- 🎯 **Group Intent Detection** — AI decides if group message needs response
- 📊 **Stats & Cost Tracking** — /stats, /dailyusage with $ estimates
- 🛡️ **Access Control** — Whitelist, auto-reject calls, auto-leave unauthorized groups
- 👍 **Smart Reactions** — Acknowledgment detection with configurable patterns
- ✏️ **Edit Detection** — Re-processes edited messages
- ↩️ **Forward Handling** — Detects and processes forwarded messages
- 🔄 **Model Fallback** — Auto-switch to Gemini if primary fails
- 📖 **Read Receipts** — Natural message read behavior
- 💾 **Conversation Persistence** — History survives restarts
- 🧹 **Chat Clear** — /clear deletes all messages + resets context
- 🎵 **Streaming** — Optional placeholder+edit response mode

## Requirements
- **OS:** Linux (Ubuntu 22.04+ recommended)
- **Node.js:** v18+
- **npm:** v9+

## Quick Start

```bash
# Clone
git clone https://github.com/metasanjaya/metaclaw
cd metaclaw

# Install & setup (auto-installs pm2, configures everything)
npm run install-all

# Run the setup wizard
npm run setup

# Start MetaClaw
pm2 start src/gramjs/index.js --name metaclaw
pm2 save

# Then send /start <YOUR_CODE> to your bot/account on Telegram!
```

## One-Line Install
```bash
curl -fsSL https://raw.githubusercontent.com/metasanjaya/metaclaw/main/install.sh | bash
```

## Commands
- `/stats` — Usage statistics
- `/dailyusage` — Daily stats with cost estimate
- `/remember <text>` — Save to memory
- `/memory` — Show recent memories
- `/forget` — Clear today's memory
- `/clear` — Delete all messages & reset conversation
- `/tasks` — List background tasks

## Configuration
Edit `config.yaml` for:
- Model routing (simple/complex/fallback)
- Access control (whitelist)
- Features (streaming on/off)
- Acknowledgment patterns: `data/ack-patterns.json`

## Architecture
- `src/gramjs/` — Main codebase
  - `GramJSClient.js` — MTProto connection, message handling
  - `GramJSBridge.js` — AI integration, tool execution, message processing
  - `ConversationManager.js` — Chat history with persistence & compaction
  - `Scheduler.js` — Persistent reminders
  - `TaskRunner.js` — Background task execution
  - `ChatQueue.js` — Per-chat concurrent processing
  - `ToolExecutor.js` — Shell, web, file tools
  - `StatsTracker.js` — Usage statistics
  - `MemoryManager.js` — Memory system
  - `RAGEngine.js` — Retrieval-augmented generation
- `src/ai/` — AI providers (Anthropic, Google, OpenAI)
- `personality/` — SOUL.md, IDENTITY.md, memory/
- `workspace/` — MetaClaw's working directory for tasks
- `data/` — Sessions, stats, conversations, schedules

## Tech Stack
- Node.js (ESM)
- GramJS (MTProto)
- Anthropic Claude (Sonnet 4.5 / Opus 4.6)
- Google Gemini (fallback + vision + intent)
- Xenova Transformers (embeddings)
- pm2 (process management)

## License
MIT

---
**MetaClaw** — Built by Meta Sanjaya 🐾
