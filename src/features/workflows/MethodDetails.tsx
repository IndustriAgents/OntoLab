import type { ReactNode } from "react";

export function MethodDetails({
  children,
  title = "Processing details",
  defaultOpen = false,
}: {
  children: ReactNode;
  title?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className="method-details" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        <span className="method-details-hint">Inspect</span>
      </summary>
      <div className="method-details-body">{children}</div>
    </details>
  );
}
