# MEMORY.md - Long-Term Memory

_Curated memories, lessons, and important context._

---

## About Meta
- Developer (personal projects) + sysadmin (clients)
- Language: Bahasa Indonesia (preferred)
- Timezone: Asia/Jakarta (UTC+7)
- Values: efficiency, clear communication

---

## Current Focus: Hexolus

### Overview
- **Type:** Server Management Platform
- **Stack:** Laravel 12 + Livewire + Octane (web platform)
- **Purpose:** Client server management via Telegram + provider sync
- **Repository:** github.com/metasanjaya/hexolus-net
- **Status:** Deployed to staging, database migrated ✅

### Deployment
- **Staging:** 172.232.251.77 (Laravel Forge)
- **User:** hexolus-dev
- **Branch:** development (active) → merge to main for production
- **Database:** MariaDB - 31 migrations completed
- **SSH Access:** Masita has hexolus_forge key

### Architecture
```
[OpenClaw/Z] ──API──► [Hexolus Platform] ──► [Client Server Agents]
                            │
                            ├─► Provider APIs (OVH, DO, Namecheap, etc.)
                            └─► Telegram Bot Integration
```

### Provider Sync
- **Tables:** providers (master), provider_accounts (credentials encrypted)
- **Supported Providers:**
  - VPS: OVH, DigitalOcean, Hetzner, Linode, Contabo, Vultr, Google Cloud
  - Domains: Namecheap, Webnic, Dynadot, IRsfa
- **Sync Command:** `php artisan app:provider-sync`
- **Auto-sync:** Can be scheduled (daily/hourly)

### Bot Integration (Z @ @Ular39)
- Natural language interface (no bot commands visible)
- Auto-fix capability (try fix first, escalate to Meta if failed)
- Intent detection (respond to problems, ignore casual chat)
- Client mapping via Telegram group ID
- Planned features: domain/IP parsing, server status, restart services

