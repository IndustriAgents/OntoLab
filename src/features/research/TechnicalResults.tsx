import type { TechnicalResult } from "../../types/research";
import { JsonDetails, ResultTable, saveJson } from "./ResearchResults";

function shown(value: unknown): unknown {
  if (typeof value === "number") return Number.isInteger(value) ? value : Number(value.toFixed(6));
  if (Array.isArray(value)) return value.map(shown);
  return value;
}
/** Render recorded numerical evidence; never calculate new scores in the browser. */
export function TechnicalResults({ results }: { results: TechnicalResult[] }) {
  return (
    <div className="research-stack">
      {results.map((result, i) => (
        <section className="technical-result" key={`${result.title}-${i}`}>
          <div className="research-section-head">
            <h3>{result.title}</h3>
            <button className="btn ghost sm" onClick={() => saveJson(result, `technical-results-${i + 1}.json`)}>
              Export measurements
            </button>
          </div>
          <p className="technical-method">{result.method}</p>
          <dl className="technical-parameters">
            {Object.entries(result.parameters).map(([key, value]) => (
              <div key={key}>
                <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                <dd>
                  {value == null ? "Not used / unavailable" : typeof value === "object" ? JSON.stringify(value) : String(shown(value))}
                </dd>
              </div>
            ))}
          </dl>
          {!!result.rows.length && (
            <ResultTable
              fullIris
              label={result.title}
              rows={result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, shown(v)])))}
              columns={result.columns}
            />
          )}
          {result.totalRows != null && result.totalRows > result.rows.length && (
            <p className="banner warn">
              Recorded {result.rows.length.toLocaleString()} of {result.totalRows.toLocaleString()} evaluated rows. This trace is capped;
              its export contains the same recorded subset.
            </p>
          )}
          {result.columns.some((c) => /cosine/i.test(c)) && (
            <p className="field-hint">
              Cosine is the dot product of normalized vectors. Similarity is not a probability of correctness. A dash means the metric was
              not computed or recorded.
            </p>
          )}
          {result.note && <p className="field-hint">{result.note}</p>}
          {!!result.rows.length && (
            <p className="field-hint">Scores displayed to six decimal places. Export preserves the stored precision.</p>
          )}
          <JsonDetails label="Exact recorded values · JSON" value={result} />
        </section>
      ))}
    </div>
  );
}
