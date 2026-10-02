ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN bun run typecheck && bun run build

FROM oven/bun:${BUN_VERSION} AS production
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 UPLOAD_DIR=/app/data/uploads
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
    && mkdir -p /app/data/uploads && chown -R bun:bun /app/data
COPY --from=build /app/dist ./dist
COPY src/server ./src/server
COPY src/shared ./src/shared
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/server/index.ts"]
