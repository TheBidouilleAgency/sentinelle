import type { Embed } from "./format.ts";
import { log } from "../log.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const USER_AGENT = "sentinelle/1.0 (status page watcher)";

export interface ForumClient {
  /** Crée un post de forum et retourne l'id du thread. */
  createThread(webhookUrl: string, name: string, embed: Embed): Promise<string>;
  /** Répond dans un post existant. */
  postMessage(webhookUrl: string, threadId: string, embed: Embed): Promise<void>;
}

export class DiscordForumClient implements ForumClient {
  /** Toutes les requêtes passent par cette chaîne : jamais deux en parallèle. */
  #queue: Promise<unknown> = Promise.resolve();

  async createThread(webhookUrl: string, name: string, embed: Embed): Promise<string> {
    const { url, payload } = createThreadRequest(webhookUrl, name, embed);
    // wait=true est obligatoire : la réponse porte channel_id, l'id du thread.
    const body = await this.#send(url, payload);
    const threadId = (body as { channel_id?: unknown } | null)?.channel_id;
    if (typeof threadId !== "string") {
      throw new Error("Réponse Discord sans channel_id : impossible de suivre le thread");
    }
    return threadId;
  }

  async postMessage(webhookUrl: string, threadId: string, embed: Embed): Promise<void> {
    const { url, payload } = postMessageRequest(webhookUrl, threadId, embed);
    await this.#send(url, payload);
  }

  #send(url: string, payload: unknown): Promise<unknown> {
    const run = this.#queue.then(
      () => request(url, payload),
      () => request(url, payload),
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * Création d'un post de forum. `thread_name` va dans le **corps JSON** : passé
 * en query string, Discord répond 400 / 220001 "Webhooks posted to forum
 * channels must have a thread_name or thread_id".
 */
export function createThreadRequest(
  webhookUrl: string,
  name: string,
  embed: Embed,
): { url: string; payload: unknown } {
  return {
    url: withQuery(webhookUrl, { wait: "true" }),
    payload: { thread_name: name, embeds: [embed] },
  };
}

/** Réponse dans un post existant : `thread_id` est bien un paramètre de query. */
export function postMessageRequest(
  webhookUrl: string,
  threadId: string,
  embed: Embed,
): { url: string; payload: unknown } {
  return {
    url: withQuery(webhookUrl, { wait: "true", thread_id: threadId }),
    payload: { embeds: [embed] },
  };
}

async function request(url: string, payload: unknown): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.ok) {
      const text = await res.text();
      return text.length > 0 ? (JSON.parse(text) as unknown) : null;
    }

    const text = await res.text().catch(() => "");

    if (res.status === 429) {
      const retryAfterSeconds = parseRetryAfter(text, res.headers.get("retry-after"));
      lastError = new Error(`Discord 429, retry_after=${retryAfterSeconds}s`);
      log.warn("discord.rate_limited", { attempt, retryAfterSeconds });
      if (attempt < MAX_ATTEMPTS) {
        await sleep(retryAfterSeconds * 1000);
        continue;
      }
      break;
    }

    if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
      lastError = new Error(`Discord ${res.status}: ${truncateForLog(text)}`);
      log.warn("discord.server_error", { attempt, status: res.status });
      await sleep(attempt * 1000);
      continue;
    }

    throw new Error(`Discord ${res.status}: ${truncateForLog(text)}`);
  }

  throw lastError ?? new Error("Discord: échec après plusieurs tentatives");
}

function parseRetryAfter(body: string, header: string | null): number {
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown };
    if (typeof parsed.retry_after === "number" && Number.isFinite(parsed.retry_after)) {
      return Math.min(Math.max(parsed.retry_after, 0), 60);
    }
  } catch {
    // corps non JSON : on retombe sur l'en-tête
  }
  const fromHeader = header !== null ? Number(header) : Number.NaN;
  return Number.isFinite(fromHeader) ? Math.min(Math.max(fromHeader, 0), 60) : 1;
}

function withQuery(webhookUrl: string, params: Record<string, string>): string {
  const url = new URL(webhookUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function truncateForLog(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Client de substitution pour DRY_RUN : logge et ne poste rien. */
export class DryRunForumClient implements ForumClient {
  #counter = 0;

  createThread(_webhookUrl: string, name: string, embed: Embed): Promise<string> {
    const threadId = `dry-run-thread-${++this.#counter}`;
    log.info("dry_run.create_thread", { threadName: name, threadId, embed });
    return Promise.resolve(threadId);
  }

  postMessage(_webhookUrl: string, threadId: string, embed: Embed): Promise<void> {
    log.info("dry_run.post_message", { threadId, embed });
    return Promise.resolve();
  }
}
