# Build context is the REPO ROOT (see docker-compose.yml's `context: .`) so
# this stage can also pick up docker/nginx/nginx.conf, which is shared
# config, not frontend-specific. Multi-stage: build the React app, then serve
# the static output with nginx. Self-contained on purpose — unlike this
# session's manual deploys (built on the host, scp'd `dist/`), this builds
# from a clean checkout with no host-side npm step required.

FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
