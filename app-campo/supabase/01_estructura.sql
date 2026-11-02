-- KO Fumigaciones · app de campo (fumigadores, edificios, certificados).
--
-- Estructura del schema `kofumigaciones`, armada a partir de la planilla
-- "KO Fumigaciones · Básica" (una tabla por pestaña, mismas columnas en
-- snake_case). Solo estructura: los datos de la planilla eran de demo y NO se
-- cargan aca.
--
-- Vive en el proyecto Supabase Giwa_Database, al lado de `ko` (la
-- conciliacion de cobranzas). Acceso solo con la service_role key, igual que
-- `ko`: anon y authenticated no ven nada y RLS queda activo como segunda
-- barrera.
--
-- Se puede correr mas de una vez.

create schema if not exists kofumigaciones;

-- --- Edificios (y otros clientes: comercios, gastronomicos) ---------------------
create table if not exists kofumigaciones.edificios (
  id              text primary key,             -- bld-01, com-01, ...
  codigo          text unique,                  -- EDIF-BEL-01
  nombre          text not null,
  direccion       text,
  barrio          text,
  total_unidades  integer,
  administrador   text,
  tel_admin       text,
  email_admin     text,
  creado_el       date,
  tipo            text,
  rubro           text
);

-- --- Fumigadores ------------------------------------------------------------------
create table if not exists kofumigaciones.fumigadores (
  id         text primary key,                  -- fum-carlos
  nombre     text not null,
  matricula  text,
  telefono   text,
  email      text,
  activo     boolean not null default true,     -- SI / NO
  notas      text
);

-- --- Quimicos ---------------------------------------------------------------------
create table if not exists kofumigaciones.quimicos (
  id                  text primary key,         -- chem-01
  nombre_comercial    text not null,
  principio_activo    text,
  concentracion       text,
  reg_senasa          text,
  categoria           text,
  plagas_objetivo     text,                     -- lista separada por |
  dosis_recomendada   text,
  unidad_dosis        text,
  horas_reingreso     numeric(6,2),
  clase_toxicologica  text,
  medidas_seguridad   text                      -- lista separada por |
);

-- --- Unidades (departamentos de cada edificio) --------------------------------------
create table if not exists kofumigaciones.unidades (
  id                  text primary key,         -- apt-bld01-1a
  edificio_id         text not null references kofumigaciones.edificios(id),
  unidad              text not null,            -- Piso 1 - Depto A
  residente           text,
  dni                 text,
  telefono            text,
  email               text,
  mascotas            boolean not null default false,  -- SI / NO
  detalle_mascotas    text,
  codigo              text unique,              -- EDIF-BEL-01:1A
  estado              text,                     -- pending / completed
  ultimo_servicio_id  text,                     -- -> reportes.id (FK abajo)
  ultima_fecha        date
);
create index if not exists unidades_edificio_idx on kofumigaciones.unidades (edificio_id);

-- --- Reportes (servicio hecho en una unidad) ----------------------------------------
create table if not exists kofumigaciones.reportes (
  id                  text primary key,         -- REP-...
  ticket              text,                     -- FUM-2026-1025-107
  edificio_id         text references kofumigaciones.edificios(id),
  edificio_nombre     text,
  edificio_direccion  text,
  unidad_id           text references kofumigaciones.unidades(id),
  unidad_nombre       text,
  tecnico             text,
  matricula           text,
  fecha               date,
  aplicado            text,                     -- "Aspersión, Gel"
  comentarios         text,
  observaciones       text,
  estado              text,
  creado_el           timestamptz
);
create index if not exists reportes_edificio_idx on kofumigaciones.reportes (edificio_id);
create index if not exists reportes_unidad_idx on kofumigaciones.reportes (unidad_id);

-- La unidad apunta a su ultimo reporte, y el reporte a su unidad: la FK va
-- despues de crear las dos tablas.
do $$ begin
  alter table kofumigaciones.unidades
    add constraint unidades_ultimo_servicio_fk
    foreign key (ultimo_servicio_id) references kofumigaciones.reportes(id)
    deferrable initially deferred;
