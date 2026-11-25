"""Turning Telegram messages into rows: link extraction, keyword filtering, message links."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from telethon import utils
from telethon.tl import types


@dataclass
class ChannelInfo:
    entity: object
    peer_id: int  # Telethon "marked" id (e.g. -100123...), used to match live events
    title: str
    username: str  # "" for private channels/groups
    requested_as: str  # what the user wrote in config.yaml
    last_id: int = 0  # newest message id seen; live polling asks for anything newer

    @property
    def source(self) -> str:
        return f"https://t.me/{self.username}" if self.username else f"Private channel (ID {self.peer_id})"


@dataclass
class MessageRecord:
    channel_title: str
    channel_username: str
    channel_id: int
    message_id: int
    posted_at: datetime  # timezone-aware
    sender: str
    forwarded_from: str
    text: str
    links: list[str] = field(default_factory=list)
    matched_keywords: list[str] = field(default_factory=list)
    message_link: str = ""
    source: str = ""
    collected_via: str = "History"

    @property
    def key(self) -> tuple[int, int]:
        return (self.channel_id, self.message_id)


# ---------------------------------------------------------------- keywords
class KeywordMatcher:
    """Matches keywords against text. No keywords configured = every message matches."""

    def __init__(self, keywords: list[str], *, case_sensitive: bool = False,
                 whole_word: bool = False, match_mode: str = "any",
                 search_in_links: bool = True):
        self.search_in_links = search_in_links
        self.keywords = [k for k in (kw.strip() for kw in keywords) if k]
        self.match_mode = match_mode
        flags = 0 if case_sensitive else re.IGNORECASE
        self._patterns = []
        for kw in self.keywords:
            body = re.escape(kw)
            if whole_word:
                # \b fails next to non-word chars (e.g. "#tag", "C++"), so use look-arounds.
                body = rf"(?<!\w){body}(?!\w)"
            self._patterns.append((kw, re.compile(body, flags)))

    @property
    def active(self) -> bool:
        return bool(self._patterns)

    def match(self, text: str) -> Optional[list[str]]:
        """Return the matched keywords, or None if the message should be excluded."""
        if not self._patterns:
            return []
        found = [kw for kw, pat in self._patterns if pat.search(text or "")]
        if self.match_mode == "all":
            return found if len(found) == len(self._patterns) else None
        return found or None


# ---------------------------------------------------------------- links
_URL_RE = re.compile(r"(?i)\b(?:https?://|www\.|t\.me/)[^\s<>\"'\]\[)(]+")
_TRAILING_PUNCT = ".,;:!?…»”’"


def _clean_url(url: str) -> str:
    url = url.strip().rstrip(_TRAILING_PUNCT)
    if url and not re.match(r"(?i)^[a-z][a-z0-9+.\-]*:", url):
        url = "https://" + url
    return url


def extract_links(message) -> list[str]:
    """All URLs in a message: inline links, hidden (text) links, link previews and URL buttons."""
    links: list[str] = []

    def add(url: Optional[str]) -> None:
        if url:
            url = _clean_url(url)
            if url and url not in links:
                links.append(url)

    try:
        entity_texts = message.get_entities_text() or []
    except Exception:
        entity_texts = []
    for entity, text in entity_texts:
        if isinstance(entity, types.MessageEntityTextUrl):
            add(entity.url)
        elif isinstance(entity, types.MessageEntityUrl):
            add(text)

    for match in _URL_RE.finditer(message.message or ""):  # fallback for un-annotated URLs
        add(match.group(0))

    media = getattr(message, "media", None)
    if isinstance(media, types.MessageMediaWebPage) and isinstance(media.webpage, types.WebPage):
        add(media.webpage.url)

    markup = getattr(message, "reply_markup", None)
    for row in getattr(markup, "rows", None) or []:
        for button in getattr(row, "buttons", None) or []:
            # Older API layers: KeyboardButtonUrl(url=...); newer: KeyboardButton(type=InlineButtonTypeUrl(url=...))
            for holder in (button, getattr(button, "type", None)):
                url = getattr(holder, "url", None)
                if isinstance(url, str):
                    add(url)
                    break
    return links


# ---------------------------------------------------------------- channel helpers
def entity_username(entity) -> str:
    username = getattr(entity, "username", None)
    if username:
        return username
    for u in getattr(entity, "usernames", None) or []:  # channels with collectible usernames
        if getattr(u, "active", False) and getattr(u, "username", None):
            return u.username
    return ""


def build_message_link(entity, message_id: int) -> str:
    """Direct t.me link. Private channels use the t.me/c/ form (opens for members only)."""
    username = entity_username(entity)
    if username:
        return f"https://t.me/{username}/{message_id}"
    if isinstance(entity, types.Channel):
        return f"https://t.me/c/{entity.id}/{message_id}"
    return ""  # basic groups / private chats have no public message links


def _display_name(entity) -> str:
    if entity is None:
        return ""
    name = utils.get_display_name(entity) or ""
    username = entity_username(entity)
    if username:
        name = f"{name} (@{username})" if name else f"@{username}"
    return name


def sender_name(message, channel: ChannelInfo) -> str:
    if getattr(message, "post_author", None):  # signed channel posts
        return message.post_author
    sender = getattr(message, "sender", None)
    if sender is not None and getattr(sender, "id", None) != getattr(channel.entity, "id", None):
        return _display_name(sender)
    return channel.title


def forwarded_from(message) -> str:
    fwd = getattr(message, "forward", None)
    if fwd is None:
        return ""
    for attr in ("chat", "sender"):
        try:
            ent = getattr(fwd, attr, None)
        except Exception:
            ent = None
        if ent is not None:
            return _display_name(ent)
    header = getattr(fwd, "original_fwd", None)
    name = getattr(fwd, "from_name", None) or getattr(header, "from_name", None)
    return name or "Hidden/unknown source"


def build_record(message, channel: ChannelInfo, matcher: KeywordMatcher,
                 collected_via: str) -> Optional[MessageRecord]:
    """Convert a Telethon message into a row, or None if it should be skipped."""
    if getattr(message, "action", None) is not None:  # service messages (joins, pins, ...)
        return None
    text = message.message or ""
    if not text.strip():  # text & links only: skip pure media without a caption
        return None
    links = extract_links(message)
    haystack = text
    if matcher.search_in_links and links:
        haystack += "\n" + "\n".join(links)
    matched = matcher.match(haystack)
    if matched is None:
        return None
    return MessageRecord(
        channel_title=channel.title,
        channel_username=f"@{channel.username}" if channel.username else "",
        channel_id=channel.peer_id,
        message_id=message.id,
        posted_at=message.date,
        sender=sender_name(message, channel),
        forwarded_from=forwarded_from(message),
        text=text,
        links=links,
        matched_keywords=matched,
        message_link=build_message_link(channel.entity, message.id),
        source=channel.source,
        collected_via=collected_via,
    )
