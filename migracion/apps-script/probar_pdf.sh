#!/bin/bash
# Manda un PDF real al Web App para probar el OCR de Drive (Ocr.gs).
# Uso: ./probar_pdf.sh <accion> <ruta.pdf>
#   ./probar_pdf.sh parse_extracto "../../Resumenes de Cuenta/xxx.pdf"
# OJO: parse_extracto NO escribe en la base (solo calcula candidatos);
# importar_informe SI escribe.
set -e

ACCION="$1"
PDF="$2"

if [ -z "$ACCION" ] || [ -z "$PDF" ]; then
  echo "Uso: ./probar_pdf.sh <accion> <ruta.pdf>"
  exit 1
fi
if [ ! -f "$PDF" ]; then
  echo "No existe el archivo: $PDF"
  exit 1
fi

URL="https://script.google.com/macros/s/AKfycbxoRncX1uo-DeuwmW84fi0LI2A9Z2AmKOIAMFMo_EGMS0Oo4l6bhhhExPplQ9RvKYqN/exec"
CACHE="$(dirname "$0")/.token"

if [ ! -f "$CACHE" ]; then
  echo "No hay token en .token - corré ./probar.sh primero (con copy(ID_TOKEN) en el portapapeles)."
  exit 1
fi
TOKEN=$(cat "$CACHE")

echo "PDF: $(basename "$PDF") ($(wc -c < "$PDF" | tr -d ' ') bytes)"

TMPFILE=$(mktemp)
python3 - "$TOKEN" "$ACCION" "$PDF" > "$TMPFILE" <<'PY'
import base64, json, sys, os
token, accion, ruta = sys.argv[1], sys.argv[2], sys.argv[3]
with open(ruta, 'rb') as fh:
    b64 = base64.b64encode(fh.read()).decode('ascii')
json.dump({
    'token': token,
    'action': accion,
    'filename': os.path.basename(ruta),
    'file_base64': b64,
}, sys.stdout)
PY

LOC=$(curl -s -D - -o /dev/null -X POST "$URL" \
  -H "Content-Type: text/plain;charset=utf-8" \
  --data-binary "@$TMPFILE" | grep -i '^location:' | cut -d' ' -f2 | tr -d '\r')

if [ -z "$LOC" ]; then
  echo "El /exec no devolvió redirect."
  rm -f "$TMPFILE"
  exit 1
fi

echo "--- respuesta ---"
curl -s "$LOC"
echo
rm -f "$TMPFILE"
