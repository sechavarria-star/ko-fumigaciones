# ko-fumigaciones / app-campo — App de campo de KO (fumigadores)

Proyecto anidado dentro de `ko-fumigaciones`, **separado de la conciliación de
cobranzas** (el panel de app.kofumigacion.com y el schema `ko`). No mezclar: esto
es la app que usan los fumigadores en la calle — edificios y unidades, visitas,
reportes de servicio, reclamos de vecinos, certificados por edificio y actas de
limpieza de tanque.

## Estado (2026-11-02)

- **Hoy** la app es un Apps Script de Vicky (v.gagey@giwa-ia.com), script ID
  `1ZByFHFwd1VozgD3mrz8M1e_3q-S3iFsJ9A3kKAH1U1O1TAPAjhrhYHVL`, que usa como base
  la planilla **"KO Fumigaciones · Básica"**
  (`17B9OTyTByMhyZKKe4dWiWUrytZmtzT3E7jzZDUyNgis`).
- **Objetivo**: migrarla a Supabase, schema `kofumigaciones`.
- **Hecho**: el schema ya está creado en Supabase (Giwa_Database), con las 10
  tablas **vacías** → `supabase/01_estructura.sql`. Por pedido del usuario no se
  cargaron los datos de la planilla (eran de demo).
- **Pendiente**: el proyecto de Apps Script no está compartido con
  s.echavarria@giwa-ia.com (clasp y Drive dicen "not found"). Vicky tiene que
  compartirlo como Editor, o copiar su código con clasp a esta carpeta.

## Plan de migración (a confirmar con el usuario antes de tocar código)

1. Leer el código y mapear cada lectura/escritura a la planilla, pestaña por pestaña.
2. Reemplazarlas por llamadas a Supabase (PostgREST, `Accept-Profile` /
   `Content-Profile: kofumigaciones`, service_role key en Script Properties —
   mismo patrón que `../migracion/apps-script/Supabase.gs`), sin cambiar lo que ve
   el usuario.
3. Probar en una copia del proyecto; el de Vicky no se toca hasta validar.
4. Decidir con el usuario si se migran datos reales o se arranca vacío.

## Mapa

- `supabase/01_estructura.sql` → schema `kofumigaciones`: `edificios`, `unidades`,
  `quimicos`, `fumigadores`, `reportes`, `reclamos`, `visitas`,
  `certificados_edificio`, `actas_tanque`, `config`. Una tabla por pestaña de la
  planilla, mismas columnas en snake_case. Solo service_role (RLS activo).

## Reglas

- Este repo (`ko-fumigaciones`) es **público**: acá solo va código y estructura,
  nunca datos de la planilla (residentes, DNI, teléfonos).
- Los SQL se aplican con `supabase db query --linked --project-ref ofhiogczijhzkuqdjwvz -f <archivo>`
  (nunca por portapapeles: rompe los acentos).
- Para que la app use la API de Supabase hay que agregar `kofumigaciones` en
  Project Settings → Data API → Exposed schemas (no se hace por SQL).
