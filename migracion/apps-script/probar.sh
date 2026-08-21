#!/bin/bash
# Uso: copiá el token al portapapeles (seleccionalo en la consola del
# navegador y Cmd+C) y despues corré: ./probar.sh [accion]
# accion por default: obtener_datos
set -e

ACCION="${1:-obtener_datos}"
URL="https://script.google.com/macros/s/AKfycbxoRncX1uo-DeuwmW84fi0LI2A9Z2AmKOIAMFMo_EGMS0Oo4l6bhhhExPplQ9RvKYqN/exec"

# El token se cachea en .token para no depender del portapapeles en cada
# corrida (se pisa facil al copiar otra cosa). Solo se toma del portapapeles
# cuando lo que hay ahi es realmente un JWT.
CACHE="$(dirname "$0")/.token"
PEGADO=$(pbpaste | tr -d '[:space:]"')

if [[ "$PEGADO" == eyJ*.*.* ]]; then
  echo "$PEGADO" > "$CACHE"
  chmod 600 "$CACHE"
  TOKEN="$PEGADO"
  echo "Token nuevo tomado del portapapeles (${#TOKEN} caracteres) y guardado en .token"
elif [ -f "$CACHE" ]; then
  TOKEN=$(cat "$CACHE")
  echo "Token reusado de .token (${#TOKEN} caracteres) - el portapapeles no tenia un JWT."
else
  echo "No hay token: copiá uno con copy(ID_TOKEN) en la consola del sitio y volvé a correr."
  exit 1
fi

# Los id_token de Google duran ~1h: avisar antes de que el 401 confunda.
VENCE=$(python3 -c "
import base64, json, sys, time
p = sys.argv[1].split('.')[1]
p += '=' * (-len(p) % 4)
exp = json.loads(base64.urlsafe_b64decode(p)).get('exp', 0)
print(int(exp - time.time()))
" "$TOKEN" 2>/dev/null || echo "")

if [ -n "$VENCE" ] && [ "$VENCE" -le 0 ] 2>/dev/null; then
  echo "OJO: el token vencio hace $(( -VENCE ))s - copiá uno nuevo con copy(ID_TOKEN)."
elif [ -n "$VENCE" ]; then
  echo "Token valido por $(( VENCE / 60 )) min mas."
fi

TMPFILE=$(mktemp)
printf '{"token":"%s","action":"%s"}' "$TOKEN" "$ACCION" > "$TMPFILE"

# El /exec responde 302 hacia script.googleusercontent.com, donde ya espera
# el resultado listo: ese segundo tramo hay que pedirlo con GET. Si se fuerza
# POST ahi (curl -L --post302) el endpoint devuelve 405 Method Not Allowed.
LOC=$(curl -s -D - -o /dev/null -X POST "$URL" \
  -H "Content-Type: text/plain;charset=utf-8" \
  --data-binary "@$TMPFILE" | grep -i '^location:' | cut -d' ' -f2 | tr -d '\r')

if [ -z "$LOC" ]; then
  echo "El /exec no devolvio redirect - revisá que el deployment sea de tipo Web app."
  rm -f "$TMPFILE"
  exit 1
fi

echo "--- respuesta ---"
curl -s "$LOC" -w "\n--- http:%{http_code} ---\n"

rm -f "$TMPFILE"
