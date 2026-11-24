import os
from datetime import datetime, timezone
from pathlib import Path

import pytest
from openpyxl import load_workbook
from telethon.tl import types
from telethon.tl.custom.message import Message

from tg_scraper import credentials as cr
from tg_scraper.config import ConfigError, TimeZone, load_config, parse_date
from tg_scraper.excel_writer import safe_sheet_name, write_workbook
from tg_scraper.messages import (ChannelInfo, KeywordMatcher, build_message_link, build_record,
                                 extract_links)
from tg_scraper.runner import _parse_channel_ref

HASH = "0123456789abcdef0123456789abcdef"


def make_channel(username="newschan", cid=1234567890, title="News Channel"):
    ent = types.Channel(id=cid, title=title, photo=types.ChatPhotoEmpty(),
                        date=datetime(2020, 1, 1, tzinfo=timezone.utc), username=username, broadcast=True)
    return ChannelInfo(entity=ent, peer_id=int(f"-100{cid}"), title=title, username=username or "",
                       requested_as=f"@{username}")


def make_msg(text, mid=10, entities=None, media=None, markup=None,
             date=datetime(2026, 11, 20, 8, 30, tzinfo=timezone.utc)):
    return Message(id=mid, peer_id=types.PeerChannel(1234567890), date=date, message=text,
                   entities=entities, media=media, reply_markup=markup)


# ------------------------------------------------------------ keywords
def test_keyword_any_case_insensitive():
    m = KeywordMatcher(["Bitcoin", "ETH"])
    assert m.match("bitcoin is up") == ["Bitcoin"]
    assert m.match("nothing here") is None


def test_keyword_all_mode():
    m = KeywordMatcher(["a1", "b2"], match_mode="all")
    assert m.match("a1 and b2") == ["a1", "b2"]
    assert m.match("only a1") is None


def test_keyword_whole_word_and_hebrew():
    m = KeywordMatcher(["art", "#tag", "שלום"], whole_word=True)
    assert m.match("start") is None
    assert m.match("modern art.") == ["art"]
    assert m.match("see #tag!") == ["#tag"]
    assert m.match("אמר שלום לכולם") == ["שלום"]
    assert m.match("שלומית") is None


def test_no_keywords_matches_everything():
    assert KeywordMatcher([]).match("anything") == []


# ------------------------------------------------------------ links
def url_button(text, url):
    if hasattr(types, "KeyboardButtonUrl"):  # older Telethon API layers
        return types.KeyboardButtonUrl(text=text, url=url)
    return types.KeyboardButton(text=text, type=types.InlineButtonTypeUrl(url=url))


def test_extract_links_all_sources():
    text = "Read 🚀 example.com/a, and click here."
    # 🚀 is 2 UTF-16 code units: "Read " (5) + 2 + " " (1) => offset 8
    ents = [types.MessageEntityUrl(offset=8, length=13),
            types.MessageEntityTextUrl(offset=30, length=4, url="https://hidden.example/x")]
    media = types.MessageMediaWebPage(webpage=types.WebPage(
        id=1, url="https://preview.example/p", display_url="preview.example/p", hash=0))
    markup = types.ReplyInlineMarkup(rows=[types.KeyboardButtonRow(buttons=[
        url_button("Go", "https://button.example")])])
    links = extract_links(make_msg(text, entities=ents, media=media, markup=markup))
    assert links == ["https://example.com/a", "https://hidden.example/x",
                     "https://preview.example/p", "https://button.example"]


def test_extract_links_regex_fallback():
    assert extract_links(make_msg("see https://x.io/p?q=1. and t.me/chan")) == \
        ["https://x.io/p?q=1", "https://t.me/chan"]


def test_message_links():
    assert build_message_link(make_channel().entity, 55) == "https://t.me/newschan/55"
    assert build_message_link(make_channel(username=None).entity, 55) == "https://t.me/c/1234567890/55"


def test_parse_channel_ref():
    assert _parse_channel_ref("-1001234") == -1001234
    assert _parse_channel_ref("https://t.me/c/1234/99") == types.PeerChannel(1234)
    assert _parse_channel_ref("@foo") == "@foo"


# ------------------------------------------------------------ records
def test_build_record_filters():
    ch = make_channel()
    m = KeywordMatcher(["launch"])
    rec = build_record(make_msg("Big LAUNCH today"), ch, m, "History")
    assert rec.matched_keywords == ["launch"]
    assert rec.message_link == "https://t.me/newschan/10"
    assert rec.source == "https://t.me/newschan"
    assert rec.channel_id == -1001234567890
    assert build_record(make_msg("unrelated"), ch, m, "History") is None
    assert build_record(make_msg(""), ch, KeywordMatcher([]), "History") is None  # media only


