import type {
  AssistantCitation,
  LinearIssueActivity,
  LinearIssueDetail,
  LinearIssueDetailPerson,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CopyIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  LinkIcon,
  PaperclipIcon,
  RefreshCwIcon,
  SettingsIcon,
  SlackIcon,
  UserRoundIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useThreadShell } from "~/state/entities";
import { linearIssueChanges, linearIssueDetail } from "~/state/linearIssues";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { linearCitationSourceId } from "@t3tools/shared/assistantCitations";
import ChatMarkdown from "../ChatMarkdown";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { AssistantSelectionToolbar } from "../chat/AssistantSelectionToolbar";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { LinearPriorityIcon, LinearStatusIcon } from "./LinearStatusIcon";
import { openInLinear } from "./openInLinear";
import { linearIssueReviewUrl } from "./useOpenLinearReview";

/**
 * One Linear issue beside its thread, like the pull request page: state,
 * details, description, and the activity log of comments and changes.
 * It re-reads the issue when Linear's live feed reports a change, when the
 * thread's status sync sees one, and on an interval as a fallback.
 */
export function LinearIssueDetailPanel({
  threadRef,
  identifier,
  onBack,
  onCite,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly identifier: string;
  /** Back to the thread's list of linked issues, when there is more than one. */
  readonly onBack: (() => void) | undefined;
  /** Cites selected text into the thread's composer, like quoting an assistant response. */
  readonly onCite?:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean)
    | undefined;
}) {
  const [citationViewport, setCitationViewport] = useState<HTMLDivElement | null>(null);
  const query = useEnvironmentQuery(
    linearIssueDetail({
      environmentId: threadRef.environmentId,
      input: { reference: identifier },
    }),
  );
  const link = useThreadShell(threadRef)?.linearIssues?.find(
    (entry) => entry.identifier === identifier,
  );
  const syncedUpdatedAt = link?.snapshot?.updatedAt ?? null;
  const { refresh } = query;
  useEffect(() => {
    if (syncedUpdatedAt !== null) refresh();
  }, [refresh, syncedUpdatedAt]);
  // Linear's live feed: re-read as soon as this issue changes, comments included.
  const change = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(linearIssueChanges({ environmentId: threadRef.environmentId, input: {} })),
    ),
  );
  const issueId = query.data?.id ?? link?.issueId ?? null;
  useEffect(() => {
    if (change && (change.identifier === identifier || change.issueId === issueId)) refresh();
  }, [change, identifier, issueId, refresh]);

  const detail = query.data;
  if (detail === null) {
    return query.error ? (
      <UnavailableState message={query.error} onRetry={refresh} onBack={onBack} />
    ) : (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <IssueHeader
        detail={detail}
        refreshing={query.isPending}
        onRefresh={refresh}
        onBack={onBack}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div
          ref={setCitationViewport}
          data-assistant-citation-viewport="true"
          className="flex flex-col gap-5 px-4 pt-2 pb-6"
        >
          <IssueProperties detail={detail} />
          <Section title="Description">
            {detail.description.trim().length > 0 ? (
              <CitableText
                threadRef={threadRef}
                sourceId={linearCitationSourceId(identifier, "description")}
              >
                <ChatMarkdown
                  text={detail.description}
                  cwd={undefined}
                  threadRef={threadRef}
                  pullRequestPanelRef={threadRef}
                  environmentId={threadRef.environmentId}
                />
              </CitableText>
            ) : (
              <p className="text-sm text-muted-foreground">No description.</p>
            )}
          </Section>
          {detail.attachments.length > 0 ? (
            <Section title={`Links (${detail.attachments.length})`}>
              <IssueAttachments threadRef={threadRef} attachments={detail.attachments} />
            </Section>
          ) : null}
          <Section title="Activity">
            {detail.activityTruncated ? (
              <p className="text-xs text-muted-foreground">
                Showing the latest activity.{" "}
                <a
                  href={detail.url}
                  className="underline"
                  onClick={(event) => openInLinear(event, detail.url)}
                >
                  Open in Linear
                </a>{" "}
                for older comments.
              </p>
            ) : null}
            <IssueActivity
              threadRef={threadRef}
              identifier={detail.identifier}
              activity={detail.activity}
            />
          </Section>
        </div>
      </ScrollArea>
      {onCite ? (
        <AssistantSelectionToolbar
          viewport={citationViewport}
          threadRef={threadRef}
          onCite={onCite}
        />
      ) : null}
      <footer className="border-t border-border/60 px-3 py-1.5 text-[.7rem] text-muted-foreground">
        {query.dataUpdatedAt > 0
          ? `Read from Linear ${formatRelativeTimeLabel(new Date(query.dataUpdatedAt).toISOString())} · updates while open`
          : "Updates while open"}
      </footer>
    </div>
  );
}

