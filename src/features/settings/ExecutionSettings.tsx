import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../../lib/http";
import type { ExecutionSettings as Settings } from "../../types/execution";
import { InlineError } from "../../components/ui/ui";

const key = ["execution-settings"];
export default function ExecutionSettings() {
  const query = useQuery({ queryKey: key, queryFn: () => request<Settings>("GET", "api/execution-settings") });
  return (
    <section className="card settings-card" aria-labelledby="st-execution">
      <div className="settings-section-head">
        <h2 id="st-execution">Extraction execution</h2>
        <p>Configure parallel CLI workers, model request timeout, and extraction retries for this workspace.</p>
      </div>
      <InlineError error={query.error} />
      {query.data ? <ExecutionForm initial={query.data} /> : !query.error && <p role="status">Loading execution settings…</p>}
    </section>
  );
}
function ExecutionForm({ initial }: { initial: Settings }) {
  const qc = useQueryClient();
  const [workers, setWorkers] = useState(String(initial.cliConcurrency));
  const [seconds, setSeconds] = useState(String(initial.timeoutMs / 1000));
  const [attempts, setAttempts] = useState(String(initial.maxStepAttempts));
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      request<Settings>("PUT", "api/execution-settings", {
        body: { cliConcurrency: Number(workers), timeoutMs: Math.round(Number(seconds) * 1000), maxStepAttempts: Number(attempts) },
      }),
    onSuccess: (settings) => {
      qc.setQueryData(key, settings);
      setSaved(true);
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        save.mutate();
      }}
      onChange={() => setSaved(false)}
    >
      <fieldset disabled={save.isPending} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="field">
          <label htmlFor="execution-workers">Parallel CLI workers</label>
          <input
            id="execution-workers"
            type="number"
            min="1"
            max="16"
            step="1"
            required
            value={workers}
            onChange={(e) => setWorkers(e.target.value)}
          />
          <p className="field-hint">
            1–16 concurrent CLI requests. Independent extraction chunks use the run’s selected model. Account limits still apply.
          </p>
        </div>
        <div className="field">
          <label htmlFor="execution-timeout">Request timeout (seconds)</label>
          <input
            id="execution-timeout"
            type="number"
            min="1"
            max="3600"
            step="0.001"
            required
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
          />
          <p className="field-hint">Up to 3,600 seconds (60 minutes) per model request, including CLI queue time.</p>
        </div>
        <div className="field">
          <label htmlFor="execution-attempts">Maximum step attempts</label>
          <input
            id="execution-attempts"
            type="number"
            min="1"
            max="20"
            step="1"
            required
            value={attempts}
            onChange={(e) => setAttempts(e.target.value)}
          />
          <p className="field-hint">1–20 attempts for retryable extraction failures, including the first attempt.</p>
        </div>
        <InlineError error={save.error} />
        <button className="btn" type="submit">
          {save.isPending ? "Saving…" : "Save execution settings"}
        </button>
        {saved && <p role="status">Execution settings saved.</p>}
      </fieldset>
      <p className="field-hint">
        Saved on this computer. Changes apply to subsequent extraction steps and requests without restarting. Existing requests keep their
        timeout.
      </p>
    </form>
  );
}
