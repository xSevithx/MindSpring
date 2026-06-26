#!/bin/sh
# Generates a self-signed TLS cert on first start so the app can be served
# over HTTPS on the LAN. Web Crypto (used for note encryption) only works in
# a secure context: https://, or http://localhost. A self-signed cert is
# enough — once the browser warning is accepted, the page is a secure context.
set -e

CERT_DIR=/etc/nginx/certs
mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/cert.pem" ] && [ -f "$CERT_DIR/key.pem" ]; then
  exit 0
fi

SAN="DNS:localhost,IP:127.0.0.1"
if [ -n "$HOST_IP" ]; then
  SAN="$SAN,IP:$HOST_IP"
fi

echo "Generating self-signed certificate (subjectAltName=$SAN)..."
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days 825 \
  -subj "/CN=securenotes" \
  -addext "subjectAltName=$SAN"
