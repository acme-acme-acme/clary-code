import type { MouseEvent } from "react";

import { readLocalApi } from "~/localApi";

/** Linear lives outside the app, so issues always open in the system browser. */
export function openInLinear(event: MouseEvent<HTMLElement> | null, url: string) {
  event?.preventDefault();
  void readLocalApi()
    ?.shell.openExternal(url)
    .catch((error: unknown) => console.error(error));
}
