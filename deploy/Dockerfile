FROM node:22-alpine
WORKDIR /app

# Exact top-level live dependency versions are pinned in package.json.
COPY package.json package-lock.json ./
RUN npm install --omit=dev --include=optional --ignore-scripts

COPY src ./src
COPY web ./web
COPY scripts ./scripts
# Built by `anchor build`; the app talks to the deployed Fuse program through it.
COPY contracts/fuse-anchor/target/idl ./contracts/fuse-anchor/target/idl
COPY policy.example.json ./

RUN mkdir -p /app/.data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/.data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node","src/http/server.mjs"]
