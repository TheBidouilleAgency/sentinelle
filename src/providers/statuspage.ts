import type {
  IncidentImpact,
  IncidentStatus,
  IncidentUpdate,
  NormalizedIncident,
  StatusProvider,
} from "./types.ts";

const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = "sentinelle/1.0 (status page watcher; +https://github.com/)";

const STATUSES: ReadonlySet<string> = new Set([
  "investigating",
  "identified",
  "monitoring",
  "resolved",
  "postmortem",
]);

const IMPACTS: ReadonlySet<string> = new Set(["none", "minor", "major", "critical"]);

type RawUpdate = {
  id?: unknown;
  status?: unknown;
  body?: unknown;
  created_at?: unknown;
};

type RawIncident = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  impact?: unknown;
  shortlink?: unknown;
  created_at?: unknown;
  resolved_at?: unknown;
  incident_updates?: unknown;
};

export class StatuspageProvider implements StatusProvider {
  readonly key: string;
  readonly #baseUrl: string;

  constructor(key: string, baseUrl: string) {
    this.key = key;
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async fetchIncidents(): Promise<NormalizedIncident[]> {
    // incidents.json (et non unresolved.json) : sinon un incident qui passe en
    // "resolved" disparaît de la réponse et on rate le message de résolution.
    const url = `${this.#baseUrl}/api/v2/incidents.json`;
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`GET ${url} → HTTP ${res.status}`);
    }

    const payload: unknown = await res.json();
    try {
      return normalizeStatuspagePayload(this.key, this.#baseUrl, payload);
    } catch (err) {
      throw new Error(`GET ${url} → ${(err as Error).message}`);
    }
  }
}

/**
 * Normalisation pure du payload `incidents.json` : testable sans réseau.
 */
export function normalizeStatuspagePayload(
  providerKey: string,
  baseUrl: string,
  payload: unknown,
): NormalizedIncident[] {
  const raw = (payload as { incidents?: unknown } | null)?.incidents;
  if (!Array.isArray(raw)) {
    throw new Error('réponse inattendue (champ "incidents" absent)');
  }
  const base = baseUrl.replace(/\/+$/, "");
  const incidents: NormalizedIncident[] = [];
  for (const item of raw) {
    const incident = normalizeIncident(providerKey, base, item as RawIncident);
    if (incident) incidents.push(incident);
  }
  return incidents;
}

function normalizeIncident(
  providerKey: string,
  baseUrl: string,
  raw: RawIncident,
): NormalizedIncident | null {
  const id = str(raw.id);
  const createdAt = date(raw.created_at);
  if (!id || !createdAt) return null;

  const updates: IncidentUpdate[] = [];
  if (Array.isArray(raw.incident_updates)) {
    for (const u of raw.incident_updates as RawUpdate[]) {
      const uid = str(u?.id);
      const uCreatedAt = date(u?.created_at);
      if (!uid || !uCreatedAt) continue;
      updates.push({
        id: uid,
        status: str(u?.status) ?? "unknown",
        body: str(u?.body) ?? "",
        createdAt: uCreatedAt,
      });
    }
    // L'ordre n'est pas garanti par l'API.
    updates.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  const status = str(raw.status);
  const impact = str(raw.impact);
  const shortlink = str(raw.shortlink);

  return {
    providerKey,
    id,
    title: str(raw.name) ?? "Incident sans titre",
    status: status && STATUSES.has(status) ? (status as IncidentStatus) : "investigating",
    impact: impact && IMPACTS.has(impact) ? (impact as IncidentImpact) : "none",
    url: shortlink ?? `${baseUrl}/incidents/${id}`,
    createdAt,
    resolvedAt: date(raw.resolved_at),
    updates,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
