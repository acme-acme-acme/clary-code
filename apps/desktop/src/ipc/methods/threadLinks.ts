import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { takePendingThreadLink } from "../../app/DesktopThreadLinks.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const takePending = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TAKE_PENDING_THREAD_LINK_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.NullOr(Schema.String),
  handler: () =>
    Effect.sync(takePendingThreadLink).pipe(Effect.withSpan("desktop.ipc.threadLinks.takePending")),
});
