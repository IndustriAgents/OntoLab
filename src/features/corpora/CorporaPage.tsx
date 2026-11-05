import { ConnectGraphDialog } from "../connections/ConnectGraphDialog";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useModelChoice, selectProps } from "../../app/providers";
import { corpusApi, corpusKeys } from "../../lib/corpusApi";
import { InlineError, LoadingState, Modal, PageHead, StatusBadge } from "../../components/ui/ui";
import { ProviderModelSelect } from "../../components/common/ProviderModelSelect";
import "./corpora.css";
export default function CorporaPage() {
  const { pid, project, revisions } = useProject(),
    navigate = useNavigate(),
    qc = useQueryClient(),
    choice = useModelChoice();
  const [search, setSearch] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.has("ontology") || params.has("new")),
    [name, setName] = useState("");
  const [ontology, setOntology] = useState(params.get("ontology") ?? project?.currentRevisionId ?? "");
  const corpora = useQuery({ queryKey: corpusKeys.list(pid), queryFn: () => corpusApi.list(pid) });
  const versions = revisions.filter((r) => r.status === "committed" && r.stats.modules > 0);
  const selected = versions.some((r) => r.id === ontology) ? ontology : (versions[0]?.id ?? "");
  const create = useMutation({
    mutationFn: () =>
      corpusApi.create(pid, { name: name.trim(), ontologyRevisionId: selected, provider: choice.provider, model: choice.model }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: corpusKeys.list(pid) });
      navigate(`/p/${c.id}/graph`);
    },
  });
  const close = () => {
    setCreating(false);
    setParams(
      (p) => {
        p.delete("ontology");
        p.delete("new");
        return p;
      },
      { replace: true },
    );
  };
  return (
    <div className="page corpus-page">
      <div className="page-wide">
        <PageHead
          title="Knowledge graphs"
          actions={
            <>
              <button className="btn ghost" onClick={() => setConnecting(true)}>
                Connect existing graph
              </button>
              <button className="btn" disabled={!versions.length} onClick={() => setCreating(true)}>
                New knowledge graph
              </button>
            </>
          }
        >
          Turn document collections into reviewed knowledge graphs using a saved ontology.
        </PageHead>
        <div className="corpus-intro">
          <div>
            <strong>Choose a knowledge graph</strong>
            <p>Each workspace keeps its documents, extraction updates and saved graph versions together.</p>
            <span>Documents → Extract → Review & validate → Save graph version</span>
          </div>
          <div>
            <strong>Use a saved ontology</strong>
            <p>Several knowledge graphs can use the same ontology version. Ontology-building documents stay in Build & sources.</p>
            <Link to={`/p/${pid}/workflows/tbox`}>Build & sources →</Link>
          </div>
        </div>
        {!versions.length && (
          <div className="banner warn">
            Save an ontology version before extracting knowledge from documents. Connected graphs can be used immediately.{" "}
            <Link to={`/p/${pid}/ontology`}>Open ontology</Link>
          </div>
        )}
        <label className="field graph-library-search">
          <span>Search knowledge graphs</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name…" />
        </label>
        <InlineError error={corpora.error} />
        {corpora.error && (
          <button className="btn ghost" onClick={() => void corpora.refetch()}>
            Retry
          </button>
        )}
        {!!corpora.data?.length && !corpora.data.some((c) => !c.archived && c.name.toLowerCase().includes(search.trim().toLowerCase())) && (
          <p className="muted">No matching knowledge graphs.</p>
        )}
        {corpora.isLoading ? (
          <LoadingState label="Loading knowledge graphs…" />
        ) : (
          <div className="corpus-cards">
            {corpora.data
              ?.filter((c) => !c.archived && c.name.toLowerCase().includes(search.trim().toLowerCase()))
              .map((c) => (
                <Link className="corpus-card" key={c.id} to={`/p/${c.id}/graph`}>
                  <span className="eyebrow">Knowledge graph</span>
                  <h2>{c.name}</h2>
                  <p>
                    {c.settings.externalGraph
                      ? "Connected graph · live data · read only"
                      : `${c.settings.corpus!.members.filter((m) => !m.removed).length} documents`}
                  </p>
                  <span>Open graph workspace →</span>
                </Link>
              ))}
            {!corpora.error && !corpora.data?.length && (
              <div className="corpus-empty">
                <h2>Create your first knowledge graph</h2>
                <p>Add documents for knowledge extraction. Ontology-building documents are never included automatically.</p>
                <button className="btn" disabled={!versions.length} onClick={() => setCreating(true)}>
                  New knowledge graph
                </button>
              </div>
            )}
          </div>
        )}
        {connecting && <ConnectGraphDialog pid={pid} onClose={() => setConnecting(false)} />}
        {creating && (
          <Modal
            title="New knowledge graph"
            onClose={close}
            footer={
              <>
                <button className="btn ghost" onClick={close}>
                  Cancel
                </button>
                <button
                  className="btn"
                  disabled={!name.trim() || !selected || !choice.providerEnabled || create.isPending}
                  onClick={() => create.mutate()}
                >
                  {create.isPending ? "Creating…" : "Create knowledge graph"}
                </button>
              </>
            }
          >
            <div className="corpus-form">
              <label className="field">
                <span>Graph name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Housing research" maxLength={200} />
              </label>
              <label className="field">
                <span>Use ontology</span>
                <select value={selected} onChange={(e) => setOntology(e.target.value)}>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      Ontology version {v.tboxVersion ?? v.number} · {v.summary}
                    </option>
                  ))}
                </select>
              </label>
              <StatusBadge tone="info">Pinned until you choose to upgrade</StatusBadge>
              <details className="method-details" open={!choice.providerEnabled}>
                <summary>Processing settings</summary>
                <div className="method-details-body">
                  <ProviderModelSelect {...selectProps(choice)} structuredOnly />
                  <p>Project defaults are selected automatically. Models and document preparation can be changed in Settings.</p>
                </div>
              </details>
              {!name.trim() && <p className="field-hint">Enter a graph name to continue.</p>}
              {!selected && (
                <p className="field-hint">
                  Save an ontology version first. <Link to={`/p/${pid}/ontology/overview`}>Open ontology →</Link>
                </p>
              )}
              {!choice.providerEnabled && (
                <p className="field-hint">
                  Choose an enabled model. <Link to="/settings#providers">Open model connections →</Link>
                </p>
              )}
              <p>Your graph workspace starts empty. Add documents, extract and review facts, then save your first graph version.</p>
              <InlineError error={create.error} />
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}
