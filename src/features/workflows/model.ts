export type WorkflowId = "tbox" | "abox" | "alignment";
export const WORKFLOWS = {
  tbox: {
    title: "Build an ontology",
    term: "T-Box",
    description: "Start from documents, a template or an existing ontology. Review your work and save a version.",
    steps: [
      ["start", "Starting point"],
      ["requirements", "Requirements"],
      ["sources", "Documents"],
      ["parse", "Parsed text"],
      ["chunks", "Chunks"],
      ["generate", "Generate"],
      ["results", "Inspect results"],
      ["validate", "Validate & save version"],
    ],
  },
  abox: {
    title: "Knowledge graphs",
    term: "A-Box",
    description: "Choose or create a corpus, add documents, and review facts extracted using a saved ontology.",
    steps: [
      ["sources", "Documents"],
      ["parse", "Parsed text"],
      ["chunks", "Chunks"],
      ["generate", "Extract"],
      ["results", "Inspect results"],
      ["validate", "Validate & commit"],
    ],
  },
  alignment: {
    title: "Align & merge",
    term: "Alignment",
    description: "Compare ontologies, review suggested connections and save an aligned version for your knowledge graphs.",
    steps: [
      ["sources", "Ontologies"],
      ["terms", "Inspect terms"],
      ["match", "Find matches"],
      ["merge", "Review mappings"],
      ["validate", "Validate & save version"],
    ],
  },
} as const;

export function workflowId(value: string | undefined): WorkflowId {
  return value === "abox" || value === "alignment" ? value : "tbox";
}

export type TboxStart = "documents" | "template" | "import" | "previous";
export type WorkflowStep = readonly [string, string];

export function tboxStart(params: URLSearchParams): TboxStart {
  const value = params.get("start");
  return value === "template" || value === "import" || value === "previous" ? value : "documents";
}

export function workflowSteps(kind: WorkflowId, params: URLSearchParams): readonly WorkflowStep[] {
  if (kind === "tbox" && params.get("run")) return WORKFLOWS.tbox.steps.slice(1);
  if (
    kind === "tbox" &&
    !params.get("run") &&
    !params.get("step") &&
    !params.has("start") &&
    !params.get("history") &&
    !params.get("from") &&
    !params.has("base")
  )
    return [["start", "Starting point"]];
  if (kind === "tbox" && !params.get("run") && tboxStart(params) !== "documents") {
    return [
      ["start", "Starting point"],
      ["requirements", "Requirements"],
      ["review", "Review & edit"],
      ["validate", "Validate & save version"],
    ];
  }
  return WORKFLOWS[kind].steps;
}

export function workflowStep(kind: WorkflowId, value: string | null, params = new URLSearchParams()): string {
  const steps = workflowSteps(kind, params);
  const legacyDocumentEntry = kind === "tbox" && (params.get("history") || params.get("from") || params.has("base"));
  return (
    steps.find(([key]) => key === value)?.[0] ??
    (legacyDocumentEntry ? steps.find(([key]) => key === "sources")?.[0] : undefined) ??
    steps[0]![0]
  );
}
