import type { TBoxModel } from "../types/tbox";
import type { ABoxResult, ABoxDataProp, ABoxObjectProp, EvidenceRef, FactOrigin, FactReview } from "../types/abox";
import type { CorpusChangeSummary, LostSourceFact } from "../types/corpus";
import type { RevisionContent } from "../types/project";
import { applyDecisions, factKey, listFacts, type FactRow } from "./ontology/factReview";
import { mergeAboxes, mergeOrigins } from "./ontology/aboxMerge";

export const corpusFactKey = (f: FactRow) => (f.kind === "type" ? `${f.key}|${f.classUri}` : f.key);
type Claim = { origins?: FactOrigin[]; evidence?: EvidenceRef[]; review?: FactReview };
const manual = (types?: string[]): FactOrigin => ({ kind: "manual", ...(types ? { types } : {}) });
function claims(abox: ABoxResult) {
  const out = new Map<string, Claim>();
  for (const i of abox.individuals) {
    out.set(`${i.id}#type|${i.classUri}`, i);
    for (const d of i.dataProperties ?? []) out.set(factKey(i.id, "data", d), d);
    for (const o of i.objectProperties ?? []) out.set(factKey(i.id, "link", o), o);
  }
  return out;
}

export function documentOrigins(abox: ABoxResult, documentId: string, chunkId: string | undefined, runId: string): ABoxResult {
  const stamp = (a: Claim, types?: string[]) => ({
    ...a,
    origins: [{ kind: "document" as const, documentId, ...(chunkId ? { chunkId } : {}), ...(types ? { types } : {}) }],
    ...(a.evidence ? { evidence: a.evidence.map((e) => ({ ...e, runId })) } : {}),
  });
  return {
    ...abox,
    individuals: abox.individuals.map((i) => ({
      ...i,
      ...stamp(i, [i.classUri, ...(i.additionalTypes ?? [])]),
      dataProperties: i.dataProperties?.map((d) => ({ ...d, ...stamp(d) })),
      objectProperties: i.objectProperties?.map((o) => ({ ...o, ...stamp(o) })),
    })),
  };
}

/** Remove only the selected source versions' contributions; manual and independently supported knowledge survives. */
export function withoutSources(abox: ABoxResult, removed: Set<string>): { abox: ABoxResult; losses: LostSourceFact[]; retained: number } {
  const before = structuredClone(abox),
    next = structuredClone(abox),
    oldClaims = claims(before);
  let retained = 0;
  const keep = (c: Claim) => {
    const had = c.origins?.some((o) => o.kind === "document" && removed.has(o.documentId ?? "")) ?? false;
    c.evidence = c.evidence?.filter((e) => !removed.has(e.documentId ?? ""));
    if (!had) return true;
    c.origins = c.origins!.filter((o) => o.kind === "manual" || !removed.has(o.documentId ?? ""));
    c.evidence = c.evidence?.filter((e) => !removed.has(e.documentId ?? ""));
    if (c.origins.length) {
      retained++;
      return true;
    }
    return false;
  };
  next.individuals = next.individuals.filter((i) => {
    const hadRemovedSource = i.origins?.some((o) => o.kind === "document" && removed.has(o.documentId ?? ""));
    let typeKept = keep(i);
    if (hadRemovedSource) i.sourceEvidence = i.evidence?.[0]?.quote;
    i.dataProperties = i.dataProperties?.filter(keep);
    i.objectProperties = i.objectProperties?.filter(keep);
    if (
      !typeKept &&
      [...(i.dataProperties ?? []), ...(i.objectProperties ?? [])].some((p) => p.origins?.some((o) => o.kind === "manual"))
    ) {
      i.origins = [manual([i.classUri, ...(i.additionalTypes ?? [])])];
      typeKept = true;
    }
    if (typeKept && i.origins?.length) {
      const types = [
        ...new Set(
          i.origins.flatMap((o) =>
            o.kind === "manual" ? [i.classUri, ...(i.additionalTypes ?? [])] : (o.types ?? [i.classUri, ...(i.additionalTypes ?? [])]),
          ),
        ),
      ];
      if (types.length) {
        i.classUri = types.includes(i.classUri) ? i.classUri : types[0];
        i.additionalTypes = types.filter((t) => t !== i.classUri);
      }
    }
    return typeKept;
  });
  next.unresolved = next.unresolved?.filter(keep);
  const afterKeys = new Set(listFacts(next).map(corpusFactKey)),
    byId = new Map(before.individuals.map((i) => [i.id, i]));
  const losses = listFacts(before)
    .filter(
      (f) =>
        !afterKeys.has(corpusFactKey(f)) &&
        oldClaims.get(corpusFactKey(f))?.origins?.some((o) => o.kind === "document" && removed.has(o.documentId ?? "")),
    )
    .map((f) => {
      const i = byId.get(f.individualId)!;
      return {
        key: corpusFactKey(f),
        fact: f,
        ...(f.kind === "data"
          ? { data: structuredClone(oldClaims.get(corpusFactKey(f)) as ABoxDataProp) }
          : f.kind === "link"
            ? { link: structuredClone(oldClaims.get(corpusFactKey(f)) as ABoxObjectProp) }
            : {}),
        subject: { id: i.id, classUri: i.classUri, label: i.label, iri: i.iri },
        decision: "pending" as const,
      };
    });
  return { abox: mergeAboxes([next]).abox, losses, retained };
}

