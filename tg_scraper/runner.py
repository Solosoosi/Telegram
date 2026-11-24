"""Login, channel resolution, history collection and live listening."""
from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from telethon import TelegramClient, errors, events, utils
from telethon.tl import types

from .config import ScraperConfig
from .credentials import Credentials
from .excel_writer import default_output_path, write_workbook
from .messages import ChannelInfo, KeywordMatcher, MessageRecord, build_record, entity_username

MODES = ("history", "live", "both")


@dataclass
class RunOptions:
    start: datetime
    end: datetime
    mode: str = "both"
    output: Path | None = None


# ---------------------------------------------------------------- login
def make_client(creds: Credentials, session_dir: Path) -> TelegramClient:
    session_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(session_dir, 0o700)
    except OSError:
        pass
    client = TelegramClient(str(session_dir / creds.session_name), creds.api_id, creds.api_hash)
    client.flood_sleep_threshold = 300  # wait out rate limits of up to 5 minutes automatically
    return client


async def login(client: TelegramClient, creds: Credentials, session_dir: Path) -> None:
    """Log in. Only the first run asks for the login code (and 2FA password, if set)."""
    phone = creds.phone or (lambda: input("Phone number (international format, e.g. +972501234567): "))
    await client.start(phone=phone)
    me = await client.get_me()
    print(f"[+] Logged in as {utils.get_display_name(me)}")
    session_file = session_dir / f"{creds.session_name}.session"
    try:
        os.chmod(session_file, 0o600)
    except OSError:
        pass


# ---------------------------------------------------------------- channels
_PRIVATE_LINK_RE = re.compile(r"(?i)^(?:https?://)?t\.me/c/(\d+)(?:/\d+)?/?$")


def _parse_channel_ref(ref: str):
    ref = ref.strip()
    m = _PRIVATE_LINK_RE.match(ref)
    if m:
        return types.PeerChannel(int(m.group(1)))
    if re.fullmatch(r"-?\d+", ref):
        return int(ref)
    return ref


async def resolve_channels(client: TelegramClient, refs: list[str]) -> tuple[list[ChannelInfo], list[str]]:
    channels: list[ChannelInfo] = []
    failed: list[str] = []
    dialogs_loaded = False
    seen: set[int] = set()
    for ref in refs:
        target = _parse_channel_ref(ref)
        entity = None
        for attempt in range(2):
            try:
                entity = await client.get_entity(target)
                break
            except (ValueError, TypeError, errors.RPCError) as exc:
                # Numeric IDs are only known after the dialog list was loaded once.
                if attempt == 0 and not dialogs_loaded and not isinstance(target, str):
                    await client.get_dialogs()
                    dialogs_loaded = True
                    continue
                print(f"[!] Could not find channel '{ref}': {exc}")
                break
        if entity is None:
            failed.append(ref)
            continue
        peer_id = utils.get_peer_id(entity)
        if peer_id in seen:
            continue
        seen.add(peer_id)
        info = ChannelInfo(entity=entity, peer_id=peer_id, title=utils.get_display_name(entity) or ref,
                           username=entity_username(entity), requested_as=ref)
        channels.append(info)
        print(f"[+] Channel: {info.title} ({info.source})")
    return channels, failed


async def list_channels(client: TelegramClient) -> None:
    print(f"\n{'ID':>16}  {'Username':<28} Title")
    print("-" * 80)
    async for dialog in client.iter_dialogs():
        if dialog.is_channel or dialog.is_group:
            username = entity_username(dialog.entity)
            print(f"{dialog.id:>16}  {('@' + username) if username else '(private)':<28} {dialog.name}")
    print("\nCopy the @username (public) or the ID (private) into the 'channels' list in config.yaml.")


# ---------------------------------------------------------------- results
class ResultStore:
    def __init__(self) -> None:
        self.records: dict[tuple[int, int], MessageRecord] = {}
        self.dirty = False

    def add(self, rec: MessageRecord) -> bool:
        if rec.key in self.records:
            return False
        self.records[rec.key] = rec
        self.dirty = True
        return True


class Saver:
    def __init__(self, path: Path, store: ResultStore, cfg: ScraperConfig, meta: dict,
                 channels: list[ChannelInfo]):
        self.path, self.store, self.cfg, self.meta = path, store, cfg, meta
        self.channel_order = [(c.title, c.source) for c in channels]

    def save(self, final: bool = False) -> None:
        try:
            write_workbook(self.store.records.values(), self.path, self.cfg.timezone,
                           self.meta, self.channel_order)
            self.store.dirty = False
        except PermissionError:
            if not final:
                print(f"[!] Could not update {self.path.name} (is it open in Excel?). Will retry.")
                return
            alt = self.path.with_name(f"{self.path.stem}_{datetime.now():%H%M%S}.xlsx")
            print(f"[!] {self.path.name} is locked (open in Excel?). Saving to {alt.name} instead.")
            self.path = alt
            write_workbook(self.store.records.values(), alt, self.cfg.timezone, self.meta, self.channel_order)
            self.store.dirty = False


