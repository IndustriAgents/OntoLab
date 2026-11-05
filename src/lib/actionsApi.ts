import type { ActionResult } from "../types/actions";
import { request } from "./http";
export const actionRequestId = () => crypto.randomUUID().replaceAll("-", "");
export const runAction = (name: string, input: Record<string, unknown>, signal?: AbortSignal) =>
  request<ActionResult>("POST", `api/actions/${name}`, { body: input, signal });
export interface AgentReply {
  threadId: string;
  message: string;
  results: ActionResult[];
}
export const chatWithAgent = (
  projectId: string,
  body: { message: string; revisionId?: string; threadId?: string; provider: string; model: string; reasoningEffort?: string },
  signal?: AbortSignal,
) => request<AgentReply>("POST", `api/projects/${projectId}/agent/chat`, { body, signal });
