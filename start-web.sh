#!/usr/bin/env bash
# Run the web app privately on this computer (macOS/Linux): http://127.0.0.1:8765
# Only this computer can open it. Press Ctrl+C to stop.
set -e
cd "$(dirname "$0")/web"
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is needed (one-time install): https://nodejs.org  - choose the LTS version."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run: installing the web app (one time)..."
  npm ci
fi
echo "Starting at http://127.0.0.1:8765 - your browser will open. Press Ctrl+C to stop."
exec npm start
