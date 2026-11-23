# Build the public PREDICT app. It imports shared modules from src/predict, so copy those too.
FROM node:24-slim AS predict-builder
WORKDIR /app
COPY apps/predict/package.json apps/predict/package-lock.json ./apps/predict/
RUN npm --prefix apps/predict ci --no-audit --no-fund
COPY src/predict ./src/predict
COPY apps/predict/index.html apps/predict/vite.config.js ./apps/predict/
COPY apps/predict/src ./apps/predict/src
COPY apps/predict/public ./apps/predict/public
ARG VITE_DEVNET_RPC=https://api.devnet.solana.com
ARG VITE_FEATURED_MARKETS=
ARG VITE_FEATURED_VAULTS=
ENV VITE_DEVNET_RPC=$VITE_DEVNET_RPC VITE_FEATURED_MARKETS=$VITE_FEATURED_MARKETS VITE_FEATURED_VAULTS=$VITE_FEATURED_VAULTS
RUN npm --prefix apps/predict run check && npm --prefix apps/predict run build

# Runtime continues supporting the archived Fuse perps lab at /perps/.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY deploy/idl ./deploy/idl
COPY policy.example.json policy.proof.json ./
COPY --from=predict-builder /app/apps/predict/dist ./apps/predict/dist
RUN mkdir -p /app/.data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/.data SOLANA_CLUSTER=devnet
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8787/api/predict/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","src/http/server.mjs"]
