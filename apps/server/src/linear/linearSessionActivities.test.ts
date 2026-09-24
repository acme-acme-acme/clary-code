import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";

import { LinearSessionActivityMirror } from "./linearSessionActivities.ts";

// Only the fields the mirror reads; the rest of a domain event is irrelevant here.
const item = (fields: Record<string, unknown>) =>
  ({ type: "turn-item.updated", payload: fields }) as unknown as OrchestrationV2DomainEvent;
const run = (id: string, status: string) =>
  ({ type: "run.updated", payload: { id, status } }) as unknown as OrchestrationV2DomainEvent;

describe("LinearSessionActivityMirror", () => {
  it("posts steps once they finish and ends a run with its last message", () => {
    const mirror = new LinearSessionActivityMirror();
    const posted = [
      item({ id: "a1", type: "assistant_message", status: "running", text: "Look" }),
      item({ id: "a1", type: "assistant_message", status: "completed", text: "Looking around." }),
      item({ id: "c1", type: "command_execution", status: "running", input: "vp test" }),
      item({
        id: "c1",
        type: "command_execution",
        status: "failed",
        input: "vp test",
        exitCode: 1,
      }),
      item({
        id: "c1",
        type: "command_execution",
        status: "failed",
        input: "vp test",
        exitCode: 1,
      }),
      item({ id: "f1", type: "file_change", status: "completed", fileName: "a.ts", additions: 3 }),
      item({ id: "a2", type: "assistant_message", status: "completed", text: "Fixed it." }),
      run("run-1", "completed"),
      run("run-1", "completed"),
    ].flatMap((event) => mirror.apply(event));

    assert.deepStrictEqual(posted, [
      { type: "thought", body: "Looking around." },
      { type: "action", action: "Ran", parameter: "vp test", result: "Exit code 1" },
      { type: "action", action: "Edited", parameter: "a.ts", result: "+3" },
      { type: "response", body: "Fixed it." },
    ]);
  });

  it("asks once per question and never echoes messages that came from Linear", () => {
    const mirror = new LinearSessionActivityMirror();
    const question = item({
      id: "q1",
      type: "user_input_request",
      status: "waiting",
      questions: [{ question: "Which database?" }],
    });
    const posted = [
      item({ id: "u0", type: "user_message", messageId: "linear-session:s1", text: "Issue" }),
      item({ id: "u1", type: "user_message", messageId: "linear-prompt:act-1", text: "Use pg" }),
      item({ id: "u2", type: "user_message", messageId: "message-9", text: "Also add tests" }),
      question,
      question,
      run("run-1", "failed"),
    ].flatMap((event) => mirror.apply(event));

    assert.deepStrictEqual(posted, [
      { type: "thought", body: "Message sent in Otter Code:\n\nAlso add tests" },
      { type: "elicitation", body: "Which database?\n\nAnswer in Otter Code to continue." },
      { type: "error", body: "The run failed. Open the thread in Otter Code for details." },
    ]);
  });

  it("keeps what an interrupted run said without calling it finished", () => {
    const mirror = new LinearSessionActivityMirror();
    const posted = [
      item({ id: "a1", type: "assistant_message", status: "completed", text: "Halfway." }),
      run("run-1", "interrupted"),
      run("run-2", "completed"),
    ].flatMap((event) => mirror.apply(event));

    assert.deepStrictEqual(posted, [
      { type: "thought", body: "Halfway." },
      { type: "response", body: "Done." },
    ]);
  });
});
