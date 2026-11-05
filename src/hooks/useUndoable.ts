import { useCallback, useMemo, useRef, useState } from "react";

export interface Undoable<T> {
  value: T;
  /** Replace the value, pushing the previous one onto the undo stack. */
  set: (next: T, label?: string) => void;
  /** Replace without creating a history entry (e.g. restoring a session). */
  reset: (next: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Label of the change that undo would revert, for the button tooltip. */
  undoLabel?: string;
  redoLabel?: string;
}

interface Entry<T> {
  value: T;
  label?: string;
}

/**
 * Value with an undo/redo history.
 *
 * The A-Box is edited by AI chat, natural-language instructions and hand edits,
 * any of which can misfire on a result that took minutes to produce — so every
 * change is reversible. Snapshots are cheap: the A-Box is plain JSON and the
 * history is capped.
 */
export function useUndoable<T>(initial: T, limit = 50): Undoable<T> {
  const [value, setValue] = useState<T>(initial);
  const past = useRef<Entry<T>[]>([]);
  const future = useRef<Entry<T>[]>([]);
  // Bumped to re-render when only the stacks change.
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const set = useCallback(
    (next: T, label?: string) => {
      setValue((current) => {
        if (Object.is(current, next)) return current;
        past.current = [...past.current, { value: current, label }].slice(-limit);
        future.current = [];
        return next;
      });
      rerender();
    },
    [limit, rerender],
  );

  const reset = useCallback(
    (next: T) => {
      past.current = [];
      future.current = [];
      setValue(next);
      rerender();
    },
    [rerender],
  );

  const undo = useCallback(() => {
    const prev = past.current[past.current.length - 1];
    if (!prev) return;
    past.current = past.current.slice(0, -1);
    setValue((current) => {
      future.current = [...future.current, { value: current, label: prev.label }];
      return prev.value;
    });
    rerender();
  }, [rerender]);

  const redo = useCallback(() => {
    const next = future.current[future.current.length - 1];
    if (!next) return;
    future.current = future.current.slice(0, -1);
    setValue((current) => {
      past.current = [...past.current, { value: current, label: next.label }];
      return next.value;
    });
    rerender();
  }, [rerender]);

  return useMemo(
    () => ({
      value,
      set,
      reset,
      undo,
      redo,
      canUndo: past.current.length > 0,
      canRedo: future.current.length > 0,
      undoLabel: past.current[past.current.length - 1]?.label,
      redoLabel: future.current[future.current.length - 1]?.label,
    }),
    [value, set, reset, undo, redo],
  );
}
