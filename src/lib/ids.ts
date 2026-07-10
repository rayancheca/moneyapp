import { randomBytes } from "node:crypto";

/**
 * UUIDv7: 48-bit unix-ms timestamp + 12-bit monotonic counter (rand_a) +
 * random tail. Time-ordered TEXT primary keys — chosen so a future sync mode
 * can merge databases without collisions (schema.md global conventions).
 *
 * The counter makes same-millisecond ids strictly ascending (RFC 9562 §6.2
 * method 1): bulk imports insert hundreds of rows per ms, and queries that
 * tiebreak on id (transactions ledger) must order identically across reseeds
 * or visual baselines shuffle. Counter overflow borrows the next millisecond.
 * An explicit `now` earlier than the last call is honored as-given (tests and
 * backfills own their timestamps) — monotonicity is guaranteed only for the
 * real-clock path, which never runs backward.
 */
let lastMs = -1;
let counter = 0;

export function uuidv7(now: number = Date.now()): string {
  let effectiveMs = now;
  if (now === lastMs) {
    counter += 1;
    if (counter > 0xfff) {
      lastMs += 1;
      counter = 0;
    }
    effectiveMs = lastMs;
  } else if (now > lastMs) {
    lastMs = now;
    counter = 0;
  } else {
    // explicit past timestamp: encode faithfully, no counter continuity
    counter = 0;
  }

  const bytes = randomBytes(16);
  const ts = BigInt(effectiveMs);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7 + counter high
  bytes[7] = counter & 0xff; // counter low
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
