import type { RouteCtx } from "./app.ts";
import type { Router } from "./router.ts";
import { StatusResponse, headerString } from "./router.ts";
import { HttpError } from "./http.ts";
import { MAX_UPLOAD_BYTES } from "./config.ts";
import { requireString, optionalString } from "./validation.ts";
import type { CorpusUpdateMode } from "../src/types/corpus.ts";
import * as corpora from "./services/corpora.ts";
import { validateChunkSettings } from "./services/research.ts";

const ids = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 10000 || value.some((v) => typeof v !== "string" || v.length > 10000))
    throw new HttpError(400, "Select valid source or fact identifiers.");
  return value as string[];
};
const mode = (value: unknown): CorpusUpdateMode => {
  if (value === undefined) return "changes";
  if (!["changes", "reprocess", "rebuild"].includes(String(value))) throw new HttpError(400, "Unknown corpus update mode.");
  return value as CorpusUpdateMode;
};
export function registerCorpusRoutes(r: Router<RouteCtx>) {
  r.get("/api/projects/:pid/corpora", async ({ svc, params }) => ({ corpora: await corpora.listCorpora(svc, params.pid) }));
  r.post("/api/projects/:pid/corpora", async ({ svc, params, json }) => {
    const b = await json();
    return new StatusResponse(201, {
      corpus: await corpora.createCorpus(svc, params.pid, {
        name: requireString(b.name, "name", { max: 200 }),
        ontologyRevisionId: optionalString(b.ontologyRevisionId, "ontologyRevisionId", { max: 80 }),
        provider: optionalString(b.provider, "provider", { max: 40 }),
        model: optionalString(b.model, "model", { max: 160 }),
      }),
    });
  });
  r.get("/api/projects/:pid/corpus/evidence", async ({ svc, params, query }) =>
    corpora.evidenceSnapshot(
      svc,
      params.pid,
      requireString(query.get("run"), "run", { max: 80 }),
      requireString(query.get("document"), "document", { max: 80 }),
    ),
  );
  r.post("/api/projects/:pid/corpus/members/:mid/reparse", async ({ svc, params }) => ({
    document: await corpora.reparseSource(svc, params.pid, params.mid),
  }));
  r.get("/api/projects/:pid/corpus", async ({ svc, params }) => corpora.corpusDetail(svc, params.pid));
  r.get("/api/projects/:pid/corpus/documents", async ({ svc, params }) => {
    const detail = await corpora.corpusDetail(svc, params.pid);
    return {
      documents: detail.documents.filter((d) =>
        detail.corpus.settings.corpus!.members.some((m) => !m.removed && m.headDocumentId === d.id),
      ),
    };
  });
  r.post("/api/projects/:pid/corpus/documents", async ({ svc, params, query, req, raw }) => {
    let name = headerString(req, "x-file-name") ?? "document";
    try {
      name = decodeURIComponent(name);
    } catch {
      /* original header */
    }
    const result = await corpora.addCorpusDocument(svc, params.pid, name, await raw(MAX_UPLOAD_BYTES), query.get("member") ?? undefined);
    return new StatusResponse(result.duplicate ? 200 : 201, result);
  });
  r.put("/api/projects/:pid/corpus/settings", async ({ svc, params, json }) => {
    const b = await json();
    return {
      corpus: await corpora.updateCorpusSettings(svc, params.pid, {
        name: optionalString(b.name, "name", { max: 200 }),
        ontologyRevisionId: optionalString(b.ontologyRevisionId, "ontologyRevisionId", { max: 80 }),
        provider: optionalString(b.provider, "provider", { max: 40 }),
        model: optionalString(b.model, "model", { max: 160 }),
        ...(b.chunking ? { chunking: validateChunkSettings(b.chunking) } : {}),
      }),
    };
  });
  r.post("/api/projects/:pid/corpus/plan", async ({ svc, params, json }) => {
    const b = await json();
    return corpora.planUpdate(svc, params.pid, mode(b.mode), b.selected === undefined ? [] : ids(b.selected));
  });
  r.post(
    "/api/projects/:pid/corpus/updates",
    async ({ svc, params, json }) => {
      const b = await json();
      return corpora.startUpdate(svc, params.pid, {
        hash: requireString(b.hash, "hash", { max: 100 }),
        mode: mode(b.mode),
        selected: b.selected === undefined ? [] : ids(b.selected),
      });
    },
    { abortOnClose: false },
  );
  r.get("/api/projects/:pid/corpus/members/:mid/impact", async ({ svc, params }) => corpora.sourceImpact(svc, params.pid, params.mid));
  r.put("/api/projects/:pid/corpus/members/:mid", async ({ svc, params, json }) => {
    const b = await json();
    if (b.removed !== undefined && typeof b.removed !== "boolean") throw new HttpError(400, "Removed must be true or false.");
    return {
      corpus: await corpora.setSourceState(svc, params.pid, params.mid, {
        removed: b.removed as boolean | undefined,
        documentId: optionalString(b.documentId, "documentId", { max: 80 }),
      }),
    };
  });
  r.post("/api/projects/:pid/corpus/members/:mid/prepare", async ({ svc, params }) => ({
    document: await corpora.prepareSource(svc, params.pid, params.mid),
  }));
  r.post("/api/projects/:pid/corpus/members/:mid/preparation", async ({ svc, params, json }) => ({
    corpus: await corpora.setPreparation(svc, params.pid, params.mid, requireString((await json()).documentId, "documentId", { max: 80 })),
  }));
  r.get("/api/projects/:pid/corpus/updates/:rid", async ({ svc, params }) => corpora.updateChanges(svc, params.pid, params.rid));
  r.post("/api/projects/:pid/corpus/updates/:rid/losses", async ({ svc, params, json }) => {
    const b = await json();
    if (b.decision !== "remove" && b.decision !== "manual") throw new HttpError(400, "Choose remove or manual.");
    return { revision: await corpora.decideSourceLosses(svc, params.pid, params.rid, ids(b.keys), b.decision) };
  });
  r.post("/api/projects/:pid/corpus/updates/:rid/replacement", async ({ svc, params, json }) => {
    const b = await json();
    if (b.decision !== "proposed" && b.decision !== "previous") throw new HttpError(400, "Choose proposed or previous.");
    return {
      revision: await corpora.decideReplacement(
        svc,
        params.pid,
        params.rid,
        requireString(b.beforeKey, "previous fact", { max: 10000 }),
        requireString(b.afterKey, "proposed fact", { max: 10000 }),
        b.decision,
      ),
    };
  });
  r.post("/api/projects/:pid/corpus/updates/:rid/relationships", async ({ svc, params, json }) => {
    const b = await json(),
      create = b.create as Record<string, unknown> | undefined;
    return {
      revision: await corpora.resolveRelationship(svc, params.pid, params.rid, {
        id: requireString(b.id, "relationship id", { max: 10000 }),
        targetId: optionalString(b.targetId, "targetId", { max: 1000 }),
        dismiss: b.dismiss === true,
        ...(create
          ? {
              create: {
                id: requireString(create.id, "entity id", { max: 300 }),
                label: requireString(create.label, "label", { max: 500 }),
                classUri: requireString(create.classUri, "classUri", { max: 2000 }),
              },
            }
          : {}),
      }),
    };
  });
}
