/** Native UI + real MCP process end-to-end check. Uses a disposable profile and mock inference. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ActionResult } from "../src/types/actions.ts";
import type { OntologyRevision, Project, ProjectDocument } from "../src/types/project.ts";

const root = await mkdtemp(join(tmpdir(), "ontolab native mcp "));
const artifactDir = resolve("output/local-mcp-smoke");
const executablePath = process.env.ONTOLAB_DESKTOP_EXECUTABLE;
let desktop: ElectronApplication | undefined;
const client = new Client({ name: "native-smoke", version: "1.0" });
const errors: string[] = [];
let sequence = 0;
async function tool<T>(name: string, input: Record<string, unknown>, write = false): Promise<T> {
  const response = await client.callTool({ name, arguments: { ...input, ...(write ? { requestId: `smoke_${++sequence}` } : {}) } });
  assert.ok(!response.isError, JSON.stringify(response.content));
  return (response.structuredContent as unknown as ActionResult).data as T;
}
try {
  await mkdir(artifactDir, { recursive: true });
  desktop = await _electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [process.cwd()],
    env: {
      ...process.env,
      ONTOLAB_DESKTOP_PROFILE: join(root, "profile"),
      MOCK_LLM: "1",
      EMBEDDINGS_BACKEND: "hash",
      NLI_BACKEND: "off",
      LOCAL_CLI_ENABLED: "0",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      GEMINI_API_KEY: "",
      DEEPSEEK_API_KEY: "",
    },
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.getByLabel("Name", { exact: true }).fill("MCP equipment");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("heading", { name: "Build an ontology", exact: true }).waitFor();
  const projectId = new URL(page.url()).pathname.match(/\/p\/([^/]+)/)![1];
  await page.getByRole("button", { name: "OntoLab AI", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "OntoLab AI" });
  await panel.getByRole("heading", { name: "What would you like to build?" }).waitFor();
  await panel.getByLabel("Ask OntoLab AI").fill("Inspect my project and available next steps");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await panel.getByText("I inspected this project's current context", { exact: false }).waitFor();
  await page.screenshot({ path: join(artifactDir, "ai-panel.png") });
  await panel.getByRole("link", { name: "Connect an assistant" }).click();
  await page.getByLabel("Connection name", { exact: true }).fill("Native smoke client");
  await page.getByLabel("Allow this connection to review facts and save versions").check();
  await page.getByRole("button", { name: "Create connection", exact: true }).click();
  await page.getByRole("heading", { name: "Connect Native smoke client" }).waitFor();
  await page.getByText("Configuration for another MCP client", { exact: true }).click();
  const json = await page.locator("details").filter({ hasText: "Configuration for another MCP client" }).locator("pre").textContent();
  const config = JSON.parse(json!).mcpServers.ontolab as { command: string; args: string[] };
  await page.screenshot({ path: join(artifactDir, "connection-setup.png") });
  await client.connect(new StdioClientTransport({ ...config, stderr: "pipe" }));
  assert.ok((await client.listTools()).tools.some((t) => t.name === "submit_fact_batch"));
  const turtle =
    '@prefix : <https://example.com/equipment#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<https://example.com/equipment> a owl:Ontology .\n:Pump a owl:Class ; rdfs:label "Pump" ; rdfs:comment "Equipment that pumps water." .';
  const draft = (
    await tool<{ revision: OntologyRevision }>(
      "submit_ontology_draft",
      { projectId, baseRevisionId: null, modules: [{ name: "equipment.ttl", turtle }], summary: "Pump ontology proposed through MCP" },
      true,
    )
  ).revision;
  await client.callTool({ name: "open_in_ontolab", arguments: { projectId, revisionId: draft.id } });
  await page.waitForURL((url) => url.searchParams.get("rev") === draft.id);
  await page.getByText(/Pump/).first().waitFor();
  assert.match(await page.locator("body").innerText(), /Pump/);
  await tool("validate_revision", { projectId, revisionId: draft.id });
  await tool("save_version", { projectId, revisionId: draft.id, expectedHash: draft.contentHash, acknowledgedWarnings: true }, true);
  const graph = (
    await tool<{ project: Project }>("create_knowledge_graph", { projectId, ontologyRevisionId: draft.id, name: "Equipment manuals" }, true)
  ).project;
  const source = (
    await tool<{ document: ProjectDocument }>(
      "import_document",
      { projectId: graph.id, name: "manual.txt", text: "Pump A moves water. Pump A is a pump." },
      true,
    )
  ).document;
  let parsed = false;
  for (let i = 0; i < 60; i++) {
    const context = await tool<{ documents: ProjectDocument[] }>("get_project_context", { projectId: graph.id });
    if (context.documents[0]?.parseState === "parsed") {
      parsed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(parsed);
  await tool("prepare_documents", { projectId: graph.id, documentIds: [source.id] }, true);
  const work = await tool<{ workPackageId: string }>("prepare_fact_submission", { projectId: graph.id }, true);
  const inputs = await tool<{ chunks: { id: string }[] }>("read_work_package", { projectId: graph.id, workPackageId: work.workPackageId });
  await tool(
    "submit_fact_batch",
    {
      projectId: graph.id,
      workPackageId: work.workPackageId,
      batchId: "manual",
      chunkIds: inputs.chunks.map((c) => c.id),
      individuals: [
        {
          id: "pump_a",
          classUri: "https://example.com/equipment#Pump",
          label: "Pump A",
          evidence: [{ chunkId: inputs.chunks[0].id, quote: "Pump A moves water." }],
        },
      ],
    },
    true,
  );
  const extracted = (
    await tool<{ revision: OntologyRevision }>("finalize_fact_submission", { projectId: graph.id, workPackageId: work.workPackageId }, true)
  ).revision;
  await client.callTool({ name: "open_in_ontolab", arguments: { projectId: graph.id, revisionId: extracted.id } });
  await page.waitForURL((url) => url.pathname.includes(graph.id) && url.searchParams.get("rev") === extracted.id);
  await page.screenshot({ path: join(artifactDir, "graph-review.png") });
  const queue = await tool<{ facts: { key: string; status: string }[] }>("list_facts", {
    projectId: graph.id,
    revisionId: extracted.id,
    status: "all",
  });
  assert.equal(queue.facts[0].status, "candidate");
  await page.getByRole("button", { name: "Inspect evidence", exact: true }).click();
  const sourcePanel = page.getByLabel("Evidence inspector panel", { exact: true });
  await sourcePanel.waitFor();
  await sourcePanel.getByText("Pump A moves water.", { exact: false }).first().waitFor();
  await sourcePanel.getByRole("button", { name: "Close evidence inspector", exact: true }).click();
  await page.getByRole("button", { name: "Accept fact", exact: true }).click();
  await page.getByText("accepted · human decision", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Save knowledge graph", exact: true }).first().click();
  const saveDialog = page.getByRole("dialog");
  await saveDialog.getByRole("heading", { name: "Save graph version", exact: true }).waitFor();
  const warning = saveDialog.getByLabel("Save with these warnings", { exact: false });
  if (await warning.isVisible()) await warning.check();
  await saveDialog.getByRole("button", { name: "Save version", exact: true }).click();
  await saveDialog.waitFor({ state: "hidden" });
  const query = await tool<{ rows: unknown[] }>("query_graph", {
    projectId: graph.id,
    revisionId: extracted.id,
    query: "SELECT ?pump WHERE { ?pump a <https://example.com/equipment#Pump> }",
  });
  assert.equal(query.rows.length, 1);
  const output = await tool<{ turtle: string }>("create_export", { projectId: graph.id, revisionId: extracted.id });
  assert.match(output.turtle, /Pump A/);
  await page.getByRole("button", { name: "OntoLab AI", exact: true }).click();
  await page.getByRole("complementary", { name: "OntoLab AI" }).waitFor();
  await page.screenshot({ path: join(artifactDir, "graph-ai.png") });
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifactDir, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        packaged: !!executablePath,
        toolCount: (await client.listTools()).tools.length,
        checks: [
          "native AI panel",
          "connection setup through UI",
          "packaged stdio bridge",
          "external ontology draft",
          "desktop navigation",
          "source preparation",
          "external fact submission",
          "source evidence in UI",
          "fact review and version saving through UI",
          "SPARQL",
          "RDF export",
        ],
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
  console.info(`Local MCP native smoke passed. Artifacts: ${artifactDir}`);
} catch (error) {
  console.error(await readFile(join(root, "profile/desktop.log"), "utf8").catch(() => "No desktop log."));
  throw error;
} finally {
  await client.close();
  await desktop?.close();
  await rm(root, { recursive: true, force: true });
}
