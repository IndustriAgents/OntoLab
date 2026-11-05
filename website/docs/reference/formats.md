---
title: "Supported formats and limits"
description: "Find the built-in formats, optional parser support and default limits."
---

Limits below are application defaults. An installation may override them; the app exposes its current upload limits through configuration.

| Input | Support | Notes |
| --- | --- | --- |
| PDF | Built in | Text extraction; image-only pages require OCR |
| DOCX | Built in | Inspect reading order and tables |
| HTML, Markdown, text | Built in | Inspect extracted content before running |
| XLSX, XLS | Built in | Sheet names and formatted cells become sections and tables; formulas use saved results |
| PPTX, images and OCR | Optional Docling | Requires server configuration |
| Ontology Turtle, RDF/XML, JSON-LD | Ontology import | Validate supported constructs after conversion |
| A-Box Turtle | Graph import | Check identifiers and schema conformance |
| Project archive | Project import | Restores a separate project; excludes run history |

## Default operational limits

| Setting | Default |
| --- | --- |
| Upload size | 20 MiB per document |
| Excel extraction | Up to 100,000 rows and 1,024 columns per sheet; 1,000,000 cells across worksheet ranges |
| Documents per project | 50 |
| Source documents per corpus | 1,000 |
| Storage quota | 10 GiB per user, configurable with `STORAGE_QUOTA_BYTES` |
| Base chunk size | 12,000 characters |
| Chunk overlap | 12%, configurable up to 30% in chunk experiments |
| Rendered graph nodes | 500 before narrowing is required |
| Concurrent extraction steps | 1 per process/deployment limiter |
| Maximum failed step attempts | 3 |

Graph rendering limits do not necessarily mean the underlying graph is empty or truncated. Narrow the view before concluding that data was lost.

## Export formats

The user-facing RDF export is Turtle, with schema/instance scope and provenance choices. Reports can be downloaded as Markdown or JSON. Project archives and research records serve different purposes; see [export and backups](../guides/export.md).

A recognized file extension does not guarantee useful text extraction. For scanned documents, verify actual parser output before starting an AI run.
