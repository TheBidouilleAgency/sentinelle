import { loadConfig, ConfigError, type Config, type ServiceConfig } from "./config.ts";
import { log, setLogLevel, errorFields } from "./log.ts";
import { StatuspageProvider } from "./providers/statuspage.ts";
import type { NormalizedIncident, StatusProvider } from "./providers/types.ts";
import { reduce, type Action } from "./core/reducer.ts";
import { loadState, saveState, seed, reconcile, prune, type State } from "./core/state.ts";
import { applyAction, resolveThreadId } from "./core/apply.ts";
import { DiscordForumClient, DryRunForumClient, type ForumClient } from "./discord/forum.ts";
import { closeEmbed, initialEmbed, threadName, updateEmbed } from "./discord/format.ts";
import { pingHealthcheck } from "./health.ts";

const JITTER_MAX_MS = 5_000;

type Runtime = {
  config: Config;
  providers: StatusProvider[];
  services: Map<string, ServiceConfig>;
  client: ForumClient;
  state: State;
};

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const services = new Map(config.services.map((s) => [s.key, s]));
  const providers: StatusProvider[] = config.services.map(
    (s) => new StatuspageProvider(s.key, s.url),
  );

  const state = await loadState(config.statePath);

  const runtime: Runtime = {
    config,
    providers,
    services,
    client: config.dryRun ? new DryRunForumClient() : new DiscordForumClient(),
    state,
  };

  log.info("boot", {
    services: config.services.map((s) => s.key),
    pollIntervalSeconds: config.pollIntervalSeconds,
    statePath: config.statePath,
    dryRun: config.dryRun,
    seeded: state.seeded,
    healthcheck: config.healthcheckUrl !== null,
  });

  await runLoop(runtime);
}

async function runLoop(runtime: Runtime): Promise<void> {
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;

  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info("shutdown.signal", { signal });
    if (timer !== null) clearTimeout(timer);
    if (wake !== null) wake();
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  while (!stopping) {
    try {
      await tick(runtime);
      await pingHealthcheck(runtime.config.healthcheckUrl);
    } catch (err) {
      // Un tick qui explose ne doit ni tuer le process ni pinger le healthcheck.
      log.error("tick.failed", errorFields(err));
    }

    if (stopping) break;

    // setTimeout récursif plutôt que setInterval : pas de chevauchement si un
    // tick dépasse l'intervalle. Jitter pour désynchroniser les redéploiements.
    const delay = runtime.config.pollIntervalSeconds * 1000 + Math.random() * JITTER_MAX_MS;
    await new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, delay);
    });
    wake = null;
  }

  // Le tick en cours est déjà terminé (on ne sort de la boucle qu'après son
  // await) ; sauvegarde de sécurité avant de rendre la main.
  await persist(runtime);
  log.info("shutdown.done");
}

async function tick(runtime: Runtime): Promise<void> {
  const now = new Date();
  const startedAt = Date.now();
  const incidents: NormalizedIncident[] = [];
  const fetched = new Set<string>();

  for (const provider of runtime.providers) {
    try {
      const found = await provider.fetchIncidents();
      incidents.push(...found);
      fetched.add(provider.key);
      log.debug("provider.fetched", { provider: provider.key, incidents: found.length });
    } catch (err) {
      // Un provider en échec n'interrompt pas le tick des autres.
      log.warn("provider.failed", { provider: provider.key, ...errorFields(err) });
    }
  }

  if (fetched.size === 0) {
    log.warn("tick.no_provider_reachable", {});
    return;
  }

  if (!runtime.state.seeded) {
    if (runtime.config.dryRun) {
      // En DRY_RUN, seeder rendrait le service muet : on saute l'étape pour
      // que la config se valide sur des actions réellement visibles.
      runtime.state.seeded = true;
      log.info("dry_run.seed_skipped", {
        message: "seed ignoré en DRY_RUN : les incidents en cours vont apparaître comme des actions",
      });
    } else if (fetched.size < runtime.providers.length) {
      // Seeder partiellement ferait passer les incidents manquants pour des
      // nouveautés au tick suivant : on attend que tout réponde.
      log.warn("seed.deferred", { fetched: fetched.size, total: runtime.providers.length });
      return;
    } else {
      const count = seed(runtime.state, incidents, now);
      await persist(runtime);
      log.info("seeded", { message: `SEEDED — ${count} incidents enregistrés sans notification` });
      return;
    }
  }

  const actions = reduce(runtime.state, incidents, fetched);
  if (actions.length > 0) {
    log.info("tick.actions", { count: actions.length, types: actions.map((a) => a.type) });
  }

  const failed = new Set<string>();
  let executed = 0;

  for (const action of actions) {
    const incidentKey = `${action.incident.providerKey} ${action.incident.id}`;
    if (failed.has(incidentKey)) {
      log.warn("action.skipped", { type: action.type, incident: incidentKey });
      continue;
    }
    try {
      await execute(runtime, action, now);
      // Persistance après chaque action : un crash en plein batch reprend
      // exactement là où il s'est arrêté, sans doublon.
      await persist(runtime);
      executed++;
    } catch (err) {
      failed.add(incidentKey);
      log.error("action.failed", { type: action.type, incident: incidentKey, ...errorFields(err) });
    }
  }

  reconcile(runtime.state, incidents, fetched, now);
  const pruned = prune(runtime.state, now);
  await persist(runtime);

  log.info("tick.done", {
    providers: fetched.size,
    incidents: incidents.length,
    actions: actions.length,
    executed,
    pruned,
    durationMs: Date.now() - startedAt,
  });
}

async function execute(runtime: Runtime, action: Action, now: Date): Promise<void> {
  const incident = action.incident;
  const service = runtime.services.get(incident.providerKey);
  if (!service) throw new Error(`Service inconnu : ${incident.providerKey}`);

  switch (action.type) {
    case "CREATE_THREAD": {
      const name = threadName(service.name, incident.title);
      const threadId = await runtime.client.createThread(
        service.webhookUrl,
        name,
        initialEmbed(incident, service.name),
      );
      applyAction(runtime.state, action, now, threadId);
      log.info("thread.created", { incident: incident.id, threadId, name });
      return;
    }

    case "POST_UPDATE": {
      const threadId = resolveThreadId(runtime.state, action);
      await runtime.client.postMessage(
        service.webhookUrl,
        threadId,
        updateEmbed(incident, action.update),
      );
      applyAction(runtime.state, action, now);
      log.info("update.posted", {
        incident: incident.id,
        update: action.update.id,
        status: action.update.status,
      });
      return;
    }

    case "CLOSE": {
      const threadId = resolveThreadId(runtime.state, action);
      await runtime.client.postMessage(
        service.webhookUrl,
        threadId,
        closeEmbed(incident, service.name),
      );
      applyAction(runtime.state, action, now);
      log.info("incident.closed", { incident: incident.id, threadId });
      return;
    }
  }
}

async function persist(runtime: Runtime): Promise<void> {
  if (runtime.config.dryRun) return; // DRY_RUN n'écrit ni sur Discord ni sur disque
  await saveState(runtime.config.statePath, runtime.state);
}

try {
  await main();
} catch (err) {
  if (err instanceof ConfigError) {
    log.error("config.invalid", { error: err.message });
  } else {
    log.error("fatal", errorFields(err));
  }
  process.exitCode = 1;
}
