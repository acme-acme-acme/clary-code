import { EnvironmentId, ThreadId } from "@t3tools/contracts";

/** Desktop app scheme on every OS; `ottercode://app/<path>` opens that path in the app. */
const DESKTOP_APP_SCHEME = "ottercode";
/** Set on links that should hand off from the hosted app to the desktop app, like Linear's. */
export const OPEN_IN_DESKTOP_PARAM = "open";

/** `/<environmentId>/<threadId>` as route params, or null for any other path. */
export function parseThreadPath(
  path: string | null,
): { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null {
  if (path === null) return null;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  try {
    const [environmentId, threadId] = segments.map((segment) => decodeURIComponent(segment));
    return environmentId && threadId
      ? { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) }
      : null;
  } catch {
    return null;
  }
}

/**
 * The desktop-app link for a hosted thread URL carrying `?open=desktop`, or
 * null when the page should just stay on the web: other pages, and phones.
 */
export function desktopHandoffUrl(url: URL, userAgent: string): string | null {
  if (url.searchParams.get(OPEN_IN_DESKTOP_PARAM) !== "desktop") return null;
  if (/Android|iPhone|iPad|iPod/iu.test(userAgent)) return null;
  if (parseThreadPath(url.pathname) === null) return null;
  return `${DESKTOP_APP_SCHEME}://app${url.pathname}`;
}