function IssueHeader({
  detail,
  refreshing,
  onRefresh,
  onBack,
}: {
  readonly detail: LinearIssueDetail;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onBack: (() => void) | undefined;
}) {
  const reviewUrl = linearIssueReviewUrl(detail);
  return (
    <header className="flex flex-col gap-2 border-b border-border/60 px-4 pt-3 pb-3">
      <div className="flex items-center gap-2">
        {onBack ? (
          <Button size="icon-xs" variant="ghost" aria-label="All linked issues" onClick={onBack}>
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {detail.identifier}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh from Linear"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? <Spinner /> : <RefreshCwIcon />}
          </Button>
          {reviewUrl ? (
            <Button size="xs" variant="outline" onClick={(event) => openInLinear(event, reviewUrl)}>
              <PullRequestGlyph.pullRequest />
              Review
            </Button>
          ) : null}
          <Button size="xs" variant="outline" onClick={(event) => openInLinear(event, detail.url)}>
            <ArrowUpRightIcon />
            Open in Linear
          </Button>
        </div>
      </div>
      <h2 className="text-base font-medium leading-snug">{detail.title}</h2>
    </header>
  );
}

function PropertyRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="contents">
      <dt className="flex h-7 items-center text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-h-7 min-w-0 items-center gap-2 text-sm">{children}</dd>
    </div>
  );
}

function IssueProperties({ detail }: { readonly detail: LinearIssueDetail }) {
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3">
      <PropertyRow label="Status">
        <LinearStatusIcon state={detail.state} />
        <span className="truncate">{detail.state.name}</span>
      </PropertyRow>
      <PropertyRow label="Priority">
        <LinearPriorityIcon priority={detail.priority} />
        <span className="truncate">{detail.priorityLabel}</span>
      </PropertyRow>
      <PropertyRow label="Assignee">
        {detail.assignee ? (
          <>
            <Avatar person={detail.assignee} />
            <span className="truncate">{detail.assignee.name}</span>
          </>
        ) : (
          <>
            <UserRoundIcon className="size-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Unassigned</span>
          </>
        )}
      </PropertyRow>
      {detail.labels.length > 0 ? (
        <PropertyRow label="Labels">
          <span className="flex flex-wrap gap-1 py-1">
            {detail.labels.map((label) => (
              <span
                key={label.name}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-2 py-0.5 text-xs"
              >
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                {label.name}
              </span>
            ))}
          </span>
        </PropertyRow>
      ) : null}
      <PropertyRow label="Team">
        <span className="rounded bg-muted px-1 font-mono text-[.7rem] text-muted-foreground">
          {detail.team.key}
        </span>
        <span className="truncate">{detail.team.name}</span>
      </PropertyRow>
      {detail.project ? (
        <PropertyRow label="Project">
          <span className="truncate">{detail.project}</span>
        </PropertyRow>
      ) : null}
      <PropertyRow label="Branch">
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-xs">{detail.branchName}</span>
        <BranchCopyButton branchName={detail.branchName} />
      </PropertyRow>
    </dl>
  );
}

/** Copies the branch name, like the app's other copy icons: a check and an anchored toast. */
function BranchCopyButton({ branchName }: { readonly branchName: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    target: "branch name",
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Copy branch name"
            onClick={() => copyToClipboard(branchName, undefined)}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{isCopied ? "Copied" : "Copy branch name"}</p>
      </TooltipPopup>
    </Tooltip>
  );
}

const GITHUB_PULL_REQUEST = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/u;
const GITHUB_COMMIT = /github\.com\/([^/]+\/[^/]+)\/commit\/([0-9a-f]{7,40})/u;

/** What a Linear attachment is, so each link says where it goes. */
export function describeAttachment(attachment: {
  readonly url: string;
  readonly sourceType: string | null;
  readonly subtitle: string | null;
}): {
  readonly kind: "pull-request" | "commit" | "slack" | "link";
  readonly detail: string | null;
} {
  const pullRequest = GITHUB_PULL_REQUEST.exec(attachment.url);
  if (pullRequest) return { kind: "pull-request", detail: `${pullRequest[1]}#${pullRequest[2]}` };
  const commit = GITHUB_COMMIT.exec(attachment.url);
  if (commit) return { kind: "commit", detail: `Commit ${commit[2]!.slice(0, 7)} · ${commit[1]}` };
  if (attachment.sourceType === "slack" || /\.slack\.com\//u.test(attachment.url)) {
    return { kind: "slack", detail: "Slack" };
  }
  return { kind: "link", detail: attachment.subtitle };
}

