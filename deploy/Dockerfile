# glibc base: the Velocity SDK pulls native packages that ship no musl builds.
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY web ./web
COPY scripts ./scripts
# The Anchor IDL for the exact deployed program, committed by the deployer (empty until then:
# the server then starts in setup mode and says so on the page).
COPY deploy/idl ./deploy/idl
COPY policy.example.json policy.proof.json ./

RUN mkdir -p /app/.data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/.data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","src/http/server.mjs"]
