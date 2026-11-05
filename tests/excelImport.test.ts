import { afterEach, describe, expect, it, vi } from "vitest";
import { utils, write, type BookType } from "xlsx";
import { parseDocument } from "../server/services/parsing.ts";
import { startApp, type TestApp } from "./helpers.ts";
import type { DocumentText, ProjectDocument } from "../src/types/project.ts";

// Excel must remain usable even when a configured sidecar is unavailable.
vi.mock("../server/config.ts", async (original) => ({
  ...(await original<object>()),
  PARSER_URL: "http://127.0.0.1:1",
}));

function workbook(format: BookType = "xlsx") {
  const book = utils.book_new();
  const sheet = utils.aoa_to_sheet([
    ["Pump", "Pressure", "Date", "Active", "Notes"],
    ["P-101", 16, 46200, true, "Water | service\n20 °C"],
    ["P-102", null, null, false, "Ångström 🧪"],
  ]);
  sheet.B2.z = '0.0" bar"';
  sheet.C2.z = "yyyy-mm-dd";
  sheet.B3 = { t: "n", f: "8*3", v: 24, z: '0" bar"' };
  utils.book_append_sheet(book, sheet, "Operating limits");
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([
      ["Material", "Grade"],
      ["Steel", "S355"],
    ]),
    "Materials",
  );
  utils.book_append_sheet(book, utils.aoa_to_sheet([]), "Empty");
  return Buffer.from(write(book, { type: "buffer", bookType: format }));
}

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("native Excel import", () => {
  it.each(["xlsx", "xls"] as const)("keeps %s sheets, displayed values, cached formulas and exact table offsets", async (format) => {
    const parsed = await parseDocument(`pumps.${format}`, workbook(format));
    expect(parsed.kind).toBe(format);
    expect(parsed.parser).toBe("node");
    expect(parsed.sections.map((s) => s.title)).toEqual(["Operating limits", "Materials"]);
    expect(parsed.tables).toHaveLength(2);
    expect(parsed.text).toContain("16.0 bar");
    expect(parsed.text).toContain("2026-06-27");
    expect(parsed.text).toContain("24 bar");
    expect(parsed.text).toContain("TRUE");
    expect(parsed.text).toContain("FALSE");
    expect(parsed.text).toContain("Water \\| service 20 °C");
    expect(parsed.text).toContain("Ångström 🧪");
    for (const table of parsed.tables) expect(parsed.text.slice(table.start, table.end)).toMatch(/^\|.*\|$/ms);
    expect(parsed.text.slice(parsed.sections[1].start)).toContain("# Materials");
  });

  it.each(["xlsx", "xls"] as const)("uploads, parses, chunks, downloads and reparses %s through HTTP", async (format) => {
    app = await startApp();
    const c = app.as("alice");
    const pid = (await c.json<{ project: { id: string } }>("POST", "/api/projects", { name: "Excel import" })).body.project.id;
    const path = `/api/projects/${pid}/documents`;
    const bytes = workbook(format);
    const res = await c.upload(path, `pumps.${format}`, bytes);
    expect(res.status).toBe(201);
    const doc = res.body.document as ProjectDocument;
    expect(doc.parseState).toBe("parsed");
    expect(doc.parser).toBe("node");
    expect(doc.chunkCount).toBeGreaterThan(0);
    expect(doc.tableCount).toBe(2);
    const source = (await c.json<DocumentText>("GET", `${path}/${doc.id}/text`)).body;
    expect(source.text).toContain("S355");
    for (const chunk of source.chunks) expect(source.text.slice(chunk.start, chunk.end).length).toBeGreaterThan(0);
    const file = await c.get(`${path}/${doc.id}/file`);
    expect(file.headers.get("content-type")).toContain(format === "xls" ? "application/vnd.ms-excel" : "spreadsheetml.sheet");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    const reprocessed = await c.json<{ document: ProjectDocument }>("POST", `${path}/${doc.id}/reprocess`);
    expect(reprocessed.status).toBe(201);
    await app.processDocuments();
    expect((await c.json<DocumentText>("GET", `${path}/${reprocessed.body.document.id}/text`)).body.text).toBe(source.text);
    expect((await app.as("bob").get(`${path}/${doc.id}/file`)).status).toBe(404);
  });

  it.each(["xlsx", "xls"])("rejects text masquerading as %s", async (format) => {
    await expect(parseDocument(`broken.${format}`, Buffer.from("Pump,Pressure\nP-101,16"))).rejects.toThrow("valid, unencrypted Excel");
  });

  it("records failed parsing while retaining the original for retry/download", async () => {
    app = await startApp();
    const c = app.as("alice");
    const pid = (await c.json<{ project: { id: string } }>("POST", "/api/projects", { name: "Broken Excel" })).body.project.id;
    const path = `/api/projects/${pid}/documents`;
    const bytes = Buffer.from("PK\x03\x04broken zip");
    const res = await c.upload(path, "broken.xlsx", bytes);
    expect(res.status).toBe(201);
    const doc = res.body.document as ProjectDocument;
    expect(doc.parseState).toBe("failed");
    expect(doc.parseError).toContain("valid, unencrypted Excel");
    expect(Buffer.from(await (await c.get(`${path}/${doc.id}/file`)).arrayBuffer())).toEqual(bytes);
    expect((await c.json("POST", `${path}/${doc.id}/retry`)).status).toBe(200);
  });

  it("warns about formulas without saved results instead of evaluating them", async () => {
    const book = utils.book_new();
    const sheet = utils.aoa_to_sheet([["Result"], [1]]);
    sheet.A2 = { t: "n", f: "1+2" };
    utils.book_append_sheet(book, sheet, "Formula");
    const parsed = await parseDocument("formula.xlsx", write(book, { type: "buffer", bookType: "xlsx" }));
    expect(parsed.warnings?.join()).toContain("no saved result");
    expect(parsed.text).not.toContain("1+2");
  });

  it("rejects worksheet ranges that would expand excessively", async () => {
    const book = utils.book_new();
    const sheet = utils.aoa_to_sheet([["Data"]]);
    sheet["!ref"] = "A1:A100001";
    utils.book_append_sheet(book, sheet, "Sparse");
    await expect(parseDocument("sparse.xlsx", write(book, { type: "buffer", bookType: "xlsx" }))).rejects.toThrow("too large");
  });
});