function IssueAttachments({
  threadRef,
  attachments,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly attachments: LinearIssueDetail["attachments"];
}) {
  // Pull request links open the PR page in this panel, like links in the chat.
  const openLink = useOpenPrLink(threadRef);
  return (
    <ul className="flex flex-col">
      {attachments.map((attachment) => {
        const { kind, detail } = describeAttachment(attachment);
        const Icon =
          kind === "pull-request"
            ? PullRequestGlyph.pullRequest
            : kind === "commit"
              ? GitCommitHorizontalIcon
              : kind === "slack"
                ? SlackIcon
                : PaperclipIcon;
        return (
          <li key={attachment.url} className="flex items-center gap-1">
            <a
              href={attachment.url}
              onClick={(event) => void openLink(event, attachment.url, threadRef)}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-accent/60"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm">{attachment.title}</span>
                {detail ? (
                  <span className="truncate text-xs text-muted-foreground">{detail}</span>
                ) : null}
              </span>
            </a>
            {attachment.reviewUrl ? (
              <Button
                size="xs"
                variant="ghost"
                aria-label="Review in Linear"
                onClick={(event) => openInLinear(event, attachment.reviewUrl!)}
              >
                <ArrowUpRightIcon />
                Review
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

type CommentActivity = Extract<LinearIssueActivity, { kind: "comment" }>;
type ActivityItem =
  | { readonly kind: "thread"; readonly root: CommentActivity; readonly replies: CommentActivity[] }
  | { readonly kind: "event"; readonly entry: Exclude<LinearIssueActivity, { kind: "comment" }> };

/** Top-level entries in time order, each comment thread grouped under its first comment. */
export function groupIssueActivity(activity: ReadonlyArray<LinearIssueActivity>): ActivityItem[] {
  const commentIds = new Set(
    activity.flatMap((entry) => (entry.kind === "comment" ? [entry.id] : [])),
  );
  const replies = new Map<string, CommentActivity[]>();
  for (const entry of activity) {
    if (entry.kind === "comment" && entry.parentId && commentIds.has(entry.parentId)) {
      replies.set(entry.parentId, [...(replies.get(entry.parentId) ?? []), entry]);
    }
  }
  return activity.flatMap((entry): ActivityItem[] => {
    if (entry.kind !== "comment") return [{ kind: "event", entry }];
    if (entry.parentId && commentIds.has(entry.parentId)) return [];
    return [{ kind: "thread", root: entry, replies: replies.get(entry.id) ?? [] }];
  });
}

function IssueActivity({
  threadRef,
  identifier,
  activity,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly identifier: string;
  readonly activity: ReadonlyArray<LinearIssueActivity>;
}) {
  const items = useMemo(() => groupIssueActivity(activity), [activity]);
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {items.map((item) =>
        item.kind === "thread" ? (
          <li key={item.root.id}>
            <CommentThread
              threadRef={threadRef}
              identifier={identifier}
              root={item.root}
              replies={item.replies}
            />
          </li>
        ) : (
          <li
            key={item.entry.id}
            className="flex items-center gap-2 px-1 text-xs text-muted-foreground"
          >
            <Avatar person={item.entry.actor} size="sm" />
            <span className="min-w-0">
              <span className="text-foreground/80">{item.entry.actor?.name ?? "Linear"}</span>{" "}
              {describeChange(item.entry)}
            </span>
            <span className="shrink-0">· {formatRelativeTimeLabel(item.entry.createdAt)}</span>
          </li>
        ),
      )}
    </ol>
  );
}

/**
 * A comment and its replies in one card, like Linear. A thread synced with
 * Slack leads with where it's connected instead of Linear's placeholder text.
 */
function CommentThread({
  threadRef,
  identifier,
  root,
  replies,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly identifier: string;
  readonly root: CommentActivity;
  readonly replies: ReadonlyArray<CommentActivity>;
}) {
  const synced = root.syncedThread;
  const comments = synced ? replies : [root, ...replies];
  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      {synced ? (
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-xs">
          {/slack/iu.test(synced.source) ? (
            <SlackIcon className="size-3.5 shrink-0" />
          ) : (
            <LinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">
            <span className="font-medium">{synced.source}</span>
            <span className="text-muted-foreground"> thread connected</span>
            {synced.displayName ? (
              <>
                <span className="text-muted-foreground"> in </span>
                {synced.url ? (
                  <a
                    href={synced.url}
                    className="font-medium hover:underline"
                    onClick={(event) => openInLinear(event, synced.url!)}
                  >
                    {synced.displayName}
                  </a>
                ) : (
                  <span className="font-medium">{synced.displayName}</span>
                )}
              </>
            ) : null}
          </span>
          <span className="ml-auto shrink-0 text-muted-foreground">
            {formatRelativeTimeLabel(root.createdAt)}
          </span>
        </div>
      ) : null}
      {comments.map((comment, index) => {
        // Like Linear: a thread's first comment leads at full width; replies indent under
        // their author's name. In a synced thread the connection header leads instead.
        const leads = !synced && index === 0;
        const firstReply = synced ? index === 0 : index === 1;
        return (
          <div key={comment.id}>
            {index > 0 ? (
              <div className={cn("border-t border-border/60", !firstReply && "ml-9")} />
            ) : null}
            <div className="px-3 py-2.5">
              <div className="mb-1 flex items-center gap-2 text-xs">
                <Avatar person={comment.actor} size="sm" />
                <span className="truncate font-medium">{comment.actor?.name ?? "Someone"}</span>
                <span className="shrink-0 text-muted-foreground">
                  {formatRelativeTimeLabel(comment.createdAt)}
                  {comment.via ? ` via ${comment.via}` : ""}
                </span>
              </div>
              <CitableText
                threadRef={threadRef}
                sourceId={linearCitationSourceId(identifier, `comment:${comment.id}`)}
                className={leads ? "text-[0.95rem]" : "pl-6"}
              >
                <ChatMarkdown
                  text={comment.body}
                  cwd={undefined}
                  threadRef={threadRef}
                  pullRequestPanelRef={threadRef}
                  environmentId={threadRef.environmentId}
                />
              </CitableText>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** What a recorded change says after its actor's name, e.g. "moved from Todo to In Progress". */
export function describeChange(
  entry: Exclude<LinearIssueActivity, { kind: "comment" }>,
): ReactNode {
  switch (entry.kind) {
    case "created":
      return "created the issue";
    case "state":
      return (
        <>
          moved{" "}
          {entry.from ? (
            <>
              from <StateChip state={entry.from} />{" "}
            </>
          ) : null}
          to {entry.to ? <StateChip state={entry.to} /> : "no state"}
        </>
      );
    case "assignee":
      return entry.to ? `assigned ${entry.to}` : `unassigned ${entry.from ?? "the issue"}`;
    case "labels":
      return [
        entry.added.length > 0 ? `added ${entry.added.join(", ")}` : null,
        entry.removed.length > 0 ? `removed ${entry.removed.join(", ")}` : null,
      ]
        .filter((part) => part !== null)
        .join(" and ");
    case "priority":
      return `set priority to ${entry.to ?? "none"}`;
    case "title":
      return `renamed the issue to “${entry.to ?? ""}”`;
    case "attachment":
      return `linked ${entry.title}`;
  }
}

function StateChip({
  state,
}: {
  readonly state: Extract<LinearIssueActivity, { kind: "state" }>["to"] & {};
}) {
  return (
    <span className="inline-flex items-center gap-1 align-middle text-foreground/80">
      <LinearStatusIcon state={state} className="size-3" />
      {state.name}
    </span>
  );
}

/** A person's Linear avatar, or their initials when they have none. */
function Avatar({
  person,
  size = "md",
}: {
  readonly person: LinearIssueDetailPerson | null;
  readonly size?: "sm" | "md";
}) {
  const sizeClass = size === "sm" ? "size-4 text-[.5rem]" : "size-5 text-[.6rem]";
  if (person?.avatarUrl) {
    return <img src={person.avatarUrl} alt="" className={cn("shrink-0 rounded-full", sizeClass)} />;
  }
  const initials = (person?.name ?? "?")
    .split(/\s+/u)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground",
        sizeClass,
      )}
    >
      {initials}
    </span>
  );
}

/**
 * Marks text the chat's selection toolbar can cite, the way assistant
 * responses are marked; the source id says which issue and part it came from.
 */
function CitableText({
  threadRef,
  sourceId,
  className,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly sourceId: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={className}
      data-assistant-citation-source={sourceId}
      data-assistant-citation-environment={threadRef.environmentId}
      data-assistant-citation-thread={threadRef.threadId}
    >
      {children}
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function UnavailableState({
  message,
  onRetry,
  onBack,
}: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly onBack: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  return (
    <Empty className="min-h-0 justify-center-safe">
      <EmptyHeader>
        <EmptyTitle>Couldn't load this issue</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <div className="flex flex-wrap justify-center gap-2">
        {onBack ? (
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon />
            Linked issues
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCwIcon />
          Retry
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void navigate({ to: "/settings/connections", hash: "linear-api-key" })}
        >
          <SettingsIcon />
          Linear settings
        </Button>
      </div>
    </Empty>
  );
}
