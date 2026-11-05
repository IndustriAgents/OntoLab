// Small formatting + browser helpers shared across the UI, so there is exactly
// one definition of each rather than a slightly different copy per component.

/** Human-readable file size. */
export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Approximate token count, for showing roughly how large a prompt will be. */
export function approxTokens(chars: number): string {
  const tokens = Math.round(chars / 4);
  return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

/** Trigger a client-side download of `text` as `filename`. */
export function downloadText(text: string, filename: string, mime = "text/plain;charset=utf-8"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Copy text to the clipboard, resolving to whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Random-ish id for client-side collections. */
export function uid(prefix = "id"): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
