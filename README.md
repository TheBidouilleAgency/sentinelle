# sentinelle

Surveille les status pages de nos dépendances (Claude, GitHub, npm, Discord…) et publie
chaque incident dans un salon **forum Discord** : un post par incident, les mises à jour
en réponses, un message de clôture avec la durée totale.

Zéro dépendance runtime (Node 22, `fetch` natif). TypeScript en devDependency uniquement.

## Fonctionnement

Un tick périodique (`POLL_INTERVAL_SECONDS`, 60 s par défaut, + jitter 0–5 s) :

1. interroge `{{statusPageUrl}}/api/v2/incidents.json` pour chaque service — et non
   `incidents/unresolved.json`, qui fait disparaître l'incident au moment même où le
   message de résolution devient intéressant ;
2. normalise en `NormalizedIncident` (updates triés par date croissante) ;
3. passe le state et les incidents au **reducer pur** (`src/core/reducer.ts`), qui produit
   une liste d'actions : `CREATE_THREAD`, `POST_UPDATE`, `CLOSE` ;
4. exécute les actions **séquentiellement**, et ne met à jour le state qu'après un succès
   réel, avec sauvegarde atomique après chaque action.

C'est ce dernier point qui garantit l'idempotence : un crash, un redéploiement ou un
rejeu reprend exactement là où il s'était arrêté, sans jamais poster deux fois.

### Seed au premier démarrage

State absent ou volume perdu → tous les incidents courants et leurs updates sont
enregistrés **sans rien poster** (`SEEDED — n incidents enregistrés sans notification`).
Sans ça, une perte de volume réveillerait le forum avec des dizaines d'incidents
historiques. Un incident encore en cours au moment du seed est adopté silencieusement :
il n'ouvre un post que s'il reçoit un update inédit ensuite.

### Dead man's switch

Après chaque tick terminé sans exception, `GET HEALTHCHECK_URL` (fire-and-forget).
Côté Healthchecks.io : période 5 min, grâce 10 min. Sans ce ping, un service mort est
indistinguable d'un service qui n'a rien à signaler.

## Développement

```bash
npm install
npm test          # node:test, aucun accès réseau, fixtures JSON
npm run typecheck
npm run build

# Validation de la config en local, sans rien écrire dans Discord ni sur disque :
DRY_RUN=true DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/x/y \
  STATE_PATH=./data/state.json node src/index.ts
```

En `DRY_RUN`, le seed est volontairement court-circuité : les incidents en cours
apparaissent comme des actions, ce qui permet de vérifier titres, couleurs et durées.

## Configuration

`services.json` (commité, aucun secret) :

```json
[{ "key": "github", "name": "GitHub", "type": "statuspage", "url": "https://www.githubstatus.com" }]
```

| Variable | Défaut | Rôle |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | — | webhook du salon forum (**requis**) |
| `DISCORD_WEBHOOK_<KEY>` | — | override par service (`DISCORD_WEBHOOK_GITHUB`) |
| `POLL_INTERVAL_SECONDS` | `60` | intervalle du tick |
| `STATE_PATH` | `/app/data/state.json` | fichier de state |
| `SERVICES_PATH` | `./services.json` | liste des services |
| `HEALTHCHECK_URL` | — | dead man's switch, optionnel |
| `DRY_RUN` | `false` | logge les actions au lieu de poster |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

Config invalide au boot (webhook manquant, `services.json` illisible) → crash immédiat
avec un message explicite, jamais de démarrage dégradé silencieux.

## Déploiement (Dokploy)

- Application depuis le repo, build Dockerfile.
- Volume `sentinelle-data` → `/app/data`.
- Variables dans l'onglet Environment.
- Restart policy `unless-stopped`.
- **Ne pas exposer de domaine** : aucun port n'est ouvert.

Le webhook doit pointer vers un salon **forum** : la création de post utilise
`?wait=true&thread_name=…` et les réponses `?wait=true&thread_id=…`.

## Ajouter un provider non-Statuspage

Implémenter `StatusProvider` (`src/providers/types.ts`) et retourner des
`NormalizedIncident`. Le reste du code — reducer, formatage, state — n'en sait rien.

## Hors scope (phase 2)

Maintenances programmées, statut par composant, providers Hostinger/Dokploy,
résumé hebdomadaire, UI web.