/** Apply explicit identity decisions, never same-label guesses. */
export function canonicalizeIncoming(incoming: ABoxResult, base: ABoxResult): ABoxResult {
  const aliases = new Map<string, string>(),
    iris = new Map<string, string>();
  for (const i of base.individuals) {
    for (const id of i.mergedFrom ?? []) aliases.set(id, i.id);
    if (i.iri) iris.set(i.iri, i.id);
  }
  for (const i of incoming.individuals) if (i.iri && iris.has(i.iri)) aliases.set(i.id, iris.get(i.iri)!);
  return {
    ...incoming,
    individuals: incoming.individuals.map((i) => ({
      ...i,
      id: aliases.get(i.id) ?? i.id,
      objectProperties: i.objectProperties?.map((o) => ({ ...o, targetId: aliases.get(o.targetId) ?? o.targetId })),
    })),
    unresolved: incoming.unresolved?.map((o) => ({
      ...o,
      subjectId: aliases.get(o.subjectId) ?? o.subjectId,
      targetId: aliases.get(o.targetId) ?? o.targetId,
    })),
  };
}

/** Keep identities available during replacement without carrying old assertions or evidence into the draft. */
export function corpusIdentityIndex(abox: ABoxResult): ABoxResult {
  return {
    individuals: abox.individuals.map(({ id, classUri, label, iri, mergedFrom, differentFrom, sameAs }) => ({
      id,
      classUri,
      label,
      iri,
      mergedFrom,
      differentFrom,
      sameAs,
    })),
  };
}

/** Exact, previously reviewed claims keep human decisions; new values still need review and keep their own evidence. */
export function preserveCorpusDecisions(incoming: ABoxResult, previous: ABoxResult): ABoxResult {
  const canonical = canonicalizeIncoming(incoming, previous);
  const known = new Map(previous.individuals.map((i) => [i.id, i]));
  const previousClaims = claims(previous);
  const review = (key: string) => {
    const old = previousClaims.get(key)?.review;
    return old?.by === "user" ? old : undefined;
  };
  return {
    ...canonical,
    individuals: canonical.individuals.map((i) => {
      const old = known.get(i.id);
      return {
        ...i,
        ...(old?.iri ? { iri: old.iri } : {}),
        ...(old?.mergedFrom?.length ? { mergedFrom: [...new Set([...old.mergedFrom, ...(i.mergedFrom ?? [])])] } : {}),
        ...(old?.differentFrom?.length ? { differentFrom: [...new Set([...old.differentFrom, ...(i.differentFrom ?? [])])] } : {}),
        ...(old?.sameAs?.length ? { sameAs: [...new Set([...old.sameAs, ...(i.sameAs ?? [])])] } : {}),
        review: review(`${i.id}#type|${i.classUri}`) ?? i.review,
        dataProperties: i.dataProperties?.map((d) => ({ ...d, review: review(factKey(i.id, "data", d)) ?? d.review })),
        objectProperties: i.objectProperties?.map((o) => ({ ...o, review: review(factKey(i.id, "link", o)) ?? o.review })),
      };
    }),
  };
}
export function suppressFacts(abox: ABoxResult, keys: string[]): ABoxResult {
  const blocked = new Set(keys);
  return {
    ...abox,
    individuals: abox.individuals
      .filter((i) => !blocked.has(`${i.id}#type|${i.classUri}`))
      .map((i) => ({
        ...i,
        additionalTypes: i.additionalTypes?.filter((t) => !blocked.has(`${i.id}#type|${t}`)),
        dataProperties: i.dataProperties?.filter((d) => !blocked.has(factKey(i.id, "data", d))),
        objectProperties: i.objectProperties?.filter((o) => !blocked.has(factKey(i.id, "link", o))),
      })),
  };
}

