// A focusable separator is an interactive window splitter; jsx-a11y treats this role as a static divider.
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
import { useEffect, useRef, useState, type CSSProperties } from "react";

const storageKey = "ontolab-ai-panel-width";
const clamp = (width: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, width)));
function saveWidth(value: number | null) {
  try {
    if (value === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, String(value));
  } catch {
    /* Resizing still works when storage is unavailable. */
  }
}

export function useAgentPanelResize(open: boolean, sidebarHidden: boolean) {
  const shellRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preferredWidth, setPreferredWidth] = useState<number | null>(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved >= 300 && saved <= 720 ? saved : null;
    } catch {
      return null;
    }
  });
  const [bounds, setBounds] = useState({ min: 320, max: 720, default: 400 });
  const width = clamp(preferredWidth ?? bounds.default, bounds.min, bounds.max);
  const currentWidth = useRef(width);
  currentWidth.current = width;

  useEffect(() => {
    if (!open) {
      if (drag.current) saveWidth(currentWidth.current);
      drag.current = null;
      setDragging(false);
      return;
    }
    if (!shellRef.current || !workspaceRef.current) return;
    const shell = shellRef.current;
    const workspace = workspaceRef.current;
    const measure = () => {
      const compact = window.matchMedia("(max-width: 860px)").matches;
      const min = compact ? 300 : 320;
      const available = shell.getBoundingClientRect().right - workspace.getBoundingClientRect().left;
      const max = Math.max(min, Math.min(720, available - (compact ? 280 : 360)));
      const next = { min, max, default: clamp(window.innerWidth * (compact ? 0.44 : 0.32), min, compact ? 360 : 400) };
      setBounds((previous) =>
        previous.min === next.min && previous.max === next.max && previous.default === next.default ? previous : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [open, sidebarHidden]);

  const reset = () => {
    setPreferredWidth(null);
    saveWidth(null);
  };
  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    saveWidth(currentWidth.current);
  };

  return {
    shellRef,
    workspaceRef,
    dragging,
    style: { "--agent-width": `${width}px` } as CSSProperties,
    handle: (
      <div
        className="agent-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="Resize OntoLab AI"
        aria-controls="ontolab-ai-panel"
        aria-orientation="vertical"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels wide`}
        title="Drag to resize · Arrow keys to adjust · Double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, width };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (drag.current?.id !== event.pointerId) return;
          const next = clamp(drag.current.width + drag.current.x - event.clientX, bounds.min, bounds.max);
          currentWidth.current = next;
          setPreferredWidth(next);
        }}
        onPointerUp={(event) => {
          if (drag.current?.id !== event.pointerId) return;
          finish();
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={reset}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 64 : 24;
          const next =
            event.key === "ArrowLeft"
              ? width + step
              : event.key === "ArrowRight"
                ? width - step
                : event.key === "Home"
                  ? bounds.min
                  : event.key === "End"
                    ? bounds.max
                    : null;
          if (next === null) return;
          event.preventDefault();
          const value = clamp(next, bounds.min, bounds.max);
          setPreferredWidth(value);
          saveWidth(value);
        }}
      >
        <span aria-hidden="true" />
      </div>
    ),
  };
}
