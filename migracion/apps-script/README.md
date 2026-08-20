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

Los archivos (PDF de informe/extracto) viajan en base64 dentro del mismo
JSON (`file_base64`, `filename`), no como `multipart/form-data` - Apps
Script no tiene un parser confiable de multipart en `doPost`.

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
- `Ocr.gs` - convierte el PDF subido a Google Doc vía Drive API (con OCR) y
  devuelve el texto - reemplaza a pdfplumber/pypdf/PyMuPDF/Vision API.
  **Sin validar todavía contra los PDFs reales** (ver pendientes abajo) -
  esta es la única pieza que no pude probar yo solo, porque necesita un
  deploy real corriendo.

## Estado actual (qué falta)

Hecho, portado y validado (corrido con Node, no solo revisado a ojo):
- El parseo del informe consolidado y el matcheo de cliente por
  dirección/nombre - mismos números que el prototipo Python contra los
  datos reales.
- La búsqueda de CUIT + monto en el extracto (regex, incluye el fix del
  espacio en cualquier posición del CUIT).

Hecho y portado, sin poder correrlo yo (necesita Supabase/Apps Script
reales, que no puedo crear ni loguear por vos):
- Auth completo (verificar token, resolver perfil, allowlist de "romper
  vidrio" con `ALLOWED_EMAILS` en Script Properties).
- CRUD de clientes, usuarios, confirmar pago manual (ahora con el UNIQUE de
  Postgres evitando el duplicado, sin condición de carrera), confirmar CUIT
  pendiente (un solo UPDATE con IN(...), atómico), obtener_datos.

Pendiente, necesita probarse con vos mirando:
- **`Ocr.gs` con un PDF real** - subir el informe y un extracto reales una
  vez deployado, y comparar contra los números de arriba.
- Deploy del Web App (`clasp push` + `clasp deploy`, o pegarlo a mano en
  script.google.com) - clasp está instalado pero la sesión local expiró
  (`clasp login` pide reautenticarse), y hace falta habilitar el servicio
  avanzado "Drive API" (v2) en el proyecto de Apps Script para que
  `Ocr.gs` funcione.
- Crear el proyecto Supabase (si no existe todavía), agregar `ko` a
  "Exposed schemas" en Database > API Settings, y correr
  `../supabase/01_schema.sql` y `../supabase/02_datos.sql` en ese orden.
- Completar Script Properties: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`.
- Adaptar `docs/admin.js` (`llamarBackend`) al nuevo formato de request -
  a propósito no tocado todavía (sigue mandando `Authorization` header +
  JSON contra Render), para no cambiar nada del sitio en producción hasta
  que el Web App esté deployado y probado en paralelo.