/** Public edits cannot forge corpus identity/source metadata. Preserve review decisions and explicit deletions. */
export function corpusUserEdit(before: RevisionContent, after: RevisionContent, trustedOriginal?: ABoxResult): RevisionContent {
  if (!before.corpus) return after;
  const prev = before.abox ?? { individuals: [] },
    next = structuredClone(after.abox ?? { individuals: [] });
  const canonical = mergeAboxes([canonicalizeIncoming(prev, next)]).abox,
    old = claims(canonical),
    nextKeys = new Set(listFacts(next).map(corpusFactKey)),
    suppressed = new Set(before.corpus.suppressed);
  const currentSources = new Set(before.corpus.sources.map((s) => s.documentId));
  const original = trustedOriginal
    ? mergeAboxes([
        canonicalizeIncoming(
          withoutSources(
            trustedOriginal,
            new Set(
              trustedOriginal.individuals
                .flatMap((i) => [
                  ...(i.origins ?? []),
                  ...(i.dataProperties ?? []).flatMap((p) => p.origins ?? []),
                  ...(i.objectProperties ?? []).flatMap((p) => p.origins ?? []),
                ])
                .filter((o) => o.kind === "document" && !currentSources.has(o.documentId ?? ""))
                .map((o) => o.documentId!),
            ),
          ).abox,
          next,
        ),
      ]).abox
    : undefined;
  const originals = original ? claims(original) : new Map<string, Claim>();
  const proof = (c: Claim) =>
    JSON.stringify([
      (c.origins ?? [])
        .filter((o) => o.kind === "document")
        .map((o) => JSON.stringify([o.documentId, o.chunkId, [...(o.types ?? [])].sort()]))
        .sort(),
      (c.evidence ?? []).map((e) => JSON.stringify([e.documentId, e.chunkId, e.quote, e.start, e.end, e.status])).sort(),
    ]);
  const pick = (key: string, input: Claim) => {
    const prior = old.get(key),
      baseline = originals.get(key);
    const manualProof = (c: Claim) =>
      JSON.stringify(
        (c.origins ?? [])
          .filter((o) => o.kind === "manual")
          .map((o) => JSON.stringify([...(o.types ?? [])].sort()))
          .sort(),
      );
    if (prior && proof(prior) === proof(input) && manualProof(prior) === manualProof(input)) return { claim: prior, recovered: false };
    if (
      baseline &&
      baseline.origins?.some((o) => o.kind === "document") &&
      baseline.origins.every((o) => o.kind === "manual" || currentSources.has(o.documentId ?? "")) &&
      proof(input) === proof(baseline)
    ) {
      suppressed.delete(key);
      return {
        claim: {
          ...baseline,
          origins: mergeOrigins(
            baseline.origins,
            input.origins?.filter((o) => o.kind === "manual"),
          ),
        },
        recovered: true,
      };
    }
    return { claim: prior, recovered: false };
  };
  for (const i of next.individuals) for (const type of i.additionalTypes ?? []) nextKeys.add(`${i.id}#type|${type}`);
  for (const key of nextKeys) suppressed.delete(key);
  for (const i of canonical.individuals)
    for (const type of i.additionalTypes ?? [])
      if (!nextKeys.has(`${i.id}#type|${type}`) && i.origins?.some((o) => o.kind === "document" && (!o.types || o.types.includes(type))))
        suppressed.add(`${i.id}#type|${type}`);
  for (const f of listFacts(canonical))
    if (!nextKeys.has(corpusFactKey(f)) && old.get(corpusFactKey(f))?.origins?.some((o) => o.kind === "document"))
      suppressed.add(corpusFactKey(f));
  for (const i of next.individuals) {
    const oldInd = prev.individuals.find((n) => n.id === i.id),
      key = `${i.id}#type|${i.classUri}`,
      picked = pick(key, i),
      p = picked.claim;
    i.origins = p?.origins ?? [manual([i.classUri, ...(i.additionalTypes ?? [])])];
    i.evidence = p?.evidence;
    if (picked.recovered) i.sourceEvidence = (p as typeof i).sourceEvidence ?? p?.evidence?.[0]?.quote;
    else if (!p) i.sourceEvidence = undefined;
    const originalInd = original?.individuals.find((n) => n.id === i.id),
      comparison = picked.recovered ? originalInd : oldInd;
    let changed =
      !comparison ||
      comparison.label !== i.label ||
      comparison.iri !== i.iri ||
      JSON.stringify([...(comparison.additionalTypes ?? [])].sort()) !== JSON.stringify([...(i.additionalTypes ?? [])].sort());
    for (const [kind, props] of [
      ["data", i.dataProperties],
      ["link", i.objectProperties],
    ] as const)
      for (const prop of props ?? []) {
        const { claim: source } = pick(factKey(i.id, kind, prop), prop);
        prop.origins = source?.origins ?? [manual()];
        prop.evidence = source?.evidence;
        if (!source) changed = true;
      }
    if (changed) i.origins = mergeOrigins(i.origins, [manual([i.classUri, ...(i.additionalTypes ?? [])])]);
  }
  const originalLinks = new Map(original?.unresolved?.map((l) => [l.id, l]));
  next.unresolved = structuredClone(before.abox?.unresolved ?? []).map((l) => {
    const proposed = after.abox?.unresolved?.find((p) => p.id === l.id),
      baseline = originalLinks.get(l.id);
    return proposed &&
      baseline &&
      proposed.status === l.status &&
      proposed.subjectId === baseline.subjectId &&
      proposed.targetId === baseline.targetId &&
      proposed.propUri === baseline.propUri &&
      proof(proposed) === proof(baseline)
      ? { ...baseline, status: l.status }
      : l;
  });
  return { ...after, abox: mergeAboxes([next]).abox, corpus: { ...before.corpus, suppressed: [...suppressed] } };
}

