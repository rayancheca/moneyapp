import { NextResponse, type NextRequest } from "next/server";

const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * DNS-rebinding defense: the server is deliberately unauthenticated because
 * it binds to loopback — but a hostile website can rebind its own hostname
 * to 127.0.0.1 and drive the API from the browser. Rejecting any Host that
 * isn't literally localhost closes that hole for pages AND server actions.
 */
export function middleware(request: NextRequest): NextResponse {
  const host = request.headers.get("host") ?? "";
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  if (!ALLOWED_HOSTNAMES.has(hostname)) {
    return new NextResponse("Forbidden: MoneyApp only serves localhost", { status: 403 });
  }
  return NextResponse.next();
}
