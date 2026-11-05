/** Client-safe provider failures shared by HTTP and local CLI transports. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class TruncatedOutputError extends Error {
  constructor(label: string, readonly usage?: { input_tokens: number; output_tokens: number }, readonly outputLimit?: number) {
    super(
      `${label} hit its output limit before finishing, so the result would be incomplete. ` +
        "Increase the reserved output-token budget or reduce the requested response size. Retrying unchanged may fail again.",
    );
    this.name = "TruncatedOutputError";
  }
}