# ---------------------------------------------------------------- collection
async def collect_history(client: TelegramClient, channel: ChannelInfo, start_utc: datetime,
                          end_utc: datetime, matcher: KeywordMatcher, store: ResultStore) -> int:
    scanned = kept = 0
    try:
        async for msg in client.iter_messages(channel.entity, offset_date=end_utc):
            if msg.date < start_utc:
                break
            if msg.date > end_utc:
                continue
            scanned += 1
            rec = build_record(msg, channel, matcher, "History")
            if rec and store.add(rec):
                kept += 1
            if scanned % 500 == 0:
                print(f"    ... {channel.title}: scanned {scanned}, kept {kept} "
                      f"(now at {msg.date.astimezone():%Y-%m-%d})")
    except errors.FloodWaitError as exc:
        print(f"[!] Telegram rate limit on '{channel.title}' ({exc.seconds}s). Partial results kept.")
    except (errors.ChannelPrivateError, errors.ChatAdminRequiredError) as exc:
        print(f"[!] No access to '{channel.title}': {exc}")
    print(f"[+] {channel.title}: scanned {scanned} messages, kept {kept}")
    return kept


def register_live_handler(client: TelegramClient, channels: list[ChannelInfo], start_utc: datetime,
                          end_utc: datetime, matcher: KeywordMatcher, store: ResultStore, tz) -> None:
    by_peer = {c.peer_id: c for c in channels}

    async def on_new_message(event):
        try:
            channel = by_peer.get(event.chat_id)
            msg = event.message
            if channel is None or not (start_utc <= msg.date <= end_utc):
                return
            rec = build_record(msg, channel, matcher, "Live")
            if rec and store.add(rec):
                kw = f" [{', '.join(rec.matched_keywords)}]" if rec.matched_keywords else ""
                print(f"[live] {tz.convert(msg.date):%Y-%m-%d %H:%M:%S} {channel.title}{kw}: "
                      f"{rec.text[:70].replace(chr(10), ' ')}")
        except Exception as exc:  # never let one bad message stop the listener
            print(f"[!] Failed to process live message: {exc!r}")

    client.add_event_handler(on_new_message, events.NewMessage(chats=[c.entity for c in channels]))


async def run(client: TelegramClient, creds: Credentials, cfg: ScraperConfig, opts: RunOptions,
              session_dir: Path) -> Path | None:
    tz = cfg.timezone
    start_utc = opts.start.astimezone(timezone.utc)
    end_utc = opts.end.astimezone(timezone.utc)
    now_utc = datetime.now(timezone.utc)

    do_history = opts.mode in ("history", "both")
    do_live = opts.mode in ("live", "both")
    if do_live and end_utc <= now_utc:
        if opts.mode == "live":
            raise SystemExit("[x] Live mode needs an end date in the future (e.g. --end 2026-12-31).")
        print("[i] End date is in the past - collecting history only (no live listening).")
        do_live = False

    matcher = KeywordMatcher(cfg.keywords, case_sensitive=cfg.case_sensitive, whole_word=cfg.whole_word,
                             match_mode=cfg.match_mode, search_in_links=cfg.search_in_links)

    await login(client, creds, session_dir)
    channels, failed = await resolve_channels(client, cfg.channels)
    if not channels:
        raise SystemExit("[x] None of the configured channels could be found. Check config.yaml.")

    method = " + ".join(m for m, on in (("Chat history", do_history), ("Live new messages", do_live)) if on)
    meta = {
        "Generated at": f"{tz.now():%Y-%m-%d %H:%M:%S} ({tz.label})",
        "Collection period": f"{tz.convert(opts.start):%Y-%m-%d %H:%M} -> {tz.convert(opts.end):%Y-%m-%d %H:%M} ({tz.label})",
        "Collection method": method,
        "Channels": "\n".join(f"{c.title} - {c.source}" for c in channels),
        "Channels not found": "\n".join(failed) or "-",
        "Keywords": ", ".join(cfg.keywords) or "(none - all messages)",
        "Keyword match": f"{cfg.match_mode}; case-sensitive={cfg.case_sensitive}; whole-word={cfg.whole_word}",
    }
    out_path = opts.output or default_output_path(cfg.output_folder, tz.convert(opts.start), tz.convert(opts.end))
    store = ResultStore()
    saver = Saver(out_path, store, cfg, meta, channels)

    autosave_task = None
    try:
        if do_live:  # register first so nothing posted during the history pass is missed
            register_live_handler(client, channels, start_utc, end_utc, matcher, store, tz)

        if do_history:
            print(f"\n[*] Collecting history {tz.convert(opts.start):%Y-%m-%d %H:%M} -> "
                  f"{tz.convert(opts.end):%Y-%m-%d %H:%M} ({tz.label})")
            for channel in channels:
                await collect_history(client, channel, start_utc, end_utc, matcher, store)
            saver.save()
            print(f"[+] History saved: {saver.path}")

        if do_live:
            async def autosave():
                while True:
                    await asyncio.sleep(cfg.save_every_seconds)
                    if store.dirty:
                        saver.save()

            saver.save()
            autosave_task = asyncio.create_task(autosave())
            remaining = (end_utc - datetime.now(timezone.utc)).total_seconds()
            print(f"\n[*] Listening for new messages until {tz.convert(opts.end):%Y-%m-%d %H:%M} "
                  f"({tz.label}). Press Ctrl+C to stop - results are saved automatically.")
            await asyncio.wait({client.disconnected}, timeout=max(0.0, remaining))
            print("[+] Live collection finished.")
    finally:
        if autosave_task:
            autosave_task.cancel()
        saver.save(final=True)
        print(f"\n[+] {len(store.records)} messages written to: {saver.path}")
    return saver.path
