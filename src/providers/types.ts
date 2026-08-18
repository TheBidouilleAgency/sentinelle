export type IncidentStatus =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved"
  | "postmortem";

export type IncidentImpact = "none" | "minor" | "major" | "critical";

export type IncidentUpdate = {
  id: string;
  status: string;
  body: string;
  createdAt: Date;
};

export type NormalizedIncident = {
  providerKey: string;
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  url: string;
  createdAt: Date;
  resolvedAt: Date | null;
  /** trié par createdAt croissant */
  updates: IncidentUpdate[];
};

export interface StatusProvider {
  readonly key: string;
  fetchIncidents(): Promise<NormalizedIncident[]>;
}

const TERMINAL: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>(["resolved", "postmortem"]);

export function isTerminal(status: IncidentStatus): boolean {
  return TERMINAL.has(status);
}
