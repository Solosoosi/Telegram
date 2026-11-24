#!/usr/bin/env python3
"""Telegram channel scraper -> Excel.

Everyday use (no code editing needed):
  1. Put your channels and keywords in config.yaml
  2. Run:  python scraper.py                      (asks for the dates)
     or:   python scraper.py --start 2026-11-01 --end 2026-11-24
     or:   python scraper.py --start 7d --end now --mode history

The first run asks for your Telegram API credentials once and stores them in
credentials.ini (a private file, separate from the code).
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

if sys.version_info < (3, 9):
    sys.exit("Python 3.9 or newer is required.")

from tg_scraper.config import DATE_HELP, ConfigError, load_config, parse_date
from tg_scraper.credentials import CredentialsError, get_credentials, run_setup_wizard
from tg_scraper.runner import MODES, RunOptions, list_channels, login, make_client, run

BASE_DIR = Path(__file__).resolve().parent
SESSION_DIR = BASE_DIR / "sessions"


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Collect Telegram channel messages (text & links) into an Excel file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"Date formats: {DATE_HELP}",
    )
    p.add_argument("--start", help="Start of the collection period (asked interactively if omitted)")
    p.add_argument("--end", help="End of the collection period (asked interactively if omitted)")
    p.add_argument("--mode", choices=MODES, default="both",
                   help="history = past messages only; live = only new incoming messages; "
                        "both = history, then keep listening until --end (default)")
    p.add_argument("--channels", nargs="+", metavar="CHANNEL", help="Override the channels in config.yaml for this run")
    p.add_argument("--keywords", nargs="+", metavar="WORD", help="Override the keywords in config.yaml for this run")
    p.add_argument("--output", type=Path, help="Excel file path (default: auto-named file in the output folder)")
    p.add_argument("--config", type=Path, default=BASE_DIR / "config.yaml", help="Settings file (default: config.yaml)")
    p.add_argument("--credentials", type=Path, default=BASE_DIR / "credentials.ini",
                   help="Credentials file (default: credentials.ini). Can live outside the project folder.")
    p.add_argument("--setup", action="store_true", help="(Re)enter your Telegram API credentials and exit")
    p.add_argument("--list-channels", action="store_true",
                   help="Print the channels/groups your account has joined (with IDs) and exit")
    p.add_argument("--logout", action="store_true", help="Log out and delete the saved login session")
    return p.parse_args(argv)


def ask_date(prompt: str, tz, is_end: bool, default: str | None = None):
    while True:
        suffix = f" [Enter = {default}]" if default else ""
        answer = input(f"{prompt}{suffix}: ").strip() or (default or "")
        try:
            return parse_date(answer, tz, is_end=is_end)
        except ConfigError as exc:
            print(f"  {exc}")


def get_period(args, cfg):
    tz = cfg.timezone
    interactive = sys.stdin.isatty()
    if (args.start is None or args.end is None) and interactive:
        print(f"\nCollection period (time zone: {tz.label}). Formats: {DATE_HELP}")
    if args.start is not None:
        start = parse_date(args.start, tz, is_end=False)
    elif interactive:
        start = ask_date("  Start date", tz, is_end=False)
    else:
        raise ConfigError("--start is required when not running interactively.")
    if args.end is not None:
        end = parse_date(args.end, tz, is_end=True)
    elif interactive:
        end = ask_date("  End date  ", tz, is_end=True, default="now" if args.mode == "history" else "today")
    else:
        raise ConfigError("--end is required when not running interactively.")
    if start >= end:
        raise ConfigError(f"Start ({start:%Y-%m-%d %H:%M}) must be before end ({end:%Y-%m-%d %H:%M}).")
    return start, end


async def _account_action(args, creds) -> None:
    client = make_client(creds, SESSION_DIR)
    async with client:
        await login(client, creds, SESSION_DIR)
        if args.list_channels:
            await list_channels(client)
        elif args.logout:
            await client.log_out()
            print("[+] Logged out. The saved session was removed.")


async def _main_async(args, creds, cfg, opts) -> None:
    client = make_client(creds, SESSION_DIR)
    await client.connect()
    try:
        await run(client, creds, cfg, opts, SESSION_DIR)
    finally:
        await client.disconnect()


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        if args.setup:
            run_setup_wizard(args.credentials.expanduser())
            return 0
        creds = get_credentials(args.credentials.expanduser())
        if args.list_channels or args.logout:
            asyncio.run(_account_action(args, creds))
            return 0

        cfg = load_config(args.config.expanduser())
        if args.channels:
            cfg.channels = args.channels
        if args.keywords:
            cfg.keywords = args.keywords
        if not cfg.channels:
            raise ConfigError("No channels configured. Add them under 'channels:' in config.yaml.")
        start, end = get_period(args, cfg)
        opts = RunOptions(start=start, end=end, mode=args.mode, output=args.output)
        asyncio.run(_main_async(args, creds, cfg, opts))
        return 0
    except (ConfigError, CredentialsError) as exc:
        print(f"[x] {exc}")
        return 2
    except KeyboardInterrupt:
        print("\n[i] Stopped by user.")
        return 130
    except EOFError:
        print("\n[x] Input closed.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
