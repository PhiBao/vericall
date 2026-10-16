# VeriCall verifier + app.
#
# The binary is built locally with `cargo build --release` and copied in, rather
# than compiled inside the image. A Rust release build in a thin image would
# spend ten minutes recompiling dependencies that are already compiled here, and
# the artefact is identical either way. Rebuild steps are in the README.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The verifier makes outbound HTTPS calls (Arc RPC) and inbound ones (its own
# built-in services are dialled over the network like any other service), so
# certificates matter.
WORKDIR /app

COPY target/release/vericall /usr/local/bin/vericall
COPY web/dist /app/web/dist
COPY deployments /app/deployments

ENV VERICALL_PORT=8080 \
    VERICALL_STATIC_DIR=/app/web/dist \
    VERICALL_COVENANTS=/app/deployments/covenants-arc-mainnet.json \
    RUST_LOG=vericall=info,tower_http=warn

EXPOSE 8080

# The verifier holds no funds and, in this deployment, no key that can move any:
# it measures, validates and quotes. Settlement is signed by the caller.
CMD ["/usr/local/bin/vericall"]
