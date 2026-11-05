"""Standard-library tests for serialize.py (no docling needed).

Run from sidecar/docling:  python -m unittest
"""

import unittest

from serialize import blocks_from_plain_text, serialize, table_to_markdown, utf16_len


def js_slice(text: str, start: int, end: int) -> str:
    """Emulate JavaScript String.prototype.slice on UTF-16 code-unit offsets."""
    units = text.encode("utf-16-le", "surrogatepass")
    return units[start * 2 : end * 2].decode("utf-16-le", "surrogatepass")


def H(text, level, page=None):
    return {"kind": "heading", "text": text, "level": level, "page": page}


def P(text, page=None):
    return {"kind": "paragraph", "text": text, "level": None, "page": page}


def L(text, page=None):
    return {"kind": "list_item", "text": text, "level": None, "page": page}


def T(text=None, page=None, rows=None):
    b = {"kind": "table", "text": text, "level": None, "page": page}
    if rows is not None:
        b["rows"] = rows
    return b


TABLE_MD = "| a | b |\n| --- | --- |\n| 1 | 2 |"


class TextTests(unittest.TestCase):
    def test_example_shape(self):
        out = serialize([H("Heading", 1, 1), P("Paragraph...", 1), T(TABLE_MD, 1)])
        self.assertEqual(
            out["text"],
            "# Heading\n\nParagraph...\n\n" + TABLE_MD + "\n",
        )
        self.assertEqual(out["parser"], "docling")
        self.assertIs(out["ocr"], False)
        self.assertEqual(set(out), {"text", "pages", "sections", "tables", "ocr", "parser"})

    def test_blocks_separated_by_exactly_one_blank_line(self):
        out = serialize([P("one\n\n\n\ntwo  "), L("item"), L("• bullet"), P("   "), P("end")])
        self.assertEqual(out["text"], "one\ntwo\n\n- item\n\n- bullet\n\nend\n")
        self.assertNotIn("\n\n\n", out["text"])

    def test_empty(self):
        out = serialize([])
        self.assertEqual(out["text"], "")
        self.assertEqual(out["pages"], [])
        self.assertEqual(out["sections"], [])
        self.assertEqual(out["tables"], [])

    def test_heading_levels_clamped_and_single_line(self):
        out = serialize([H("Deep\nTitle", 9), H("Zero", 0)])
        self.assertEqual(out["text"], "###### Deep Title\n\n# Zero\n")
        self.assertEqual([s["level"] for s in out["sections"]], [6, 1])

    def test_ocr_flag_and_parser(self):
        out = serialize([P("x")], ocr=True, parser="docling")
        self.assertIs(out["ocr"], True)


class SectionTests(unittest.TestCase):
    def setUp(self):
        self.out = serialize(
            [
                H("Intro", 1),
                P("Intro body."),
                H("Background", 2),
                P("Background body."),
                H("Detail", 3),
                P("Detail body."),
                H("Scope", 2),
                P("Scope body."),
                H("Methods", 1),
                P("Methods body."),
            ]
        )
        self.text = self.out["text"]
        self.secs = {s["title"]: s for s in self.out["sections"]}

    def test_paths(self):
        self.assertEqual(self.secs["Intro"]["path"], ["Intro"])
        self.assertEqual(self.secs["Background"]["path"], ["Intro", "Background"])
        self.assertEqual(self.secs["Detail"]["path"], ["Intro", "Background", "Detail"])
        self.assertEqual(self.secs["Scope"]["path"], ["Intro", "Scope"])
        self.assertEqual(self.secs["Methods"]["path"], ["Methods"])

    def test_starts_point_at_heading_lines(self):
        for s in self.out["sections"]:
            prefix = "#" * s["level"] + " " + s["title"]
            self.assertTrue(js_slice(self.text, s["start"], len(self.text)).startswith(prefix))

    def test_ends(self):
        s = self.secs
        self.assertEqual(s["Intro"]["end"], s["Methods"]["start"])
        self.assertEqual(s["Background"]["end"], s["Scope"]["start"])
        self.assertEqual(s["Detail"]["end"], s["Scope"]["start"])
        self.assertEqual(s["Scope"]["end"], s["Methods"]["start"])
        self.assertEqual(s["Methods"]["end"], utf16_len(self.text))

    def test_section_slice_content(self):
        bg = self.secs["Background"]
        chunk = js_slice(self.text, bg["start"], bg["end"])
        self.assertEqual(
            chunk, "## Background\n\nBackground body.\n\n### Detail\n\nDetail body.\n\n"
        )


