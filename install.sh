#!/bin/bash
set -e

echo "🐾 MetaClaw Installer"
echo "====================="
echo ""

# Check OS
if [[ "$(uname)" != "Linux" ]]; then
  echo "❌ MetaClaw currently only supports Linux (Ubuntu recommended)"
  exit 1
fi

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "📦 Installing Node.js 22.x..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js 18+ required (found v$(node -v))"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# Install pm2 globally if not present
if ! command -v pm2 &>/dev/null; then
  echo "📦 Installing pm2..."
  sudo npm install -g pm2
fi
echo "✅ pm2 $(pm2 -v)"

# Setup pm2 startup (auto-start on reboot)
echo "🔧 Setting up pm2 startup..."
pm2 startup systemd -u $USER --hp $HOME 2>/dev/null || true

# Clone if not in metaclaw dir
if [ ! -f "package.json" ] || ! grep -q "metaclaw" package.json 2>/dev/null; then
  echo "📥 Cloning MetaClaw..."
  git clone https://github.com/metasanjaya/metaclaw.git
  cd metaclaw
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Install gTTS for voice replies
pip3 install gTTS 2>/dev/null || pip install gTTS 2>/dev/null || echo "⚠️ gTTS not installed (voice replies won't work)"

# Install openpyxl for Excel file reading
pip3 install openpyxl 2>/dev/null || pip install openpyxl 2>/dev/null || echo "⚠️ openpyxl not installed (Excel reading won't work)"

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Run the setup wizard:  npm run setup"
echo "  2. Start MetaClaw:        pm2 start src/gramjs/index.js --name metaclaw"
echo "  3. Save pm2 config:       pm2 save"
echo "  4. Send /start <CODE> to your bot on Telegram"
echo ""
echo "🐾 Enjoy MetaClaw!"
