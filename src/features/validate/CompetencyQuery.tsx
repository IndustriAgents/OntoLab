import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useModelChoice, selectProps } from "../../app/providers";
import { api, qk, type CqAnswer } from "../../lib/projectApi";
import type { CqResult } from "../../types/project";
import { ProviderModelSelect } from "../../components/common/ProviderModelSelect";
import { InlineError } from "../../components/ui/ui";
function ResultTable({ r }: { r: Pick<CqResult, "columns" | "rows" | "truncated" | "error"> }) {
  if (r.error) return <div className="dz-error">{r.error}</div>;
  if (!r.rows.length) return <p className="muted">No results.</p>;
  return (
    <div className="cq-table-wrap">
      <table className="cq-table">
        <thead>
          <tr>
            {r.columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.rows.slice(0, 200).map((row, i) => (
            <tr key={i}>
              {r.columns.map((c) => (
                <td key={c}>{row[c]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(r.truncated || r.rows.length > 200) && <p className="muted small">Showing the first {Math.min(200, r.rows.length)} rows.</p>}
    </div>
  );
}

export function AskCq({ revisionId }: { revisionId: string }) {
  const { pid, project } = useProject();
  const qc = useQueryClient();
  const choice = useModelChoice();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<(CqAnswer & { question: string }) | null>(null);
  const ask = useMutation({
    mutationFn: (q: string) => api.askCq(pid, revisionId, q, choice.provider, choice.model),
    onSuccess: (a, q) => setAnswer({ ...a, question: q }),
  });
  const saved = project?.settings.savedQueries ?? [];
  const save = useMutation({
    mutationFn: () =>
      api.updateProject(pid, {
        settings: {
          ...project!.settings,
          savedQueries: [...saved.filter((s) => s.question !== answer!.question), { question: answer!.question, sparql: answer!.sparql }],
        },
      }),
    onSuccess: (p) => qc.setQueryData(qk.project(pid), p),
  });
  const unsaved = (project?.competencyQuestions ?? []).filter((q) => !saved.some((s) => s.question === q));

  return (
    <section className="card" aria-labelledby="cq-ask">
      <div className="card-head">
        <h3 id="cq-ask">Competency questions</h3>
      </div>
      <p className="field-hint">
        A question is translated to a read-only SPARQL query (SELECT or ASK) and run against this revision only. Saved queries re-run on
        every validation without a model call.
      </p>
      {unsaved.length > 0 && (
        <div className="chip-list" aria-label="Project competency questions without a saved query">
          {unsaved.map((q) => (
            <button key={q} className="chip chip-btn" onClick={() => (setQuestion(q), ask.mutate(q))}>
              {q}
            </button>
          ))}
        </div>
      )}
      <ProviderModelSelect {...selectProps(choice)} structuredOnly compact />
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) ask.mutate(question.trim());
        }}
      >
        <input
          aria-label="Competency question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Which sensors belong to the stack magazine?"
        />
        <button className="btn" disabled={!question.trim() || ask.isPending || !choice.providerEnabled}>
          {ask.isPending ? "Asking…" : "Ask"}
        </button>
      </form>
      <InlineError error={ask.error} />
      {answer && (
        <div className="cq-answer">
          <p>{answer.explanation}</p>
          <pre className="ttl-preview">{answer.sparql}</pre>
          <ResultTable r={answer} />
          {!answer.error && (
            <button className="btn ghost sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {saved.some((s) => s.question === answer.question) ? "Update saved query" : "Save query"}
            </button>
          )}
          <InlineError error={save.error} />
        </div>
      )}
    </section>
  );
}
