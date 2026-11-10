FROM oven/bun:1.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3000
# Build from the database in the volume, then serve dist/.
CMD ["sh", "-c", "bun run build && bun src/index.ts"]
