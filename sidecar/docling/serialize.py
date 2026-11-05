"""Pure serializer for the OntoLab document-parsing sidecar.

Turns a flat, reading-ordered list of blocks into the ``/parse`` response
dict (``text`` plus ``pages`` / ``sections`` / ``tables`` spans).

This module must stay free of docling (and any third-party) imports so it can
be unit-tested with only the standard library.

Offsets
-------
Every ``start`` / ``end`` value is measured in UTF-16 code units, i.e. it can
be used directly with JavaScript ``String.prototype.slice`` on the ``text``
value. A character outside the Basic Multilingual Plane (e.g. an emoji) counts
as 2. Spans are half-open: ``text.slice(start, end)``.

Block shape (input)
-------------------
``{"kind": "heading"|"paragraph"|"list_item"|"table", "text": str,
   "level": int|None, "page": int|None}``

A ``table`` block may carry ``"rows": [[str, ...], ...]`` instead of ``text``;
it is then rendered as a GitHub pipe table (first row is the header).
"""

from __future__ import annotations

import re
from typing import Any, Iterable

BLOCK_SEPARATOR = "\n\n"
KINDS = ("heading", "paragraph", "list_item", "table")

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_BLANK_LINES = re.compile(r"\n[ \t]*\n+")
_INLINE_WS = re.compile(r"\s+")
_BULLET_PREFIX = re.compile(r"^(?:[-*+•▪●◦‣⁃·–—]\s+)+")


def utf16_len(s: str) -> int:
    """Length of ``s`` in UTF-16 code units (what JavaScript's ``.length`` reports)."""
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def _clean(s: Any) -> str:
    s = "" if s is None else str(s)
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = _CONTROL_CHARS.sub("", s)
    return s


def _clean_multiline(s: Any) -> str:
    """Normalise a block body: no blank lines inside a block, no trailing spaces."""
    s = _clean(s)
    s = _BLANK_LINES.sub("\n", s)
    lines = [line.rstrip() for line in s.split("\n")]
    return "\n".join(lines).strip()


def _single_line(s: Any) -> str:
    return _INLINE_WS.sub(" ", _clean(s)).strip()


def _cell(s: Any) -> str:
    return _single_line(s).replace("|", "\\|")


def table_to_markdown(rows: Iterable[Iterable[Any]]) -> str:
    """Render rows as a GitHub pipe table. The first row is the header row.

    Returns an empty string when there are no non-empty cells.
    """
    grid = [[_cell(c) for c in row] for row in rows]
    grid = [row for row in grid if row]
    if not grid or not any(c for row in grid for c in row):
        return ""
    width = max(len(row) for row in grid)
    grid = [row + [""] * (width - len(row)) for row in grid]

    def line(cells: list[str]) -> str:
        return "| " + " | ".join(cells) + " |"

    out = [line(grid[0]), line(["---"] * width)]
    out.extend(line(row) for row in grid[1:])
    return "\n".join(out)


def blocks_from_plain_text(text: str) -> list[dict]:
    """Split plain text into paragraph blocks on blank lines (no pages)."""
    text = _clean(text)
    blocks = []
    for chunk in re.split(r"\n[ \t]*\n", text):
        chunk = chunk.strip()
        if chunk:
            blocks.append({"kind": "paragraph", "text": chunk, "level": None, "page": None})
    return blocks


def _render(block: dict) -> tuple[str, int | None] | None:
    """Return (rendered markdown, heading level or None), or None to skip the block."""
    kind = block.get("kind")
    if kind not in KINDS:
        kind = "paragraph"

    if kind == "heading":
        title = _single_line(block.get("text"))
        if not title:
            return None
        level = block.get("level")
        try:
            level = int(level) if level is not None else 1
        except (TypeError, ValueError):
            level = 1
        level = min(max(level, 1), 6)
        return ("#" * level + " " + title, level)

    if kind == "table":
        if block.get("rows") is not None:
            body = table_to_markdown(block["rows"])
        else:
            body = _clean_multiline(block.get("text"))
        return (body, None) if body else None

    if kind == "list_item":
        body = _BULLET_PREFIX.sub("", _clean_multiline(block.get("text")))
        if not body:
            return None
        # Continuation lines are indented so they stay inside the list item.
        return ("- " + body.replace("\n", "\n  "), None)

    body = _clean_multiline(block.get("text"))
    return (body, None) if body else None


def _page_of(block: dict) -> int | None:
    page = block.get("page")
    if page is None or isinstance(page, bool):
        return None
    try:
        page = int(page)
    except (TypeError, ValueError):
        return None
    return page if page >= 1 else None


def serialize(blocks: Iterable[dict], *, ocr: bool = False, parser: str = "docling") -> dict:
    """Build the ``/parse`` response dict from reading-ordered blocks."""
    parts: list[str] = []
    rendered: list[dict] = []  # {kind, start, end, level, title, page}
    cursor = 0  # UTF-16 offset where the next block starts

    for block in blocks:
        r = _render(block)
        if r is None:
            continue
        body, level = r
        if parts:
            parts.append(BLOCK_SEPARATOR)
            cursor += utf16_len(BLOCK_SEPARATOR)
        start = cursor
        parts.append(body)
        cursor += utf16_len(body)
        rendered.append(
            {
                "kind": block.get("kind") if block.get("kind") in KINDS else "paragraph",
                "start": start,
                "end": cursor,
                "level": level,
                "title": body[level + 1 :] if level else None,
                "page": _page_of(block),
            }
        )

    if parts:
        parts.append("\n")
        cursor += 1
    text = "".join(parts)
    total = cursor

    # Pages: make page numbers monotonic in reading order. Blocks without a page
    # inherit the previous block's page (or the first known page when leading).
    # A page number lower than one already seen is folded into the current page,
    # so spans stay contiguous, ordered and non-overlapping.
    known = [b["page"] for b in rendered if b["page"] is not None]
    if known:
        current = known[0]
        for b in rendered:
            if b["page"] is not None and b["page"] > current:
                current = b["page"]
            b["eff_page"] = current
    else:
        for b in rendered:
            b["eff_page"] = None

    pages: list[dict] = []
    for b in rendered:
        p = b["eff_page"]
        if p is None:
            continue
        if pages and pages[-1]["page"] == p:
            continue
        if pages:
            pages[-1]["end"] = b["start"]
        pages.append({"page": p, "start": 0 if not pages else b["start"], "end": total})

    # Sections: one per heading; end at the next heading of same or higher level.
    sections: list[dict] = []
    stack: list[tuple[int, str]] = []
    headings = [b for b in rendered if b["level"]]
    for i, h in enumerate(headings):
        while stack and stack[-1][0] >= h["level"]:
            stack.pop()
        stack.append((h["level"], h["title"]))
        end = total
        for nxt in headings[i + 1 :]:
            if nxt["level"] <= h["level"]:
                end = nxt["start"]
                break
        sections.append(
            {
                "level": h["level"],
                "title": h["title"],
                "path": [title for _, title in stack],
                "start": h["start"],
                "end": end,
            }
        )

    tables = [
        {"start": b["start"], "end": b["end"], "page": b["eff_page"]}
        for b in rendered
        if b["kind"] == "table"
    ]

    return {
        "text": text,
        "pages": pages,
        "sections": sections,
        "tables": tables,
        "ocr": bool(ocr),
        "parser": parser,
    }