export function retainLostFact(content: RevisionContent, loss: LostSourceFact): RevisionContent {
  const abox = structuredClone(content.abox ?? { individuals: [] });
  const retainedTypes = new Set([loss.subject.id]);
  let i = abox.individuals.find((n) => n.id === loss.subject.id);
  if (!i) {
    i = { ...loss.subject, origins: [manual([loss.subject.classUri])], review: { by: "user", status: "accepted" } };
    abox.individuals.push(i);
  }
  i.origins = mergeOrigins(i.origins, [manual([i.classUri])]);
  const f = loss.fact,
    review = { by: "user" as const, status: "accepted" as const, reason: "Retained as manual knowledge after source removal" };
  if (f.kind === "data")
    (i.dataProperties ??= []).push({
      ...loss.data,
      propUri: f.propUri!,
      value: f.value!,
      evidence: undefined,
      origins: [manual()],
      review,
    });
  if (f.kind === "link") {
    if (!abox.individuals.some((n) => n.id === f.targetId)) {
      const target = content.corpus?.losses.find((l) => l.fact.kind === "type" && l.subject.id === f.targetId)?.subject;
      if (target) {
        abox.individuals.push({ ...target, origins: [manual([target.classUri])], review });
        retainedTypes.add(target.id);
      }
    }
    (i.objectProperties ??= []).push({
      ...loss.link,
      propUri: f.propUri!,
      targetId: f.targetId!,
      evidence: undefined,
      origins: [manual()],
      review,
    });
  }
  const state = content.corpus!;
  return {
    ...content,
    abox: mergeAboxes([abox]).abox,
    corpus: {
      ...state,
      losses: state.losses.map((l) =>
        l.key === loss.key || (l.fact.kind === "type" && retainedTypes.has(l.subject.id)) ? { ...l, decision: "manual" } : l,
      ),
    },
  };
}
const supportIds = (f: FactRow, claim: Claim | undefined) =>
  new Set([
    ...f.evidence.map((e) => JSON.stringify(["evidence", e.documentId, e.chunkId, e.start, e.quote])),
    ...(claim?.origins ?? []).map((o) => JSON.stringify(["origin", o.kind, o.documentId, o.chunkId])),
  ]);
