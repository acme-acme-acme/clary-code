import type { CodeLocation } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

interface CodeHistory {
  entries: ReadonlyArray<CodeLocation>;
  index: number;
  id: number;
}

/**
 * Back/forward history for code navigation across file surfaces. The panel outlives
 * individual file tabs, so a definition in another file keeps its way back.
 */
export function useCodeNavigationHistory(input: {
  relativePath: string | null;
  revealLine: number | null;
  revealRequestId: number;
  onOpenFile: (relativePath: string) => void;
}) {
  const { relativePath, revealLine, revealRequestId, onOpenFile } = input;
  const [history, setHistory] = useState<CodeHistory>({ entries: [], index: -1, id: 0 });
  const navigate = useCallback(
    (target: CodeLocation, source: CodeLocation) => {
      setHistory((current) => {
        const previous = current.index < 0 ? [] : current.entries.slice(0, current.index);
        return {
          entries: [...previous, source, target],
          index: previous.length + 1,
          id: current.id + 1,
        };
      });
      onOpenFile(target.path);
    },
    [onOpenFile],
  );
  const move = (direction: -1 | 1) => {
    const target = history.entries[history.index + direction];
    if (!target) return;
    setHistory((current) => ({
      ...current,
      index: current.index + direction,
      id: current.id + 1,
    }));
    onOpenFile(target.path);
  };
  const destination = history.entries[history.index];
  // A reveal requested by a link wins over the navigation destination.
  const reveal = useMemo(
    () =>
      revealLine !== null
        ? { line: revealLine, column: 1, id: revealRequestId }
        : destination?.path === relativePath
          ? {
              line: destination.range.start.line,
              column: destination.range.start.column,
              id: history.id,
            }
          : null,
    [destination, history.id, relativePath, revealLine, revealRequestId],
  );
  return {
    reveal,
    navigate,
    back: history.index > 0 ? () => move(-1) : undefined,
    forward: history.index < history.entries.length - 1 ? () => move(1) : undefined,
  };
}
