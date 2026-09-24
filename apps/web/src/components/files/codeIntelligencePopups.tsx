import type { CodeDiagnostic, CodeLocation } from "@t3tools/contracts";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";

import { cn } from "~/lib/utils";

export interface CodeInfo {
  display: string;
  documentation: string;
  markdown?: boolean | undefined;
  parameter?: string | undefined;
  problems?: ReadonlyArray<CodeDiagnostic> | undefined;
  anchor: { top: number; left: number };
}

const POPUP_CLASS =
  "fixed z-50 max-w-[calc(100vw-16px)] rounded-md border border-border bg-popover text-popover-foreground shadow-lg";

export function diagnosticLabel(item: CodeDiagnostic) {
  return `${item.source ?? "TypeScript"}${item.code === "" ? "" : ` ${item.code}`}`;
}

/** Hover documentation, signature help, and problems under the pointer. */
export function CodeInfoCard(props: {
  info: CodeInfo;
  /** Diff hovers carry actions, so the pointer must be able to reach them. */
  actions?: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const { info } = props;
  return (
    <div
      data-file-code-popup
      role="tooltip"
      className={cn(POPUP_CLASS, "w-96 p-3 text-xs", !props.actions && "pointer-events-none")}
      style={info.anchor}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
    >
      {info.problems?.map((item) => (
        <p
          key={`${item.range.start.line}:${item.range.start.column}:${item.code}:${item.message}`}
          className={cn(
            "mb-2 whitespace-pre-wrap break-words",
            item.severity === "error" ? "text-destructive" : "text-warning-foreground",
          )}
        >
          {item.message}
          <span className="ml-1 text-muted-foreground">({diagnosticLabel(item)})</span>
        </p>
      ))}
      {info.display ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">
          {info.display}
        </pre>
      ) : null}
      {info.parameter ? <p className="mt-2 font-mono font-semibold">{info.parameter}</p> : null}
      {info.documentation ? (
        <div className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-muted-foreground [&_p+p]:mt-2 [&_pre]:whitespace-pre-wrap [&_pre]:font-mono">
          {info.markdown ? (
            <ReactMarkdown skipHtml disallowedElements={["img"]}>
              {info.documentation}
            </ReactMarkdown>
          ) : (
            info.documentation
          )}
        </div>
      ) : null}
      {props.actions ? (
        <div className="mt-2 flex items-center gap-1 border-t border-border pt-2">
          {props.actions}
        </div>
      ) : null}
    </div>
  );
}

/** Definition and reference results; selecting one navigates to it. */
export function CodeLocationList(props: {
  items: ReadonlyArray<CodeLocation>;
  emptyText: string;
  onSelect: (item: CodeLocation) => void;
}) {
  if (props.items.length === 0)
    return <p className="px-3 pb-3 text-muted-foreground">{props.emptyText}</p>;
  return props.items.map((item) => (
    <button
      type="button"
      key={`${item.path}:${item.range.start.line}:${item.range.start.column}`}
      className="block w-full truncate px-3 py-1.5 text-left hover:bg-accent"
      onClick={() => props.onSelect(item)}
    >
      <span>
        {item.path}:{item.range.start.line}
      </span>
      {item.preview ? <span className="ml-3 text-muted-foreground">{item.preview}</span> : null}
    </button>
  ));
}

export const CODE_POPUP_CLASS = POPUP_CLASS;
