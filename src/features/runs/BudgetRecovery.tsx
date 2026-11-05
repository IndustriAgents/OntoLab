import "./budget-recovery.css";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { InlineError } from "../../components/ui/ui";

/** Budget controls appear at the failure that needs them, rather than in the normal workflow. */
export function BudgetRecovery({ error }: { error: unknown }) {
  const { pid, project } = useProject();
  const qc = useQueryClient();
  const [perRun, setPerRun] = useState(project?.settings.budget?.maxUsdPerRun?.toString() ?? "");
  const [total, setTotal] = useState(project?.settings.budget?.maxUsdTotal?.toString() ?? "");
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const invalid = [perRun, total].some((s) => s.trim() !== "" && (!Number.isFinite(Number(s)) || Number(s) < 0));
  const save = useMutation({
    mutationFn: async () => {
      const fresh = await api.getProject(pid);
      return api.updateProject(pid, {
        settings: {
          ...fresh.settings,
          budget: {
            ...(perRun.trim() ? { maxUsdPerRun: Number(perRun) } : {}),
            ...(total.trim() ? { maxUsdTotal: Number(total) } : {}),
          },
        },
      });
    },
    onSuccess: (p) => {
      qc.setQueryData(qk.project(pid), p);
      void qc.invalidateQueries({ queryKey: ["estimate", pid] });
      void qc.invalidateQueries({ queryKey: ["induction-estimate", pid] });
      void qc.invalidateQueries({ queryKey: ["alignment-estimate", pid] });
    },
  });
  if (!/per-run budget|project.{0,100}budget|budget of \$|spending limit/i.test(message)) return null;
  return (
    <details className="method-details budget-recovery" open>
      <summary>Adjust spending limits to continue</summary>
      <p>
        Increase the relevant USD limit, or leave it empty for no limit. Saving updates the limits; start or retry processing separately.
      </p>
      <div className="field-row">
        <label className="field">
          <span>Per activity limit (USD)</span>
          <input inputMode="decimal" value={perRun} onChange={(e) => setPerRun(e.target.value)} placeholder="No limit" />
        </label>
        <label className="field">
          <span>Project total limit (USD)</span>
          <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="No limit" />
        </label>
      </div>
      {invalid && <p role="alert">Enter a non-negative amount or leave the limit empty.</p>}
      <button className="btn ghost" disabled={invalid || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : "Save spending limits"}
      </button>
      {save.isSuccess && <p role="status">Limits saved. You can now retry or start processing.</p>}
      <InlineError error={save.error} />
    </details>
  );
}
