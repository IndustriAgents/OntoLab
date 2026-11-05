// Validation of the manual changes on the working copy, relative to the
// revision they started from: new findings show at once (client-side schema
// check), and once the draft is saved the server adds the reasoner's verdict.
// The same rule gates the commit — new errors block, new warnings need confirming.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { checkChange } from "../../lib/ontology/changeCheck";
import { StatusBadge, fmtDate } from "../../components/ui/ui";
import type { ABoxResult, ValidationIssue } from "../../types/abox";
import type { TBoxModel } from "../../types/tbox";

interface Props {
  tbox: TBoxModel;
  abox: ABoxResult;
  onSelect: (id: string) => void;
}

export function ChangeCheckPanel({ tbox, abox, onSelect }: Props) {
  const { pid, working } = useProject();
  const [tab, setTab] = useState<"check" | "log">("check");
  const rev = working.revision;
  // a draft is compared with the revision it started from; a committed revision being edited, with itself
  const baseId = rev?.status === "draft" ? rev.parentId : rev?.id;
  const base = useQuery({
    queryKey: qk.revision(pid, baseId ?? "none"),
    queryFn: () => api.getRevision(pid, baseId!),
    enabled: !!baseId && baseId !== rev?.id,
  });
  const baseAbox = baseId === rev?.id ? (rev?.content.abox ?? null) : (base.data?.content.abox ?? null);
  const local = useMemo(() => checkChange(baseAbox, abox, tbox, working.baseIri), [baseAbox, abox, tbox, working.baseIri]);

  const saved = working.isDraft && working.save !== "saving" && working.save !== "conflict" && !!rev;
  const server = useQuery({
    queryKey: qk.check(pid, rev?.id ?? "none", rev?.contentHash ?? ""),
    queryFn: () => api.check(pid, rev!.id),
    enabled: saved,
    staleTime: 60_000,
  });

  const edits = working.content?.edits ?? [];
  const reasonerNew = server.data?.reasoner?.introduced ?? [];
  const errors = [...local.blocking, ...reasonerNew.filter((i) => i.severity === "error")];
  const warnings = [...local.introduced, ...reasonerNew].filter((i) => i.severity !== "error");
  if (!working.isDraft && !local.touched.length) return null;

  return (
    <section className="card change-check" aria-labelledby="cc-h">
      <div className="card-head">
        <h3 id="cc-h">Change check</h3>
        <span className="file">
          {local.touched.length} individual{local.touched.length === 1 ? "" : "s"} changed
          {local.resolved.length > 0 && ` · ${local.resolved.length} finding${local.resolved.length === 1 ? "" : "s"} resolved`}
        </span>
      </div>
      <p className="cc-status">
        {errors.length ? (
          <StatusBadge tone="alert">
            {errors.length} blocking error{errors.length === 1 ? "" : "s"}
          </StatusBadge>
        ) : warnings.length ? (
          <StatusBadge tone="warn">
            {warnings.length} warning{warnings.length === 1 ? "" : "s"} to confirm at commit
          </StatusBadge>
        ) : (
          <StatusBadge tone="ok">Ready to commit</StatusBadge>
        )}{" "}
        {server.isFetching ? (
          <span className="muted small">Reasoning…</span>
        ) : server.data?.reasoner ? (
          server.data.reasoner.consistent ? (
            <StatusBadge tone="ok" title={`${server.data.reasoner.tier.toUpperCase()} reasoner`}>
              Consistent
            </StatusBadge>
          ) : (
            <StatusBadge tone="alert">Inconsistent</StatusBadge>
          )
        ) : saved && server.isError ? (
          <span className="muted small">Reasoner check unavailable</span>
        ) : !saved ? (
          <span className="muted small">The reasoner runs once the draft is saved</span>
        ) : null}
      </p>
      <div className="tabbar" role="tablist" aria-label="Change check">
        <button role="tab" aria-selected={tab === "check"} className={"tab" + (tab === "check" ? " on" : "")} onClick={() => setTab("check")}>
          New findings<span className="count">{errors.length + warnings.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "log"} className={"tab" + (tab === "log" ? " on" : "")} onClick={() => setTab("log")}>
          Edit log<span className="count">{edits.length}</span>
        </button>
      </div>
      {tab === "check" ? (
        errors.length + warnings.length === 0 ? (
          <p className="muted small">These changes add no findings.</p>
        ) : (
          <FindingList issues={[...errors, ...warnings]} onSelect={onSelect} />
        )
      ) : edits.length === 0 ? (
        <p className="muted small">No manual edits on this draft yet.</p>
      ) : (
        <ul className="cc-log">
          {[...edits]
            .reverse()
            .slice(0, 50)
            .map((e, i) => (
              <li key={i}>
                <StatusBadge tone={e.kind === "remove" ? "alert" : e.kind === "add" ? "ok" : "muted"}>{e.kind}</StatusBadge> {e.summary}{" "}
                <span className="muted small">
                  {e.by} · {fmtDate(e.at)}
                </span>
              </li>
            ))}
          {edits.length > 50 && <li className="muted small">…and {edits.length - 50} earlier</li>}
        </ul>
      )}
    </section>
  );
}

function FindingList({ issues, onSelect }: { issues: ValidationIssue[]; onSelect: (id: string) => void }) {
  return (
    <ul className="issue-mini cc-findings">
      {issues.slice(0, 20).map((i, n) => (
        <li key={n}>
          <StatusBadge tone={i.severity === "error" ? "alert" : "warn"}>{i.severity === "error" ? "Error" : "Warning"}</StatusBadge>{" "}
          {i.id ? (
            <button className="cite" onClick={() => onSelect(i.id!)}>
              {i.where}
            </button>
          ) : (
            <b>{i.where}</b>
          )}
          : {i.message}
          {i.explanation?.length ? <div className="row-sub">{i.explanation.join(" · ")}</div> : null}
        </li>
      ))}
      {issues.length > 20 && <li className="muted small">…and {issues.length - 20} more</li>}
    </ul>
  );
}