### Git Workflow
- **development** branch = staging/testing
- **main** branch = production
- Commit convention: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`

### Recent Progress (2026-02-10)

**Morning:**
- Migration timestamps fixed (ticket tables)
- Currency migration column reference corrected
- README.md created with full documentation
- SSH access established for deployment support

**Evening (21:34-22:58) - Testing & Debug Session:**
- ✅ Created TestUserSeeder (test@hexolus.dev, admin@hexolus.dev)
- ✅ Comprehensive browser testing completed
- ✅ Fixed critical Livewire 500 error (is_active → status column)
- ✅ Dashboard now fully functional
- ✅ All management pages tested & working
- Status: **Production Ready** with minor Alpine.js warnings

### Future Direction: Forge-like Features (2026-02-10)
**Vision:** Hexolus as Laravel Forge alternative with Telegram-first approach
**Feasibility:** High - 70% foundation already exists
**Core Features to Build:**
- Site Management (Nginx/Apache config, SSL automation)
- Auto Deployment (Git webhooks, deploy scripts, rollback)
- Database Management (create/backup automation)
- Queue & Scheduler (Supervisor, cron management)
- Firewall & Security (UFW, SSH keys)
**Key Requirements:**
- Server agent/SSH executor
- Webhook handler
- Config template engine
- Deployment pipeline system
- Real-time logs streaming
**Differentiator:** Telegram integration + multi-provider management
**Status:** Brainstorming - for future reference

---

## Agents

### Multi-Agent Setup (2026-02-10)
- **Masita** = Main agent (general assistance, Hexolus focus)
- **Z (M's Assistant @Ular39)** = Specialized agent (ular28 projects, client ops)
- Same gateway, separate workspaces

---

### Mission Control Dashboard (2026-02-15) ⭐
- **Type:** Ops dashboard for MetaClaw multi-instance monitoring
- **Repo:** github.com/metasanjaya/metaclaw-mission-control (PUBLIC)
- **Stack:** uWebSockets.js + Redis + vanilla JS (no build step)
- **Business model:** Open core → SaaS (like Grafana/Supabase)
- **Status:** Initial scaffold pushed (20 files), wireframe approved
- **Panels:** Instance list, token/cost dashboard, task board, live feed, memory/knowledge, cross-instance delegation

### StatsTracker v2 (2026-02-15)
- All providers now return `inputTokens`/`outputTokens` separately
- Auto cost calculation with price map per model
- Methods: `getCostToday()`, `getCostByModel()`

### Schedule Tool (2026-02-15)
- Native function calling tool added to MetaClaw
- Types: `direct` (0 tokens) vs `agent` (burns tokens)
- Works cross-instance (delegated tasks auto-resolve peerId to owner)

### MetaClaw Multi-Instance Communication (2026-02-15) ⭐
- **InstanceManager.js** — Redis pub/sub peer-to-peer communication
- **Instances:** Nayla (@ZahraNayla28, scope: general) + Arifin (@Arifin2026, scope: server/devops)
- **Paths:** `/root/metaclaw/` (Nayla), `/root/metaclaw-arifin/` (Arifin)
- **PM2:** `metaclaw-nayla`, `metaclaw-arifin`
- **Features:** auto-discovery, delegate_task, knowledge sync, anti-loop, scope-based routing
- **Config:** `instance.id`, `instance.scope`, `instance.redis.url` in config.yaml
- **Key lesson:** MetaClaw providers use `Object.keys(t.params)` — tools MUST use `params` not `input_schema`
- **Setup wizard:** 6-step (personality → instance → AI → Telegram → owner → connect+pm2)
- **SOUL.md** is single source of truth (no IDENTITY.md)
- **Next:** Mission Control dashboard

### MetaPower Antidetect Browser (2026-02-11 → 2026-02-12)
- **Type:** Chromium-based antidetect browser project
- **Goal:** Alternative to expensive Hidemium ($299/mo for sync)
- **Priority Feature:** 10 fingerprint protection vectors (automation, canvas, webgl, webrtc, audio, navigator, screen, fonts, hardware, battery)
- **Status:** Vector #1 implemented (manual, clean) + Vectors #2-10 implemented (sub-agent, has bugs) → 8 failed builds debugging in progress
- **GitHub:** Private repo at github.com/metasanjaya/metapower ✅
- **VPS:** 217.15.161.56 (Chromium source + builds)
- **Current Blocker:** Sub-agent patches have Chromium anti-patterns (unsafe buffers, extra braces, wrong containers)
- **Location:** /projects/metapower/ + VPS /root/metapower/
- **Proactive Monitoring:** ✅ Cron job active (every 5 min, auto-reports)
- **Documentation:** BUILD-STATUS-SUMMARY.md has full details
- **Next Session Options:** (A) Incremental fix, (B) Audit all 9 files first, (C) Revert to Vector #1 MVP

---

### MetaClaw - Personal AI Assistant (2026-02-13 → 2026-02-14) ⭐
- **Type:** Personal AI assistant on Telegram via GramJS (MTProto userbot)
- **Account:** @ZahraNayla28 (Nayla), personality "cewek chill yang friendly"
- **Stack:** Node.js ESM, GramJS MTProto, multi-provider AI
- **Models:** Sonnet 4.5 (simple) + Opus 4.6 (complex) + Gemini Flash (intent/vision) + Gemini Pro (fallback)
- **Features:** Smart model routing, **native function calling** (v1.7.0), tools (shell/web/file/image), memory+RAG, KnowledgeManager, TaskPlanner, voice in/out, file handling, background tasks (AsyncTaskManager), persistent scheduler (3-tier), concurrent chat queues, conversation persistence+compaction, streaming, cost tracking
- **GitHub:** github.com/metasanjaya/metaclaw (v1.7.0 latest)
- **Location:** Live at `/root/metaclaw/`, repo at `/projects/metaclaw/`
- **Config:** `config.local.yaml` > `config.yaml` (local is gitignored)
- **Do NOT modify:** `src/core/`, `StatsTracker.js`, `MemoryManager.js`, `RAGEngine.js`
- **Status:** v1.7.0 live, running via `pm2 metaclaw-nayla`
- **Key lesson:** Text-based `[TOOL:]` tags caused "stuck" behavior — AI would describe actions instead of executing. Native function calling (structured API tool calls) fixed this fundamentally.

### TokenClaw - Token-Efficient Assistant (2026-02-11)
- **Type:** OpenClaw-like system but 90% token-free
- **Status:** Prototype complete, ready to test
- **Architecture:** Local handlers → Cache → AI (minimal)
- **Features:** Pattern matching, proactive monitoring, Telegram bot
- **Location:** /projects/tokenclaw/
- **Quick test:** `cd projects/tokenclaw && npm install && npm run dev`

---

## Lessons Learned

### Proactive Monitoring Pattern (2026-02-12)
**Meta's Valid Complaint:** "Kenapa tidak proaktif ya?"

**Problem:** Sub-agents are passive - they wait for instructions, don't auto-report
**Solution:** Cron job + message tool = truly proactive
```json
{
  "schedule": {"kind": "every", "everyMs": 300000},
  "sessionTarget": "isolated",
  "payload": {"kind": "agentTurn", "message": "Check status + report via message tool"},
  "delivery": {"mode": "none"}
}
```

**Key:** Use `message` tool inside cron task to send notifications directly to user

### Native Function Calling > Text-Based Tools (2026-02-14)
**Problem:** MetaClaw used `[TOOL: shell]...[/TOOL]` text tags parsed by regex
**Result:** AI frequently "described" what it would do instead of using tags → stuck/incomplete responses
**Solution:** Native function calling via API (Anthropic tool_use, Google functionCall, OpenAI tool_calls)
**Impact:** Eliminated stuck behavior completely. Model MUST use structured tool calls to execute.
**Lesson:** Always use provider-native APIs for tool calling. Text-based parsing is fragile and model-dependent.

### Sub-Agent Limitations (2026-02-12)
**Use Case:** Complex code generation (Chromium C++ patches)
**Result:** 8 failed builds in 5 hours - sub-agent didn't understand strict compilation rules
**Lessons:**
1. Sub-agents good for: research, testing, isolated tasks
2. Sub-agents risky for: code generation in complex codebases without validation
3. Always audit AI-generated C++ before compiling (syntax checks, pattern matching)
4. Manual implementation (Vector #1) was clean - sub-agent (Vectors #2-10) all had bugs

### Token Efficiency Reminder
- Keep workspace .md files under 200 lines
- Compact conversations after major work
- Use sub-agents for isolated tasks (don't inherit main context)
- Batch file operations, use grep before reading

---

_Last updated: 2026-02-14 20:16 WIB_
