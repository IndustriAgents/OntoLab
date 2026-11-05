// Explore: the selected revision as a graph and as an editable table, with a
// shared selection, filters (class, text, evidence, duplicates), neighbourhood
// focus, the merge review of duplicate candidates, and an inspector showing
// every claim with its source and entailment score.
//
// The graph is a projection of the ontology data. It renders at most
// `maxGraphNodes` nodes and always says how many of how many are shown.

import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useProject } from "../../app/project";
import { useAuth } from "../../app/auth";
import { useTheme } from "../../app/theme";
import type { ABoxIndividual, ABoxResult } from "../../types/abox";
import { validateABox } from "../../lib/ontology/aboxValidator";
import { findPossibleDuplicates, carryEvidence } from "../../lib/ontology/aboxMerge";
import { serializeABox } from "../../lib/ontology/aboxSerializer";
import { parseABoxTurtle } from "../../lib/ontology/aboxFromTurtle";
import { localName } from "../../lib/ontology/iri";
import { effectiveAbox, listFacts } from "../../lib/ontology/factReview";
import { stampManual } from "../../lib/ontology/editProvenance";
import { AboxEditor } from "../../components/review/AboxEditor";
import { EmptyState, Inspector, LoadingState } from "../../components/ui/ui";
import { IconSearch } from "../../components/icons";
import { RevisionBar } from "../revisions/RevisionBar";
import { useEvidenceViewer } from "../evidence/useEvidence";
import { IndividualInspector } from "./IndividualInspector";
import { MergePanel } from "./MergePanel";
import { ReviewQueue } from "./ReviewQueue";
import { ChangeCheckPanel } from "./ChangeCheckPanel";
import { ImportAboxButton } from "./ImportAbox";
import { ForceGraph, type GraphEdge, type GraphNode } from "./ForceGraph";
import { matchesEvidence, type EvidenceFilter } from "./evidenceUtil";
import "./graph-workspace.css";

type View = "graph" | "table" | "turtle";

function neighbourhood(abox: ABoxResult, focus: string, hops: number): Set<string> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const i of abox.individuals) {
    for (const o of i.objectProperties ?? []) {
      link(i.id, o.targetId);
      link(o.targetId, i.id);
    }
  }
  const seen = new Set([focus]);
  let frontier = [focus];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return seen;
}

