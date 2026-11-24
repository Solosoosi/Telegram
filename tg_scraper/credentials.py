"""Telegram account credentials: loaded from an external file, never from source code.

Lookup order for each value:
  1. Environment variables (TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_PHONE)
  2. The credentials file (default: credentials.ini next to scraper.py)

If no usable credentials are found, an interactive setup wizard asks for them and
writes the file with owner-only permissions, so nobody ever needs to edit Python code.
"""
from __future__ import annotations

import configparser
import getpass
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

SECTION = "telegram"
ENV_API_ID = "TELEGRAM_API_ID"
ENV_API_HASH = "TELEGRAM_API_HASH"
ENV_PHONE = "TELEGRAM_PHONE"

_API_HASH_RE = re.compile(r"^[0-9a-fA-F]{32}$")
_PHONE_RE = re.compile(r"^\+?\d{7,15}$")


class CredentialsError(Exception):
    """Raised when credentials are missing or invalid."""


@dataclass(frozen=True)
class Credentials:
    api_id: int
    api_hash: str
    phone: str  # may be "" -> Telegram will ask for it at login
    session_name: str = "telegram_scraper"

    def __repr__(self) -> str:  # never leak the hash into logs/tracebacks
        return f"Credentials(api_id={self.api_id}, api_hash='***', phone='***', session_name={self.session_name!r})"


def normalize_phone(phone: str) -> str:
    return re.sub(r"[\s\-().]", "", phone or "")


def validate(api_id: str, api_hash: str, phone: str) -> list[str]:
    """Return a list of human-readable problems (empty list = valid)."""
    problems = []
    if not str(api_id).strip().isdigit():
        problems.append("api_id must be a number (e.g. 1234567).")
    if not _API_HASH_RE.match(str(api_hash).strip()):
        problems.append("api_hash must be the 32-character code from my.telegram.org.")
    phone = normalize_phone(phone)
    if phone and not _PHONE_RE.match(phone):
        problems.append("phone must be in international format, e.g. +972501234567.")
    return problems


def load_credentials(path: Path) -> Credentials:
    """Load credentials from environment variables and/or the credentials file."""
    values = {"api_id": "", "api_hash": "", "phone": "", "session_name": "telegram_scraper"}

    if path.is_file():
        _warn_if_permissions_too_open(path)
        parser = configparser.ConfigParser(interpolation=None)
        try:
            parser.read(path, encoding="utf-8")
        except configparser.Error as exc:
            raise CredentialsError(f"Could not read {path}: {exc}") from exc
        if parser.has_section(SECTION):
            for key in values:
                if parser.has_option(SECTION, key) and parser.get(SECTION, key).strip():
                    values[key] = parser.get(SECTION, key).strip()

    env_map = {"api_id": ENV_API_ID, "api_hash": ENV_API_HASH, "phone": ENV_PHONE}
    for key, env in env_map.items():
        if os.environ.get(env, "").strip():
            values[key] = os.environ[env].strip()

    if not values["api_id"] or not values["api_hash"]:
        raise CredentialsError(
            f"No credentials found. Expected file: {path} (or {ENV_API_ID}/{ENV_API_HASH} environment variables)."
        )
    problems = validate(values["api_id"], values["api_hash"], values["phone"])
    if problems:
        raise CredentialsError(f"Invalid credentials in {path}:\n  - " + "\n  - ".join(problems))

    session_name = re.sub(r"[^\w\-]", "_", values["session_name"]) or "telegram_scraper"
    return Credentials(
        api_id=int(values["api_id"]),
        api_hash=values["api_hash"],
        phone=normalize_phone(values["phone"]),
        session_name=session_name,
    )


def save_credentials(path: Path, api_id: str, api_hash: str, phone: str) -> None:
    """Write the credentials file readable/writable by the current user only."""
    parser = configparser.ConfigParser(interpolation=None)
    parser[SECTION] = {
        "api_id": str(api_id).strip(),
        "api_hash": str(api_hash).strip(),
        "phone": normalize_phone(phone),
        "session_name": "telegram_scraper",
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("# Telegram API credentials - KEEP THIS FILE PRIVATE. Do not share or commit it.\n")
        fh.write("# Get api_id / api_hash at https://my.telegram.org -> 'API development tools'.\n")
        parser.write(fh)
    _restrict_permissions(path)


def run_setup_wizard(path: Path) -> Credentials:
    """Interactively ask for credentials and store them in `path`."""
    if not sys.stdin.isatty():
        raise CredentialsError(
            f"Credentials file {path} is missing/invalid and no interactive terminal is available "
            f"to run the setup wizard. Copy credentials.example.ini to {path.name} and fill it in."
        )
    print("\n" + "=" * 64)
    print(" Telegram login setup (one-time)")
    print("=" * 64)
    print(" 1. Open https://my.telegram.org and log in with your phone number.")
    print(" 2. Click 'API development tools' and create an app (any name).")
    print(" 3. Copy the 'App api_id' and 'App api_hash' values below.")
    print(f"\n Your answers are saved to: {path}")
    print(" (a private file outside the source code - you can edit or delete it anytime)\n")

    while True:
        api_id = input(" api_id   : ").strip()
        api_hash = getpass.getpass(" api_hash (hidden while typing/pasting): ").strip()
        phone = input(" phone number with country code, e.g. +972501234567\n"
                      " (press Enter to type it at login instead): ").strip()
        problems = validate(api_id, api_hash, phone)
        if not problems:
            break
        print("\n Please fix the following and try again:")
        for p in problems:
            print(f"   - {p}")
        print()

    save_credentials(path, api_id, api_hash, phone)
    print(f"\n Saved. Next time the scraper will log in automatically using {path.name}.\n")
    return load_credentials(path)


def get_credentials(path: Path) -> Credentials:
    """Load credentials, falling back to the setup wizard when they are missing/invalid."""
    try:
        return load_credentials(path)
    except CredentialsError as exc:
        print(f"[!] {exc}")
        return run_setup_wizard(path)


def _restrict_permissions(path: Path) -> None:
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # best effort (e.g. some Windows filesystems)


def _warn_if_permissions_too_open(path: Path) -> None:
    if os.name != "posix":
        return
    try:
        mode = path.stat().st_mode & 0o777
    except OSError:
        return
    if mode & 0o077:
        print(f"[!] Warning: {path} is readable by other users (mode {oct(mode)}). "
              f"Run: chmod 600 \"{path}\"")
