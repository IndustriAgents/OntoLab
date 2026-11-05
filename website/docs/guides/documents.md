---
title: "Upload and inspect documents"
description: "Check parsing, chunks and document variants before running a model."
---

The text OntoLab processes is the parser output, not necessarily what a PDF looks like on screen. Inspect it before generation or extraction.

## Add documents

For ontology-building sources, open **Ontology → Build & sources** and use the **Documents** step. For extraction sources, open a knowledge graph and choose **Documents**. Upload files in the appropriate workspace. Wait for parsing to finish. A failed document should be retried or replaced before it is selected for a run.

Native parsers support PDF, DOCX, XLSX, XLS, HTML, Markdown and text. Scanned PDFs may contain no usable text. OCR and additional office/image formats require the optional Docling parser. See [formats](../reference/formats.md).

## Check the parsed text

Verify headings, reading order, tables and relevant passages. Look for repeated headers, missing values and content that was extracted in the wrong order. Page and section locations are useful context, but a parser cannot reconstruct every visual relationship correctly.

## Inspect chunks

The workflow’s **Chunks** step shows chunk text and boundaries. Character-based settings default to a 12,000-character base with 12% overlap; token-aware preparation uses separate token budgets. The configured method and settings determine the actual boundaries. Neighboring chunks may repeat text intentionally.

Choose **Inspect evidence** to read a chunk alongside its source, available model inputs, and processing history. Tables can show their headers and cited rows. For XML documents with recorded locations, **Original structure** checks the original checksum and displays the corresponding element or table, including cell spans. Unsupported structure mappings remain explicit.

## Compare chunking strategies

Use the **Chunks** step in **Ontology → Build & sources** to configure and inspect document preparation. For a graph workspace, configure preparation under **Graph settings** and inspect its documents and chunks. Existing runs retain their recorded inputs and settings.

## Manage source changes

Replacing or retrying a document affects later inputs. Inspect a historical run through its **Experiment** selector to see recorded inputs rather than assuming the current document matches that run.

Evidence from a retained run uses that run's saved text and file name. **Open in Documents** preserves the run and highlighted location, even when the current corpus file has changed. A missing historical snapshot is reported; current text is not substituted. Original bytes may be unavailable after ordinary document deletion even when saved run text survives.

Document deletion can remove material you still want for review. Export an archive before destructive cleanup. Consult [export and backups](./export.md) for what archives preserve.
