import * as Effect from "effect/Effect";
import * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import { DESKTOP_HOST, getDesktopScheme } from "../electron/ElectronProtocol.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/** Tells an open window to take the pending link; see `takePendingThreadLink`. */
export const OPEN_THREAD_LINK_ACTION = "open-thread-link";

/**
 * `ottercode://app/<environmentId>/<threadId>` as the in-app thread path, or
 * null for any other URL. Clerk's sign-in callback is the bare `ottercode://app/`.
 */
export function threadPathFromDeepLink(url: string, scheme: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${scheme}:` || parsed.host !== DESKTOP_HOST) return null;
    const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length !== 2) return null;
    return `/${segments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join("/")}`;
  } catch {
    return null;
  }
}

// The window may not exist yet when a link launches the app, so the renderer
// pulls the link once it can navigate instead of being sent it.
let pendingThreadPath: string | null = null;

export function takePendingThreadLink(): string | null {
  const path = pendingThreadPath;
  pendingThreadPath = null;
  return path;
}

/**
 * Opens threads from `ottercode://` links, such as Linear's "Open in Otter
 * Code". macOS delivers them through `open-url`; Windows and Linux start the
 * app, or a second instance, with the link as an argument.
 */
export const register = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopWindow.DesktopWindow>();
  const runPromise = Effect.runPromiseWith(context);
  const scheme = getDesktopScheme(environment.isDevelopment);

  const receive = (url: string): boolean => {
    const path = threadPathFromDeepLink(url, scheme);
    if (path === null) return false;
    pendingThreadPath = path;
    // Before `ready` no window can exist; the renderer takes the link on start.
    if (Electron.app.isReady()) {
      void runPromise(
        desktopWindow.dispatchMenuAction(OPEN_THREAD_LINK_ACTION).pipe(Effect.ignoreCause),
      );
    }
    return true;
  };

  for (const argument of process.argv) receive(argument);
  yield* electronApp.on("open-url", (event: Electron.Event, url: string) => {
    if (receive(url)) event.preventDefault();
  });
  yield* electronApp.on(
    "second-instance",
    (_event: Electron.Event, argv: ReadonlyArray<string>) => {
      for (const argument of argv) receive(argument);
    },
  );
});
