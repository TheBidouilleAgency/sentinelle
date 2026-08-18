import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LogLevel } from "./log.ts";

export type ServiceConfig = {
  key: string;
  name: string;
  type: "statuspage";
  url: string;
  /** Webhook effectif : override par service, sinon le webhook global. */
  webhookUrl: string;
};

export type Config = {
  services: ServiceConfig[];
  pollIntervalSeconds: number;
  statePath: string;
  servicesPath: string;
  healthcheckUrl: string | null;
  dryRun: boolean;
  logLevel: LogLevel;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/**
 * Validation stricte au boot : mieux vaut un crash explicite qu'un service
 * qui tourne à moitié sans jamais poster.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const webhookUrl = (env.DISCORD_WEBHOOK_URL ?? "").trim();
  if (webhookUrl.length === 0) {
    throw new ConfigError("DISCORD_WEBHOOK_URL est requis (webhook du salon forum Discord)");
  }
  assertHttpUrl(webhookUrl, "DISCORD_WEBHOOK_URL");

  const servicesPath = resolve((env.SERVICES_PATH ?? "./services.json").trim());
  const services = parseServices(readServicesFile(servicesPath), servicesPath).map((service) => ({
    ...service,
    webhookUrl: serviceWebhook(env, service.key, webhookUrl),
  }));

  const pollIntervalSeconds = positiveInt(env.POLL_INTERVAL_SECONDS, 60, "POLL_INTERVAL_SECONDS");

  const healthcheckUrl = (env.HEALTHCHECK_URL ?? "").trim();
  if (healthcheckUrl.length > 0) assertHttpUrl(healthcheckUrl, "HEALTHCHECK_URL");

  const logLevel = (env.LOG_LEVEL ?? "info").trim().toLowerCase();
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(`LOG_LEVEL invalide : "${logLevel}" (debug|info|warn|error)`);
  }

  return {
    services,
    pollIntervalSeconds,
    statePath: resolve((env.STATE_PATH ?? "/app/data/state.json").trim()),
    servicesPath,
    healthcheckUrl: healthcheckUrl.length > 0 ? healthcheckUrl : null,
    dryRun: (env.DRY_RUN ?? "false").trim().toLowerCase() === "true",
    logLevel: logLevel as LogLevel,
  };
}

function readServicesFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Impossible de lire ${path} : ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ConfigError(`${path} n'est pas du JSON valide : ${(err as Error).message}`);
  }
}

export function parseServices(input: unknown, source = "services.json"): Omit<ServiceConfig, "webhookUrl">[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ConfigError(`${source} doit être un tableau non vide de services`);
  }

  const seen = new Set<string>();
  return input.map((entry, index) => {
    const at = `${source}[${index}]`;
    if (!entry || typeof entry !== "object") throw new ConfigError(`${at} : objet attendu`);
    const { key, name, type, url } = entry as Record<string, unknown>;

    if (typeof key !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      throw new ConfigError(`${at}.key : identifiant [a-z0-9_-] attendu`);
    }
    if (seen.has(key)) throw new ConfigError(`${at}.key : "${key}" est dupliqué`);
    seen.add(key);

    if (typeof name !== "string" || name.trim().length === 0) {
      throw new ConfigError(`${at}.name : chaîne non vide attendue`);
    }
    if (type !== "statuspage") {
      throw new ConfigError(`${at}.type : "${String(type)}" non supporté (seul "statuspage" existe)`);
    }
    if (typeof url !== "string") throw new ConfigError(`${at}.url : chaîne attendue`);
    assertHttpUrl(url, `${at}.url`);

    return { key, name: name.trim(), type, url };
  });
}

/** DISCORD_WEBHOOK_<KEY>, la clé étant normalisée en majuscules. */
export function webhookEnvName(key: string): string {
  return `DISCORD_WEBHOOK_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function serviceWebhook(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const name = webhookEnvName(key);
  const override = (env[name] ?? "").trim();
  if (override.length === 0) return fallback;
  assertHttpUrl(override, name);
  return override;
}

function assertHttpUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${label} : URL invalide ("${value}")`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${label} : protocole ${url.protocol} non supporté`);
  }
}

function positiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} : entier positif attendu (reçu "${raw}")`);
  }
  return value;
}
