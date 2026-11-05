// Reusable UI states and building blocks. Every page renders its empty,
// loading, failed, interrupted and quota-exceeded states through these, so the
// same situation always looks and reads the same way.

import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, NetworkError } from "../../lib/http";
import { IconAlert, IconClose } from "../icons";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state empty">
      <h2>{title}</h2>
      {children && <div className="state-body">{children}</div>}
      {action && <div className="state-actions">{action}</div>}
    </div>
  );
}

/** Human message for any thrown error, with quota / connectivity specialised. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 507) return e.message;
  if (e instanceof ApiError && e.status === 401) return "Your session has expired. Sign in again to continue.";
  if (e instanceof NetworkError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const quota = error instanceof ApiError && error.status === 507;
  return (
    <div className="state error" role="alert">
      <IconAlert className="state-icon" />
      <h2>{title ?? (quota ? "Storage quota exceeded" : "Could not load this")}</h2>
      <p>{errorMessage(error)}</p>
      {error instanceof ApiError && error.requestId && <p className="muted mono-sm">Request {error.requestId}</p>}
      {onRetry && (
        <div className="state-actions">
          <button className="btn ghost sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="dz-error" role="alert">
      {errorMessage(error)}
    </div>
  );
}

export type Tone = "ok" | "warn" | "alert" | "info" | "muted";

/** Status is never colour alone: every badge carries a text label. */
export function StatusBadge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      <span className="badge-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  suspended = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Preserve form state while a workspace inspector temporarily owns focus. */
  suspended?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  // Focus belongs to the dialog's lifetime. Inline close callbacks change on
  // each keystroke and must not pull focus away from the edited field.
  useEffect(() => {
    if (suspended) return;
    const prev = document.activeElement as HTMLElement | null;
    const initial = ref.current?.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled), textarea:not(:disabled)');
    (initial ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key !== "Tab" || !ref.current) return;
      const controls = [
        ...ref.current.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ].filter((element) => element.offsetParent !== null && element.tabIndex !== -1);
      const first = controls[0],
        last = controls.at(-1);
      if (!first || !last) {
        e.preventDefault();
        ref.current.focus();
      } else if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [suspended]);
  return (
    <div className="modal-scrim" hidden={suspended}>
      <button className="modal-backdrop" tabIndex={-1} aria-hidden="true" onClick={onClose} />
      <div className={"modal" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Two-step destructive action without a browser confirm() dialog. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  className = "btn ghost sm",
}: {
  label: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!armed) return;
    confirmRef.current?.focus();
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return armed ? (
    <button
      ref={confirmRef}
      className={className + " danger"}
      onClick={() => {
        setArmed(false);
        onConfirm();
      }}
      disabled={disabled}
    >
      {confirmLabel}
    </button>
  ) : (
    <button className={className} onClick={() => setArmed(true)} disabled={disabled}>
      {label}
    </button>
  );
}

/**
 * Right-hand inspector. Wide screens: a resizable column next to the work
 * area. Below 1200px: an overlay drawer. Closing returns focus to the view.
 */
export function Inspector({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const [width, setWidth] = useState(() => {
    try {
      return Number(localStorage.getItem("ontolab-inspector-w")) || 360;
    } catch {
      return 360;
    }
  });
  const drag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      const next = Math.max(280, Math.min(640, drag.current.w + (drag.current.x - e.clientX)));
      setWidth(next);
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      try {
        localStorage.setItem("ontolab-inspector-w", String(width));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [width]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && window.matchMedia("(max-width: 1199px)").matches) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <button className="inspector-scrim" aria-label="Close details" onClick={onClose} />
      <aside className="side-inspector" style={{ ["--inspector-w" as string]: `${width}px` }} aria-label={title}>
        <button
          className="inspector-resize"
          aria-label="Resize details panel (arrow keys)"
          onPointerDown={(e) => (drag.current = { x: e.clientX, w: width })}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setWidth((w) => Math.min(640, w + 24));
            if (e.key === "ArrowRight") setWidth((w) => Math.max(280, w - 24));
          }}
        />
        <div className="side-inspector-head">
          <h2>{title}</h2>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close details">
            <IconClose />
          </button>
        </div>
        <div className="side-inspector-body">{children}</div>
      </aside>
    </>
  );
}

export function PageHead({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head row">
      <div className="grow">
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}

export function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Keeps one broken page from blanking the whole application. */
export class PageErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error)
      return (
        <div className="page">
          <ErrorState title="This page failed to load" error={this.state.error} onRetry={() => this.setState({ error: null })} />
        </div>
      );
    return this.props.children;
  }
}
