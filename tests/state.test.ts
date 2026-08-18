import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyState, loadState, migrate, putTracked, saveState } from "../src/core/state.ts";
import { loadConfig, parseServices, webhookEnvName, ConfigError } from "../src/config.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sentinelle-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("state absent -> state vide non seedé", async () => {
  await withTempDir(async (dir) => {
    const state = await loadState(join(dir, "nope", "state.json"));
    assert.deepEqual(state, emptyState());
  });
});

test("sauvegarde atomique : pas de .tmp résiduel, relecture identique", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "data", "state.json");
    const state = emptyState();
    state.seeded = true;
    putTracked(state, "github", "inc-1", {
      threadId: "123",
      postedUpdateIds: ["upd-1"],
      closed: false,
      lastSeenAt: "2026-08-17T12:00:00.000Z",
      title: "Elevated error rates",
      impact: "major",
      url: "https://stspg.io/inc1",
      createdAt: "2026-08-17T09:00:00.000Z",
    });

    await saveState(path, state);

    assert.deepEqual((await readdir(join(dir, "data"))).sort(), ["state.json"]);
    assert.deepEqual(await loadState(path), state);
  });
});

test("state corrompu ou d'une autre version -> repart de zéro (donc reseed silencieux)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify({ version: 99, seeded: true, services: {} }), "utf8");

    assert.deepEqual(await loadState(path), emptyState());
    assert.deepEqual(migrate(null), emptyState());
    assert.deepEqual(migrate({ version: 1 }), emptyState());
  });
});

test("migrate complète les champs manquants d'une entrée", () => {
  const state = migrate({
    version: 1,
    seeded: true,
    services: { github: { incidents: { "inc-1": { threadId: "9", closed: true } } } },
  });

  const entry = state.services.github?.incidents["inc-1"];
  assert.equal(entry?.threadId, "9");
  assert.deepEqual(entry?.postedUpdateIds, []);
  assert.equal(entry?.title, "Incident");
});

test("parseServices rejette une configuration invalide", () => {
  assert.throws(() => parseServices([]), ConfigError);
  assert.throws(() => parseServices([{ key: "a", name: "A", type: "rss", url: "https://x.dev" }]), ConfigError);
  assert.throws(() => parseServices([{ key: "A B", name: "A", type: "statuspage", url: "https://x.dev" }]), ConfigError);
  assert.throws(
    () =>
      parseServices([
        { key: "a", name: "A", type: "statuspage", url: "https://x.dev" },
        { key: "a", name: "B", type: "statuspage", url: "https://y.dev" },
      ]),
    ConfigError,
  );
});

test("loadConfig exige DISCORD_WEBHOOK_URL", () => {
  assert.throws(() => loadConfig({ SERVICES_PATH: "./services.json" }), /DISCORD_WEBHOOK_URL/);
});

test("loadConfig applique les overrides de webhook par service", () => {
  const config = loadConfig({
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/global",
    DISCORD_WEBHOOK_CLAUDE: "https://discord.com/api/webhooks/2/claude",
    SERVICES_PATH: "./services.json",
    STATE_PATH: "./data/state.json",
  });

  assert.equal(webhookEnvName("claude"), "DISCORD_WEBHOOK_CLAUDE");
  assert.equal(
    config.services.find((s) => s.key === "claude")?.webhookUrl,
    "https://discord.com/api/webhooks/2/claude",
  );
  assert.equal(
    config.services.find((s) => s.key === "github")?.webhookUrl,
    "https://discord.com/api/webhooks/1/global",
  );
  assert.equal(config.pollIntervalSeconds, 60);
  assert.equal(config.dryRun, false);
});

test("loadConfig rejette un intervalle non entier positif", () => {
  assert.throws(
    () =>
      loadConfig({
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/global",
        POLL_INTERVAL_SECONDS: "0",
      }),
    /POLL_INTERVAL_SECONDS/,
  );
});
