# Multi-stage build: compile TypeScript in one image, ship only the output.
# Small final image = faster deploys, smaller attack surface.

FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Reference chat page, served at /demo outside production.
COPY examples ./examples
# Never run as root inside the container.
USER node
EXPOSE 8080
# Liveness check for Docker / orchestrators.
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "dist/index.js"]
