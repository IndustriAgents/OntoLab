import { request } from "./http";
import type { ProviderId } from "./api";

/** A saved OpenAI-compatible endpoint. The API key stays on the server. */
export interface ModelEndpoint {
  id: string;
  providerId: ProviderId;
  label: string;
  baseUrl: string;
  models: string[];
  hasKey: boolean;
  updatedAt: string;
}
export interface ModelEndpointInput {
  label: string;
  baseUrl: string;
  models: string[];
  /** Omitted keeps the stored key; an empty string removes it. */
  apiKey?: string;
}
export const modelEndpointsKey = ["model-endpoints"] as const;
export const modelEndpointsApi = {
  list: () => request<{ available: boolean; endpoints: ModelEndpoint[] }>("GET", "api/model-endpoints"),
  save: (input: ModelEndpointInput, id?: string) =>
    request<{ endpoint: ModelEndpoint }>(id ? "PUT" : "POST", `api/model-endpoints${id ? `/${id}` : ""}`, { body: input }).then(
      (r) => r.endpoint,
    ),
  remove: (id: string) => request("DELETE", `api/model-endpoints/${id}`),
  discover: (input: { baseUrl: string; apiKey?: string; id?: string }) =>
    request<{ baseUrl: string; models: string[] }>("POST", "api/model-endpoints/discover", { body: input }),
};
/** Model ids as people type them: one per line or comma-separated. */
export const splitModels = (text: string) => [
  ...new Set(
    text
      .split(/[\n,]/)
      .map((m) => m.trim())
      .filter(Boolean),
  ),
];
