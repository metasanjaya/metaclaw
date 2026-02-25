#!/bin/bash
# MetaClaw Terminal Launcher
# Connects to running instance via Mission Control

INSTANCE=${1:-nayla}
cd /root/metaclaw

# Check if MetaClaw is running
if ! curl -s http://localhost:3100/health >/dev/null 2>&1; then
    echo "❌ MetaClaw Mission Control is not running!"
    echo "   Start with: pm2 start ecosystem.config.cjs"
    exit 1
fi

# Run terminal client
exec node bin/metaclaw-term-client.js "$INSTANCE"
