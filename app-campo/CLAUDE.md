# ko-fumigaciones / app-campo — App de campo de KO (fumigadores)

Proyecto anidado dentro de `ko-fumigaciones`, **separado de la conciliación de
cobranzas** (el panel de app.kofumigacion.com y el schema `ko`). No mezclar: esto
es la app que usan los fumigadores en la calle — edificios y unidades, visitas,
reportes de servicio, reclamos de vecinos, certificados por edificio y actas de
limpieza de tanque.

## Estado (2026-11-02)

- **Hoy en uso**: el Apps Script de Vicky (v.gagey@giwa-ia.com), script ID
  `1ZByFHFwd1VozgD3mrz8M1e_3q-S3iFsJ9A3kKAH1U1O1TAPAjhrhYHVL`, pegado a la
  planilla **"KO Fumigaciones · Básica"** (`17B9OTyTByMhyZKKe4dWiWUrytZmtzT3E7jzZDUyNgis`).
  **No se toca** hasta validar la migración.
- **Migrado (en prueba)**: `apps-script/` es ese mismo código pero con la base en
  Supabase (schema `kofumigaciones`). Se sube a una **copia de prueba** standalone
  de s.echavarria@giwa-ia.com: `1NpXK0x951PREmU7bWDNq037ApqTatDTyLc8NK8H0jKjHx0EQn8FNpYlo`.
  - `apps-script/.clasp.json` apunta a la COPIA (un `clasp push` va ahí).
  - `apps-script/.clasp.original.json` es el de Vicky, de referencia. No usarlo para push.
  - Los dos están en `.gitignore`.
- Base vacía: por pedido del usuario no se cargaron los datos de la planilla.

## Cómo quedó la migración

- `Supabase.js` → llamadas a la API de Supabase (Accept/Content-Profile
  `kofumigaciones`, service_role desde Script Properties `SUPABASE_URL` y
  `SUPABASE_SERVICE_ROLE_KEY`).
- `Datos.js` → las funciones base (`_leerHoja`, `_agregarFila`, `_actualizarFila`,
  `_escribirFila`, `_borrarFila`, `_filaDeId`, `cfg*`) mantienen nombre y forma,
  pero leen y escriben en Supabase. Traducen las claves (`EdificioID` ↔
  `edificio_id`) y los tipos (SI/NO ↔ boolean, «09:30» ↔ time, JSON texto ↔ jsonb,
  vacío ↔ null). `_fila` es la columna `orden` de cada tabla, así el resto del
  código (Abm, Cronograma, CertEdificio, Importar…) no cambió.
- `Seeds.js` → siembra en Supabase (`sembrarConfig`, `sembrarTodo`, `restablecerDemo`).
- `Código.js` → `api_bootstrap` trae las 10 tablas en paralelo.
- El menú de la planilla (`onOpen`, `abrirApp`) quedó, pero en un script standalone
  no se usa. No borrarlo sin confirmar.
- Verificado en local: corriendo el original (con planilla simulada) y el migrado
  (con Postgres + imitación de PostgREST), un recorrido de 41 pasos (siembra,
  bootstrap, ABM, servicios, reclamos, visitas, certificados, actas, borrados)
  da las mismas respuestas.

## Mapa

- `supabase/01_estructura.sql` → schema `kofumigaciones`: `edificios`, `unidades`,
  `quimicos`, `fumigadores`, `reportes`, `reclamos`, `visitas`,
  `certificados_edificio`, `actas_tanque`, `config`. Una tabla por pestaña de la
  planilla, mismas columnas en snake_case. Solo service_role (RLS activo).
- `supabase/02_ajustes_app.sql` → columna `orden` (identity) en cada tabla y claves
  foráneas con `on delete set null` (y `cascade` para las unidades de un edificio).
- `apps-script/` → el código de la app (ver arriba).

## Reglas

- Este repo (`ko-fumigaciones`) es **público**: acá solo va código y estructura,
  nunca datos de la planilla (residentes, DNI, teléfonos).
- Los SQL se aplican con `supabase db query --linked --project-ref ofhiogczijhzkuqdjwvz -f <archivo>`
  (nunca por portapapeles: rompe los acentos).
- Para que la app use la API de Supabase hay que agregar `kofumigaciones` en
  Project Settings → Data API → Exposed schemas (no se hace por SQL).
