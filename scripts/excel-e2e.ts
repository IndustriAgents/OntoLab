/** Real browser uploads, local parsing, source inspection and chunk persistence. */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { utils, write } from "xlsx";
import type { DocumentText, ProjectDocument } from "../src/types/project.ts";

process.env.MOCK_LLM = "1";
process.env.PARSER_URL = "";
const { startApp } = await import("../tests/helpers.ts");
const output = resolve("output/playwright/excel-import");
await mkdir(output, { recursive: true });
await Promise.all(["failure.json", "failure.png", "report.json"].map((name) => rm(`${output}/${name}`, { force: true })));
const app = await startApp({ distDir: resolve("dist") });
const c = app.as("alice");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { "x-test-user": "alice" } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const steps: string[] = [];
const step = (message: string) => {
  steps.push(message);
  console.info(`PASS ${message}`);
};
// Exercise the real background worker while keeping this fixture deterministic.
const worker = setInterval(() => {
  void app.processDocuments().catch((error) => errors.push(String(error)));
}, 50);
try {
  const pid = (await c.json<{ project: { id: string } }>("POST", "/api/projects", { name: "Excel browser import" })).body.project.id;
  const path = `/api/projects/${pid}/documents`;
  for (const format of ["xlsx", "xls"] as const) {
    const book = utils.book_new();
    const sheet = utils.aoa_to_sheet([
      ["Pump", "Pressure"],
      ["P-101", 16],
      ["P-102", 24],
    ]);
    sheet.B2.z = '0.0" bar"';
    utils.book_append_sheet(book, sheet, "Operating limits");
    utils.book_append_sheet(
      book,
      utils.aoa_to_sheet([
        ["Material", "Grade"],
        ["Steel", "S355"],
      ]),
      "Materials",
    );
    const buffer = Buffer.from(write(book, { type: "buffer", bookType: format }));
    const name = `pumps.${format}`;
    await page.goto(`${app.url}/p/${pid}/documents`);
    const input = page.locator('.dropzone input[type="file"]');
    assert.ok((await input.getAttribute("accept"))?.split(",").includes(`.${format}`));
    const uploaded = page.waitForResponse((res) => res.url().endsWith(path) && res.request().method() === "POST");
    await input.setInputFiles({ name, mimeType: "application/octet-stream", buffer });
    const response = await uploaded;
    assert.equal(response.status(), 201);
    const doc = (await response.json()).document as ProjectDocument;
    const row = page.locator(`[data-source-id="${doc.id}"]`);
    await row.getByText("Text ready", { exact: true }).waitFor();
    await row.getByRole("button", { name: "Inspect parsed text", exact: true }).click();
    const reader = page.getByRole("document", { name: "Document text", exact: true });
    await reader.getByText(/16\.0 bar/).waitFor();
    assert.ok((await reader.innerText()).includes("# Materials"));
    await page.getByRole("button", { name: "Original file", exact: true }).click();
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download original", exact: true }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), name);
    assert.deepEqual(await readFile((await download.path())!), buffer);
    step(`${format}: browser upload, automatic native parsing, both sheet previews and unchanged original download`);

    await page.goto(`${app.url}/p/${pid}/research?view=documents&doc=${doc.id}`);
    await page.getByRole("button", { name: "Preview experiment", exact: true }).click();
    await page.getByRole("button", { name: "Save as document variant", exact: true }).click();
    await page.getByText(/Saved “/).waitFor();
    const docs = (await c.json<{ documents: ProjectDocument[] }>("GET", path)).body.documents;
    const chunked = docs.find((d) => (d.id === doc.id || d.variantOf === doc.id) && d.chunkCount > 0);
    assert.ok(chunked, "Browser chunk configuration must be persisted");
    const source = (await c.json<DocumentText>("GET", `${path}/${chunked.id}/text`)).body;
    assert.equal(source.sections?.length, 2);
    assert.equal(source.tables?.length, 2);
    assert.ok(source.chunks.every((chunk) => source.text.slice(chunk.start, chunk.end).trim()));
    await page.reload();
    await page.getByRole("heading", { name: "Chunk 1", exact: true }).waitFor();
    step(`${format}: browser chunk preview and save persist after reload with exact source offsets`);
  }
  await page.goto(`${app.url}/p/${pid}/documents`);
  await page
    .locator('.dropzone input[type="file"]')
    .setInputFiles({ name: "broken.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("PK\x03\x04broken") });
  const broken = page.locator(".workflow-source").filter({ hasText: "broken.xlsx" });
  await broken.getByText(/valid, unencrypted Excel/).waitFor();
  await broken.getByRole("button", { name: "Retry parsing", exact: true }).click();
  await broken.getByText(/valid, unencrypted Excel/).waitFor();
  step("Corrupt workbook displays a useful parse error and can be retried without reuploading");
  await page.screenshot({ path: `${output}/documents.png`, fullPage: true });
  assert.deepEqual(errors, [], "Uncaught browser/worker errors");
  await writeFile(`${output}/report.json`, JSON.stringify({ result: "passed", steps, browserErrors: errors }, null, 2));
  console.info(`Excel E2E passed (${steps.length} journeys)`);
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify({ url: page.url(), error: String(error), steps, browserErrors: errors }, null, 2),
  );
  throw error;
} finally {
  clearInterval(worker);
  await browser.close();
  await app.close();
}
