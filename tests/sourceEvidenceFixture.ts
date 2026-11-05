import type { Client } from "./helpers.ts";
import type { Project, RevisionWithContent, RunView } from "../src/types/project.ts";
import type { CorpusPlan } from "../src/types/corpus.ts";
import { listFacts } from "../src/lib/ontology/factReview.ts";

/** Real corpus workflow, shared by HTTP and browser smoke tests. */
export async function seedEvidenceCorpus(c: Client, processDocuments: () => Promise<number>) {
  const project = (
    await c.json<{ project: Project }>("POST", "/api/projects", {
      name: "Evidence research",
      settings: { provider: "mock", model: "mock-1", models: { embeddings: "hash", nli: "off" } },
    })
  ).body.project;
  const ontology = (
    await c.json<{ revision: RevisionWithContent }>("POST", `/api/projects/${project.id}/revisions`, {
      source: "import",
      content: {
        modules: [
          {
            id: "schema",
            name: "schema.ttl",
            turtle:
              "@prefix ex:<http://example.org/#>. @prefix owl:<http://www.w3.org/2002/07/owl#>. ex:Pump a owl:Class. ex:Sensor a owl:Class.",
          },
        ],
        abox: null,
        baseIri: "http://example.org/#",
      },
    })
  ).body.revision;
  await c.json("POST", `/api/projects/${project.id}/revisions/${ontology.id}/commit`, { acknowledgedWarnings: true });
  const corpus = (
    await c.json<{ corpus: Project }>("POST", `/api/projects/${project.id}/corpora`, {
      name: "Fatigue studies",
      ontologyRevisionId: ontology.id,
      provider: "mock",
      model: "mock-1",
    })
  ).body.corpus;
  const text =
    "Pump fatigue study. Treatment A improved fatigue performance in the tested specimens.\n\n" +
    "Material and specimen preparation were recorded separately. ".repeat(40) +
    "\n\nTable 2: Test conditions 🧪\nTemperature | Room temperature\nLoad ratio | R = 0.1\nThe load ratio applies only to the fatigue test for Material A.\n";
  const uploaded = await c.upload(`/api/projects/${corpus.id}/corpus/documents`, "fatigue-study.txt", text, false);
  if (uploaded.status !== 201) throw new Error(JSON.stringify(uploaded));
  await processDocuments();
  const plan = (await c.json<CorpusPlan>("POST", `/api/projects/${corpus.id}/corpus/plan`, {})).body;
  const run = (await c.json<{ run: RunView }>("POST", `/api/projects/${corpus.id}/corpus/updates`, { hash: plan.hash })).body.run;
  let completed: RunView = run;
  for (let i = 0; i < 100 && !["ready_for_review", "failed"].includes(completed.status); i++)
    completed = (await c.json<{ run: RunView }>("POST", `/api/projects/${corpus.id}/runs/${run.id}/advance`)).body.run;
  if (!completed.resultRevisionId) throw new Error(JSON.stringify(completed));
  const draft = (
    await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${corpus.id}/revisions/${completed.resultRevisionId}`)
  ).body.revision;
  const decisions = listFacts(draft.content.abox!).map((f) => ({ key: f.key, status: "accepted" }));
  if (decisions.length) await c.json("POST", `/api/projects/${corpus.id}/revisions/${draft.id}/facts/review`, { decisions });
  const saved = await c.json("POST", `/api/projects/${corpus.id}/revisions/${draft.id}/commit`, { acknowledgedWarnings: true });
  if (saved.status !== 200) throw new Error(JSON.stringify(saved));
  return { project, corpus, revision: draft, text, runId: run.id };
}
