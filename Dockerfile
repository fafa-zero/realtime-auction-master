# Build the existing React frontend and TypeScript server in one workspace.
FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY apps apps
COPY services services
COPY .env.example .env.example
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime

WORKDIR /app/apps/server
ENV NODE_ENV=production
ENV PORT=4300
ENV CLIENT_URL=http://localhost:4300
ENV AUCTION_DATA_FILE=/app/data/auction-state.json

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package-lock.json /app/
COPY --from=build /app/apps/server/package.json ./package.json
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/public ./public
COPY --from=build /app/apps/web/dist /app/apps/web/dist

RUN mkdir -p /app/data
EXPOSE 4300
HEALTHCHECK --interval=10s --timeout=3s --retries=10 CMD node -e "fetch('http://127.0.0.1:4300/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]

