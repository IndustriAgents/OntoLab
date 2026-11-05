# OntoLab Docling sidecar

A small Python HTTP service that turns uploaded documents into structured,
offset-annotated text for OntoLab. It wraps [Docling](https://github.com/docling-project/docling)
(layout analysis, table structure, OCR) behind a tiny contract so the Node
server never has to touch Python.

The Node server uses it when `PARSER_URL` is set (e.g. `PARSER_URL=http://docling:8001`);
otherwise it keeps its built-in parsers.

## Files

| File | Purpose |
| --- | --- |
| `app.py` | FastAPI app: auth, size limit, format detection, Docling conversion, `DoclingDocument` to blocks |
| `serialize.py` | Pure (stdlib-only) serializer: blocks to `text` plus `pages` / `sections` / `tables` spans |
| `test_serialize.py` | `unittest` tests for `serialize.py` (no Docling needed) |
| `requirements.txt` | Pinned `docling`, `fastapi`, `uvicorn[standard]` |
| `Dockerfile` | `python:3.12-slim`, tesseract OCR, CPU-only PyTorch, non-root user, port 8001 |

## HTTP contract

### `GET /health`

```json
{"ok": true, "parser": "docling", "version": "2.130.0"}
```

`version` is the installed Docling package version.

### `POST /parse`

Request:

- Body: the raw file bytes (not multipart).
- `x-file-name`: URL-encoded original file name. The extension selects the format.
  Without an extension the type is sniffed from magic bytes (PDF, PNG, JPEG, TIFF only).
- `x-ocr`: `1` (default) or `0`. Turns OCR on or off for PDFs and images.
- `x-token`: required, and must equal `PARSER_TOKEN`, when that env var is set.

Response `200`:

```json
{
  "text": "# Heading\n\nParagraph...\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
  "pages":    [ {"page": 1, "start": 0, "end": 1234} ],
  "sections": [ {"level": 1, "title": "Heading", "path": ["Heading"], "start": 0, "end": 900} ],
  "tables":   [ {"start": 500, "end": 640, "page": 1} ],
  "ocr": false,
  "parser": "docling"
}
```

- `text`: the document as Markdown-like text in reading order. Headings are `#`..`######`
  lines, paragraphs are plain text, list items start with `- `, tables are GitHub pipe tables
  (first row is the header, `|` in cells escaped as `\|`). Blocks are separated by exactly one
  blank line (`"\n\n"`), and the text ends with a single `"\n"`. Heading levels follow Docling's
  own Markdown: a document title is level 1 and a section header of Docling level *n* is level *n+1*.
  Page headers/footers and pictures are dropped.
- `pages`: one entry per page that produced text, in order, with 1-based page numbers. The spans
  are contiguous and do not overlap. The first starts at 0, each `end` equals the next `start`
  (so the separator belongs to the earlier page), and the last ends at the end of `text`. Blocks
  without page provenance belong to the page before them. Formats without pages (DOCX, HTML,
  Markdown, plain text) return `[]`. PPTX slides and XLSX sheets are reported as pages when
  Docling gives them page provenance.
- `sections`: one per heading, in order. `path` is the titles of the heading's ancestors and the
  heading itself, from the top. `start` is the start of the heading line. `end` is the start of
  the next heading of the same or a higher level (smaller or equal `level`), or the end of `text`.
- `tables`: the span of each serialized pipe table, with its page (`null` when unknown).
- `ocr`: `true` when OCR produced text for any page. This is always true for images when OCR is
  on. For PDFs it is best-effort detection from Docling's `from_ocr` cell flags.
- `parser`: always `"docling"`.

#### Offsets are UTF-16 code units

Every `start`/`end` is a **UTF-16 code-unit index** into `text`, so the Node server can use it
directly with JavaScript `text.slice(start, end)`. A character outside the Basic Multilingual Plane
(an emoji, for example) counts as 2, the same as JavaScript's `.length`. These are **not** Python
`str` indices: in Python, compute them as `len(s.encode("utf-16-le")) // 2`, or slice the
UTF-16-LE bytes at `2*start:2*end`. Spans are half-open `[start, end)`.

#### Errors

All errors are JSON `{"error": "<message>"}`. Stack traces are never returned.

| Status | When |
| --- | --- |
| 401 | `PARSER_TOKEN` is set and `x-token` is missing or wrong |
| 413 | Body larger than `MAX_BYTES` |
| 415 | Unsupported file type |
| 422 | Empty file, or Docling cannot parse the file |
| 500 | Unexpected internal error |

### Supported inputs

PDF, DOCX, HTML (`.html`, `.htm`, `.xhtml`), PPTX, XLSX, Markdown (`.md`, `.markdown`),
plain text (`.txt`, `.text`), and images (PNG, JPEG, TIFF; these need OCR). Plain text does not go
through Docling. It is split into paragraphs on blank lines, and it is never interpreted as
Markdown.

## Running locally

```sh
docker build -t ontolab-docling sidecar/docling
docker run -p 8001:8001 ontolab-docling

curl http://localhost:8001/health
curl -X POST --data-binary @paper.pdf -H "x-file-name: paper.pdf" http://localhost:8001/parse
```

The image is large (PyTorch CPU plus models, a few GB). The build tries to pre-download the layout
and table-structure models into `/opt/docling-models`. If that fails, the build still succeeds and
Docling downloads the models from Hugging Face on the first request. The first `/parse` for each OCR
setting also initialises a converter, so expect it to be slow. Later requests reuse the converter.

Without Docker (Python 3.10 to 3.12 recommended for Docling):

```sh
cd sidecar/docling
pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8001
```

Tests (serializer only, standard library, no Docling needed):

```sh
cd sidecar/docling
python -m unittest
```

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PARSER_TOKEN` | unset | When set, `/parse` requires a matching `x-token` header (else 401). `/health` is always open. |
| `MAX_BYTES` | `26214400` (25 MB) | Maximum request body size in bytes (else 413). |
| `MAX_CONCURRENCY` | `1` | Maximum conversions running at once. Extra requests wait. Conversion runs in a worker thread, so `/health` stays responsive. |
| `OCR_ENGINE` | `tesseract` | `tesseract` (tesseract CLI, installed in the image), `easyocr`, or anything else for Docling's default. |
| `OCR_LANG` | `eng` | Comma-separated OCR languages (tesseract language codes; install extra `tesseract-ocr-*` packages for more). |
| `MODELS_DIR` | `/opt/docling-models` in the image | Pre-downloaded Docling models. Ignored when missing or empty. |
| `LOG_LEVEL` | `INFO` | Python log level. |

## Licensing

Docling is MIT-licensed, and so are FastAPI and Uvicorn (BSD-3). The Docling layout and table
models are published under permissive licenses. Tesseract is Apache-2.0. MinerU is deliberately
**not** used: it is AGPL-3.0, which would impose network-copyleft obligations on a hosted OntoLab.
