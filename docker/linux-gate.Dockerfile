# The gate, on Linux, in Docker.
#
#   docker build -f docker/linux-gate.Dockerfile -t oac-linux-gate .
#   docker run --rm oac-linux-gate                       # the whole gate
#   docker run --rm oac-linux-gate bash -c 'pnpm typecheck && pnpm test'
#
# The default base is Docker Hub's Alpine node. Where Hub is unreachable (the
# author's machine), pass an internal Alpine base, a reachable mirror, and
# INSTALL_NODE=1 — that base has no node, and its entrypoint drops privileges, so
# the build clears it and works as root:
#
#   docker build \
#     --build-arg BASE_IMAGE=<internal-alpine-base> \
#     --build-arg APK_MIRROR=https://mirrors.tuna.tsinghua.edu.cn \
#     --build-arg INSTALL_NODE=1 \
#     -f docker/linux-gate.Dockerfile -t oac-linux-gate .
ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE}

ARG APK_MIRROR=""
ARG INSTALL_NODE=0

ENTRYPOINT []
USER root

RUN if [ -n "$APK_MIRROR" ]; then \
      sed -i "s#https://dl-cdn.alpinelinux.org#$APK_MIRROR#g" /etc/apk/repositories; \
    fi \
 && apk add --no-cache \
      tmux zsh bash python3 py3-jsonschema git curl \
 && if [ "$INSTALL_NODE" = "1" ]; then apk add --no-cache nodejs npm; fi \
 && npm install -g pnpm@11.7.0

WORKDIR /work
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# The gate itself. `scripts/verify.sh` resolves the opencode binary from PATH, and
# the version scripts install a release into a temporary prefix.
CMD ["bash", "scripts/verify.sh"]
