"""OntoLab document-parsing sidecar (Docling).

HTTP contract (see README.md):
  GET  /health -> {"ok": true, "parser": "docling", "version": "<docling version>"}
  POST /parse  -> raw file bytes in, {"text", "pages", "sections", "tables", "ocr", "parser"} out

Docling is imported lazily (on the first /parse) so the module stays cheap to
import; the text/offset building lives in the pure ``serialize`` module.
"""

from __future__ import annotations

import asyncio
import hmac
import io
import logging
import os
import threading
from importlib import metadata
from typing import Any
from urllib.parse import unquote

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from serialize import blocks_from_plain_text, serialize, table_to_markdown

log = logging.getLogger("ontolab.docling")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())


def _int_env(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except ValueError:
        return default


PARSER_TOKEN = os.environ.get("PARSER_TOKEN") or None
MAX_BYTES = _int_env("MAX_BYTES", 25 * 1024 * 1024)
MAX_CONCURRENCY = _int_env("MAX_CONCURRENCY", 1)
OCR_ENGINE = os.environ.get("OCR_ENGINE", "tesseract").strip().lower()
OCR_LANG = [s.strip() for s in os.environ.get("OCR_LANG", "eng").split(",") if s.strip()]
# Directory with pre-downloaded docling models; ignored when missing or empty
# (docling then fetches models from Hugging Face on first use).
MODELS_DIR = os.environ.get("MODELS_DIR", "").strip()

# extension -> docling InputFormat member name ("TEXT" is handled without docling)
EXTENSIONS = {
    "pdf": "PDF",
    "docx": "DOCX",
    "html": "HTML",
    "htm": "HTML",
    "xhtml": "HTML",
    "pptx": "PPTX",
    "xlsx": "XLSX",
    "md": "MD",
    "markdown": "MD",
    "txt": "TEXT",
    "text": "TEXT",
    "png": "IMAGE",
    "jpg": "IMAGE",
    "jpeg": "IMAGE",
    "tif": "IMAGE",
    "tiff": "IMAGE",
}
# Canonical extension handed to docling so its own format detection agrees with ours.
CANONICAL_EXT = {"HTML": "html", "MD": "md"}

SKIP_LABELS = {"page_header", "page_footer", "picture", "chart", "empty_value"}
HEADING_LABELS = {"title", "section_header"}
TABLE_LABELS = {"table", "document_index"}


def _docling_version() -> str:
    try:
        return metadata.version("docling")
    except metadata.PackageNotFoundError:
        return "unknown"


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


class UnsupportedType(Exception):
    pass


class ParseFailure(Exception):
    pass


def _detect(file_name: str, head: bytes) -> tuple[str, str]:
    """Return (format key, extension) from the file name, falling back to magic bytes."""
    base = file_name.replace("\\", "/").rsplit("/", 1)[-1]
    ext = base.rsplit(".", 1)[-1].lower() if "." in base else ""
    if ext in EXTENSIONS:
        return EXTENSIONS[ext], ext
    if ext:
        raise UnsupportedType(f"unsupported file type: .{ext}")
    if head.startswith(b"%PDF"):
        return "PDF", "pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "IMAGE", "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "IMAGE", "jpg"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "IMAGE", "tiff"
    raise UnsupportedType("unsupported file type (no recognisable extension)")


# ---------------------------------------------------------------------------
# Docling converters: one per OCR setting, created lazily and reused.
# ---------------------------------------------------------------------------

_converters: dict[bool, Any] = {}
_converters_lock = threading.Lock()


def _ocr_options() -> Any:
    from docling.datamodel import pipeline_options as po

    if OCR_ENGINE == "tesseract" and hasattr(po, "TesseractCliOcrOptions"):
        return po.TesseractCliOcrOptions(lang=OCR_LANG or ["eng"])
    if OCR_ENGINE == "easyocr" and hasattr(po, "EasyOcrOptions"):
        return po.EasyOcrOptions()
    return None  # docling default


def _build_converter(ocr: bool) -> Any:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    opts = PdfPipelineOptions()
    if MODELS_DIR and os.path.isdir(MODELS_DIR) and os.listdir(MODELS_DIR):
        opts.artifacts_path = MODELS_DIR  # models pre-downloaded at image build time
    opts.do_ocr = ocr
    opts.do_table_structure = True
    if ocr:
        ocr_opts = _ocr_options()
        if ocr_opts is not None:
            opts.ocr_options = ocr_opts

    format_options: dict[Any, Any] = {InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    try:
        from docling.document_converter import ImageFormatOption

        format_options[InputFormat.IMAGE] = ImageFormatOption(pipeline_options=opts)
    except ImportError:  # older 2.x: images fall back to docling defaults
        pass

    allowed = sorted({v for v in EXTENSIONS.values() if v != "TEXT"})
    return DocumentConverter(
        allowed_formats=[getattr(InputFormat, name) for name in allowed],
        format_options=format_options,
    )


def _get_converter(ocr: bool) -> Any:
    conv = _converters.get(ocr)
    if conv is None:
        with _converters_lock:
            conv = _converters.get(ocr)
            if conv is None:
                log.info("initialising docling converter (ocr=%s)", ocr)
                conv = _build_converter(ocr)
                _converters[ocr] = conv
    return conv


# ---------------------------------------------------------------------------
# DoclingDocument -> blocks
# ---------------------------------------------------------------------------


def _label(item: Any) -> str:
    label = getattr(item, "label", None)
    return str(getattr(label, "value", label) or "").lower()


def _page(item: Any) -> int | None:
    prov = getattr(item, "prov", None) or []
    try:
        return int(prov[0].page_no) if prov else None
    except (AttributeError, TypeError, ValueError):
        return None


def _table_block(item: Any, doc: Any, page: int | None) -> dict | None:
    try:
        rows = [[getattr(cell, "text", "") or "" for cell in row] for row in item.data.grid]
        if rows:
            return {"kind": "table", "rows": rows, "level": None, "page": page}
    except Exception:  # noqa: BLE001 - fall back to docling's own markdown
        pass
    try:
        try:
            md = item.export_to_markdown(doc=doc)
        except TypeError:
            md = item.export_to_markdown()
    except Exception:  # noqa: BLE001
        return None
    return {"kind": "table", "text": md, "level": None, "page": page} if md else None


def doc_to_blocks(doc: Any) -> list[dict]:
    blocks: list[dict] = []
    for item, _depth in doc.iterate_items():
        label = _label(item)
        if label in SKIP_LABELS:
            continue
        page = _page(item)

        if label in TABLE_LABELS:
            block = _table_block(item, doc, page)
            if block:
                blocks.append(block)
            continue

        text = getattr(item, "text", None) or ""
        if not text.strip():
            continue
        if label in HEADING_LABELS:
            # Mirrors docling's own markdown: title -> "#", section header level n -> n+1 hashes.
            level = 1 if label == "title" else int(getattr(item, "level", 1) or 1) + 1
            blocks.append({"kind": "heading", "text": text, "level": level, "page": page})
        elif label == "list_item":
            blocks.append({"kind": "list_item", "text": text, "level": None, "page": page})
        else:
            blocks.append({"kind": "paragraph", "text": text, "level": None, "page": page})
    return blocks


def _ocr_used(result: Any, fmt: str, ocr: bool) -> bool:
    """Best effort: true if any page text cell came from OCR (images always do)."""
    if not ocr:
        return False
    if fmt == "IMAGE":
        return True
    if fmt != "PDF":
        return False
    try:
        for page in getattr(result, "pages", None) or []:
            cell_lists = []
            parsed = getattr(page, "parsed_page", None)
            if parsed is not None:
                cell_lists += [
                    getattr(parsed, "textline_cells", None) or [],
                    getattr(parsed, "word_cells", None) or [],
                ]
            cell_lists.append(getattr(page, "cells", None) or [])
            for cells in cell_lists:
                if any(getattr(c, "from_ocr", False) for c in cells):
                    return True
    except Exception:  # noqa: BLE001
        return False
    return False


def _decode_text(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")


def convert_bytes(data: bytes, fmt: str, ext: str, ocr: bool) -> dict:
    """Blocking conversion; run in a worker thread."""
    if fmt == "TEXT":
        return serialize(blocks_from_plain_text(_decode_text(data)), ocr=False)

    from docling.datamodel.base_models import DocumentStream

    converter = _get_converter(ocr)
    stream = DocumentStream(name=f"upload.{CANONICAL_EXT.get(fmt, ext)}", stream=io.BytesIO(data))
    try:
        result = converter.convert(stream, raises_on_error=True)
    except Exception as exc:  # noqa: BLE001
        log.warning("docling conversion failed: %s", exc, exc_info=log.isEnabledFor(logging.DEBUG))
        raise ParseFailure("the document could not be parsed") from exc

    status = str(getattr(result.status, "value", result.status)).lower()
    if status not in ("success", "partial_success"):
        raise ParseFailure(f"the document could not be parsed (status: {status})")
    return serialize(doc_to_blocks(result.document), ocr=_ocr_used(result, fmt, ocr))


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

app = FastAPI(title="OntoLab Docling sidecar", docs_url=None, redoc_url=None, openapi_url=None)
_semaphore = asyncio.Semaphore(MAX_CONCURRENCY)


@app.exception_handler(Exception)
async def _unhandled(_request: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled error", exc_info=exc)
    return _error(500, "internal error")


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "parser": "docling", "version": _docling_version()}


async def _read_body(request: Request) -> bytes | None:
    """Read the raw body, returning None once it exceeds MAX_BYTES."""
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > MAX_BYTES:
                return None
        except ValueError:
            pass
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > MAX_BYTES:
            return None
    return bytes(buf)


@app.post("/parse")
async def parse(request: Request) -> JSONResponse:
    if PARSER_TOKEN is not None:
        supplied = request.headers.get("x-token", "")
        if not hmac.compare_digest(supplied.encode(), PARSER_TOKEN.encode()):
            return _error(401, "unauthorized")

    data = await _read_body(request)
    if data is None:
        return _error(413, f"file exceeds the {MAX_BYTES} byte limit")

    file_name = unquote(request.headers.get("x-file-name", "")).strip()
    try:
        fmt, ext = _detect(file_name, data[:8])
    except UnsupportedType as exc:
        return _error(415, str(exc))
    if not data:
        return _error(422, "empty file")

    ocr = request.headers.get("x-ocr", "1").strip().lower() not in ("0", "false", "no", "off")

    async with _semaphore:
        try:
            body = await asyncio.to_thread(convert_bytes, data, fmt, ext, ocr)
        except ParseFailure as exc:
            return _error(422, str(exc))
        except Exception:  # noqa: BLE001 - never leak internals
            log.exception("parse failed for %s", fmt)
            return _error(422, "the document could not be parsed")
    return JSONResponse(content=body)
