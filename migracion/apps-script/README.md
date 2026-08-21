# KO Fumigaciones - migración a Apps Script + Supabase

Reemplaza al backend FastAPI/Render. El frontend (`docs/`) sigue siendo el
mismo sitio estático en GitHub Pages - solo cambia `CONFIG.BACKEND_URL` para
apuntar a la URL del Web App de Apps Script en vez de a Render.

## Por qué el formato de request es distinto al de antes

Un Web App de Apps Script **no puede responder a un preflight CORS
(OPTIONS)** - es una limitación de la plataforma, no algo que se pueda
configurar. Cualquier fetch() con un header custom (`Authorization: Bearer
...`) o `Content-Type: application/json` dispara ese preflight en el
navegador, así que el request fallaría siempre.

Por eso todo pasa a viajar como **una sola llamada `POST` con
`Content-Type: text/plain;charset=utf-8`**, cuyo body es un JSON con esta
forma:

```json
{ "token": "<id_token de Google>", "action": "obtener_datos", "...": "..." }
```

`text/plain` es uno de los content-types "simples" según la spec de CORS
- no dispara preflight aunque el body sea en verdad JSON. Apps Script lee el
body crudo con `e.postData.contents` y lo parsea a mano.

## De dónde sale el texto de los PDFs (esto cambió)

El plan original era mandar el PDF en base64 y que Apps Script lo pasara por
el OCR de Drive. **Probado contra el extracto real de Abril 2026, no
funciona**: la conversión PDF -> Google Doc aplana la tabla (758 párrafos
sueltos, sin ninguna tabla) y manda la columna de importes a otra parte del
documento, lejos del movimiento al que pertenece. Como el matcher busca el
CUIT y el importe en una ventana de ~250 caracteres, encontró **5 pagos en
vez de 43**. El texto no se pierde (mismos 677 `$` y 751 importes que
pdfplumber) - se pierde la *proximidad*, que es de lo que depende el
matcheo.

La solución es extraer el texto **en el navegador con pdf.js** y mandar
`texto` en vez de `file_base64`: pdf.js expone las coordenadas de cada
palabra, así que agrupando por Y y ordenando por X se reconstruyen las
columnas igual que pdfplumber. Verificado sobre el mismo extracto:

| método | matches |
| --- | --- |
| pdfplumber (backend Python) | 43 |
| pdf.js agrupando por coordenadas | 43 (idénticos) |
| OCR de Drive | 5 |

`textoDelPdf_()` (Ocr.gs) prefiere `body.texto` y solo cae al OCR de Drive
si viene un `file_base64` sin texto - o sea, para PDFs escaneados de una
sola factura, donde el layout es simple y la reflow no molesta.

## Archivos

- `Config.gs` - lee `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y
  `GOOGLE_CLIENT_ID` de Script Properties (Project Settings > Script
  Properties en el editor de Apps Script) - nunca hardcodeados.
- `Auth.gs` - valida el id_token de Google contra el endpoint público
  `tokeninfo` de Google (no hace falta ninguna librería), y busca el
  usuario/perfil en `ko.usuarios` de Supabase.
- `Supabase.gs` - helpers `sbGet`/`sbInsert`/`sbUpdate`/`sbUpsert` sobre la
  REST API de PostgREST (`UrlFetchApp`), con el mismo patrón de reintento
  ante conflicto que ya resolvimos del lado de GitHub - Postgres lo maneja
  mejor nativamente, pero el helper igual reintenta ante un 409 real.
- `Api.gs` - el `doPost` único: valida el token, arma `usuario`, despacha
  por `action` a cada handler y responde `text/plain` con el resultado. El
  CORS de la respuesta no lo controla este código - `ContentService` no
  deja setear headers custom, así que depende de que la infraestructura de
  Apps Script sirva la respuesta legible para un fetch() "simple" (ver el
  comentario dentro del archivo). Si en la prueba real el navegador la
  bloquea igual, no hay arreglo por código - tocaría meter un proxy.
- `PdfParse.gs` - port del parseo de facturas/extractos (regex de CUIT,
  informe consolidado, matcheo por dirección) - la lógica es la misma que
  `backend/pdf_extract.py` / `backend/informe_parser.py`, casi 1 a 1.
  **Ya validado**: corrido con Node contra el texto real del informe
  (`informe.txt` de la sesión anterior) y contra `data/clientes.json` -
  da exactamente los mismos números que el prototipo en Python (1192
  comprobantes, $107.576.630,41, 970 matcheados / 165 sugeridos / 57 sin
  candidato), y el caso de Clínica Delta (CUIT con espacio metido en medio)
  matchea igual que en Python.
- `Ocr.gs` - `textoDelPdf_()` decide de dónde sale el texto (ver la sección
  de arriba); `extraerTextoPdf_()` es el respaldo por OCR de Drive, que
  quedó relegado a PDFs escaneados de layout simple.

## Estado actual

Andando de punta a punta contra el deploy real y la base real:
- Auth: valida el id_token de Google y resuelve el perfil desde
  `ko.usuarios` (con la allowlist `ALLOWED_EMAILS` de "romper vidrio").
- `obtener_datos`: devuelve los mismos números que producción - 242
  clientes, 1192 facturas, 746 pagos, $107.576.630,41, sin duplicados.
- `parse_extracto` sobre el extracto real de Abril 2026 mandando el texto de
  pdf.js: **43 matches, idénticos uno por uno a los del backend Python**
  (mismo número de factura, CUIT, monto, tipo de movimiento y fecha).
- El parseo del informe y el matcheo por dirección/nombre (validado con Node
  contra los datos reales: 1192 comprobantes, $107.576.630,41, 970
  matcheados / 165 sugeridos / 57 sin candidato), incluido el caso de
  Clínica Delta (CUIT con un espacio metido en el medio).

Infra ya configurada: schema `ko` expuesto en la Data API, los tres SQL
corridos (`01_schema`, `02_datos`, `03_grants`), Script Properties cargadas,
Drive API (v2) habilitada y el Web App deployado con acceso "Anyone".

Falta:
- **`docs/admin.js`**: extraer el texto con pdf.js antes de subir, y hablar
  el formato nuevo (body `text/plain` con `{token, action, ...}`, status
  adentro del JSON en vez de `res.ok`). Sigue apuntando a Render a
  propósito: no se toca producción hasta cortar.
- Probar el **informe consolidado** real end-to-end (escribe en la base, así
  que conviene hacerlo mirando). Si ese PDF resulta ser escaneado, ahí sí
  entra el respaldo por OCR de Drive.
- Cortar `CONFIG.BACKEND_URL` de Render al Web App y dar de baja Render.
