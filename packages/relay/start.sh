#!/bin/sh
# The relay, and coturn beside it when TURN_SECRET is set. Either one stopping
# stops the machine, so Fly restarts both rather than leaving half running.
set -eu

if [ -z "${TURN_SECRET:-}" ]; then
  exec node signaling-server.mjs
fi

# UDP on Fly arrives at, and must leave from, the fly-global-services address.
# TCP comes through Fly's proxy to the machine's own address.
udp_ip=$(getent hosts fly-global-services | awk '{ print $1; exit }')
tcp_ip=$(ip -4 -o addr show eth0 | awk '{ split($4, a, "/"); print a[1]; exit }')
: "${TURN_PUBLIC_IP:?set TURN_PUBLIC_IP to the app's dedicated IPv4}"

# The secret goes in a file, not the command line, where any process could read it.
conf=$(mktemp)
cat /app/turnserver.conf > "$conf"
echo "static-auth-secret=$TURN_SECRET" >> "$conf"
chmod 600 "$conf"

turnserver -c "$conf" \
  --listening-ip="$udp_ip" --listening-ip="$tcp_ip" \
  --relay-ip="$udp_ip" \
  --external-ip="$TURN_PUBLIC_IP/$udp_ip" &
turn=$!

node signaling-server.mjs &
relay=$!

trap 'kill $turn $relay 2>/dev/null' TERM INT
while kill -0 $turn 2>/dev/null && kill -0 $relay 2>/dev/null; do sleep 2; done
kill $turn $relay 2>/dev/null || true
exit 1
