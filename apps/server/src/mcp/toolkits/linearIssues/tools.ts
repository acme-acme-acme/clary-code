import {
  LinearIssueStateType,
  McpCapabilityUnavailableError,
  ThreadLinearIssueLinkSource,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, OrchestratorV2];

export const LinearIssueTargetInput = Schema.Struct({
  issue: TrimmedNonEmptyString.annotate({
    description:
      "The issue identifier, for example ENG-123, or its linear.app URL, for example https://linear.app/acme/issue/ENG-123/title.",
  }),
});
export type LinearIssueTargetInput = typeof LinearIssueTargetInput.Type;

export class LinearIssueReferenceInvalidError extends Schema.TaggedError<LinearIssueReferenceInvalidError>()(
  "LinearIssueReferenceInvalidError",
  {},
) {
  override get message(): string {
    return "Pass a Linear issue identifier such as ENG-123 or a linear.app issue URL.";
  }
}

export class LinearIssueThreadNotFoundError extends Schema.TaggedError<LinearIssueThreadNotFoundError>()(
  "LinearIssueThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class LinearIssueLinkFailedError extends Schema.TaggedError<LinearIssueLinkFailedError>()(
  "LinearIssueLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not update the thread's Linear issues.";
  }
}

export const LinearIssueToolError = Schema.Union([
  McpCapabilityUnavailableError,
  LinearIssueReferenceInvalidError,
  LinearIssueThreadNotFoundError,
  LinearIssueLinkFailedError,
]);

export const LinkLinearIssueResult = Schema.Struct({
  identifier: Schema.String,
  alreadyLinked: Schema.Boolean,
});

export const UnlinkLinearIssueResult = Schema.Struct({
  identifier: Schema.String,
  wasLinked: Schema.Boolean,
});

export const ThreadLinearIssueEntry = Schema.Struct({
  identifier: Schema.String,
  url: Schema.String,
  source: ThreadLinearIssueLinkSource,
  title: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
  stateType: Schema.NullOr(LinearIssueStateType),
});
export type ThreadLinearIssueEntry = typeof ThreadLinearIssueEntry.Type;

export const ListThreadLinearIssuesResult = Schema.Struct({
  issues: Schema.Array(ThreadLinearIssueEntry),
});

const LinkLinearIssueTool = Tool.make("link_linear_issue", {
  description:
    "Link a Linear issue to this thread so Otter Code shows its status beside the thread. Link the issue you are working on when the user names one. Linking an already-linked issue succeeds with alreadyLinked=true.",
  parameters: LinearIssueTargetInput,
  success: LinkLinearIssueResult,
  failure: LinearIssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link Linear issue to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkLinearIssueTool = Tool.make("unlink_linear_issue", {
  description:
    "Remove a Linear issue link from this thread. Unlinking an issue that is not linked succeeds with wasLinked=false.",
  parameters: LinearIssueTargetInput,
  success: UnlinkLinearIssueResult,
  failure: LinearIssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink Linear issue from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadLinearIssuesTool = Tool.make("list_thread_linear_issues", {
  description:
    "List the Linear issues linked to this thread with their last known status. Status is null until Otter Code has synced the issue.",
  success: ListThreadLinearIssuesResult,
  failure: LinearIssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread Linear issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const LinearIssuesToolkit = Toolkit.make(
  LinkLinearIssueTool,
  UnlinkLinearIssueTool,
  ListThreadLinearIssuesTool,
);
