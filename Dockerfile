# The kernel and the control plane in one image. celld comes from its own
# image; the packages are built for Linux here.
FROM node:22-bookworm-slim

COPY --from=ghcr.io/openstudiotech/celld:v0.6.2-openstudio.1 /usr/local/bin/celld /usr/local/bin/celld
COPY licenses/celld /usr/share/licenses/celld
ENV CELLD_ESBUILD=/app/kernel/node_modules/.bin/esbuild

WORKDIR /app
COPY kernel/package.json kernel/package-lock.json kernel/
COPY control/package.json control/package-lock.json control/
RUN npm ci --prefix kernel && npm ci --prefix control
COPY kernel kernel
COPY control control

# Starts the kernel where other machines can reach it. celld takes the
# kernel's settings from a file beside its config, not from the environment,
# and without them the kernel would run on the secret everyone knows.
COPY --chmod=755 <<'EOF' /usr/local/bin/serve-kernel
#!/bin/sh
set -e
cd /app/kernel
printf 'KERNEL_SECRET=%s\nCONTROL_URL=%s\n' "${KERNEL_SECRET:?}" "${CONTROL_URL:?}" > .dev.vars
exec celld dev . --host 0.0.0.0 --port "${PORT:-28181}" --no-watch
EOF

# Both in one container, for running it on your own machine: the kernel, then
# the control plane once the kernel answers. Everything it keeps is under
# /data. If either stops, the container stops, so Docker can start it again.
COPY --chmod=755 <<'EOF' /usr/local/bin/serve
#!/bin/sh
set -e
mkdir -p /data/control /data/kernel
ln -sfn /data/kernel /app/kernel/.celld
[ -f /data/kernel-secret ] || node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))' > /data/kernel-secret
export KERNEL_SECRET="$(cat /data/kernel-secret)" CONTROL_URL=http://127.0.0.1:4010
export HOST=0.0.0.0 OPENSTUDIO_DATA=/data/control

cd /app/kernel
printf 'KERNEL_SECRET=%s\nCONTROL_URL=%s\n' "$KERNEL_SECRET" "$CONTROL_URL" > .dev.vars
celld dev . --host 0.0.0.0 --port 28181 --no-watch &
kernel=$!
until node -e 'fetch("http://127.0.0.1:28181/.well-known/celld/health").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'; do
  kill -0 $kernel 2>/dev/null || exit 1
  sleep 1
done
npm --prefix /app/control start &
control=$!
trap 'kill $kernel $control 2>/dev/null' TERM INT
while kill -0 $kernel 2>/dev/null && kill -0 $control 2>/dev/null; do sleep 2; done
kill $kernel $control 2>/dev/null
exit 1
EOF
EXPOSE 4010 28181
VOLUME /data
CMD ["serve"]
