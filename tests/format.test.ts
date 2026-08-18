import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMBED_DESCRIPTION_MAX,
  THREAD_NAME_MAX,
  closeEmbed,
  colorFor,
  formatDuration,
  initialEmbed,
  sanitizeBody,
  threadName,
  truncate,
  updateEmbed,
} from "../src/discord/format.ts";
import type { NormalizedIncident } from "../src/providers/types.ts";

const incident: NormalizedIncident = {
  providerKey: "github",
  id: "inc-1",
  title: "Elevated error rates on the API",
  status: "investigating",
  impact: "major",
  url: "https://stspg.io/inc1",
  createdAt: new Date("2026-08-17T09:00:00Z"),
  resolvedAt: null,
  updates: [
    {
      id: "upd-1",
      status: "investigating",
      body: "We are investigating elevated error rates.",
      createdAt: new Date("2026-08-17T09:00:00Z"),
    },
  ],
};

test("thread_name est tronqué à 100 caractères", () => {
  const longTitle = "x".repeat(200);
  const name = threadName("GitHub", longTitle);

  assert.equal(name.length, THREAD_NAME_MAX);
  assert.ok(name.startsWith("GitHub — xxx"));
  assert.ok(name.endsWith("…"));
});

test("thread_name court est laissé intact", () => {
  assert.equal(threadName("GitHub", "Elevated error rates"), "GitHub — Elevated error rates");
});

test("la description de l'embed est bornée à 4096 caractères", () => {
  const embed = initialEmbed({ ...incident, updates: [{ ...incident.updates[0]!, body: "y".repeat(9000) }] }, "GitHub");

  assert.ok(embed.description !== undefined);
  assert.equal(embed.description.length, EMBED_DESCRIPTION_MAX);
});

test("couleurs par impact, vert une fois résolu", () => {
  assert.equal(colorFor("critical", false), 0xed4245);
  assert.equal(colorFor("major", false), 0xe67e22);
  assert.equal(colorFor("minor", false), 0xfee75c);
  assert.equal(colorFor("none", false), 0x57f287);
  assert.equal(colorFor("critical", true), 0x57f287);
});

test("durées formatées en 1h 12min", () => {
  assert.equal(formatDuration(45 * 60_000), "45min");
  assert.equal(formatDuration(72 * 60_000), "1h 12min");
  assert.equal(formatDuration(120 * 60_000), "2h");
  assert.equal(formatDuration(27 * 60 * 60_000), "1j 3h");
  assert.equal(formatDuration(-1000), "0min");
});

test("le message de clôture annonce la durée totale", () => {
  const resolved: NormalizedIncident = {
    ...incident,
    status: "resolved",
    resolvedAt: new Date("2026-08-17T10:12:00Z"),
  };

  const embed = closeEmbed(resolved, "GitHub");

  assert.match(embed.description ?? "", /Durée totale : \*\*1h 12min\*\*/);
  assert.equal(embed.color, 0x57f287);
});

test("le message de clôture de repli omet la durée", () => {
  const embed = closeEmbed({ ...incident, status: "resolved" }, "GitHub");

  assert.match(embed.description ?? "", /Durée totale inconnue/);
});

test("les backticks du body sont neutralisés", () => {
  assert.equal(sanitizeBody("use `code` here"), "use ˋcodeˋ here");
  const embed = updateEmbed(incident, { ...incident.updates[0]!, body: "a `b` c" });
  assert.equal(embed.description, "a ˋbˋ c");
});

test("truncate ajoute une ellipse sans dépasser la limite", () => {
  assert.equal(truncate("abcdef", 10), "abcdef");
  assert.equal(truncate("abcdef", 4), "abc…");
});

test("le post initial porte le statut, l'impact et le lien", () => {
  const embed = initialEmbed(incident, "GitHub");

  assert.equal(embed.url, "https://stspg.io/inc1");
  assert.equal(embed.footer?.text, "GitHub");
  assert.deepEqual(
    embed.fields?.map((f) => f.name),
    ["Statut", "Impact", "Début"],
  );
  assert.equal(embed.fields?.[0]?.value, "Investigation");
  assert.equal(embed.fields?.[1]?.value, "Majeur");
});
