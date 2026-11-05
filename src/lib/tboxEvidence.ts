import type { CompetencyQuestion, DocumentChunk, RunStep, TermEvidence, RevisionWithContent } from "../types/project";
import type { RunResearch } from "../types/research";
import { parseTBox, mergeTBox } from "./ontology/tboxParser";
import { localName } from "./ontology/iri";
import { locateQuote } from "./sourceQuote";
import { toTermLocalName } from "./ontology/tboxSerializer";

export type EvidenceKind = "class" | "object" | "data";
export interface RecordedPassage {
  text: string;
  chunkId: string;
  documentId: string;
  start: number;
  name: string;
}
export interface EvidenceCall {
  id: string;
  step: RunStep;
  topicId: string;
  completed: boolean;
  passages?: RecordedPassage[];
  termIds: string[];
  scores: Map<string, number>;
}
export interface Citation {
  quote: string;
  located: boolean;
  documentId?: string;
  chunkId?: string;
  start?: number;
  end?: number;
  callId: string;
}
export interface EvidenceTerm {
  id: string;
  name: string;
  label: string;
  kind: EvidenceKind;
  uri?: string;
  definition: string;
  parents: string[];
  domain: string[];
  range: string[];
  inResult: boolean;
  origins: { callId: string; candidate: string; definition: string }[];
  citations: Citation[];
}
export interface EvidenceTopic {
  id: string;
  label: string;
  callIds: string[];
  chunkIds: string[];
  termIds: string[];
}
export interface EvidenceQuestion extends CompetencyQuestion {
  usedAsGuidance: boolean;
}
const object = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const records = (v: unknown) => (Array.isArray(v) ? v.map(object) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const text = (v: unknown) => (typeof v === "string" ? v : "");

export function buildTboxEvidence(report: RunResearch, revision?: RevisionWithContent) {
  const terms = new Map<string, EvidenceTerm>();
  const calls: EvidenceCall[] = [];
  const topics = new Map<string, EvidenceTopic>();
  const chunks = new Map((report.inputs?.chunks ?? []).map((c) => [c.id, c]));
  const documents = new Map((report.inputs?.documents ?? []).map((d) => [d.id, d]));
  const aliases = object(object(report.checkpoints.find((c) => c.key === "merge")?.payload).aliases);
  const canonical = (name: string) => {
    name = toTermLocalName(name);
    const seen = new Set<string>();
    while (typeof aliases[name] === "string" && !seen.has(name)) {
      seen.add(name);
      name = aliases[name] as string;
    }
    return name;
  };
  const ensure = (kind: EvidenceKind, name: string, uri?: string) => {
    name = !uri && kind === "class" ? canonical(name) : toTermLocalName(name);
    const baseId = `${kind}:${name}`;
    const matches = [...terms.values()].filter((t) => t.inResult && t.kind === kind && t.name === name);
    if (!uri && matches.length === 1) return matches[0];
    const id =
      uri && terms.get(baseId)?.uri && terms.get(baseId)!.uri !== uri
        ? `${baseId}@${uri}`
        : !uri && matches.length > 1
          ? `${baseId}@candidate`
          : baseId;
    if (!terms.has(id))
      terms.set(id, {
        id,
        name,
        label: name.replace(/([a-z])([A-Z])/g, "$1 $2"),
        kind,
        definition: "",
        parents: [],
        domain: [],
        range: [],
        inResult: false,
        origins: [],
        citations: [],
      });
    return terms.get(id)!;
  };
  let resultError: string | undefined;
  if (revision?.content.modules.length) {
    try {
      const model = mergeTBox(
        revision.content.modules.map((m) => parseTBox(m.turtle)),
        revision.content.baseIri,
      );
      for (const [kind, values] of [
        ["class", model.classes],
        ["object", model.objectProps],
        ["data", model.dataProps],
      ] as const) {
        for (const value of values) {
          const term = ensure(kind, localName(value.uri), value.uri);
          Object.assign(term, {
            uri: value.uri,
            label: value.label || term.label,
            definition: value.comment || "",
            inResult: true,
            parents: (model.subClassOf[value.uri] ?? []).map(localName),
            domain: "domain" in value ? value.domain.map(localName) : [],
            range: "range" in value ? value.range.map(localName) : [],
          });
        }
      }
    } catch {
      resultError = "The result ontology could not be parsed. Candidate records are still available below.";
    }
  }
  for (const step of report.run.steps.filter((s) => s.kind === "terms" || s.kind === "relations")) {
    const cp = report.checkpoints.find((c) => c.key === step.key);
    const input = cp?.trace?.input;
    const rows = (step.technical ?? []).flatMap((t) => t.rows);
    const recordedTopic = rows.find((r) => typeof r.assignedTopic === "number")?.assignedTopic;
    const labelTopic = /Topic (\d+)/i.exec(step.label)?.[1];
    const number = step.topic
      ? step.topic.index + 1
      : typeof recordedTopic === "number"
        ? recordedTopic
        : labelTopic
          ? Number(labelTopic)
          : undefined;
    const topicId = number === undefined ? "unrecorded" : `topic:${number}`;
    if (!topics.has(topicId))
      topics.set(topicId, {
        id: topicId,
        label: number === undefined ? "Topic not recorded" : `Topic ${number}`,
        callIds: [],
        chunkIds: [],
        termIds: [],
      });
    const topic = topics.get(topicId)!;
    const passages = Array.isArray(input?.sampledDocuments)
      ? records(input.sampledDocuments)
          .filter((p) => typeof p.text === "string" && typeof p.chunkId === "string")
          .map((p) => ({
            text: text(p.text),
            chunkId: text(p.chunkId),
            documentId: text(p.documentId) || chunks.get(text(p.chunkId))?.documentId || "",
            start: typeof p.start === "number" ? p.start : (chunks.get(text(p.chunkId))?.start ?? 0),
            name: text(p.name),
          }))
      : undefined;
    const call: EvidenceCall = {
      id: step.key,
      step,
      topicId,
      completed: !!cp,
      passages,
      termIds: [],
      scores: new Map(
        rows
          .filter((r) => typeof r.chunk === "string" && typeof r.assignedCosine === "number")
          .map((r) => [String(r.chunk), Number(r.assignedCosine)]),
      ),
    };
    calls.push(call);
    topic.callIds.push(call.id);
    topic.chunkIds.push(...(step.chunkIds ?? []), ...(passages ?? []).map((p) => p.chunkId));
    const payload = object(cp?.payload);
    for (const [kind, values] of [
      ["class", payload.classes],
      ["object", payload.objectProperties],
      ["data", payload.dataProperties],
    ] as const) {
      for (const value of records(values)) {
        if (!text(value.name)) continue;
        const term = ensure(kind, text(value.name));
        if (!term.inResult)
          Object.assign(term, {
            label: text(value.label) || term.label,
            definition: text(value.comment) || term.definition,
            parents: strings(value.parents),
            domain: strings(value.domain),
            range: strings(value.range).length ? strings(value.range) : text(value.datatype) ? [text(value.datatype)] : [],
          });
        term.origins.push({ callId: call.id, candidate: text(value.name), definition: text(value.comment) });
        call.termIds.push(term.id);
        topic.termIds.push(term.id);
        for (const evidence of records(payload.evidence).filter(
          (e) => toTermLocalName(text(e.term)) === toTermLocalName(text(value.name)) && e.kind === kind,
        )) {
          const ev = evidence as unknown as TermEvidence;
          const candidatePassages = (passages ?? []).filter(
            (p) => (!ev.documentId || p.documentId === ev.documentId) && (!ev.chunkId || p.chunkId === ev.chunkId),
          );
          let location: Pick<Citation, "chunkId" | "documentId" | "start" | "end"> = {};
          if (ev.located && ev.quote) {
            for (const passage of candidatePassages) {
              const found = locateQuote(ev.quote, passage.text);
              if (found) {
                location = {
                  chunkId: passage.chunkId,
                  documentId: passage.documentId,
                  start: passage.start + found.start,
                  end: passage.start + found.end,
                };
                break;
              }
            }
          }
          term.citations.push({ quote: ev.quote || "", located: ev.located, documentId: ev.documentId, callId: call.id, ...location });
        }
      }
    }
  }
  for (const call of calls) call.termIds = [...new Set(call.termIds)];
  for (const topic of topics.values()) {
    topic.chunkIds = [...new Set(topic.chunkIds)];
    topic.termIds = [...new Set(topic.termIds)];
  }
  const saved = object(report.inputs?.requirements);
  const requirements = saved.requirements ? object(saved.requirements) : saved;
  const questions: EvidenceQuestion[] = records(requirements.cqs)
    .filter((q) => text(q.text))
    .map(
      (q, i) =>
        ({
          ...q,
          id: text(q.id) || `legacy-${i}`,
          text: text(q.text),
          status: q.status === "approved" || q.status === "rejected" ? q.status : "proposed",
          source: q.source === "generated" || q.source === "template" || q.source === "tbox" ? q.source : "user",
          usedAsGuidance:
            report.run.options?.cqGuided !== false &&
            report.checkpoints.some(
              (c) => typeof c.trace?.input?.requirementsText === "string" && c.trace.input.requirementsText.includes(text(q.text)),
            ),
        }) as EvidenceQuestion,
    );
  for (const [index, question] of strings(saved.competencyQuestions).entries())
    if (!questions.some((q) => q.text === question))
      questions.push({
        id: `saved-${index}`,
        text: question,
        status: "approved",
        source: "user",
        usedAsGuidance:
          report.run.options?.cqGuided !== false &&
          report.checkpoints.some((c) => String(c.trace?.input?.requirementsText ?? "").includes(question)),
      });
  return { terms: [...terms.values()], topics: [...topics.values()], calls, chunks, documents, questions, resultError };
}

export type TboxEvidence = ReturnType<typeof buildTboxEvidence>;

/** A located model quote is stronger provenance than sharing a request's inputs. */
export function topicChunkEvidence(data: TboxEvidence, topicId: string, chunkId: string) {
  const topic = data.topics.find((t) => t.id === topicId);
  const calls = data.calls.filter(
    (c) => c.topicId === topicId && (c.step.chunkIds?.includes(chunkId) || c.passages?.some((p) => p.chunkId === chunkId)),
  );
  const sent = calls.filter((c) => c.completed && c.passages?.some((p) => p.chunkId === chunkId));
  const terms = data.terms.filter((t) => topic?.termIds.includes(t.id));
  const cited = terms.filter((t) => t.citations.some((c) => c.chunkId === chunkId && topic?.callIds.includes(c.callId)));
  const associated = terms.filter((t) => !cited.includes(t) && t.origins.some((o) => sent.some((c) => c.id === o.callId)));
  const status = sent.length
    ? "used"
    : calls.some((c) => !c.completed)
      ? "pending"
      : !calls.length || calls.some((c) => !c.passages)
        ? "unknown"
        : "omitted";
  const chunk = data.chunks.get(chunkId);
  const shortened = !!chunk && sent.some((c) => passageStatus(c, chunk) === "Shortened");
  return { calls, sent, cited, associated, status, shortened };
}

/** Stable, short file labels; full recorded names remain available to the reader. */
export function evidenceFiles(data: TboxEvidence) {
  const passages = data.calls.flatMap((c) => c.passages ?? []);
  const ids = [...new Set([...data.documents.keys(), ...passages.map((p) => p.documentId)])].filter(Boolean);
  return ids.map((id, i) => ({
    id,
    label: `File ${i + 1}`,
    name: data.documents.get(id)?.name ?? passages.find((p) => p.documentId === id)?.name ?? id,
  }));
}

/** Presentation only: the exact saved XML is always retained for source inspection. */
export function readableChunkPreview(text: string, xml: boolean) {
  const readable = xml
    ? text
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
    : text;
  return readable.replace(/\s+/g, " ").trim();
}

export function passageStatus(
  call: EvidenceCall,
  chunk: DocumentChunk,
): "Sent in full" | "Overlap removed" | "Shortened" | "Not sent" | "Not recorded" | "Pending" {
  if (!call.completed) return "Pending";
  if (!call.passages) return "Not recorded";
  const passage = call.passages.find((p) => p.chunkId === chunk.id);
  if (!passage) return "Not sent";
  if (passage.start === chunk.start && passage.text === chunk.text) return "Sent in full";
  if (passage.start === chunk.start + (chunk.overlap ?? 0) && passage.text === chunk.text.slice(chunk.overlap ?? 0))
    return "Overlap removed";
  return "Shortened";
}

const STOP = new Set(
  "which what that with from this their they have each should does where when between across given specific particular associated directly reported would could into been were there your then only also other".split(
    " ",
  ),
);
const words = (s: string) =>
  new Set(
    s
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{4,}/gu)
      ?.filter((w) => !STOP.has(w))
      .map((w) => (w.length > 4 ? w.replace(/s$/, "") : w)) ?? [],
  );
/** A transparent lexical hint, never a claim that a CQ is answered. */
export function questionMatches(question: EvidenceQuestion, terms: EvidenceTerm[]) {
  const asked = words(question.text);
  return terms
    .map((term) => ({
      term,
      matches: [...words([term.name, term.label, term.definition, ...term.domain, ...term.range, ...term.parents].join(" "))].filter((w) =>
        asked.has(w),
      ),
    }))
    .filter((r) => r.matches.length)
    .sort((a, b) => b.matches.length - a.matches.length);
}
