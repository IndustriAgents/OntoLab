// Isolated browser acceptance: npm run build && MOCK_LLM=1 npx tsx scripts/evidence-smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { createApp } from "../server/app.ts";
import { createLocalStore } from "../server/store/local.ts";
import { startDocumentWorker } from "../server/documentWorker.ts";
import { silentLogger } from "../server/services/context.ts";
import { stopSparqlPool } from "../server/services/sparqlPool.ts";
import { seedEvidenceCorpus } from "../tests/sourceEvidenceFixture.ts";
import type { Client } from "../tests/helpers.ts";

if (process.env.MOCK_LLM !== "1") throw new Error("Run with MOCK_LLM=1; this test uses no external models.");
const data = await mkdtemp(join(tmpdir(), "ontolab-evidence-browser-"));
const store = createLocalStore(data);
const worker = startDocumentWorker(store, silentLogger, { autoStart: false });
const server = http.createServer(
  createApp({
    store,
    distDir: resolve("dist"),
    log: silentLogger,
    auth: { mode: "local", authenticate: async () => ({ user: { id: "browser-evidence" } }) },
  }),
);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const c: Client = {
  get: (path) => fetch(url + path),
  async json(method, path, body) {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  },
  async upload(path, name, bytes) {
    const response = await fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
      body: typeof bytes === "string" ? bytes : new Uint8Array(bytes),
    });
    return { status: response.status, body: await response.json() };
  },
};
const browser = await chromium.launch({ headless: true });
try {
  const fixture = await seedEvidenceCorpus(c, () => worker!.tick());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("ontolab-model", JSON.stringify({ provider: "mock", model: "mock-1" })));
  await page.goto(`${url}/p/${fixture.corpus.id}/assistant`);
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("What load ratio was used in the fatigue test?");
  await page.getByRole("button", { name: "Send question", exact: true }).click();
  await page.waitForURL(/\?c=/);
  const citation = page.locator(".msg-assistant .md .cite-src").first();
  await citation.waitFor();
  await citation.click();
  await page.getByRole("region", { name: "Selected source passage" }).waitFor();
  assert((await page.locator(".source-excerpt").innerText()).includes("R = 0.1"));
  await page.getByRole("button", { name: "Inspect saved source", exact: true }).click();
  const inspector = page.getByLabel("Evidence inspector panel", { exact: true });
  await inspector.getByText("Quote location", { exact: true }).waitFor();
  assert((await inspector.innerText()).includes("R = 0.1"));
  await inspector.getByRole("button", { name: "Back to answer evidence", exact: true }).click();
  await page.getByRole("region", { name: "Selected source passage" }).waitFor();
  assert(page.url().includes("source="), "The citation has no durable link");
  await page.reload();
  await page.getByRole("region", { name: "Selected source passage" }).waitFor();
  assert((await page.locator(".source-excerpt").innerText()).includes("R = 0.1"));

  await page.getByRole("button", { name: "Report citation issue", exact: true }).click();
  await page.getByRole("button", { name: "Record issue", exact: true }).click();
  await page.getByText("Citation issue recorded.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "More context", exact: true }).click();
  await page.locator(".source-inspector .doc-viewer").waitFor();
  await page.getByRole("button", { name: "Back to sources", exact: true }).click();
  await page.getByRole("textbox", { name: "Search saved sources", exact: true }).fill("Temperature");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByText(/passages from 1 document/).waitFor();
  await page.locator(".source-hit").first().click();
  await page.getByRole("button", { name: "Ask using this passage", exact: true }).click();
  assert((await page.getByRole("textbox", { name: "Question", exact: true }).inputValue()).includes("Using this passage"));
  await page.getByRole("button", { name: "Send question", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".msg-assistant .md").length >= 2);
  await page.getByRole("button", { name: "Send question", exact: true }).waitFor();
  await page.reload();
  await page.locator(".msg-assistant .md .cite-src").first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileCitation = await page.locator(".msg-assistant .md .cite-src").first().elementHandle();
  await page.locator(".msg-assistant .md .cite-src").first().click();
  await page.getByRole("region", { name: "Selected source passage" }).waitFor();
  const bounds = await page.locator(".gc-panel").boundingBox();
  assert(bounds && bounds.width <= 390 && bounds.x >= 0, JSON.stringify(bounds));
  await page.getByRole("button", { name: "Back to answer", exact: true }).click();
  assert(await mobileCitation!.evaluate((node) => node.isConnected), "Citation remounted while opening/closing evidence");
  try {
    await page.waitForFunction(() => document.querySelector(".msg-assistant .md .cite-src") === document.activeElement);
  } catch (error) {
    console.error(
      "Focus restoration diagnostic",
      await page.evaluate(() => ({
        active: document.activeElement?.outerHTML,
        expected: document.querySelector(".msg-assistant .md .cite-src")?.outerHTML,
        url: location.href,
      })),
    );
    throw error;
  }
  // Activation can arrive after a citation remount leaves focus on the body.
  // The stored message/ref must recover the citation, not the connected body.
  await page.locator(".msg-assistant .md .cite-src").first().evaluate((node) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    (node as HTMLElement).click();
  });
  await page.getByRole("region", { name: "Selected source passage" }).waitFor();
  await page.getByRole("button", { name: "Back to answer", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".msg-assistant .md .cite-src") === document.activeElement);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".msg-assistant .md .cite-src").first().click();
  await mkdir(resolve("output/playwright"), { recursive: true });
  await page.screenshot({ path: "output/playwright/evidence-inspector.png", fullPage: true });
  // Preserve the ordinary-project source reader while corpus search uses immutable snapshots.
  const legacyPath = `/api/projects/${fixture.project.id}/documents`;
  const legacy = await c.upload(legacyPath, "ordinary.txt", "The ordinary project reports room temperature testing.", false);
  const legacyDoc = legacy.body.document as { id: string };
  await worker!.tick();
  const settings = { method: "paragraph", maxChars: 12000, overlap: 0.12 };
  const preview = await c.json<{ textHash: string }>("POST", `${legacyPath}/${legacyDoc.id}/chunk-preview`, settings);
  await c.json("POST", `${legacyPath}/${legacyDoc.id}/chunk-variant`, { settings, textHash: preview.body.textHash });
  await page.goto(`${url}/p/${fixture.project.id}/assistant`);
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("temperature");
  await page.getByRole("button", { name: "Send question", exact: true }).click();
  await page.waitForURL(/\?c=/);
  await page.locator(".msg-assistant .md .cite-src").first().click();
  await page.getByRole("button", { name: "Open current source", exact: true }).click();
  await page.getByLabel("Evidence inspector panel", { exact: true }).getByText("Quote location", { exact: true }).waitFor();
  assert((await page.getByLabel("Evidence inspector panel", { exact: true }).innerText()).includes("ordinary.txt"));
  assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
  console.log(
    "PASS: real corpus ingestion, Ask, citations, retained context, source search, passage follow-up, refresh, mobile inspector and focus restoration.",
  );
} finally {
  await browser.close();
  await worker?.stop();
  await new Promise<void>((r) => server.close(() => r()));
  await stopSparqlPool();
  await rm(data, { recursive: true, force: true });
}
