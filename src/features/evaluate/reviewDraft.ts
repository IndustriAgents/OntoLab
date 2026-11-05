import { useState } from "react";

export interface ReviewDraft {
  grade: string;
  support: string;
  sourceId: string;
  quote: string;
  reason: string;
  confirmed: boolean;
  start?: number;
  end?: number;
}
const empty: ReviewDraft = { grade: "", support: "", sourceId: "", quote: "", reason: "", confirmed: false };
// Also preserves navigation drafts if browser storage is unavailable.
const memory = new Map<string, ReviewDraft>();
export function reviewDraftKey(owner: string, project: string, evaluation: string, capture: string, previous?: string) {
  return `ontolab-evaluation-draft:${JSON.stringify([owner, project, evaluation, capture, previous ?? "new"])}`;
}
export function useReviewDraft(key: string) {
  const [draft, setDraft] = useState<ReviewDraft>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as ReviewDraft | null;
      if (saved && typeof saved.reason === "string" && typeof saved.quote === "string") return { ...empty, ...saved };
    } catch {
      /* Use the in-memory draft when storage is unavailable. */
    }
    return memory.get(key) ?? { ...empty };
  });
  const [storageError, setStorageError] = useState(false);
  const update = (patch: Partial<ReviewDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    memory.set(key, next);
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  };
  const clear = () => {
    memory.delete(key);
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Nothing persisted. */
    }
  };
  return { draft, update, clear, storageError };
}
