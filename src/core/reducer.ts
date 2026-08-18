import type { IncidentUpdate, NormalizedIncident } from "../providers/types.ts";
import { isTerminal } from "../providers/types.ts";
import type { State, TrackedIncident } from "./state.ts";
import { getTracked } from "./state.ts";

export type Action =
  | { type: "CREATE_THREAD"; incident: NormalizedIncident }
  | {
      type: "POST_UPDATE";
      incident: NormalizedIncident;
      /** null quand le thread est cree dans le meme batch ; resolu a l'execution. */
      threadId: string | null;
      update: IncidentUpdate;
    }
  | { type: "CLOSE"; incident: NormalizedIncident; threadId: string | null };

/**
 * Coeur de la logique. Fonction pure : aucun I/O, aucun nouveau state produit.
 * Le state ne bouge qu'apres exécution réussie d'une action (cf. index.ts).
 *
 * `fetchedProviderKeys` limite la règle de repli (incident disparu -> CLOSE)
 * aux providers réellement interrogés avec succès ; par défaut on la déduit
 * des incidents fournis.
 */
export function reduce(
  state: State,
  incidents: NormalizedIncident[],
  fetchedProviderKeys: Iterable<string> = new Set(incidents.map((i) => i.providerKey)),
): Action[] {
  const actions: Action[] = [];
  const seen = new Set<string>();

  const ordered = [...incidents].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const incident of ordered) {
    seen.add(key(incident.providerKey, incident.id));
    const entry = getTracked(state, incident.providerKey, incident.id);

    if (entry?.closed) continue; // règle 5 : plus rien après la clôture

    if (!entry || entry.threadId === "") {
      // Incident adopté au seed : on n'ouvre un post que s'il se passe
      // quelque chose de neuf, sinon il reste silencieux.
      const hasNews =
        !entry || incident.updates.some((u) => !entry.postedUpdateIds.includes(u.id));
      if (hasNews) actions.push(...openActions(incident, entry));
      continue;
    }

    actions.push(...updateActions(incident, entry));

    if (isTerminal(incident.status)) {
      actions.push({ type: "CLOSE", incident, threadId: entry.threadId });
    }
  }

  // Règle 4 : incident suivi, non clos, sorti de la fenêtre récente de l'API.
  for (const providerKey of fetchedProviderKeys) {
    const service = state.services[providerKey];
    if (!service) continue;
    for (const [incidentId, entry] of Object.entries(service.incidents)) {
      if (entry.closed || seen.has(key(providerKey, incidentId))) continue;
      if (entry.threadId === "") continue; // jamais posté : clôture silencieuse
      actions.push({
        type: "CLOSE",
        incident: fromTracked(providerKey, incidentId, entry),
        threadId: entry.threadId,
      });
    }
  }

  return actions;
}

/** Incident inconnu (ou adopté au seed sans thread) : on ouvre le post. */
function openActions(incident: NormalizedIncident, entry: TrackedIncident | undefined): Action[] {
  const actions: Action[] = [{ type: "CREATE_THREAD", incident }];

  const posted = new Set(entry?.postedUpdateIds ?? []);
  const first = incident.updates[0];
  if (first) posted.add(first.id); // le premier update est inclus dans le post initial

  for (const update of incident.updates) {
    if (posted.has(update.id)) continue;
    actions.push({ type: "POST_UPDATE", incident, threadId: null, update });
  }

  if (isTerminal(incident.status)) {
    actions.push({ type: "CLOSE", incident, threadId: null });
  }
  return actions;
}

/** Incident connu : les updates jamais postés, dans l'ordre chronologique. */
function updateActions(incident: NormalizedIncident, entry: TrackedIncident): Action[] {
  const posted = new Set(entry.postedUpdateIds);
  const actions: Action[] = [];
  for (const update of incident.updates) {
    if (posted.has(update.id)) continue;
    actions.push({ type: "POST_UPDATE", incident, threadId: entry.threadId, update });
  }
  return actions;
}

/** Reconstruit un incident depuis le snapshot du state (CLOSE de repli). */
function fromTracked(
  providerKey: string,
  incidentId: string,
  entry: TrackedIncident,
): NormalizedIncident {
  return {
    providerKey,
    id: incidentId,
    title: entry.title,
    status: "resolved",
    impact: entry.impact,
    url: entry.url,
    createdAt: new Date(entry.createdAt),
    resolvedAt: null, // durée inconnue : le message de clôture l'omettra
    updates: [],
  };
}

function key(providerKey: string, incidentId: string): string {
  return `${providerKey} ${incidentId}`;
}
