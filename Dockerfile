# --- build -------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# --- runtime -----------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# Aucune dépendance runtime : seuls le JS compilé et la liste des services.
COPY package.json ./
COPY services.json ./services.json
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]

# Pas de HEALTHCHECK Docker : aucun port exposé, la supervision passe par
# le dead man's switch (HEALTHCHECK_URL).
CMD ["node", "dist/index.js"]
