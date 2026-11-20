# syntax=docker/dockerfile:1

FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-slim
ENV NODE_ENV=production \
    DROP_DIR=/data/drop \
    CONFIG_DIR=/data/config \
    YOUTUBE_CLIENT_SECRET_FILE=/data/credentials/youtube-client-secret.json \
    YOUTUBE_TOKEN_FILE=/data/credentials/youtube-token.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js", "start"]
