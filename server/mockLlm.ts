// Deterministic offline "model" (provider id `mock`, enabled by MOCK_LLM=1).
//
// It exists so the whole product — upload → extraction → clarification →
// review → assistant → export — can be exercised end to end in automated tests
// and demos without provider keys or spend. It reads the same structured-output
// schema the real providers get (class/property URIs are enums there), finds
// class names mentioned in the text and quotes the sentence it found them in,
// so evidence verification has real work to do.

import type { ExtractDoc } from "../src/types/abox.ts";

interface MockCall {
  schema: Record<string, unknown>;
  docs?: ExtractDoc[];
  extra?: string;
  lead: string;
  toolName: string;
}

type Obj = Record<string, unknown>;

const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Obj)[k] : undefined), o);
const enumOf = (o: unknown): string[] => (Array.isArray(get(o, "enum")) ? (get(o, "enum") as string[]) : []);

const localName = (uri: string) => uri.replace(/^.*[#/]/, "");
const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The sentence around `index`, verbatim, so it can be located again later. */
function sentenceAround(text: string, index: number): string {
  let start = index;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
  let end = index;
  while (end < text.length && !/[.!?\n]/.test(text[end])) end++;
  const s = text.slice(start, Math.min(end + 1, text.length)).trim();
  return s.length > 220 ? s.slice(0, 220).trim() : s;
}

function docsText(call: MockCall): string {
  return (call.docs ?? []).map((d) => d.text).join("\n\n");
}

function mockIndividuals(call: MockCall, itemSchema: unknown) {
  const text = docsText(call) || call.extra || "";
  const lower = text.toLowerCase();
  const classes = enumOf(get(itemSchema, "properties", "classUri"));
  const objProps = enumOf(get(itemSchema, "properties", "objectProperties", "items", "properties", "propUri"));
  const individuals: Obj[] = [];
  for (const cls of classes) {
    const phrase = words(localName(cls));
    if (phrase.length < 3) continue;
    const at = lower.indexOf(phrase);
    if (at < 0) continue;
    const id = kebab(phrase);
    individuals.push({
      id,
      classUri: cls,
      label: phrase.replace(/\b\w/g, (c) => c.toUpperCase()),
      sourceEvidence: sentenceAround(text, at),
    });
    if (individuals.length >= 25) break;
  }
  if (individuals.length >= 2 && objProps.length) {
    individuals[0].objectProperties = [{ propUri: objProps[0], targetId: individuals[1].id, quote: individuals[0].sourceEvidence }];
  }
  return individuals;
}

export async function mockStructured(call: MockCall): Promise<{ data: Obj; usage: { input_tokens: number; output_tokens: number } }> {
  const usage = { input_tokens: Math.ceil((docsText(call).length + (call.extra?.length ?? 0)) / 4), output_tokens: 200 };
  const props = get(call.schema, "properties") as Obj | undefined;

  if (call.toolName === "emit_abox" && props?.operations) {
    // Edit mode: a single deterministic change keeps proposals testable.
    const item = get(props, "operations", "items", "properties", "individual");
    const classes = enumOf(get(item, "properties", "classUri"));
    const message = call.lead.split("USER MESSAGE:").pop() ?? "";
    const wantsAdd = /\badd\b|\bcreate\b/i.test(message);
    const ops =
      wantsAdd && classes.length ? [{ op: "add", individual: { id: "mock-added", classUri: classes[0], label: "Mock added" } }] : [];
    return { data: { operations: ops, summary: ops.length ? "Added one individual (mock)." : "No change needed (mock)." }, usage };
  }

  if (call.toolName === "emit_abox") {
    const data: Obj = { individuals: mockIndividuals(call, get(props, "individuals", "items")) };
    if (props?.proposedTerms) {
      // Propose the first capitalised word the ontology has no class for, so the improvement loop has work.
      const text = docsText(call);
      const classes = new Set(enumOf(get(props, "individuals", "items", "properties", "classUri")).map((u) => localName(u).toLowerCase()));
      const word = [...text.matchAll(/\b([A-Z][a-z]{4,})\b/g)].map((m) => m[1]).find((w) => !classes.has(w.toLowerCase()));
      data.proposedTerms = word
        ? [
            {
              kind: "class",
              name: word,
              definition: `A ${word.toLowerCase()} as described in the document (mock).`,
              quote: sentenceAround(text, text.indexOf(word)),
              subject: kebab(word),
              subjectLabel: word,
            },
          ]
        : [];
    }
    if (props?.questions) {
      const answered = /PREVIOUS CLARIFICATIONS/.test(call.extra ?? "");
      data.questions = answered
        ? []
        : [{ id: "q1", text: "Which station does this document describe?", options: ["Distributing station", "Testing station"] }];
    }
    return { data, usage };
  }

  if (call.toolName === "emit_cq") {
    return {
      data: {
        sparql: "SELECT ?individual ?type WHERE { ?individual a ?type } LIMIT 25",
        explanation: "Lists individuals with their types (mock).",
      },
      usage,
    };
  }

  if (call.toolName === "emit_answer") {
    const first = /\[(C\d+)\]/.exec(call.extra ?? "")?.[1];
    // Quote the first substantial line of that excerpt (a heading number like "1.3" cannot be located).
    const body = first ? (new RegExp(`\\[${first}\\][^\\n]*\\n([\\s\\S]*?)(?:\\n\\[C\\d+\\]|$)`).exec(call.extra ?? "")?.[1] ?? "") : "";
    const quote = (body.split("\n").find((l) => l.trim().length >= 20) ?? "").trim().slice(0, 160);
    return {
      data: {
        answer: first ? `According to the documents, ${quote.slice(0, 120)} [${first}]` : "I could not find this in the project documents.",
        citations: first ? [{ ref: first, quote: quote.slice(0, 120) }] : [],
        entities: [],
      },
      usage,
    };
  }

  if (call.toolName === "emit_tbox") {
    return {
      data: {
        classes: [{ name: "Station" }, { name: "Component" }, { name: "Sensor", parents: ["Component"] }],
        objectProperties: [{ name: "hasComponent", domain: ["Station"], range: ["Component"] }],
        dataProperties: [{ name: "name", domain: ["Component"], datatype: "string" }],
      },
      usage,
    };
  }

  if (call.toolName === "emit_summary") {
    const text = docsText(call).trim();
    return { data: { summary: text ? sentenceAround(text, 0) : "" }, usage };
  }

  if (call.toolName === "emit_classes") {
    // Frequent capitalised words become classes; the first is everyone's parent.
    const counts = new Map<string, number>();
    for (const m of docsText(call).matchAll(/\b([A-Z][a-z]{3,})\b/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    const top = [...counts.entries()]
      .filter(([w]) => !/^(The|This|That|When|With|Each|Then|There|These|Section|Page)$/.test(w))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([w]) => w);
    const text = docsText(call);
    const classes = top.map((name, i) => ({
      name,
      label: name,
      comment: `A ${name.toLowerCase()} (mock).`,
      quote: sentenceAround(text, Math.max(0, text.indexOf(name))),
      ...(i > 0 ? { parents: [top[0]] } : {}),
    }));
    return { data: { classes }, usage };
  }

  if (call.toolName === "emit_review") {
    // A subclass whose name shares nothing with its parent's gets a (minor) hierarchy finding.
    const edge = /^- (\w+) ⊑ (\w+)/m.exec(call.lead);
    return {
      data: {
        findings: edge
          ? [
              {
                term: edge[1],
                kind: "hierarchy",
                severity: "minor",
                message: `Check that every ${edge[1]} is a kind of ${edge[2]} (mock).`,
                fix: `Move ${edge[1]} if it is not.`,
              },
            ]
          : [],
      },
      usage,
    };
  }

  if (call.toolName === "emit_axioms") {
    // Siblings under the same parent are declared disjoint (the classic missing axiom, pitfall P10).
    const block = /=== CLASSES ===\n([\s\S]*?)\n=== RELATIONS ===/.exec(call.extra ?? "")?.[1] ?? "";
    const byParent = new Map<string, string[]>();
    for (const m of block.matchAll(/^- (\w+) \(a (\w+)/gm)) byParent.set(m[2], [...(byParent.get(m[2]) ?? []), m[1]]);
    const group = [...byParent.values()].find((g) => g.length >= 2);
    return {
      data: {
        disjointGroups: group ? [{ classes: group.slice(0, 2), why: "Siblings (mock)." }] : [],
        restrictions: [],
        inverses: [],
        characteristics: [],
      },
      usage,
    };
  }

  if (call.toolName === "emit_properties") {
    const block = /=== CLASSES ===\n([\s\S]*?)\n=== END CLASSES ===/.exec(call.extra ?? "")?.[1] ?? "";
    const names = [...block.matchAll(/^- (\w+)/gm)].map((m) => m[1]);
    return {
      data: {
        objectProperties:
          names.length >= 2 ? [{ name: "relatedTo", comment: "Related to (mock).", domain: [names[1]], range: [names[0]] }] : [],
        dataProperties: names.length
          ? [{ name: "identifier", comment: "An identifier (mock).", domain: [names[0]], datatype: "string" }]
          : [],
      },
      usage,
    };
  }

  if (call.toolName === "review_extracted_assertions") return { data: { changes: [] }, usage };
  if (call.toolName === "review_answer_semantics") return { data: { edits: [] }, usage };
  if (call.toolName === "emit_decisions") return { data: { decisions: [] }, usage };

  if (call.toolName === "emit_verdicts") {
    const n = (call.lead.match(/^PAIR \d+/gm) ?? []).length;
    return { data: { verdicts: Array.from({ length: n }, (_, i) => ({ n: i + 1, verdict: "entailed" })) }, usage };
  }

  if (call.toolName === "emit_user_story") {
    const context = JSON.parse(call.lead) as { draft: string; project: { name: string; purpose: string } };
    const draft = context.draft.trim().replace(/[.!?]+$/, "");
    return {
      data: {
        story: draft
          ? /^As (?:a|an) /i.test(draft)
            ? `${draft}.`
            : `As a knowledge graph user, I want to ${draft}, so that I can make informed decisions.`
          : `As a knowledge graph user, I want to explore ${context.project.name}, so that I can find relevant information and its sources.`,
      },
      usage,
    };
  }
  if (call.toolName === "emit_ontology_patch") return { data: { remove: [], add: "" }, usage };

  if (call.toolName === "emit_cqs") {
    const stories = [...call.lead.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
    const cqs = stories.flatMap((s, i) => {
      const want = /want to ([^,.]+?)(?: so that|[,.]|$)/i.exec(s)?.[1] ?? s;
      return [{ text: `Which items are needed to ${want.trim()}?`, story: i + 1 }];
    });
    return { data: { questions: cqs.length ? cqs : [{ text: "What are the main entities in the documents?" }] }, usage };
  }

  if (call.toolName === "emit_cq_terms") {
    // Every listed term whose name occurs in the question; the noun after "which/what" is "missing" when nothing matched it.
    const terms = enumOf(
      get(call.schema, "properties", "questions", "items", "properties", "mentions", "items", "properties", "term"),
    ).filter(Boolean);
    const questions = [...call.lead.matchAll(/^Q(\d+): (.+)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
    return {
      data: {
        questions: questions.map((q) => {
          const lower = ` ${q.text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
          const mentions: Obj[] = [];
          for (const t of terms) {
            const phrase = words(localName(t));
            if (phrase.length >= 3 && (lower.includes(` ${phrase} `) || lower.includes(` ${phrase}s `)))
              mentions.push({ text: phrase, role: /^[A-Z]/.test(localName(t)) ? "class" : "property", term: t });
          }
          const head = /\b(?:which|what)\s+([a-z]+)/i.exec(q.text)?.[1]?.toLowerCase();
          const headWord = head?.replace(/s$/, "");
          if (headWord && !mentions.some((m) => String(m.text).includes(headWord)))
            mentions.push({ text: headWord, role: "class", term: "" });
          return { n: q.n, mentions };
        }),
      },
      usage,
    };
  }

  if (call.toolName === "emit_tbox_cqs") {
    const paths = [...call.lead.matchAll(/^- (\w+) —(\w+)→ (\w+)$/gm)].slice(0, 4);
    const human = (s: string) => words(s);
    return { data: { questions: paths.map((m) => ({ text: `Which ${human(m[1])} ${human(m[2])} which ${human(m[3])}?` })) }, usage };
  }

  if (call.toolName === "emit_mappings") {
    const n = (call.lead.match(/^PAIR \d+/gm) ?? []).length;
    return {
      data: {
        mappings: Array.from({ length: n }, (_, i) => ({
          n: i + 1,
          relation: "equivalent",
          rationale: "Same name and definition (mock).",
        })),
      },
      usage,
    };
  }

  return { data: {}, usage };
}

export async function mockChat(messages: { role: string; content: string }[]): Promise<string> {
  const last = messages[messages.length - 1]?.content ?? "";
  return `Mock reply to: ${last.slice(0, 200)}`;
}
