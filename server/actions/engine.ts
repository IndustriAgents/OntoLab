import { ProviderError, TruncatedOutputError } from "../providerErrors.ts";
import Ajv from "ajv";
import type { ActionDefinition, ActionResult, ActionFailure, AgentActivity } from "../../src/types/actions.ts";
import type { ServiceCtx } from "../services/context.ts";
import * as projects from "../services/projects.ts";
import { HttpError } from "../http.ts";
import { ConflictError, NotFoundError } from "../store/types.ts";
import { digest, readState, writeState, serialized, stale, workspaceEvents } from "./state.ts";
const ajv = new Ajv({ strict: false, validateFormats: false });
export interface ActionAccess {
  caller?: string;
  label?: string;
  allowedProjects?: string[];
  effects?: ActionDefinition["effect"][];
}
export interface ActionCtx extends ServiceCtx {
  operationId: string;
  access: ActionAccess;
}
interface Registered extends ActionDefinition {
  validate: ReturnType<typeof ajv.compile>;
  execute: (ctx: ActionCtx, input: unknown) => Promise<ActionResult>;
  recoverable: boolean;
}
const actions = new Map<string, Registered>();
export function define<T>(
  name: string,
  description: string,
  effect: ActionDefinition["effect"],
  properties: Record<string, unknown>,
  required: string[],
  execute: (ctx: ActionCtx, input: T) => Promise<ActionResult>,
  recoverable = effect === "read",
) {
  const inputSchema: ActionDefinition["inputSchema"] = {
    type: "object",
    properties: { ...properties, ...(effect !== "read" ? { requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,80}$" } } : {}) },
    required: [...required, ...(effect !== "read" ? ["requestId"] : [])],
    additionalProperties: false,
  };
  actions.set(name, {
    name,
    description,
    effect,
    inputSchema,
    validate: ajv.compile(inputSchema),
    execute: (ctx, input) => execute(ctx, input as T),
    recoverable,
  });
}
export const result = (summary: string, data: unknown, projectId?: string, destination?: string, nextActions?: string[]): ActionResult => ({
  summary,
  data,
  ...(destination ? { destination } : {}),
  ...(projectId ? { changed: [projectId] } : {}),
  ...(nextActions ? { nextActions } : {}),
});
export const destination = (pid: string, rid?: string, graph = false) =>
  `/p/${pid}/${graph ? "graph?tab=updates" : "ontology?tab=review"}${rid ? `&rev=${rid}` : ""}`;
export function identity(ctx: ActionCtx, prefix: string) {
  return `${prefix}_${digest(ctx.operationId).slice(0, 20)}`;
}
async function permitted(ctx: ServiceCtx, pid: string, access: ActionAccess) {
  const project = await projects.requireProject(ctx, pid);
  if (
    access.allowedProjects &&
    !access.allowedProjects.includes(pid) &&
    !access.allowedProjects.includes(project.settings.corpus?.parentProjectId ?? project.settings.externalGraph?.parentProjectId ?? "")
  )
    throw new HttpError(403, "This connection cannot access this project.");
  return project;
}
export async function editable(ctx: ServiceCtx, pid: string) {
  const p = await projects.requireProject(ctx, pid);
  if (p.settings.externalGraph) throw new HttpError(409, "Connected graphs are read-only. Create a local graph to build new knowledge.");
  return p;
}
export function actionDefinitions(access: ActionAccess = {}): ActionDefinition[] {
  return [...actions.values()]
    .filter((a) => !access.effects || access.effects.includes(a.effect))
    .map(({ name, description, effect, inputSchema }) => ({ name, description, effect, inputSchema }));
}
export function actionFailure(error: unknown): ActionFailure {
  const status =
    error instanceof HttpError || error instanceof ProviderError
      ? error.status
      : error instanceof TruncatedOutputError
        ? 422
        : error instanceof ConflictError
          ? 409
          : error instanceof NotFoundError
            ? 404
            : 500;
  return {
    status,
    code:
      status === 400 || status === 422
        ? "invalid_input"
        : status === 404
          ? "not_found"
          : status === 403
            ? "forbidden"
            : status === 409
              ? "conflict"
              : status === 428
                ? "review_required"
                : status === 503
                  ? "unavailable"
                  : "failed",
    message:
      status === 500
        ? "The action could not finish. Inspect the activity and retry with the same request ID."
        : error instanceof Error
          ? error.message
          : "The action failed.",
    recovery:
      status === 409
        ? "Refresh project context or the plan. Existing drafts and completed work are preserved."
        : status === 428 || status === 422
          ? "Review validation and proposed changes before continuing."
          : status === 403
            ? "Check this connection's project access and permissions."
            : "Inspect project context and activity before retrying.",
  };
}
interface RequestRecord {
  inputHash: string;
  state: "running" | "completed";
  result?: ActionResult;
  at: string;
  name: string;
}
export async function executeAction(ctx: ServiceCtx, name: string, input: unknown, access: ActionAccess = {}): Promise<ActionResult> {
  const action = actions.get(name);
  if (!action) throw new HttpError(404, "Action not found.");
  if (!action.validate(input)) throw new HttpError(400, `Invalid ${name} input: ${ajv.errorsText(action.validate.errors)}`);
  if (access.effects && !access.effects.includes(action.effect))
    throw new HttpError(403, "This action is outside this connection's permissions.");
  const body = input as Record<string, unknown>;
  for (const key of ["projectId", "sourceProjectId"]) if (typeof body[key] === "string") await permitted(ctx, body[key], access);
  if (name === "create_project" && access.allowedProjects)
    throw new HttpError(403, "Project creation requires a connection with access to all projects.");
  const key = digest([access.caller ?? "ui", name, body.requestId ?? ctx.requestId]);
  const actx: ActionCtx = { ...ctx, operationId: key, access };
  if (action.effect === "read") return action.execute(actx, input);
  return serialized(`${ctx.user.id}:actions:${typeof body.projectId === "string" ? body.projectId : key}`, async () => {
    const legacyPath = `agent/requests/${key}.json`;
    const path = typeof body.projectId === "string" ? `${body.projectId}/${legacyPath}` : legacyPath;
    const inputHash = digest(input);
    const saved =
      (await readState<RequestRecord>(ctx, path)) ?? (path !== legacyPath ? await readState<RequestRecord>(ctx, legacyPath) : null);
    if (saved && saved.inputHash !== inputHash) stale("This request ID was already used with different inputs. Use a new request ID.");
    if (saved?.state === "completed") return saved.result!;
    if (saved && !action.recoverable)
      stale(
        "This request was interrupted. Inspect project context and activity before submitting a new request; it may already have taken effect.",
      );
    await writeState(ctx, path, { inputHash, state: "running", at: ctx.now().toISOString(), name });
    let output: ActionResult;
    try {
      output = await action.execute(actx, input);
    } catch (error) {
      await ctx.store.blobs.delete(path);
      throw error;
    }
    await writeState(ctx, path, { inputHash, state: "completed", result: output, at: ctx.now().toISOString(), name });
    if (typeof body.projectId === "string") {
      const activities = (await readState<AgentActivity[]>(ctx, `${body.projectId}/agent/activity.json`)) ?? [];
      activities.unshift({
        id: key,
        caller: access.label ?? (access.caller?.startsWith("ai:") ? "OntoLab AI" : "This workspace"),
        name,
        summary: output.summary,
        status:
          output.nextActions?.includes("review_facts") || output.nextActions?.includes("validate_revision")
            ? "ready_for_review"
            : "completed",
        at: ctx.now().toISOString(),
        destination: output.destination,
      });
      await writeState(ctx, `${body.projectId}/agent/activity.json`, activities.slice(0, 100));
    }
    if (typeof body.projectId === "string") workspaceEvents.emit("changed", ctx.user.id, body.projectId);
    return output;
  });
}
