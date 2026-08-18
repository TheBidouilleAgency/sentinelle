import { log, errorFields } from "./log.ts";

const PING_TIMEOUT_MS = 5_000;

/**
 * Dead man's switch : sans ce ping, un service mort est indistinguable d'un
 * service qui n'a rien à signaler. Fire-and-forget, un échec ne casse rien.
 */
export async function pingHealthcheck(url: string | null): Promise<void> {
  if (url === null) return;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "user-agent": "sentinelle/1.0" },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    log.debug("healthcheck.ping", { status: res.status });
  } catch (err) {
    log.debug("healthcheck.failed", errorFields(err));
  }
}