export function corpusChanges(before: ABoxResult, after: ABoxResult): CorpusChangeSummary {
  const a = new Map(listFacts(before).map((f) => [corpusFactKey(f), f])),
    b = new Map(listFacts(after).map((f) => [corpusFactKey(f), f]));
  const ids = new Set(before.individuals.map((i) => i.id)),
    newIds = new Set(after.individuals.map((i) => i.id)),
    enriched: FactRow[] = [],
    reduced: FactRow[] = [],
    reviewed: FactRow[] = [],
    changed = new Set<string>(),
    oldClaims = claims(before),
    newClaims = claims(after);
  for (const [key, f] of b) {
    const old = a.get(key);
    if (old) {
      const prev = supportIds(old, oldClaims.get(key)),
        next = supportIds(f, newClaims.get(key));
      const gained = [...next].some((k) => !prev.has(k)),
        lost = [...prev].some((k) => !next.has(k)),
        decided = old.status !== f.status;
      if (gained) enriched.push(f);
      if (lost) reduced.push(f);
      if (decided) reviewed.push(f);
      if (gained || lost || decided) changed.add(key);
    }
  }
  const conflicts: string[] = [];
  const added = [...b].filter(([k]) => !a.has(k)).map(([, f]) => f);
  const removed = [...a].filter(([k]) => !b.has(k)).map(([, f]) => f);
  const slot = (f: FactRow) => `${f.individualId}|${f.kind}|${f.propUri ?? ""}`;
  const grouped = (facts: FactRow[]) => {
    const groups = new Map<string, FactRow[]>();
    for (const f of facts) groups.set(slot(f), [...(groups.get(slot(f)) ?? []), f]);
    return groups;
  };
  const addedBySlot = grouped(added),
    removedBySlot = grouped(removed);
  const updated = removed
    .filter((f) => f.kind !== "type")
    .flatMap((old) => {
      const replacements = addedBySlot.get(slot(old)) ?? [];
      return replacements.length === 1 && removedBySlot.get(slot(old))?.length === 1 ? [{ before: old, after: replacements[0] }] : [];
    });
  return {
    updated,
    addedEntities: [...newIds].filter((id) => !ids.has(id)),
    removedEntities: [...ids].filter((id) => !newIds.has(id)),
    added,
    removed,
    enriched,
    reduced,
    reviewed,
    unchanged: [...b.keys()].filter((k) => a.has(k) && !changed.has(k)).length,
    conflicts,
    candidates: [...b.values()].filter((f) => f.status === "candidate").length,
  };
}

/** One explicit decision accepts a replacement, or retains the previous value as manual knowledge. */
export function decideCorpusReplacement(
  content: RevisionContent,
  beforeKey: string,
  afterKey: string,
  decision: "proposed" | "previous",
  at: string,
): RevisionContent | null {
  const loss = content.corpus?.losses.find((l) => l.key === beforeKey);
  const facts = content.abox ? listFacts(content.abox) : [];
  const next = facts.find((f) => corpusFactKey(f) === afterKey);
  if (
    beforeKey === afterKey ||
    !loss ||
    loss.decision !== "pending" ||
    facts.some((f) => corpusFactKey(f) === beforeKey) ||
    !next ||
    next.kind === "type" ||
    next.kind !== loss.fact.kind ||
    next.individualId !== loss.fact.individualId ||
    next.propUri !== loss.fact.propUri
  )
    return null;
  let result: RevisionContent = {
    ...content,
    abox: applyDecisions(content.abox!, [{ key: next.key, status: decision === "proposed" ? "accepted" : "rejected" }], at).abox,
  };
  if (decision === "previous") result = retainLostFact(result, loss);
  else
    result.corpus = {
      ...result.corpus!,
      losses: result.corpus!.losses.map((l) => (l.key === beforeKey ? { ...l, decision: "remove" } : l)),
    };
  return result;
}

/** Match the RDF serializer's implicit datatype without guessing entity identity or numeric equivalence. */
export function normalizeCorpusLiterals(abox: ABoxResult, tbox: TBoxModel): ABoxResult {
  const ranges = new Map(tbox.dataProps.map((p) => [p.uri, p.range[0] ?? "http://www.w3.org/2001/XMLSchema#string"]));
  return {
    ...abox,
    individuals: abox.individuals.map((i) => ({
      ...i,
      dataProperties: i.dataProperties?.map((p) => ({
        ...p,
        datatype:
          p.datatype ??
          (p.lang
            ? "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString"
            : (ranges.get(p.propUri) ?? "http://www.w3.org/2001/XMLSchema#string")),
        ...(p.lang ? { lang: p.lang.toLowerCase() } : {}),
      })),
    })),
  };
}
export function respectCorpusEdits(incoming: ABoxResult, base: ABoxResult, suppressed: string[]): ABoxResult {
  const blocks = new Set(suppressed),
    known = new Map(base.individuals.map((i) => [i.id, i]));
  const canonical = canonicalizeIncoming(incoming, base);
  const corrected = {
    ...canonical,
    individuals: canonical.individuals.map((i) => {
      const old = known.get(i.id);
      return blocks.has(`${i.id}#type|${i.classUri}`) && old
        ? {
            ...i,
            classUri: old.classUri,
            additionalTypes: old.additionalTypes,
            evidence: old.evidence,
            sourceEvidence: old.sourceEvidence,
            origins: old.origins,
            review: old.review,
          }
        : i;
    }),
  };
  return suppressFacts(corrected, suppressed);
}
