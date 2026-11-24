#!/usr/bin/env bash
# Run the Telegram scraper on macOS/Linux. Extra arguments are passed through, e.g.:
#   ./run.sh --start 7d --end now --mode history
set -e
cd "$(dirname "$0")"
if [ ! -x ".venv/bin/python" ]; then
  echo "First run: setting up a private Python environment..."
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -r requirements.txt
fi
exec .venv/bin/python scraper.py "$@"
