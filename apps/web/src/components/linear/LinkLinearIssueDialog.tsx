import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLinearIssueLinking } from "~/hooks/useLinearIssueLinking";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { resolveLinkLinearIssueInput } from "./linearIssues.logic";

/**
 * Which thread has the dialog open. Entry points (command palette, issues panel) set it and the
 * chat view renders the dialog once, so it outlives a palette that closes as its command runs.
 */
const linkLinearIssueDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("linear-issues:link-dialog-thread"),
);

export function openLinkLinearIssueDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkLinearIssueDialogThreadAtom, threadRef);
}

/** Mounted once per chat view; shows the dialog for whichever thread asked for it. */
export function LinkLinearIssueDialogHost() {
  const threadRef = useAtomValue(linkLinearIssueDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <LinkLinearIssueDialog
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(linkLinearIssueDialogThreadAtom, null)}
    />
  );
}

function LinkLinearIssueDialog({
  threadRef,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const linking = useLinearIssueLinking(threadRef.environmentId);
  const resolved = useMemo(() => resolveLinkLinearIssueInput(reference), [reference]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const submit = useCallback(async () => {
    setDirty(true);
    if (resolved === null) return;
    setSubmitError(null);
    setPending(true);
    try {
      await linking.linkIssue(threadRef, resolved);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not link the Linear issue.");
      return;
    } finally {
      setPending(false);
    }
    onClose();
  }, [linking, onClose, resolved, threadRef]);

  const validation = !dirty
    ? null
    : reference.trim().length === 0
      ? "Enter an issue identifier like ENG-123 or paste its Linear URL."
      : resolved === null
        ? "Use an identifier like ENG-123 or a linear.app issue URL."
        : null;

  return (
    <Dialog open onOpenChange={(next) => (pending || next ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link Linear issue</DialogTitle>
          <DialogDescription>
            Attach a Linear issue to this thread to follow its status from here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            placeholder="ENG-123 or https://linear.app/…/issue/ENG-123"
            value={reference}
            onChange={(event) => {
              setDirty(true);
              setReference(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          {(validation ?? submitError) ? (
            <p className="text-destructive text-xs">{validation ?? submitError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pending || resolved === null}
          >
            {pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
