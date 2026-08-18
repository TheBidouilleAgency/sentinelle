import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { normalizeStatuspagePayload } from "../src/providers/statuspage.ts";
import type { NormalizedIncident } from "../src/providers/types.ts";
import { reduce, type Action } from "../src/core/reducer.ts";
import { applyAction } from "../src/core/apply.ts";
import { emptyState, getTracked, prune, reconcile, seed, type State } from "../src/core/state.ts";

const BASE_URL = "https://www.githubstatus.com";
const NOW = new Date("2026-08-17T12:00:00Z");

function fixture(name: string): NormalizedIncident[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  const payload: unknown = JSON.parse(readFileSync(path, "utf8"));
  return normalizeStatuspagePayload("github", BASE_URL, payload);
}

/** Rejoue le batch d'actions comme le fait le runtime, avec des threads factices. */
function apply(state: State, actions: Action[], now: Date = NOW): string[] {
  const created: string[] = [];
  for (const action of actions) {
    if (action.type === "CREATE_THREAD") {
      const threadId = `thread-${action.incident.id}`;
      created.push(threadId);
      applyAction(state, action, now, threadId);
    } else {
      applyAction(state, action, now);
    }
  }
  return created;
}

function seededState(): State {
  const state = emptyState();
  state.seeded = true;
  return state;
}

test("nouvel incident -> CREATE_THREAD puis un POST_UPDATE par update supplémentaire", () => {
  const state = seededState();
  const incidents = fixture("github-incident-investigating");

  const actions = reduce(state, incidents);

  assert.deepEqual(
    actions.map((a) => a.type),
    ["CREATE_THREAD", "POST_UPDATE"],
  );
  // Le premier update est embarqué dans le post initial, seul le second est posté.
  assert.equal(actions[1]?.type === "POST_UPDATE" && actions[1].update.id, "upd-2");
  assert.equal(actions[1]?.type === "POST_UPDATE" && actions[1].threadId, null);
});

test("rejouer le même payload deux fois ne produit aucune action la seconde fois", () => {
  const state = seededState();
  const incidents = fixture("github-incident-investigating");

  apply(state, reduce(state, incidents));

  assert.deepEqual(reduce(state, incidents), []);
});

test("un update supplémentaire produit exactement un POST_UPDATE", () => {
  const state = seededState();
  apply(state, reduce(state, fixture("github-incident-investigating")));

  const actions = reduce(state, fixture("github-incident-identified"));

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "POST_UPDATE");
  assert.equal(actions[0]?.type === "POST_UPDATE" && actions[0].update.id, "upd-3");
  assert.equal(actions[0]?.type === "POST_UPDATE" && actions[0].threadId, "thread-inc-1");
});

test("passage en resolved -> un POST_UPDATE final puis un CLOSE unique", () => {
  const state = seededState();
  apply(state, reduce(state, fixture("github-incident-investigating")));
  apply(state, reduce(state, fixture("github-incident-identified")));

  const resolved = fixture("github-incident-resolved");
  const actions = reduce(state, resolved);

  assert.deepEqual(
    actions.map((a) => a.type),
    ["POST_UPDATE", "CLOSE"],
  );
  const close = actions[1];
  assert.ok(close?.type === "CLOSE");
  assert.equal(close.threadId, "thread-inc-1");
  assert.equal(close.incident.resolvedAt?.toISOString(), "2026-08-17T10:12:00.000Z");

  apply(state, actions);
  // Idempotence : plus rien à faire, même en rejouant le payload résolu.
  assert.deepEqual(reduce(state, resolved), []);
  assert.equal(getTracked(state, "github", "inc-1")?.closed, true);
});

test("les updates renvoyés dans le désordre sont postés dans l'ordre chronologique", () => {
  const state = seededState();
  // Le fixture "resolved" liste les updates dans un ordre arbitraire.
  const actions = reduce(state, fixture("github-incident-resolved"));

  const postedIds = actions
    .filter((a): a is Extract<Action, { type: "POST_UPDATE" }> => a.type === "POST_UPDATE")
    .map((a) => a.update.id);

  assert.deepEqual(postedIds, ["upd-2", "upd-3", "upd-4"]);
  assert.deepEqual(
    actions.map((a) => a.type),
    ["CREATE_THREAD", "POST_UPDATE", "POST_UPDATE", "POST_UPDATE", "CLOSE"],
  );
});

