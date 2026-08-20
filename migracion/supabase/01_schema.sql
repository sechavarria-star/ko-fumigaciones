-- KO Fumigaciones: schema Supabase (reemplaza a los JSON en GitHub)
-- Correr esto una sola vez en el SQL Editor de Supabase, en el proyecto elegido.

create schema if not exists ko;

create table ko.clientes (
  cuit           text primary key check (cuit ~ '^\d{11}$'),
  nombre         text not null,
  condicion_iva  text not null default '',
  direccion      text not null default '',
  provincia      text not null default '',
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create table ko.usuarios (
  email          text primary key,
  nombre         text not null default '',
  apellido       text not null default '',
  perfil         text not null check (perfil in ('admin', 'supervisor', 'usuario')),
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create table ko.facturas (
  numero          text primary key,
  fecha_emision   date not null,
  periodo         text not null,
  cuit_cliente    text references ko.clientes (cuit),
  cliente_informe text,
  detalle         text not null default '',
  total           numeric(14, 2) not null,
  tipo            text not null default 'FC' check (tipo in ('FC', 'NC')),
  cuit_sugerido   text,
  nombre_sugerido text,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index facturas_cuit_cliente_idx on ko.facturas (cuit_cliente);
create index facturas_cliente_informe_idx on ko.facturas (cliente_informe) where cuit_cliente is null;

create table ko.pagos (
  id                  bigint generated always as identity primary key,
  -- una factura no puede tener más de un pago - esto Postgres lo garantiza
  -- solo con la constraint, sin el chequeo manual con condición de carrera
  -- que teníamos contra el JSON en GitHub.
  factura_numero      text not null unique references ko.facturas (numero),
  cuit_cliente        text not null,
  monto               numeric(14, 2),
  origen              text not null check (origen in ('manual', 'auto')),
  extracto             text,
  tipo_movimiento     text,
  fecha_aprox         text,
  numero_transaccion  text,
  confirmado_por      text not null,
  fecha_confirmacion  date not null,
  creado_en           timestamptz not null default now()
);

-- mantiene actualizado_en al día en cada UPDATE, sin que cada endpoint tenga
-- que acordarse de setearlo a mano
create or replace function ko.tocar_actualizado_en() returns trigger as $$
begin
  new.actualizado_en = now();
  return new;
end;
$$ language plpgsql;

create trigger clientes_tocar_actualizado before update on ko.clientes
  for each row execute function ko.tocar_actualizado_en();
create trigger usuarios_tocar_actualizado before update on ko.usuarios
  for each row execute function ko.tocar_actualizado_en();
create trigger facturas_tocar_actualizado before update on ko.facturas
  for each row execute function ko.tocar_actualizado_en();

-- RLS: el Apps Script accede con la service_role key (bypassea RLS por
-- diseño), así que esto es una segunda barrera por si alguna vez se expone
-- la anon key - sin políticas explícitas, RLS deniega todo por default.
alter table ko.clientes enable row level security;
alter table ko.usuarios enable row level security;
alter table ko.facturas enable row level security;
alter table ko.pagos enable row level security;
