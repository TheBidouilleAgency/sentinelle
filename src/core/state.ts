import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IncidentImpact, NormalizedIncident } from "../providers/types.ts";
import { isTerminal } from "../providers/types.ts";

export const STATE_VERSION = 1;

/**
 * Snapshot minimal d'un incident suivi. Les champs `title`/`impact`/`url`/
 * `createdAt` servent au CLOSE de repli (règle 4) : un incident sorti de la
 * fenêtre récente de l'API doit pouvoir être clos sans être re-téléchargé.
 */
export type TrackedIncident = {
  threadId: string;
  postedUpdateIds: string[];
  closed: boolean;
  lastSeenAt: string;
  title: string;
  impact: IncidentImpact;
  url: string;
  createdAt: string;
};

export type State = {
  version: typeof STATE_VERSION;
  seeded: boolean;
  services: Record<string, { incidents: Record<string, TrackedIncident> }>;
};

export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export function emptyState(): State {
  return { version: STATE_VERSION, seeded: false, services: {} };
}

export function getTracked(state: State, providerKey: string, incidentId: string): TrackedIncident | undefined {
  return state.services[providerKey]?.incidents[incidentId];
}

export function putTracked(
  state: State,
  providerKey: string,
  incidentId: string,
  entry: TrackedIncident,
): void {
  const service = (state.services[providerKey] ??= { incidents: {} });
  service.incidents[incidentId] = entry;
}

export function snapshot(incident: NormalizedIncident, now: Date): Omit<TrackedIncident, "threadId" | "postedUpdateIds" | "closed"> {
  return {
    lastSeenAt: now.toISOString(),
    title: incident.title,
    impact: incident.impact,
    url: incident.url,
    createdAt: incident.createdAt.toISOString(),
  };
}

/**
 * Enregistre tous les incidents et tous leurs updates sans produire d'action :
 * premier démarrage, ou volume perdu. Évite de réveiller le forum avec
 * l'historique complet.
 */
export function seed(state: State, incidents: NormalizedIncident[], now: Date): number {
  for (const incident of incidents) {
    putTracked(state, incident.providerKey, incident.id, {
      // threadId vide = incident adopté sans post. Si un incident encore en
      // cours reçoit un nouvel update, le reducer créera alors le thread.
      threadId: "",
      postedUpdateIds: incident.updates.map((u) => u.id),
      closed: isTerminal(incident.status),
      ...snapshot(incident, now),
    });
  }
  state.seeded = true;
  return incidents.length;
}

/**
 * Transitions d'état qui ne produisent aucun message :
 * - rafraîchir `lastSeenAt` et le snapshot des incidents encore visibles ;
 * - absorber silencieusement les updates des incidents déjà clos (règle 5) ;
 * - clore les incidents adoptés au seed (sans thread) qui ont disparu de l'API.
 *
 * `fetchedProviderKeys` ne contient que les providers dont le fetch a réussi :
 * un provider en échec ne doit rien clore.
 */
export function reconcile(
  state: State,
  incidents: NormalizedIncident[],
  fetchedProviderKeys: Iterable<string>,
  now: Date,
): void {
  const seen = new Set<string>();
  for (const incident of incidents) {
    seen.add(`${incident.providerKey}\u0000${incident.id}`);
    const entry = getTracked(state, incident.providerKey, incident.id);
    if (!entry) continue;
    entry.lastSeenAt = now.toISOString();
    entry.title = incident.title;
    entry.impact = incident.impact;
    entry.url = incident.url;
    if (entry.closed) {
      for (const update of incident.updates) {
        if (!entry.postedUpdateIds.includes(update.id)) entry.postedUpdateIds.push(update.id);
      }
    } else if (entry.threadId === "" && isTerminal(incident.status)) {
      // Adopté au seed, jamais posté, terminé : on le clôt sans rien annoncer.
      entry.closed = true;
    }
  }

  for (const providerKey of fetchedProviderKeys) {
    const service = state.services[providerKey];
    if (!service) continue;
    for (const [incidentId, entry] of Object.entries(service.incidents)) {
      if (entry.closed || entry.threadId !== "") continue;
      if (seen.has(`${providerKey}\u0000${incidentId}`)) continue;
      entry.closed = true; // jamais posté, donc rien à annoncer
    }
  }
}

export function prune(state: State, now: Date, maxAgeMs = PRUNE_AFTER_MS): number {
  let removed = 0;
  for (const [serviceKey, service] of Object.entries(state.services)) {
    for (const [incidentId, entry] of Object.entries(service.incidents)) {
      if (!entry.closed) continue;
      const seenAt = Date.parse(entry.lastSeenAt);
      if (Number.isNaN(seenAt) || now.getTime() - seenAt > maxAgeMs) {
        delete service.incidents[incidentId];
        removed++;
      }
    }
    if (Object.keys(service.incidents).length === 0) delete state.services[serviceKey];
  }
  return removed;
}

export async function loadState(path: string): Promise<State> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
  return migrate(JSON.parse(raw) as unknown);
}

/** Écriture atomique : fichier temporaire puis rename(). */
export async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}

export function migrate(input: unknown): State {
  if (!input || typeof input !== "object") return emptyState();
  const candidate = input as Partial<State>;
  if (candidate.version !== STATE_VERSION) {
    // Aucune version antérieure n'existe : un state illisible repart de zéro,
    // ce qui déclenchera un seed silencieux plutôt qu'un flot de notifications.
    return emptyState();
  }

  const state = emptyState();
  state.seeded = candidate.seeded === true;
  const services = candidate.services;
  if (!services || typeof services !== "object") return state;

  for (const [serviceKey, service] of Object.entries(services)) {
    const incidents = (service as { incidents?: unknown })?.incidents;
    if (!incidents || typeof incidents !== "object") continue;
    for (const [incidentId, entry] of Object.entries(incidents as Record<string, unknown>)) {
      const e = entry as Partial<TrackedIncident>;
      if (typeof e?.threadId !== "string") continue;
      putTracked(state, serviceKey, incidentId, {
        threadId: e.threadId,
        postedUpdateIds: Array.isArray(e.postedUpdateIds)
          ? e.postedUpdateIds.filter((id): id is string => typeof id === "string")
          : [],
        closed: e.closed === true,
        lastSeenAt: typeof e.lastSeenAt === "string" ? e.lastSeenAt : new Date(0).toISOString(),
        title: typeof e.title === "string" ? e.title : "Incident",
        impact: typeof e.impact === "string" ? (e.impact as IncidentImpact) : "none",
        url: typeof e.url === "string" ? e.url : "",
        createdAt: typeof e.createdAt === "string" ? e.createdAt : new Date(0).toISOString(),
      });
    }
  }
  return state;
}