function TurtleView({ abox, onApply }: { abox: ABoxResult; onApply: (next: ABoxResult) => void }) {
  const { working } = useProject();
  const turtle = useMemo(
    () => (working.tbox ? serializeABox(abox, working.tbox, working.baseIri).turtle : ""),
    [abox, working.tbox, working.baseIri],
  );
  const [text, setText] = useState(turtle);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!dirty) setText(turtle);
    // only follow upstream changes while the user is not editing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turtle]);
  return (
    <div className="turtle-view">
      <p className="field-hint">
        Edit the A-Box as Turtle. Applying keeps the located evidence of individuals and claims that are unchanged.
      </p>
      <textarea
        className="ttl-editor"
        aria-label="A-Box Turtle"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
      />
      {err && (
        <div className="dz-error" role="alert">
          {err}
        </div>
      )}
      <div className="row-actions">
        <button className="btn ghost" disabled={!dirty} onClick={() => (setText(turtle), setDirty(false), setErr(null))}>
          Revert
        </button>
        <button
          className="btn"
          disabled={!dirty}
          onClick={() => {
            try {
              const next = parseABoxTurtle(text);
              if (!next.individuals.length) throw new Error("No individuals found in the Turtle.");
              onApply(carryEvidence(abox, next));
              setDirty(false);
              setErr(null);
            } catch (e) {
              setErr(e instanceof Error ? e.message : "Could not parse Turtle");
            }
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

export default function ExplorePage() {
  const { pid, project, working, current, revisions } = useProject();
  const { config } = useAuth();
  const { theme } = useTheme();
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as View) || "graph";
  const selectedId = params.get("sel");
  const setParam = (k: string, v: string | null) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  const select = (id: string | null) => setParam("sel", id);

  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [evidence, setEvidence] = useState<EvidenceFilter>("all");
  const [dupOnly, setDupOnly] = useState(false);
  const [focus, setFocus] = useState<{ id: string; hops: number } | null>(null);
  const [showMerges, setShowMerges] = useState(false);
  const [includeProposals, setIncludeProposals] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const evidenceViewer = useEvidenceViewer(pid);
  const maxNodes = config?.limits.maxGraphNodes ?? 500;

  const abox = useMemo<ABoxResult>(() => working.content?.abox ?? { individuals: [] }, [working.content]);
  const factCounts = useMemo(() => {
    const counts = { candidate: 0, accepted: 0, rejected: 0 };
    for (const fact of listFacts(abox)) counts[fact.status]++;
    return counts;
  }, [abox]);
  const publishedOnly = !!working.content?.corpus && !working.isDraft && !includeProposals && view === "graph";
  const displayed = useMemo(() => (publishedOnly ? effectiveAbox(abox, "accepted-only") : abox), [abox, publishedOnly]);
  const tbox = working.tbox;
  const issues = useMemo(() => (tbox ? validateABox(abox, tbox, working.baseIri) : []), [abox, tbox, working.baseIri]);
  const dupGroups = useMemo(() => findPossibleDuplicates(abox), [abox]);
  const candidates = useMemo(
    () => (working.content?.resolution?.candidates ?? []).filter((c) => c.decision !== "distinct"),
    [working.content],
  );
  const dupOf = useMemo(() => {
    const m = new Map<string, string[]>();
    const add = (ids: string[]) => {
      for (const id of ids) m.set(id, [...new Set([...(m.get(id) ?? []), ...ids.filter((x) => x !== id)])]);
    };
    for (const g of dupGroups) add(g.ids);
    for (const c of candidates) add(c.ids);
    return m;
  }, [dupGroups, candidates]);
  const dupCount = dupGroups.length + candidates.length;

  // Links per individual across the whole revision (dot size, "N links").
  const degree = useMemo(() => {
    const deg = new Map<string, number>();
    for (const i of displayed.individuals) {
      for (const o of i.objectProperties ?? []) {
        deg.set(i.id, (deg.get(i.id) ?? 0) + 1);
        deg.set(o.targetId, (deg.get(o.targetId) ?? 0) + 1);
      }
    }
    return deg;
  }, [displayed]);
  const allNodes = useMemo<GraphNode[]>(
    () =>
      displayed.individuals.map((i) => ({
        id: i.id,
        type: localName(i.classUri) || "Thing",
        label: i.label || i.id,
        degree: degree.get(i.id) ?? 0,
      })),
    [displayed, degree],
  );

  // Every filter but the hidden classes: the graph still lists those as chips.
  const matching = useMemo(() => {
    const q = search.trim().toLowerCase();
    const near = focus ? neighbourhood(displayed, focus.id, focus.hops) : null;
    return displayed.individuals.filter(
      (i) =>
        (!near || near.has(i.id)) &&
        (!q || i.id.toLowerCase().includes(q) || (i.label ?? "").toLowerCase().includes(q)) &&
        matchesEvidence(i, evidence) &&
        (!dupOnly || dupOf.has(i.id)),
    );
  }, [displayed, search, evidence, dupOnly, dupOf, focus]);
  const filtered = useMemo(
    () => (hidden.size ? matching.filter((i) => !hidden.has(localName(i.classUri) || "Thing")) : matching),
    [matching, hidden],
  );

  // Cap what the canvas draws; keep the best-connected (and the selection).
  const keep = matching.length > maxNodes ? selectedId : null;
  const graph = useMemo(() => {
    let list = matching;
    if (list.length > maxNodes) {
      list = [...list]
        .sort((a, b) => (b.id === keep ? 1 : 0) - (a.id === keep ? 1 : 0) || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
        .slice(0, maxNodes);
    }
    const ids = new Set(list.map((i) => i.id));
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const nodes = list.map((i) => byId.get(i.id)!);
    const edges: GraphEdge[] = list.flatMap((i) =>
      (i.objectProperties ?? [])
        .filter((o) => ids.has(o.targetId))
        .map((o) => ({ from: i.id, to: o.targetId, name: localName(o.propUri) })),
    );
    return { nodes, edges };
  }, [matching, maxNodes, keep, degree, allNodes]);

  const selected = abox.individuals.find((i) => i.id === selectedId) ?? null;
  const filtersActive = !!(search || hidden.size || evidence !== "all" || dupOnly || focus);
  const inspectorOpen = !!selected && (view !== "graph" || detailOpen);
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const restrict = useMemo(() => (filtersActive ? new Set(filtered.map((i) => i.id)) : null), [filtersActive, filtered]);

  if (!revisions.length || !current) {
    return (
      <div className="page">
        <EmptyState
          title="Nothing to explore yet"
          action={
            <Link className="btn" to={`/p/${pid}/ontology`}>
              Set up the ontology
            </Link>
          }
        >
          Commit an ontology revision, then run an extraction to populate it.
        </EmptyState>
      </div>
    );
  }
  if (!working.content || !tbox) return <LoadingState label="Loading revision…" />;

  // Manual edits carry provenance: changed facts are marked as entered by this person, and logged on the draft.
  const editor = "Local user";
  const manualAbox = (next: ABoxResult, label = "Edit") =>
    working.setContent(stampManual(working.content!, next, { at: new Date().toISOString(), by: editor, label }), label);
  const patchIndividual = (next: ABoxIndividual, label: string) =>
    manualAbox({ individuals: abox.individuals.map((i) => (i.id === next.id ? next : i)) }, label);

  return (
    <div className="explore graph-workspace">
      <header className="explore-head">
        <div>
          <span className="graph-workspace-name">{project?.name}</span>
          <h1>Graph</h1>
          <p>
            {working.content.corpus
              ? publishedOnly
                ? "Published graph · accepted facts only."
                : "Revision inspection · includes proposals and review decisions."
              : "The individuals in this revision and how they connect."}
          </p>
          {working.content.corpus?.ontology && (
            <Link
              className="graph-ontology-link"
              to={`/p/${working.content.corpus.ontology.projectId}/ontology?tab=review&rev=${working.content.corpus.ontology.revisionId}`}
            >
              Ontology v{working.content.corpus.ontology.number} · pinned ↗
            </Link>
          )}
        </div>
        <div className="explore-head-actions">
          <ImportAboxButton abox={abox} tbox={tbox} onImport={manualAbox} />
          <div className="segmented" role="tablist" aria-label="View">
            {(["graph", "table", "turtle"] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                className={view === v ? "on" : ""}
                onClick={() => setParam("view", v === "graph" ? null : v)}
              >
                {v === "graph" ? "Graph" : v === "table" ? "Table" : "Turtle"}
              </button>
            ))}
          </div>
        </div>
      </header>
      <RevisionBar editable />
      <div className="graph-review-summary" aria-label="Graph review">
        <div>
          <strong>{abox.individuals.length.toLocaleString()}</strong>
          <span>entities</span>
          <span className="graph-summary-separator">·</span>
          <strong>{factCounts.accepted.toLocaleString()}</strong>
          <span>{factCounts.accepted === 1 ? "accepted fact" : "accepted facts"}</span>
        </div>
        <div>
          {(factCounts.candidate > 0 || factCounts.rejected > 0) && (
            <button
              className="btn ghost sm"
              aria-expanded={showReview}
              aria-controls="graph-fact-review"
              onClick={() => {
                setShowReview((value) => !value);
                setShowMerges(false);
              }}
            >
              Review facts <span className="graph-review-count">{factCounts.candidate.toLocaleString()}</span>
            </button>
          )}
          {candidates.length > 0 && (
            <button
              className="btn ghost sm"
              aria-expanded={showMerges}
              aria-controls="graph-duplicate-review"
              onClick={() => {
                setShowMerges((value) => !value);
                setShowReview(false);
              }}
            >
              Review duplicates <span className="graph-review-count">{candidates.length.toLocaleString()}</span>
            </button>
          )}
        </div>
      </div>
      <div className="explore-toolbar" role="toolbar" aria-label="Filters">
        {!!working.content.corpus && !working.isDraft && view === "graph" && (
          <label className="check">
            <input type="checkbox" checked={includeProposals} onChange={(e) => setIncludeProposals(e.target.checked)} /> Include proposals
            for review
          </label>
        )}
        {view !== "graph" && (
          <label className="search">
            <IconSearch />
            <span className="sr-only">Search individuals</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search label or id" />
          </label>
        )}
        <label className="compact-field">
          <span>Evidence</span>
          <select value={evidence} onChange={(e) => setEvidence(e.target.value as EvidenceFilter)}>
            <option value="all">All</option>
            <option value="verified">Verified only</option>
            <option value="needs-review">Needs review</option>
            <option value="none">No evidence</option>
          </select>
        </label>
        {dupCount > 0 && (
          <label className="check">
            <input type="checkbox" checked={dupOnly} onChange={(e) => setDupOnly(e.target.checked)} /> Possible duplicates ({dupCount})
          </label>
        )}
        {filtersActive && (
          <button
            className="btn ghost sm"
            onClick={() => (setSearch(""), setHidden(new Set()), setEvidence("all"), setDupOnly(false), setFocus(null))}
          >
            Clear filters
          </button>
        )}
        <span className="spacer" />
        <span className="muted counts" aria-live="polite">
          {view === "graph"
            ? `${graph.nodes.length} of ${abox.individuals.length} in the graph`
            : `${filtered.length} of ${abox.individuals.length}`}
          {errorCount > 0 && (
            <>
              {" · "}
              <Link to={`/p/${pid}/validate${params.get("rev") ? `?rev=${params.get("rev")}` : ""}`}>{errorCount} errors</Link>
            </>
          )}
        </span>
      </div>

      {working.content.migration && (working.content.migration.renamed.length > 0 || working.content.migration.flagged.length > 0) && (
        <div className="banner subtle" role="status">
          The ontology changed under these individuals:{" "}
          {working.content.migration.renamed.map((r) => `${localName(r.from)} → ${localName(r.to)} (${r.individuals})`).join(", ") ||
            "no renames"}
          {working.content.migration.flagged.length > 0 && (
            <>
              {" · "}
              {working.content.migration.flagged.length} individual{working.content.migration.flagged.length === 1 ? " uses" : "s use"} a
              removed term:{" "}
              {working.content.migration.flagged.slice(0, 5).map((f) => (
                <button key={`${f.id}-${f.term}`} className="cite" onClick={() => select(f.id)}>
                  {f.id}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {showMerges && candidates.length > 0 && (
        <div className="graph-review-panel" id="graph-duplicate-review">
          <button className="btn ghost sm graph-review-close" onClick={() => setShowMerges(false)}>
            Close duplicate review ×
          </button>
          <MergePanel content={working.content} onChange={(next, label) => working.setContent(next, label)} onSelect={select} />
        </div>
      )}
      <ChangeCheckPanel tbox={tbox} abox={abox} onSelect={select} />
      {showReview && (
        <div className="graph-review-panel" id="graph-fact-review">
          <button className="btn ghost sm graph-review-close" onClick={() => setShowReview(false)}>
            Close fact review ×
          </button>
          <ReviewQueue
            content={working.content}
            onChange={(next, label) => working.setContent(next, label)}
            onSelect={select}
            onInspect={(key) => void evidenceViewer.openFact(key)}
          />
        </div>
      )}

      <div className="explore-body">
        <div className="explore-main">
          {abox.individuals.length === 0 && view !== "table" ? (
            <EmptyState
              title="No individuals in this revision"
              action={
                <>
                  <ImportAboxButton abox={abox} tbox={tbox} onImport={manualAbox} />{" "}
                  <Link className="btn ghost" to={`/p/${pid}/runs`}>
                    Run an extraction
                  </Link>
                </>
              }
            >
              Import an existing A-Box file, extract individuals from your documents, or add them by hand in the Table view.
            </EmptyState>
          ) : view === "graph" && publishedOnly && !displayed.individuals.length ? (
            <EmptyState
              title="No accepted entities to show yet"
              action={
                <>
                  <button className="btn" onClick={() => setIncludeProposals(true)}>
                    Explore proposals
                  </button>
                  <button
                    className="btn ghost"
                    onClick={() => {
                      setShowReview(true);
                      setShowMerges(false);
                    }}
                  >
                    Review facts
                  </button>
                </>
              }
            >
              This version contains {abox.individuals.length.toLocaleString()} entities. Review and save their proposed facts to include
              them in the published graph, or explore the proposals first.
            </EmptyState>
          ) : view === "graph" ? (
            <ForceGraph
              compactLegend
              nodes={graph.nodes}
              edges={graph.edges}
              all={allNodes}
              total={matching.length}
              theme={theme}
              hidden={hidden}
              onToggleType={(t) => setHidden((h) => (h.has(t) ? new Set([...h].filter((x) => x !== t)) : new Set([...h, t])))}
              selectedId={selectedId}
              onSelect={(id) => {
                select(id);
                if (!id) setDetailOpen(false);
              }}
              onOpen={(id) => (select(id), setDetailOpen(true))}
              showPanel={!inspectorOpen}
              focus={focus ? { ...focus, label: abox.individuals.find((i) => i.id === focus.id)?.label || focus.id } : null}
              onFocus={(id) => setFocus(id ? { id, hops: 2 } : null)}
              onFocusHops={(hops) => setFocus((f) => (f ? { ...f, hops } : f))}
            />
          ) : view === "table" ? (
            <div className="explore-scroll">
              {filtersActive && (
                <p className="field-hint">
                  Filters apply here too — {filtered.length} of {abox.individuals.length} rows shown.
                </p>
              )}
              <AboxEditor
                abox={abox}
                tbox={tbox}
                issues={issues}
                selectedId={selectedId}
                onSelect={select}
                onChange={manualAbox}
                restrictTo={restrict}
              />
            </div>
          ) : (
            <div className="explore-scroll">
              <TurtleView abox={abox} onApply={(next) => manualAbox(next, "Turtle edit")} />
            </div>
          )}
        </div>

        <Inspector
          title={selected?.label || selected?.id || "Details"}
          open={inspectorOpen}
          onClose={() => (view === "graph" ? setDetailOpen(false) : select(null))}
        >
          {selected && inspectorOpen && (
            <IndividualInspector
              ind={selected}
              abox={abox}
              tbox={tbox}
              issues={issues.filter((i) => i.id === selected.id)}
              duplicates={dupOf.get(selected.id) ?? []}
              docNames={evidenceViewer.names}
              onSelect={select}
              onFocus={(id) => (setFocus({ id, hops: 1 }), setParam("view", null))}
              onOpenEvidence={(ev, key) => void evidenceViewer.openFact(key, ev)}
              onInspectFact={(key) => void evidenceViewer.openFact(key)}
              onChange={patchIndividual}
            />
          )}
        </Inspector>
      </div>
      {evidenceViewer.element}
    </div>
  );
}
