import type { OrchestrationV2DomainEvent, OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { RelayLinearActivity } from "@t3tools/contracts/relay";

const MAX_BODY_CHARS = 8_000;
const MAX_PARAMETER_CHARS = 2_000;

/** Message ids the mirror never echoes: the launch prompt and replies that came from Linear. */
const LINEAR_ORIGIN_MESSAGE_PREFIXES = ["linear-session:", "linear-prompt:"];

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const FINISHED_ITEM_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

type TurnItem<Type extends OrchestrationV2TurnItem["type"]> = Extract<
  OrchestrationV2TurnItem,
  { readonly type: Type }
>;

function actionFor(item: OrchestrationV2TurnItem): RelayLinearActivity | null {
  switch (item.type) {
    case "command_execution":
      return {
        type: "action",
        action: "Ran",
        parameter: truncate(item.input, MAX_PARAMETER_CHARS),
        ...(item.exitCode !== undefined && item.exitCode !== 0
          ? { result: `Exit code ${item.exitCode}` }
          : {}),
      };
    case "file_change": {
      const stats = [
        item.additions === undefined ? null : `+${item.additions}`,
        item.deletions === undefined ? null : `-${item.deletions}`,
      ].filter((part) => part !== null);
      return {
        type: "action",
        action: "Edited",
        parameter: truncate(item.fileName, MAX_PARAMETER_CHARS),
        ...(stats.length > 0 ? { result: stats.join(" ") } : {}),
      };
    }
    case "web_search":
      return {
        type: "action",
        action: "Searched the web",
        parameter: truncate((item.patterns ?? []).join(", "), MAX_PARAMETER_CHARS),
      };
    case "file_search":
      return {
        type: "action",
        action: "Searched files",
        parameter: truncate(item.pattern ?? "", MAX_PARAMETER_CHARS),
      };
    case "dynamic_tool":
      return {
        type: "action",
        action: truncate(item.toolName ?? item.title ?? "Used a tool", 200),
        parameter: item.toolName && item.title ? truncate(item.title, MAX_PARAMETER_CHARS) : "",
      };
    default:
      return null;
  }
}

function questionFor(item: TurnItem<"approval_request"> | TurnItem<"user_input_request">) {
  const asked =
    item.type === "approval_request"
      ? `Otter Code needs approval: ${item.prompt ?? item.title ?? item.requestKind}`
      : item.questions.map((question) => question.question).join("\n\n");
  return truncate(`${asked}\n\nAnswer in Otter Code to continue.`, MAX_BODY_CHARS);
}

/**
 * Turns one delegated thread's events into Linear agent activities. Linear
 * can't edit an activity once posted and shows finished steps, so this posts
 * each step once it's done: tool calls as actions, questions as elicitations,
 * assistant messages as thoughts. The latest assistant message is held back
 * so the one that ends a run becomes its response.
 */
export class LinearSessionActivityMirror {
  private readonly seen = new Set<string>();
  private held: string | null = null;

  apply(event: OrchestrationV2DomainEvent): ReadonlyArray<RelayLinearActivity> {
    if (event.type === "run.updated") return this.applyRun(event.payload);
    if (event.type === "turn-item.updated") return this.applyItem(event.payload);
    return [];
  }

  private once(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private flushHeld(): Array<RelayLinearActivity> {
    const held = this.held;
    this.held = null;
    return held === null ? [] : [{ type: "thought", body: held }];
  }

  private applyItem(item: OrchestrationV2TurnItem): ReadonlyArray<RelayLinearActivity> {
    switch (item.type) {
      case "assistant_message": {
        const text = item.text.trim();
        if (item.status !== "completed" || text.length === 0 || !this.once(item.id)) return [];
        const flushed = this.flushHeld();
        this.held = truncate(text, MAX_BODY_CHARS);
        return flushed;
      }
      case "user_message": {
        const text = item.text.trim();
        if (
          text.length === 0 ||
          LINEAR_ORIGIN_MESSAGE_PREFIXES.some((prefix) => item.messageId.startsWith(prefix)) ||
          !this.once(item.id)
        ) {
          return [];
        }
        return [
          ...this.flushHeld(),
          {
            type: "thought",
            body: truncate(`Message sent in Otter Code:\n\n${text}`, MAX_BODY_CHARS),
          },
        ];
      }
      case "approval_request":
      case "user_input_request":
        if (FINISHED_ITEM_STATUSES.has(item.status) || !this.once(item.id)) return [];
        return [...this.flushHeld(), { type: "elicitation", body: questionFor(item) }];
      default: {
        const action = actionFor(item);
        if (action === null || !FINISHED_ITEM_STATUSES.has(item.status) || !this.once(item.id)) {
          return [];
        }
        return [...this.flushHeld(), action];
      }
    }
  }

  private applyRun(
    run: Extract<OrchestrationV2DomainEvent, { readonly type: "run.updated" }>["payload"],
  ): ReadonlyArray<RelayLinearActivity> {
    switch (run.status) {
      case "completed": {
        if (!this.once(`run:${run.id}`)) return [];
        const response = this.held ?? "Done.";
        this.held = null;
        return [{ type: "response", body: response }];
      }
      case "failed":
        if (!this.once(`run:${run.id}`)) return [];
        return [
          ...this.flushHeld(),
          { type: "error", body: "The run failed. Open the thread in Otter Code for details." },
        ];
      // A steering restart also interrupts a run, so only keep what it said.
      case "interrupted":
      case "cancelled":
        return this.flushHeld();
      default:
        return [];
    }
  }
}
