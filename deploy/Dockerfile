FROM rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS rust-build
ARG CARGO_BUILD_JOBS
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY apps apps
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target \
    cargo build --locked --release --workspace && mkdir -p /output && \
    cp target/release/oas-server target/release/oas-browser-worker target/release/oasctl /output/

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS web-build
WORKDIR /src
COPY web/package*.json web/
RUN cd web && npm ci
COPY web web
COPY docs/plan1/contracts docs/plan1/contracts
RUN cd web && npm run build

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && useradd --system --uid 10001 oas
FROM runtime-base AS api
WORKDIR /app
COPY --from=rust-build /output/oas-server /app/oas-server
USER oas
ENV OAS_WEB_DIR=/app/web OAS_BIND=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/app/oas-server"]

FROM nginx:stable-alpine@sha256:caf4e1e032a20f9c3c5e28fc7f25ffd768ad8677b4975c54193075997b3a97e3 AS web
COPY --from=web-build /src/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
ENV OAS_API_HOST=oas-api OAS_API_PORT=8080
EXPOSE 80

FROM runtime-base AS browser
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends firefox-esr fonts-noto-cjk fonts-liberation tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/oas && chown oas /home/oas
WORKDIR /app
COPY --from=rust-build /output/oas-browser-worker /app/oas-browser-worker
USER oas
ENV OAS_WORKER_BIND=0.0.0.0:8090
EXPOSE 8090
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/app/oas-browser-worker"]