def test_keyword_in_link_only():
    ch = make_channel()
    msg = make_msg("look", entities=[types.MessageEntityTextUrl(0, 4, "https://site/launch-news")])
    assert build_record(msg, ch, KeywordMatcher(["launch"]), "Live").matched_keywords == ["launch"]
    assert build_record(msg, ch, KeywordMatcher(["launch"], search_in_links=False), "Live") is None


# ------------------------------------------------------------ dates
def test_parse_dates():
    tz = TimeZone("Asia/Jerusalem")
    s = parse_date("2026-11-01", tz, is_end=False)
    e = parse_date("2026-11-01", tz, is_end=True)
    assert (s.hour, s.minute) == (0, 0) and (e.hour, e.minute, e.second) == (23, 59, 59)
    assert s.utcoffset().total_seconds() == 2 * 3600
    assert parse_date("2026-07-01 14:30", tz, is_end=False).utcoffset().total_seconds() == 3 * 3600  # DST
    seven = parse_date("7d", tz, is_end=False)
    assert 6.99 < (tz.now() - seven).total_seconds() / 86400 < 7.01
    with pytest.raises(ConfigError):
        parse_date("01/11/2026", tz, is_end=False)


def test_bad_timezone():
    with pytest.raises(ConfigError):
        TimeZone("Mars/Base")


# ------------------------------------------------------------ config & credentials
def test_load_config(tmp_path):
    p = tmp_path / "config.yaml"
    p.write_text("channels:\n  - '@a'\n  - -1001\nkeywords: []\ntimezone: UTC\n", encoding="utf-8")
    cfg = load_config(p)
    assert cfg.channels == ["@a", "-1001"]
    assert cfg.keywords == [] and cfg.output_folder == tmp_path / "output"


def test_credentials_roundtrip(tmp_path, monkeypatch):
    for v in (cr.ENV_API_ID, cr.ENV_API_HASH, cr.ENV_PHONE):
        monkeypatch.delenv(v, raising=False)
    p = tmp_path / "credentials.ini"
    cr.save_credentials(p, "12345", HASH, "+972 50-123-4567")
    if os.name == "posix":
        assert (p.stat().st_mode & 0o777) == 0o600
    c = cr.load_credentials(p)
    assert (c.api_id, c.api_hash, c.phone) == (12345, HASH, "+972501234567")
    assert HASH not in repr(c)


def test_credentials_env_override_and_errors(tmp_path, monkeypatch):
    p = tmp_path / "missing.ini"
    monkeypatch.delenv(cr.ENV_PHONE, raising=False)
    monkeypatch.delenv(cr.ENV_API_ID, raising=False)
    monkeypatch.delenv(cr.ENV_API_HASH, raising=False)
    with pytest.raises(cr.CredentialsError):
        cr.load_credentials(p)
    monkeypatch.setenv(cr.ENV_API_ID, "999")
    monkeypatch.setenv(cr.ENV_API_HASH, HASH)
    assert cr.load_credentials(p).api_id == 999
    monkeypatch.setenv(cr.ENV_API_HASH, "short")
    with pytest.raises(cr.CredentialsError, match="api_hash"):
        cr.load_credentials(p)


# ------------------------------------------------------------ excel
def test_write_workbook(tmp_path):
    a, b = make_channel(), make_channel(username=None, cid=42, title="Private: Ops/Team")
    m = KeywordMatcher([])
    recs = [
        build_record(make_msg("=SUM(1,2) not a formula\x07", mid=1), a, m, "History"),
        build_record(make_msg("second https://x.io", mid=2,
                              date=datetime(2026, 11, 21, tzinfo=timezone.utc)), b, m, "Live"),
    ]
    out = write_workbook(recs, tmp_path / "out.xlsx", TimeZone("Asia/Jerusalem"), {"Keywords": "x"},
                         [(a.title, a.source), (b.title, b.source)])
    wb = load_workbook(out)
    assert wb.sheetnames == ["Summary", "All Messages", "News Channel", "Private_ Ops_Team"]
    ws = wb["All Messages"]
    assert ws["C1"].value == "Posted At (Asia/Jerusalem)"
    assert ws["F2"].value == "=SUM(1,2) not a formula" and ws["F2"].data_type == "s"
    assert ws["C2"].value == datetime(2026, 11, 20, 10, 30)  # 08:30 UTC -> 10:30 Israel
    assert ws["I2"].hyperlink.target == "https://t.me/newschan/1"
    assert ws["I3"].value == "https://t.me/c/42/2"
    assert ws["G3"].hyperlink.target == "https://x.io"
    assert ws["L3"].value == "Live"
    assert wb["News Channel"].max_row == 2
    assert not list(Path(tmp_path).glob(".tmp_*"))


def test_safe_sheet_name():
    used = {"summary"}
    assert safe_sheet_name("Summary", used) == "Summary (2)"
    long = "x" * 40
    assert safe_sheet_name(long, used) == "x" * 31
    assert safe_sheet_name(long, used) == "x" * 27 + " (2)"
