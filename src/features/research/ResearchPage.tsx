import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { EmptyState, ErrorState, LoadingState, PageHead, fmtDate } from "../../components/ui/ui";
import { ChunkLab } from "./ChunkLab";
import { RunInspector } from "./RunInspector";
import "./research.css";

export default function ResearchPage() {
  const { pid } = useProject();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "induction" ? "induction" : params.get("view") === "extraction" ? "extraction" : "documents";
  const docs = useQuery({ queryKey: qk.documents(pid), queryFn: () => api.listDocuments(pid) });
  const runs = useQuery({ queryKey: qk.runs(pid), queryFn: () => api.listRuns(pid) });
  const defaults = useQuery({ queryKey: ["chunk-defaults", pid], queryFn: () => api.chunkDefaults(pid) });
  const documents = (docs.data ?? []).filter((d) => d.parseState === "parsed");
  const list = (runs.data ?? []).filter((r) => (r.kind ?? "extraction") === view);
  const doc = documents.find((d) => d.id === params.get("doc")) ?? documents[0];
  const run = list.find((r) => r.id === params.get("run")) ?? list[0];
  const select = (key: string, value: string) =>
    setParams((old) => {
      const next = new URLSearchParams(old);
      next.set(key, value);
      return next;
    });
  return (
    <div className="page research-page">
      <div className="page-wide">
        <PageHead title="Research workspace">
          Inspect how your documents become an ontology and a knowledge graph. Compare preprocessing methods, follow each stage, and export
          the recorded evidence behind a run.
        </PageHead>
        <div className="research-tabs research-main-tabs" role="group" aria-label="Research pipeline">
          <button aria-pressed={view === "documents"} onClick={() => select("view", "documents")}>
            <span>01</span> Documents & chunking
          </button>
          <button aria-pressed={view === "induction"} onClick={() => select("view", "induction")}>
            <span>02</span> T-Box pipeline
          </button>
          <button aria-pressed={view === "extraction"} onClick={() => select("view", "extraction")}>
            <span>03</span> A-Box pipeline
          </button>
        </div>
        {docs.error || runs.error || defaults.error ? (
          <ErrorState
            error={docs.error ?? runs.error ?? defaults.error}
            onRetry={() => {
              void docs.refetch();
              void runs.refetch();
              void defaults.refetch();
            }}
          />
        ) : docs.isLoading || runs.isLoading || defaults.isLoading ? (
          <LoadingState />
        ) : view === "documents" ? (
          doc && defaults.data ? (
            <>
              <label className="field research-picker">
                <span>Document to inspect</span>
                <select value={doc.id} onChange={(e) => select("doc", e.target.value)}>
                  {documents.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} · {d.chunkCount} chunks
                    </option>
                  ))}
                </select>
              </label>
              <ChunkLab key={doc.id} pid={pid} doc={doc} defaults={defaults.data} />
            </>
          ) : (
            <EmptyState
              title="Start with a document"
              action={
                <Link className="btn" to={`/p/${pid}/documents`}>
                  Upload documents
                </Link>
              }
            >
              After parsing, inspect the extracted structure, exact chunk text, boundaries and overlap here.
            </EmptyState>
          )
        ) : run ? (
          <>
            <label className="field research-picker">
              <span>{view === "induction" ? "T-Box induction" : "A-Box extraction"} run</span>
              <select value={run.id} onChange={(e) => select("run", e.target.value)}>
                {list.map((r) => (
                  <option key={r.id} value={r.id}>
                    {fmtDate(r.createdAt)} · {r.model} · {r.status.replaceAll("_", " ")} · {r.id.slice(-6)}
                  </option>
                ))}
              </select>
            </label>
            <RunInspector key={run.id} pid={pid} runId={run.id} />
          </>
        ) : (
          <EmptyState
            title={`No ${view === "induction" ? "T-Box induction" : "A-Box extraction"} runs yet`}
            action={
              <Link className="btn" to={`/p/${pid}/${view === "induction" ? "ontology" : "runs"}`}>
                {view === "induction" ? "Build an ontology" : "Configure extraction"}
              </Link>
            }
          >
            Once a run starts, each successful stage appears here with its saved result. Imported ontologies have no induction trace.
          </EmptyState>
        )}
      </div>
    </div>
  );
}