test("incident disparu de la réponse -> CLOSE de repli sans durée", () => {
  const state = seededState();
  apply(state, reduce(state, fixture("github-incident-investigating")));

  // Le provider répond, mais l'incident est sorti de la fenêtre récente.
  const actions = reduce(state, [], ["github"]);

  assert.equal(actions.length, 1);
  const close = actions[0];
  assert.ok(close?.type === "CLOSE");
  assert.equal(close.incident.id, "inc-1");
  assert.equal(close.incident.title, "Elevated error rates on the API");
  assert.equal(close.incident.resolvedAt, null);
  assert.equal(close.threadId, "thread-inc-1");
});

test("un provider en échec ne clôt pas ses incidents", () => {
  const state = seededState();
  apply(state, reduce(state, fixture("github-incident-investigating")));

  // github n'a pas répondu : il n'apparaît pas dans les providers interrogés.
  assert.deepEqual(reduce(state, [], []), []);
});

test("state vide + seeded:false -> zéro action et state peuplé", () => {
  const state = emptyState();
  const incidents = fixture("github-incident-resolved");

  const count = seed(state, incidents, NOW);

  assert.equal(count, 1);
  assert.equal(state.seeded, true);
  const entry = getTracked(state, "github", "inc-1");
  assert.deepEqual(entry?.postedUpdateIds, ["upd-1", "upd-2", "upd-3", "upd-4"]);
  assert.equal(entry?.closed, true);
  assert.deepEqual(reduce(state, incidents), []);
});

test("incident encore en cours au seed : adopté sans post, thread créé au prochain update", () => {
  const state = emptyState();
  seed(state, fixture("github-incident-investigating"), NOW);

  assert.deepEqual(reduce(state, fixture("github-incident-investigating")), []);

  const actions = reduce(state, fixture("github-incident-identified"));
  assert.deepEqual(
    actions.map((a) => a.type),
    ["CREATE_THREAD", "POST_UPDATE"],
  );
  // Seul l'update inédit est posté ; les anciens restent silencieux.
  assert.equal(actions[1]?.type === "POST_UPDATE" && actions[1].update.id, "upd-3");
});

test("incident adopté au seed et disparu : clôture silencieuse, aucune action", () => {
  const state = emptyState();
  seed(state, fixture("github-incident-investigating"), NOW);

  assert.deepEqual(reduce(state, [], ["github"]), []);

  reconcile(state, [], ["github"], NOW);
  assert.equal(getTracked(state, "github", "inc-1")?.closed, true);
});

test("les updates arrivant après la clôture sont absorbés silencieusement", () => {
  const state = seededState();
  apply(state, reduce(state, fixture("github-incident-investigating")));
  apply(state, reduce(state, fixture("github-incident-resolved")));

  const postmortem = fixture("github-incident-resolved");
  const incident = postmortem[0]!;
  incident.status = "postmortem";
  incident.updates.push({
    id: "upd-5",
    status: "postmortem",
    body: "Post-mortem published.",
    createdAt: new Date("2026-08-18T09:00:00Z"),
  });

  assert.deepEqual(reduce(state, postmortem), []);

  reconcile(state, postmortem, ["github"], NOW);
  assert.ok(getTracked(state, "github", "inc-1")?.postedUpdateIds.includes("upd-5"));
});

test("incident sans update : CREATE_THREAD seul", () => {
  const state = seededState();
  const incidents = normalizeStatuspagePayload(
    "github",
    BASE_URL,
    JSON.parse(
      readFileSync(fileURLToPath(new URL("./fixtures/multi-service.json", import.meta.url)), "utf8"),
    ),
  );

  const actions = reduce(state, incidents);

  assert.deepEqual(
    actions.map((a) => a.type),
    ["CREATE_THREAD", "CREATE_THREAD"],
  );
  // Ordre chronologique de création des incidents.
  assert.deepEqual(
    actions.map((a) => a.incident.id),
    ["inc-long-title", "inc-empty"],
  );
});

test("prune supprime les incidents clos de plus de 30 jours", () => {
  const state = seededState();
  apply(state, reduce(state, fixture("github-incident-resolved")), new Date("2026-06-01T00:00:00Z"));
  apply(state, reduce(state, fixture("multi-service")), NOW);

  const removed = prune(state, NOW);

  assert.equal(removed, 1);
  assert.equal(getTracked(state, "github", "inc-1"), undefined);
  assert.ok(getTracked(state, "github", "inc-long-title"));
});
