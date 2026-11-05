import { rawRequest } from "./http";
/** Events are refresh hints. Persisted resources remain authoritative after reconnects. */
export async function watchWorkspace(pid: string, changed: () => void, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const response = await rawRequest("GET", `api/projects/${pid}/agent/events`, { signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (message.startsWith("data:")) changed();
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
