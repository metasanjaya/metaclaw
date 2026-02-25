# Terminal Channel

Interactive CLI/REPL interface for MetaClaw — perfect for headless servers or quick admin tasks.

## Quick Start

```bash
# Enable terminal in your instance config
# ~/.metaclaw/instances/<name>/config.yaml
terminal:
  enabled: true

# Start terminal mode
metaclaw terminal agent1
```

## Commands

While in terminal mode:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/quit` or `/exit` | Exit terminal |
| `/clear` | Clear screen |
| `/history` | Show conversation history |
| `/save` | Save session to file |
| `/load` | Load session from file |

## Features

- 🎨 **Colored output** with automatic fallback
- ⚡ **Streaming responses** (real-time)
- 📜 **Command history** (arrow keys, persisted to disk)
- 💾 **Session persistence** (resume conversations)
- 🔧 **Tab completion** for commands

## Session Files

Sessions and history are stored in your instance directory:
- `~/.metaclaw/instances/<name>/terminal-session.json`
- `~/.metaclaw/instances/<name>/terminal-history.txt`

## Tips

- Use arrow keys (↑/↓) to navigate command history
- Press `Ctrl+C` to cancel current request
- Type `/clear` anytime to clean the screen
- Terminal works alongside Telegram — you can use both simultaneously
