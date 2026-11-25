"""Runs the full collection flow against a fake Telegram client (no network/account needed)."""
import asyncio
from datetime import datetime, timedelta, timezone

from openpyxl import load_workbook
from telethon import utils
from telethon.tl import types
from telethon.tl.custom.message import Message

from tg_scraper import credentials as cr
from tg_scraper.config import ScraperConfig, TimeZone
from tg_scraper.credentials import Credentials
from tg_scraper.runner import RunOptions, run

NOW = datetime.now(timezone.utc).replace(microsecond=0)
PUBLIC = types.Channel(id=111, title="Alpha News", photo=types.ChatPhotoEmpty(), date=NOW,
                       username="alpha", broadcast=True)
PRIVATE = types.Channel(id=222, title="Secret Ops", photo=types.ChatPhotoEmpty(), date=NOW,
                        username=None, broadcast=True)


def msg(cid, mid, text, ago):
    return Message(id=mid, peer_id=types.PeerChannel(cid), date=NOW - ago, message=text)


HISTORY = {
    111: [msg(111, 5, "bitcoin rally", timedelta(hours=1)), msg(111, 4, "weather", timedelta(hours=2)),
          msg(111, 3, "BITCOIN too old", timedelta(days=10))],
    222: [msg(222, 9, "bitcoin in private", timedelta(hours=3))],
}


class FakeEvent:
    def __init__(self, message, chat_id):
        self.message, self.chat_id = message, chat_id


class FakeClient:
    def __init__(self):
        self.handlers = []
        self.disconnected = asyncio.get_running_loop().create_future()

    async def start(self, phone):
        pass

    async def get_me(self):
        return types.User(id=1, first_name="Tester")

    async def get_dialogs(self):
        pass

    async def get_entity(self, target):
        if target == "@alpha":
            return PUBLIC
        if target == utils.get_peer_id(PRIVATE):
            return PRIVATE
        raise ValueError("Cannot find any entity")

    def add_event_handler(self, callback, event):
        self.handlers.append(callback)

    async def iter_messages(self, entity, offset_date):
        for m in HISTORY[entity.id]:
            yield m

    async def get_messages(self, entity, min_id=0, limit=100):
        return [m for m in HISTORY[entity.id] if m.id > min_id][:limit]


def test_history_and_live(tmp_path):
    async def scenario():
        client = FakeClient()
        cfg = ScraperConfig(channels=["@alpha", str(utils.get_peer_id(PRIVATE)), "@missing"],
                            keywords=["bitcoin"], timezone=TimeZone("UTC"), output_folder=tmp_path,
                            poll_every_seconds=0.3)
        opts = RunOptions(start=NOW - timedelta(days=1), end=datetime.now(timezone.utc) + timedelta(seconds=1.5))

        async def push_live():
            await asyncio.sleep(0.3)
            pid = utils.get_peer_id(PUBLIC)
            for h in client.handlers:
                await h(FakeEvent(msg(111, 6, "live bitcoin news", timedelta(0)), pid))
                await h(FakeEvent(msg(111, 7, "live but irrelevant", timedelta(0)), pid))
                await h(FakeEvent(msg(111, 5, "bitcoin rally", timedelta(hours=1)), pid))  # duplicate
            # Posted in a channel we haven't joined: no push event, only polling can find it.
            HISTORY[222].insert(0, msg(222, 10, "bitcoin via polling", timedelta(0)))

        asyncio.get_running_loop().create_task(push_live())
        return await run(client, Credentials(1, "0" * 32, ""), cfg, opts, tmp_path / "sessions")

    path = asyncio.run(scenario())
    wb = load_workbook(path)
    assert wb.sheetnames == ["Summary", "All Messages", "Alpha News", "Secret Ops"]
    rows = list(wb["All Messages"].iter_rows(min_row=2, values_only=True))
    assert [(r[0], r[5], r[8], r[11]) for r in rows] == [
        ("Secret Ops", "bitcoin in private", "https://t.me/c/222/9", "History"),
        ("Alpha News", "bitcoin rally", "https://t.me/alpha/5", "History"),
        ("Alpha News", "live bitcoin news", "https://t.me/alpha/6", "Live"),
        ("Secret Ops", "bitcoin via polling", "https://t.me/c/222/10", "Live"),
    ]
    summary = {r[0]: r[1] for r in wb["Summary"].iter_rows(values_only=True) if r[0]}
    assert summary["Channels not found"] == "@missing"
    assert summary["Collection method"] == "Chat history + Live new messages"


def test_setup_wizard(tmp_path, monkeypatch):
    for v in (cr.ENV_API_ID, cr.ENV_API_HASH, cr.ENV_PHONE):
        monkeypatch.delenv(v, raising=False)
    answers = iter(["abc", "+1 555", "12345", "+972501234567"])  # first attempt invalid, then valid
    hashes = iter(["nothex", "0123456789abcdef0123456789abcdef"])
    monkeypatch.setattr(cr.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda *_: next(answers))
    monkeypatch.setattr(cr.getpass, "getpass", lambda *_: next(hashes))
    creds = cr.get_credentials(tmp_path / "credentials.ini")
    assert (creds.api_id, creds.phone) == (12345, "+972501234567")
    assert (tmp_path / "credentials.ini").is_file()
