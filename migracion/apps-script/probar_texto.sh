#!/bin/bash
# Manda texto ya extraído (no el PDF) al Web App - es el camino que va a usar
# el frontend con pdf.js. Uso: ./probar_texto.sh <accion> <archivo.txt> [label]
set -e

ACCION="$1"
TXT="$2"
LABEL="${3:-prueba.pdf}"

if [ -z "$ACCION" ] || [ ! -f "$TXT" ]; then
  echo "Uso: ./probar_texto.sh <accion> <archivo.txt> [label]"
  exit 1
fi

URL="https://script.google.com/macros/s/AKfycbxoRncX1uo-DeuwmW84fi0LI2A9Z2AmKOIAMFMo_EGMS0Oo4l6bhhhExPplQ9RvKYqN/exec"
CACHE="$(dirname "$0")/.token"
[ -f "$CACHE" ] || { echo "No hay token en .token - corré ./probar.sh primero."; exit 1; }

TMPFILE=$(mktemp)
python3 - "$(cat "$CACHE")" "$ACCION" "$TXT" "$LABEL" > "$TMPFILE" <<'PY'
import json, sys
token, accion, ruta, label = sys.argv[1:5]
json.dump({
    'token': token,
    'action': accion,
    'filename': label,
    'texto': open(ruta, encoding='utf-8').read(),
}, sys.stdout)
PY

LOC=$(curl -s -D - -o /dev/null -X POST "$URL" \
  -H "Content-Type: text/plain;charset=utf-8" \
  --data-binary "@$TMPFILE" | grep -i '^location:' | cut -d' ' -f2 | tr -d '\r')

[ -n "$LOC" ] || { echo "El /exec no devolvió redirect."; rm -f "$TMPFILE"; exit 1; }

curl -s "$LOC"
echo
rm -f "$TMPFILE"
