"""Excel output: a Summary sheet, an 'All Messages' sheet and one sheet per channel."""
from __future__ import annotations

import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Iterable

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from .config import TimeZone
from .messages import MessageRecord

MAX_CELL_CHARS = 32767
_HEADER_FILL = PatternFill("solid", fgColor="1F4E78")
_HEADER_FONT = Font(bold=True, color="FFFFFF")
_LINK_FONT = Font(color="0563C1", underline="single")
_SAFE_LINK_RE = re.compile(r"(?i)^(https?|tg)://")

# (header, width, wrap)
COLUMNS = [
    ("Channel", 24, False),
    ("Channel Username", 20, False),
    ("Posted At", 20, False),
    ("Sender", 22, False),
    ("Forwarded From", 22, False),
    ("Text", 70, True),
    ("Links", 45, True),
    ("Matched Keywords", 20, True),
    ("Message Link", 36, False),
    ("Source", 30, False),
    ("Message ID", 11, False),
    ("Collected Via", 13, False),
]


def _clean(value: str) -> str:
    value = ILLEGAL_CHARACTERS_RE.sub("", value or "")
    if len(value) > MAX_CELL_CHARS:
        value = value[: MAX_CELL_CHARS - 15] + " …[truncated]"
    return value


def _set_text(cell, value: str) -> None:
    """Write untrusted text as a literal string (a message starting with '=' must not become a formula)."""
    cell.value = _clean(value)
    cell.data_type = "s"


def _set_link(cell, url: str, label: str | None = None) -> None:
    _set_text(cell, label if label is not None else url)
    if url and _SAFE_LINK_RE.match(url):
        cell.hyperlink = url
        cell.font = _LINK_FONT


def safe_sheet_name(name: str, used: set[str]) -> str:
    base = re.sub(r"[\[\]:*?/\\]", "_", name or "Channel").strip("' ") or "Channel"
    base = base[:31]
    candidate, n = base, 2
    while candidate.lower() in used:
        suffix = f" ({n})"
        candidate = base[: 31 - len(suffix)] + suffix
        n += 1
    used.add(candidate.lower())
    return candidate


def _style_header(ws, headers: list[str], widths: list[int]) -> None:
    ws.append(headers)
    for idx, width in enumerate(widths, start=1):
        cell = ws.cell(row=1, column=idx)
        cell.fill, cell.font = _HEADER_FILL, _HEADER_FONT
        cell.alignment = Alignment(vertical="center")
        ws.column_dimensions[get_column_letter(idx)].width = width
    ws.freeze_panes = "A2"


def _write_messages_sheet(ws, records: list[MessageRecord], tz: TimeZone) -> None:
    headers = [h if h != "Posted At" else f"Posted At ({tz.label})" for h, _, _ in COLUMNS]
    _style_header(ws, headers, [w for _, w, _ in COLUMNS])
    wrap = Alignment(wrap_text=True, vertical="top")
    top = Alignment(vertical="top")

    for r, rec in enumerate(records, start=2):
        row = [
            rec.channel_title, rec.channel_username, None, rec.sender, rec.forwarded_from,
            rec.text, "\n".join(rec.links), ", ".join(rec.matched_keywords),
            None, None, rec.message_id, rec.collected_via,
        ]
        for c, value in enumerate(row, start=1):
            cell = ws.cell(row=r, column=c)
            if isinstance(value, str):
                _set_text(cell, value)
            elif value is not None:
                cell.value = value
            cell.alignment = wrap if COLUMNS[c - 1][2] else top

        posted = ws.cell(row=r, column=3)
        posted.value = tz.convert(rec.posted_at).replace(tzinfo=None)  # Excel has no time zones
        posted.number_format = "yyyy-mm-dd hh:mm:ss"
        if len(rec.links) == 1:
            _set_link(ws.cell(row=r, column=7), rec.links[0])
        _set_link(ws.cell(row=r, column=9), rec.message_link)
        src = rec.source if rec.source.startswith("https://") else ""
        _set_link(ws.cell(row=r, column=10), src, rec.source)

    if records:
        ws.auto_filter.ref = f"A1:{get_column_letter(len(COLUMNS))}{len(records) + 1}"


def _write_summary(ws, records: list[MessageRecord], meta: dict, per_channel: dict) -> None:
    ws.column_dimensions["A"].width = 28
    ws.column_dimensions["B"].width = 60
    ws.column_dimensions["C"].width = 16
    title = ws.cell(row=1, column=1, value="Telegram Scrape Report")
    title.font = Font(bold=True, size=14)
    row = 3
    for label, value in meta.items():
        ws.cell(row=row, column=1, value=label).font = Font(bold=True)
        _set_text(ws.cell(row=row, column=2), str(value))
        ws.cell(row=row, column=2).alignment = Alignment(wrap_text=True, vertical="top")
        row += 1
    ws.cell(row=row, column=1, value="Total messages").font = Font(bold=True)
    ws.cell(row=row, column=2, value=len(records))
    row += 2
    for c, h in enumerate(["Channel", "Source", "Messages"], start=1):
        cell = ws.cell(row=row, column=c, value=h)
        cell.fill, cell.font = _HEADER_FILL, _HEADER_FONT
    for (title_, source), count in per_channel.items():
        row += 1
        _set_text(ws.cell(row=row, column=1), title_)
        _set_link(ws.cell(row=row, column=2), source if source.startswith("https://") else "", source)
        ws.cell(row=row, column=3, value=count)


def write_workbook(records: Iterable[MessageRecord], path: Path, tz: TimeZone, meta: dict,
                   channel_order: list[tuple[str, str]] | None = None) -> Path:
    """Write the report atomically (temp file + rename) so a crash never leaves a corrupt file."""
    records = sorted(records, key=lambda r: (r.posted_at, r.channel_title, r.message_id))

    by_channel: dict[tuple[str, str], list[MessageRecord]] = {}
    for key in channel_order or []:
        by_channel.setdefault(key, [])
    for rec in records:
        by_channel.setdefault((rec.channel_title, rec.source), []).append(rec)

    wb = Workbook()
    summary = wb.active
    summary.title = "Summary"
    _write_summary(summary, records, meta, {k: len(v) for k, v in by_channel.items()})

    used = {"summary", "all messages"}
    _write_messages_sheet(wb.create_sheet("All Messages"), records, tz)
    for (title, _source), recs in by_channel.items():
        _write_messages_sheet(wb.create_sheet(safe_sheet_name(title, used)), recs, tz)

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp_", suffix=".xlsx", dir=path.parent)
    os.close(fd)
    try:
        wb.save(tmp)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return path


def default_output_path(folder: Path, start: datetime, end: datetime) -> Path:
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    return folder / f"telegram_{start:%Y-%m-%d}_to_{end:%Y-%m-%d}_{stamp}.xlsx"
