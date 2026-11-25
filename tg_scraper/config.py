"""Scraper settings (config.yaml) and collection-period parsing."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Optional

import yaml

try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - Python < 3.9
    raise SystemExit("Python 3.9 or newer is required.")


class ConfigError(Exception):
    """Raised for invalid settings or dates."""


class TimeZone:
    """Wraps either the computer's local time zone or a named IANA zone (DST-aware)."""

    def __init__(self, name: str = "local"):
        self.name = (name or "local").strip()
        self._zone: Optional[tzinfo] = None
        if self.name.lower() != "local":
            try:
                self._zone = ZoneInfo(self.name)
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise ConfigError(
                    f"Unknown timezone '{self.name}'. Use 'local' or a name like 'Asia/Jerusalem', 'UTC'."
                ) from exc

    @property
    def label(self) -> str:
        if self._zone is not None:
            return self.name
        return datetime.now().astimezone().tzname() or "local"

    def localize(self, naive: datetime) -> datetime:
        """Interpret a naive datetime as wall-clock time in this zone."""
        if self._zone is None:
            return naive.astimezone()  # naive -> system local time, DST aware
        return naive.replace(tzinfo=self._zone)

    def convert(self, aware: datetime) -> datetime:
        if aware.tzinfo is None:
            aware = aware.replace(tzinfo=timezone.utc)
        return aware.astimezone(self._zone) if self._zone is not None else aware.astimezone()

    def now(self) -> datetime:
        return self.convert(datetime.now(timezone.utc))


@dataclass
class ScraperConfig:
    channels: list[str]
    keywords: list[str] = field(default_factory=list)
    case_sensitive: bool = False
    whole_word: bool = False
    match_mode: str = "any"  # "any" or "all"
    search_in_links: bool = True
    timezone: TimeZone = field(default_factory=TimeZone)
    output_folder: Path = Path("output")
    save_every_seconds: int = 30
    poll_every_seconds: float = 30


def _as_list(value, name: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (str, int)):
        value = [value]
    if not isinstance(value, list):
        raise ConfigError(f"'{name}' must be a list.")
    return [str(v).strip() for v in value if v is not None and str(v).strip()]


def load_config(path: Path) -> ScraperConfig:
    if not path.is_file():
        raise ConfigError(f"Settings file not found: {path}")
    try:
        with open(path, encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"{path} is not valid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"{path} must contain 'key: value' settings.")

    opts = raw.get("keyword_options") or {}
    live = raw.get("live") or {}
    match_mode = str(opts.get("match", "any")).strip().lower()
    if match_mode not in ("any", "all"):
        raise ConfigError("keyword_options.match must be 'any' or 'all'.")

    out = Path(str(raw.get("output_folder") or "output")).expanduser()
    if not out.is_absolute():
        out = path.parent / out

    try:
        save_every = int(live.get("save_every_seconds", 30))
        poll_every = float(live.get("poll_every_seconds", 30))
    except (TypeError, ValueError) as exc:
        raise ConfigError("live.save_every_seconds and live.poll_every_seconds must be numbers.") from exc

    return ScraperConfig(
        channels=_as_list(raw.get("channels"), "channels"),
        keywords=_as_list(raw.get("keywords"), "keywords"),
        case_sensitive=bool(opts.get("case_sensitive", False)),
        whole_word=bool(opts.get("whole_word", False)),
        match_mode=match_mode,
        search_in_links=bool(opts.get("search_in_links", True)),
        timezone=TimeZone(str(raw.get("timezone") or "local")),
        output_folder=out,
        save_every_seconds=max(5, save_every),
        poll_every_seconds=max(10.0, poll_every),
    )


_RELATIVE_RE = re.compile(r"^(\d+)\s*([mhdw])$", re.IGNORECASE)
_DATE_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M")
DATE_HELP = (
    "YYYY-MM-DD, 'YYYY-MM-DD HH:MM', today, yesterday, now, "
    "or how far back: 30m, 12h, 7d, 4w"
)


def parse_date(text: str, tz: TimeZone, *, is_end: bool) -> datetime:
    """Parse a user-supplied date in the configured time zone.

    A bare date means the start of that day for the start date and the end of that
    day (23:59:59) for the end date, so `--start 2026-11-01 --end 2026-11-01`
    covers the whole of Nov 1st.
    """
    s = (text or "").strip()
    if not s:
        raise ConfigError("Date is empty.")
    low = s.lower()
    now = tz.now()

    if low == "now":
        return now
    if low in ("today", "yesterday"):
        day = now.date() - timedelta(days=1 if low == "yesterday" else 0)
        return tz.localize(datetime.combine(day, time.max if is_end else time.min))

    m = _RELATIVE_RE.match(low)
    if m:
        amount, unit = int(m.group(1)), m.group(2)
        delta = {"m": timedelta(minutes=amount), "h": timedelta(hours=amount),
                 "d": timedelta(days=amount), "w": timedelta(weeks=amount)}[unit]
        return now - delta

    try:
        d = datetime.strptime(s, "%Y-%m-%d")
        return tz.localize(datetime.combine(d.date(), time.max if is_end else time.min))
    except ValueError:
        pass
    for fmt in _DATE_FORMATS:
        try:
            return tz.localize(datetime.strptime(s, fmt))
        except ValueError:
            continue
    raise ConfigError(f"Could not understand date '{s}'. Use: {DATE_HELP}")
