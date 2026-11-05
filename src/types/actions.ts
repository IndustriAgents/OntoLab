/** Transport-neutral contracts shared by screens, OntoLab AI and local MCP. */
export interface ActionDefinition {
  name: string;
  description: string;
  effect: "read" | "draft" | "run" | "save";
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
}
export interface ActionResult {
  summary: string;
  data: unknown;
  destination?: string;
  changed?: string[];
  nextActions?: string[];
}
export interface ActionFailure {
  code: "invalid_input" | "not_found" | "conflict" | "review_required" | "unavailable" | "forbidden" | "failed";
  message: string;
  status: number;
  recovery: string;
}
export interface TaskContext {
  projectId: string;
  revisionId?: string;
  contentHash?: string;
}
export interface Capability {
  action: string;
  available: boolean;
  reason?: string;
  nextAction?: string;
}
export interface AgentActivity {
  caller?: string;
  id: string;
  name: string;
  summary: string;
  status: "running" | "awaiting_input" | "ready_for_review" | "completed" | "failed";
  at: string;
  destination?: string;
}
