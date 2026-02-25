# TOOLS.md - Instance Environment Notes

_Per-instance infrastructure and configuration details._

---

## SSH Hosts

| Alias | Host | User | Key | Notes |
|-------|------|------|-----|-------|
| `home-server` | 192.168.1.100 | admin | ~/.ssh/id_rsa | Main home server |
| `vps-staging` | 203.0.113.10 | app-dev | ~/.ssh/staging_key | Staging environment |
| `vps-build` | 198.51.100.20 | root | ~/.ssh/build_key | Build server |

### Quick Connect Examples
```bash
ssh home-server
ssh vps-staging -t "cd /var/www && ls -la"
```

---

## API Keys & Endpoints

| Service | Key Location | Endpoint | Notes |
|---------|--------------|----------|-------|
| Brave Search | env:BRAVE_API_KEY | https://api.search.brave.com | Web search |
| OpenAI | env:OPENAI_API_KEY | https://api.openai.com | GPT-4, embeddings |
| Anthropic | env:ANTHROPIC_API_KEY | https://api.anthropic.com | Claude models |
| Google AI | env:GOOGLE_API_KEY | https://generativelanguage.googleapis.com | Gemini |

---

## Servers & VPS

### Production
| Name | IP | Purpose | Status |
|------|-----|---------|--------|
| `app-prod` | TBD | Production server | Planned |

### Staging
| Name | IP | Purpose | Status |
|------|-----|---------|--------|
| `app-staging` | 203.0.113.10 | Staging environment | Active |

### Development
| Name | IP | Purpose | Status |
|------|-----|---------|--------|
| `build-server` | 198.51.100.20 | Build/CI server | Active |
| `agent-host` | 192.0.2.100 | MetaClaw host | Active |

---

## Cameras (if applicable)

| Name | Location | Type | URL/Access |
|------|----------|------|------------|
| `living-room` | Main area | 180° wide angle | rtsp://... |
| `front-door` | Entrance | Motion-triggered | rtsp://... |

---

## TTS / Voice Preferences

| Preference | Value |
|------------|-------|
| Default voice | "Nova" (warm, slightly British) |
| Default speaker | Kitchen HomePod |
| Fallback voice | "Onyx" |

---

## Device Nicknames

| Nickname | Actual Device | Location |
|----------|---------------|----------|
| `main-pc` | Workstation | Office |
| `pi-hole` | Raspberry Pi 4 | Networking rack |
| `nas` | Synology DS920+ | Storage closet |

---

## Project Paths

| Project | Local Path | Remote Path |
|---------|------------|-------------|
| MetaClaw | ~/.metaclaw | - |
| App | /var/www/app | /opt/app |

---

## Quick Commands

```bash
# Check MetaClaw status
pm2 status

# View logs
pm2 logs metaclaw --lines 50

# Restart instance
pm2 restart metaclaw
```

---

## Notes

- SSH keys are stored in `~/.ssh/`
- VPS access requires VPN for some hosts
- Backup schedule: Daily at 2 AM (cron)

---

_Last updated: 2026-02-25_