class TableTests(unittest.TestCase):
    def test_table_span_text(self):
        out = serialize([P("before", 1), T(TABLE_MD, 2), P("after", 2)])
        (t,) = out["tables"]
        self.assertEqual(js_slice(out["text"], t["start"], t["end"]), TABLE_MD)
        self.assertEqual(t["page"], 2)

    def test_rows_rendering(self):
        md = table_to_markdown([["a", "b|c"], ["1"], ["x\ny", "z"]])
        self.assertEqual(md, "| a | b\\|c |\n| --- | --- |\n| 1 |  |\n| x y | z |")
        out = serialize([T(rows=[["a", "b"], ["1", "2"]])])
        (t,) = out["tables"]
        self.assertEqual(js_slice(out["text"], t["start"], t["end"]), TABLE_MD)
        self.assertIsNone(t["page"])

    def test_empty_table_skipped(self):
        out = serialize([T(rows=[["", ""], []]), P("x")])
        self.assertEqual(out["tables"], [])
        self.assertEqual(out["text"], "x\n")


class PageTests(unittest.TestCase):
    def test_contiguous_page_spans(self):
        out = serialize(
            [
                H("Title", 1, 1),
                P("p1 text", 1),
                P("p2 text", 2),
                P("no prov", None),
                T(TABLE_MD, 3),
                P("p3 text", 3),
            ]
        )
        text, pages = out["text"], out["pages"]
        self.assertEqual([p["page"] for p in pages], [1, 2, 3])
        self.assertEqual(pages[0]["start"], 0)
        self.assertEqual(pages[-1]["end"], utf16_len(text))
        for a, b in zip(pages, pages[1:]):
            self.assertEqual(a["end"], b["start"])
        self.assertTrue(js_slice(text, pages[0]["start"], pages[0]["end"]).startswith("# Title"))
        self.assertIn("p1 text", js_slice(text, pages[0]["start"], pages[0]["end"]))
        p2 = js_slice(text, pages[1]["start"], pages[1]["end"])
        self.assertTrue(p2.startswith("p2 text"))
        self.assertIn("no prov", p2)
        self.assertTrue(js_slice(text, pages[2]["start"], pages[2]["end"]).startswith("| a | b |"))

    def test_non_monotonic_pages_fold_forward(self):
        out = serialize([P("a", 2), P("b", 1), P("c", 3)])
        self.assertEqual([p["page"] for p in out["pages"]], [2, 3])

    def test_no_pages_for_pageless_formats(self):
        out = serialize([H("Doc", 1), P("body")])
        self.assertEqual(out["pages"], [])


class Utf16Tests(unittest.TestCase):
    def test_emoji_before_heading(self):
        emoji = "\U0001F600"  # non-BMP: 1 Python char, 2 UTF-16 units
        out = serialize([P("Smile " + emoji + " here", 1), H("After", 1, 2), P("body \U0001F680", 2)])
        text = out["text"]
        (sec,) = out["sections"]
        # Python index is one less than the UTF-16 offset.
        self.assertEqual(sec["start"], text.index("# After") + 1)
        self.assertEqual(js_slice(text, sec["start"], sec["end"]), "# After\n\nbody \U0001F680\n")
        self.assertEqual(sec["end"], utf16_len(text))
        self.assertEqual(out["pages"][1]["start"], sec["start"])
        self.assertEqual(out["pages"][1]["end"], utf16_len(text))
        self.assertEqual(utf16_len(text), len(text) + 2)

    def test_utf16_len(self):
        self.assertEqual(utf16_len("abc"), 3)
        self.assertEqual(utf16_len("é"), 1)
        self.assertEqual(utf16_len("\U0001F600"), 2)


class PlainTextTests(unittest.TestCase):
    def test_paragraph_split(self):
        blocks = blocks_from_plain_text("First line\nstill first\r\n\r\n\n  Second  \n\n")
        self.assertEqual([b["text"] for b in blocks], ["First line\nstill first", "Second"])
        out = serialize(blocks)
        self.assertEqual(out["text"], "First line\nstill first\n\nSecond\n")
        self.assertEqual(out["sections"], [])
        # Markdown-looking plain text is not turned into headings.
        out = serialize(blocks_from_plain_text("# not a heading"))
        self.assertEqual(out["sections"], [])


if __name__ == "__main__":
    unittest.main()
