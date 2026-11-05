// Import an existing A-Box file (Turtle, RDF/XML, JSON-LD, N-Triples …) into
// the working copy. The import is an ordinary manual edit: it lands in a
// draft, is checked against the ontology by the change check, and is
// committed through the same validation gate.

import { useRef, useState } from "react";
import { api } from "../../lib/projectApi";
import { parseABoxTurtle } from "../../lib/ontology/aboxFromTurtle";
import { mergeAboxes } from "../../lib/ontology/aboxMerge";
import { localName } from "../../lib/ontology/iri";
import { Modal, StatusBadge } from "../../components/ui/ui";
import { IconUpload } from "../../components/icons";
import type { ABoxResult } from "../../types/abox";
import type { TBoxModel } from "../../types/tbox";

const ACCEPT = ".ttl,.n3,.nt,.nq,.trig,.rdf,.owl,.xml,.jsonld,.json";
const TURTLE_RE = /\.(ttl|n3|nt)$/i;

/** Read an RDF file as A-Box: Turtle family directly, anything else via the server's converter. */
async function readAbox(file: File): Promise<ABoxResult> {
  const text = await file.text();
  if (TURTLE_RE.test(file.name) || !/^\s*(<\?xml|<rdf:RDF|<Ontology|\{|\[)/.test(text)) {
    try {
      return parseABoxTurtle(text);
    } catch (e) {
      if (TURTLE_RE.test(file.name)) throw e;
    }
  }
  const { turtle } = await api.convertRdf(file.name, text);
  return parseABoxTurtle(turtle);
}

interface Props {
  abox: ABoxResult;
  tbox: TBoxModel;
  onImport: (next: ABoxResult, label: string) => void;
}

export function ImportAboxButton(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}>
        <IconUpload /> Import A-Box
      </button>
      {open && <ImportAboxDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function ImportAboxDialog({ abox, tbox, onImport, onClose }: Props & { onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ABoxResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"merge" | "replace">(abox.individuals.length ? "merge" : "replace");

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setParsed(null);
    setError(null);
    setBusy(true);
    try {
      const next = await readAbox(f);
      if (!next.individuals.length) throw new Error("No individuals found in this file. It may contain only ontology terms (classes and properties).");
      setParsed(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read this file as RDF.");
    } finally {
      setBusy(false);
    }
  };

  // What the import looks like against the ontology, before anything changes.
  const known = new Set(tbox.classes.map((c) => c.uri));
  const untyped = parsed?.individuals.filter((i) => !i.classUri).length ?? 0;
  const unknownClasses = [...new Set((parsed?.individuals ?? []).map((i) => i.classUri).filter((c) => c && !known.has(c)))];
  const existing = new Set(abox.individuals.map((i) => i.id));
  const overlapping = parsed?.individuals.filter((i) => existing.has(i.id)).length ?? 0;

  const apply = () => {
    if (!parsed || !file) return;
    // mergeAboxes mutates what it merges into: work on copies
    const next = mode === "replace" ? parsed : mergeAboxes([structuredClone(abox), structuredClone(parsed)]).abox;
    onImport(next, `Imported ${file.name}`);
    onClose();
  };

  return (
    <Modal
      title="Import A-Box"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!parsed || busy} onClick={apply}>
            Import into draft
          </button>
        </>
      }
    >
      <p>
        Load individuals and their facts from an RDF file (Turtle, RDF/XML, OWL, JSON-LD, N-Triples). They are checked against this project's ontology and go into a draft; nothing is committed until you
        validate and commit.
      </p>
      <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => void pick(e.target.files?.[0])} />
      <button className="btn ghost" onClick={() => input.current?.click()} disabled={busy}>
        <IconUpload /> {file ? `Change file (${file.name})` : "Choose file…"}
      </button>
      {busy && <p className="muted small">Reading {file?.name}…</p>}
      {error && (
        <div className="dz-error" role="alert">
          {error}
        </div>
      )}
      {parsed && (
        <>
          <ul className="diff-summary">
            <li>
              <b>{parsed.individuals.length}</b> individuals, <b>{parsed.individuals.reduce((n, i) => n + (i.dataProperties?.length ?? 0) + (i.objectProperties?.length ?? 0), 0)}</b> facts
            </li>
            {unknownClasses.length > 0 && (
              <li>
                <StatusBadge tone="alert">
                  {unknownClasses.length} class{unknownClasses.length === 1 ? "" : "es"} not in the ontology
                </StatusBadge> {unknownClasses.slice(0, 5).map(localName).join(", ")}
                {unknownClasses.length > 5 ? ", …" : ""}
              </li>
            )}
            {untyped > 0 && (
              <li>
                <StatusBadge tone="alert">{untyped} without rdf:type</StatusBadge> they need a class before the draft can be committed
              </li>
            )}
            {!unknownClasses.length && !untyped && (
              <li>
                <StatusBadge tone="ok">Every individual uses a class from the ontology</StatusBadge>
              </li>
            )}
          </ul>
          {abox.individuals.length > 0 && (
            <fieldset className="import-mode">
              <legend>The revision already has {abox.individuals.length} individuals</legend>
              <label className="check">
                <input type="radio" name="mode" checked={mode === "merge"} onChange={() => setMode("merge")} /> Add to them
                {overlapping > 0 && <span className="muted small"> — {overlapping} with the same id are merged</span>}
              </label>
              <label className="check">
                <input type="radio" name="mode" checked={mode === "replace"} onChange={() => setMode("replace")} /> Replace them
              </label>
            </fieldset>
          )}
        </>
      )}
    </Modal>
  );
}
