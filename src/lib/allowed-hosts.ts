/**
 * The app's entire security boundary.
 *
 * MoneyApp is deliberately unauthenticated because it binds to loopback
 * (`next start -H 127.0.0.1`). That is only safe while the Host header is
 * trusted: a hostile website can point its own DNS name at 127.0.0.1 and drive
 * this API from the visitor's browser (DNS rebinding). Rejecting any Host that
 * isn't explicitly allowed closes that hole for pages AND server actions.
 *
 * Remote access (Tailscale Serve) needs exactly one more hostname to be
 * admitted, so extra hosts come from MONEYAPP_ALLOWED_HOSTS. Loopback is
 * hard-coded and never sourced from env, so an unset variable reproduces the
 * historical local-only posture byte for byte.
 *
 * Deliberately absent: any `x-forwarded-host` fallback. That header is
 * attacker-controlled and would defeat the very defense this module exists to
 * provide. There are zero `x-forwarded-*` reads in src today; keep it zero.
 */

/** Always admitted, regardless of env. `next start -H 127.0.0.1` binds here. */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;

/** Extra hostnames come from this variable, comma-separated. */
export const ALLOWED_HOSTS_ENV_VAR = "MONEYAPP_ALLOWED_HOSTS";

/**
 * Reduce a raw `Host` header to a bare hostname for comparison.
 *
 * Strips the port, because a Host is `name:port` and the allowlist is about
 * names — admitting `moneyapp.example.ts.net` must not depend on whether
 * Tailscale forwarded it on :443 or :3000. IPv6 literals arrive bracketed
 * (`[::1]:3000`), and the brackets are KEPT: they are what distinguishes the
 * address from a lone colon-separated port, and dropping them would make the
 * bare-`::1` case below indistinguishable from an empty hostname.
 *
 * Lowercased because DNS is case-insensitive: a browser may send `LocalHost`
 * and RFC 4343 says that is the same name. This is applied symmetrically to
 * both sides, so it widens nothing that the allowlist did not already name.
 */
export function hostnameFromHostHeader(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    // An unterminated bracket is malformed; yield "" so it can never match.
    return close === -1 ? "" : trimmed.slice(0, close + 1).toLowerCase();
  }
  return trimmed.split(":")[0]!.toLowerCase();
}

/**
 * Parse MONEYAPP_ALLOWED_HOSTS into a set of comparable hostnames.
 *
 * Entries run through the SAME normalizer as the incoming Host. Without that,
 * an operator who writes `moneyapp.example.ts.net:443` — a completely
 * reasonable thing to copy out of a URL — would configure an entry that can
 * never match anything, and the failure would look like Tailscale being broken
 * rather than like a typo.
 */
export function parseAllowedHosts(raw: string | undefined): Set<string> {
  const extra = (raw ?? "")
    .split(",")
    .map(hostnameFromHostHeader)
    .filter((entry) => entry.length > 0);
  return new Set<string>([...LOOPBACK_HOSTNAMES, ...extra]);
}

/**
 * True when this `Host` header may be served.
 *
 * Reads the environment on every call rather than at module scope. Module-level
 * capture would freeze the value for the lifetime of the process, which makes
 * the behaviour untestable without `vi.resetModules()` and would silently
 * ignore an operator's edit until a full restart.
 */
export function isHostAllowed(host: string | null | undefined): boolean {
  if (!host) return false;
  const hostname = hostnameFromHostHeader(host);
  if (hostname.length === 0) return false;
  return parseAllowedHosts(process.env[ALLOWED_HOSTS_ENV_VAR]).has(hostname);
}
