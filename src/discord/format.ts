import type { IncidentImpact, IncidentUpdate, NormalizedIncident } from "../providers/types.ts";

export const THREAD_NAME_MAX = 100;
export const EMBED_DESCRIPTION_MAX = 4096;
export const EMBED_TITLE_MAX = 256;
export const EMBED_FIELD_VALUE_MAX = 1024;

const COLORS = {
  critical: 0xed4245,
  major: 0xe67e22,
  minor: 0xfee75c,
  resolved: 0x57f287,
} as const;

const STATUS_LABELS: Record<string, string> = {
  investigating: "Investigation",
  identified: "Identifié",
  monitoring: "Sous surveillance",
  resolved: "Résolu",
  postmortem: "Post-mortem",
};

const IMPACT_LABELS: Record<IncidentImpact, string> = {
  none: "Aucun",
  minor: "Mineur",
  major: "Majeur",
  critical: "Critique",
};

export type Embed = {
  title?: string;
  description?: string;
  url?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
};

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  if (max <= 1) return input.slice(0, max);
  return `${input.slice(0, max - 1).trimEnd()}…`;
}

/** `{Service} — {titre}`, borné à 100 caractères (contrainte Discord). */
export function threadName(serviceName: string, incidentTitle: string): string {
  return truncate(`${serviceName} — ${incidentTitle}`, THREAD_NAME_MAX);
}

export function colorFor(impact: IncidentImpact, resolved: boolean): number {
  if (resolved) return COLORS.resolved;
  switch (impact) {
    case "critical":
      return COLORS.critical;
    case "major":
      return COLORS.major;
    case "minor":
      return COLORS.minor;
    case "none":
      return COLORS.resolved;
  }
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function impactLabel(impact: IncidentImpact): string {
  return IMPACT_LABELS[impact];
}

/** `1h 12min`, `45min`, `2j 3h`. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}min`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}j` : `${days}j ${restHours}h`;
}

/** Horodatage Discord dynamique : rendu dans le fuseau du lecteur. */
export function timestamp(date: Date, style: "f" | "R" = "f"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

/** Le body Statuspage est du texte brut : on neutralise juste les backticks. */
export function sanitizeBody(body: string): string {
  return body.replace(/`/g, "ˋ").trim();
}

export function initialEmbed(incident: NormalizedIncident, serviceName: string): Embed {
  const first = incident.updates[0];
  const resolved = incident.status === "resolved" || incident.status === "postmortem";
  const body = first ? sanitizeBody(first.body) : "";

  const description = truncate(
    body.length > 0 ? body : "_Aucun détail fourni par la status page._",
    EMBED_DESCRIPTION_MAX,
  );

  return {
    title: truncate(incident.title, EMBED_TITLE_MAX),
    url: incident.url,
    description,
    color: colorFor(incident.impact, resolved),
    fields: [
      { name: "Statut", value: statusLabel(incident.status), inline: true },
      { name: "Impact", value: impactLabel(incident.impact), inline: true },
      { name: "Début", value: timestamp(incident.createdAt), inline: false },
    ],
    footer: { text: serviceName },
    timestamp: incident.createdAt.toISOString(),
  };
}

export function updateEmbed(incident: NormalizedIncident, update: IncidentUpdate): Embed {
  const resolved = update.status === "resolved" || update.status === "postmortem";
  const body = sanitizeBody(update.body);
  return {
    title: truncate(statusLabel(update.status), EMBED_TITLE_MAX),
    description: truncate(
      body.length > 0 ? body : "_Aucun détail fourni par la status page._",
      EMBED_DESCRIPTION_MAX,
    ),
    color: colorFor(incident.impact, resolved),
    fields: [{ name: "Horodatage", value: timestamp(update.createdAt), inline: false }],
    timestamp: update.createdAt.toISOString(),
  };
}

export function closeEmbed(incident: NormalizedIncident, serviceName: string): Embed {
  const duration =
    incident.resolvedAt !== null
      ? formatDuration(incident.resolvedAt.getTime() - incident.createdAt.getTime())
      : null;

  const lines = [
    `**Incident résolu** — ${serviceName}`,
    duration !== null
      ? `Durée totale : **${duration}**`
      : "Durée totale inconnue (incident sorti de la fenêtre de la status page).",
  ];

  const fields: Embed["fields"] = [
    { name: "Début", value: timestamp(incident.createdAt), inline: true },
  ];
  if (incident.resolvedAt !== null) {
    fields.push({ name: "Fin", value: timestamp(incident.resolvedAt), inline: true });
  }

  return {
    title: "Résolu",
    description: truncate(lines.join("\n"), EMBED_DESCRIPTION_MAX),
    color: COLORS.resolved,
    fields,
    timestamp: (incident.resolvedAt ?? new Date()).toISOString(),
  };
}
