import type { Action } from "./reducer.ts";
import { getTracked, putTracked, snapshot, type State } from "./state.ts";

/**
 * Applique au state le résultat d'une action **réellement exécutée**.
 * Partagé entre le runtime et les tests : l'idempotence testée est donc
 * exactement celle du service.
 */
export function applyAction(
  state: State,
  action: Action,
  now: Date,
  createdThreadId?: string,
): void {
  const { providerKey, id } = action.incident;

  if (action.type === "CREATE_THREAD") {
    if (createdThreadId === undefined) {
      throw new Error("applyAction(CREATE_THREAD) : threadId manquant");
    }
    const existing = getTracked(state, providerKey, id);
    const posted = new Set(existing?.postedUpdateIds ?? []);
    const first = action.incident.updates[0];
    if (first) posted.add(first.id); // inclus dans le post initial
    putTracked(state, providerKey, id, {
      threadId: createdThreadId,
      postedUpdateIds: [...posted],
      closed: false,
      ...snapshot(action.incident, now),
    });
    return;
  }

  const entry = getTracked(state, providerKey, id);
  if (!entry) throw new Error(`applyAction : incident ${providerKey}/${id} absent du state`);
  entry.lastSeenAt = now.toISOString();

  if (action.type === "POST_UPDATE") {
    if (!entry.postedUpdateIds.includes(action.update.id)) {
      entry.postedUpdateIds.push(action.update.id);
    }
    return;
  }

  entry.closed = true;
}

/** Thread où poster : celui créé dans le batch courant, sinon celui du state. */
export function resolveThreadId(state: State, action: Action): string {
  const { providerKey, id } = action.incident;
  const entry = getTracked(state, providerKey, id);
  if (!entry || entry.threadId === "") {
    throw new Error(`Thread introuvable pour ${providerKey}/${id}`);
  }
  return entry.threadId;
}
