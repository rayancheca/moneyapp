import { NextResponse, type NextRequest } from "next/server";

import { isHostAllowed } from "@/lib/allowed-hosts";

/**
 * DNS-rebinding defense for every page, asset and Server Action.
 *
 * This file must live at `src/proxy.ts` and export `proxy`. Next resolves the
 * convention against the directory containing `app/`, so a root-level
 * `proxy.ts` is accepted by the build with NO warning and NO tree entry — and
 * the perimeter is then silently absent while the app still serves. A wrong
 * export name fails the build loudly; a wrong location does not. Do not move
 * this file, and do not add route segment config (`export const runtime`) —
 * a proxy always runs on the Node runtime and declaring it is a build error.
 *
 * The allowlist itself lives in `@/lib/allowed-hosts` so it sits inside the
 * repo's 100%-coverage gate; this stays a thin adapter.
 */
export function proxy(request: NextRequest): NextResponse {
  if (!isHostAllowed(request.headers.get("host"))) {
    return new NextResponse("Forbidden: MoneyApp does not serve this host", { status: 403 });
  }
  return NextResponse.next();
}