exception when duplicate_object then null; end $$;

-- --- Reclamos de vecinos -------------------------------------------------------------
create table if not exists kofumigaciones.reclamos (
  id               text primary key,            -- REC-...
  fecha            timestamptz,
  edificio_id      text references kofumigaciones.edificios(id),
  edificio_nombre  text,
  unidad_id        text references kofumigaciones.unidades(id),
  unidad_nombre    text,
  vecino           text,
  contacto         text,
  motivo           text,
  detalle          text,
  reporte_id       text references kofumigaciones.reportes(id),
  estado           text,                        -- abierto / en_curso / resuelto
  respuesta        text,
  respondido_el    timestamptz
);

-- --- Visitas programadas -------------------------------------------------------------
create table if not exists kofumigaciones.visitas (
  id                text primary key,           -- vis-...
  fecha             date,
  hora_desde        time,
  hora_hasta        time,
  edificio_id       text references kofumigaciones.edificios(id),
  edificio_nombre   text,
  fumigador_id      text references kofumigaciones.fumigadores(id),
  fumigador_nombre  text,
  alcance           text,                       -- unidades separadas por | o "Todo el edificio"
  estado            text,                       -- programada / en_curso / hecha
  notas             text,
  creado_el         timestamptz,
  resumen           text,
  productos         text,
  ingreso_el        timestamptz,
  servicio          text                        -- fumigacion, ...
);
create index if not exists visitas_fecha_idx on kofumigaciones.visitas (fecha);

-- --- Certificados por edificio --------------------------------------------------------
create table if not exists kofumigaciones.certificados_edificio (
  id                  text primary key,         -- CED-...
  fecha               date,
  edificio_id         text references kofumigaciones.edificios(id),
  edificio_nombre     text,
  edificio_direccion  text,
  fumigador           text,
  fumigadas           integer,
  total               integer,
  unidades_json       jsonb,                    -- [{"nombre":..., "fumigada":true}, ...]
  porteria_nombre     text,
  firma_file_id       text,                     -- archivo de Drive con la firma
  creado_el           timestamptz,
  comunes             text,
  metodos             text,
  productos           text,
  enviado_a           text,
  enviado_el          timestamptz,
  plagas              text,
  productos_json      jsonb,
  vence               date
);

-- --- Actas de limpieza de tanque -------------------------------------------------------
create table if not exists kofumigaciones.actas_tanque (
  id                text primary key,           -- TQ-...
  fecha             date,
  cliente_id        text references kofumigaciones.edificios(id),
  cliente_nombre    text,
  direccion         text,
  fumigador         text,
  cantidad          integer,                    -- cantidad de tanques
  litros            numeric(12,2),
  desinfectante     text,
  analisis          boolean,                    -- SI / NO
  observaciones     text,
  proxima_limpieza  date,
  firma_nombre      text,
  firma_file_id     text,
  creado_el         timestamptz,
  enviado_a         text,
  enviado_el        timestamptz
);

-- --- Config (clave / valor) --------------------------------------------------------------
create table if not exists kofumigaciones.config (
  clave        text primary key,
  valor        text,
  descripcion  text,
  ambito       text                             -- empresa / tecnica
);

-- --- permisos ------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['edificios','fumigadores','quimicos','unidades','reportes','reclamos',
                           'visitas','certificados_edificio','actas_tanque','config'] loop
    execute format('alter table kofumigaciones.%I enable row level security', t);
  end loop;
end $$;

grant usage on schema kofumigaciones to service_role;
grant all privileges on all tables in schema kofumigaciones to service_role;
grant all privileges on all sequences in schema kofumigaciones to service_role;
alter default privileges in schema kofumigaciones grant all on tables to service_role;
alter default privileges in schema kofumigaciones grant all on sequences to service_role;
revoke all on all tables in schema kofumigaciones from anon, authenticated;
revoke usage on schema kofumigaciones from anon, authenticated;
