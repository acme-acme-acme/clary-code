import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { isHostedStaticApp } from "~/hostedPairing";
import { desktopHandoffUrl, OPEN_IN_DESKTOP_PARAM, parseThreadPath } from "~/threadDeepLinks";

/** Matches `OPEN_THREAD_LINK_ACTION` in the desktop app. */
const OPEN_THREAD_LINK_ACTION = "open-thread-link";

/**
 * Opens threads from `ottercode://` links in the desktop app, and hands
 * hosted `?open=desktop` thread links (Linear's "Open in Otter Code") over
 * to the desktop app, staying on the web thread if it isn't installed.
 */
export function ThreadDeepLinkCoordinator() {
  const navigate = useNavigate();
  const openThread = useEffectEvent((path: string | null) => {
    const target = parseThreadPath(path);
    if (target) void navigate({ to: "/$environmentId/$threadId", params: target });
  });

  useEffect(() => {
    const bridge = window.desktopBridge;
    const take = bridge?.takePendingThreadLink;
    if (!bridge || !take) return;
    const openPending = () => void take().then(openThread, () => undefined);
    openPending();
    return bridge.onMenuAction((action) => {
      if (action === OPEN_THREAD_LINK_ACTION) openPending();
    });
  }, []);

  useEffect(() => {
    if (window.desktopBridge || !isHostedStaticApp()) return;
    const url = new URL(window.location.href);
    const handoff = desktopHandoffUrl(url, navigator.userAgent);
    if (!url.searchParams.has(OPEN_IN_DESKTOP_PARAM)) return;
    url.searchParams.delete(OPEN_IN_DESKTOP_PARAM);
    window.history.replaceState(window.history.state, "", url);
    if (handoff) window.location.assign(handoff);
  }, []);

  return null;
}
