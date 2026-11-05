import { Link } from "react-router";
import type { ActionResult } from "../../types/actions";

/** Render application-owned destinations; model text cannot introduce executable controls. */
export function ActionCard({ result }: { result: ActionResult }) {
  const data = result.data as {
    report?: { schemaIssues?: unknown[]; ontologyIssues?: unknown[]; shaclIssues?: unknown[] };
    run?: { status: string; completedSteps?: number; steps?: unknown[] };
    plan?: { estimate?: { usd: number | null; modelCalls: number }; errors?: string[] };
    document?: { name: string; parseState: string };
  } | null;
  return (
    <article className="agent-result">
      <strong>{result.summary}</strong>
      {data?.run && (
        <p>
          Activity: {data.run.status.replaceAll("_", " ")}
          {data.run.steps ? ` · ${data.run.completedSteps ?? 0} / ${data.run.steps.length} steps saved` : ""}
        </p>
      )}
      {data?.document && (
        <p>
          {data.document.name} · {data.document.parseState}
        </p>
      )}
      {data?.report && (
        <p>
          {(data.report.schemaIssues?.length ?? 0) + (data.report.ontologyIssues?.length ?? 0) + (data.report.shaclIssues?.length ?? 0)}{" "}
          validation findings. Open validation to inspect severity and evidence.
        </p>
      )}
      {data?.plan?.estimate && (
        <p>
          {data.plan.estimate.modelCalls} model calls ·{" "}
          {data.plan.estimate.usd == null ? "Cost unavailable" : `Estimated $${data.plan.estimate.usd.toFixed(2)}`}
        </p>
      )}
      {data?.plan?.errors?.map((error) => (
        <p key={error} className="error-text">
          {error}
        </p>
      ))}
      {result.destination?.match(/^\/p\/[A-Za-z0-9_-]+(?:\/|$)/) && (
        <Link className="btn ghost sm" to={result.destination}>
          {/validate/.test(result.destination)
            ? "View validation"
            : /rev=/.test(result.destination)
              ? "Review changes"
              : /runs\//.test(result.destination)
                ? "View progress"
                : "Open workspace"}
        </Link>
      )}
    </article>
  );
}
