-- Ajustes para que el Apps Script de la app de campo use estas tablas en
-- lugar de la planilla, sin cambiar su logica.
--
-- 1) `orden`: numero correlativo por tabla. La app trabajaba con el numero de
--    fila de la planilla (lee, busca la fila de un ID y escribe o borra esa
--    fila) y con el orden de carga (los reportes se muestran del ultimo al
--    primero). `orden` cumple los dos papeles: es el `_fila` que ve el codigo.
--
-- 2) Claves foraneas que no traban los borrados que la app ya hace. En la
--    planilla, borrar una unidad o un edificio dejaba los reportes, reclamos,
--    visitas y actas con el ID viejo (tienen copiado el nombre y la
--    direccion). Aca el ID pasa a null y el resto del historial queda; las
--    unidades de un edificio borrado se borran con el.
--
-- Se puede correr mas de una vez.

do $$
declare t text;
begin
  foreach t in array array['edificios','fumigadores','quimicos','unidades','reportes','reclamos',
                           'visitas','certificados_edificio','actas_tanque','config'] loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'kofumigaciones' and table_name = t and column_name = 'orden') then
      execute format('alter table kofumigaciones.%I add column orden bigint generated always as identity', t);
      execute format('create unique index %I on kofumigaciones.%I (orden)', t || '_orden_idx', t);
    end if;
  end loop;
end $$;

-- (tabla, columna, tabla referenciada, accion al borrar)
do $$
declare
  r record;
  nombre text;
begin
  for r in select * from (values
    ('unidades',              'edificio_id',        'edificios',   'cascade'),
    ('unidades',              'ultimo_servicio_id', 'reportes',    'set null'),
    ('reportes',              'edificio_id',        'edificios',   'set null'),
    ('reportes',              'unidad_id',          'unidades',    'set null'),
    ('reclamos',              'edificio_id',        'edificios',   'set null'),
    ('reclamos',              'unidad_id',          'unidades',    'set null'),
    ('reclamos',              'reporte_id',         'reportes',    'set null'),
    ('visitas',               'edificio_id',        'edificios',   'set null'),
    ('visitas',               'fumigador_id',       'fumigadores', 'set null'),
    ('certificados_edificio', 'edificio_id',        'edificios',   'set null'),
    ('actas_tanque',          'cliente_id',         'edificios',   'set null')
  ) as v(tabla, columna, ref, accion) loop
    -- la FK que haya hoy sobre esa columna, se llame como se llame
    for nombre in
      select c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f'
        and c.conrelid = format('kofumigaciones.%I', r.tabla)::regclass
        and a.attname = r.columna
    loop
      execute format('alter table kofumigaciones.%I drop constraint %I', r.tabla, nombre);
    end loop;
    execute format(
      'alter table kofumigaciones.%I add constraint %I foreign key (%I) references kofumigaciones.%I(id) on delete %s deferrable initially deferred',
      r.tabla, r.tabla || '_' || r.columna || '_fkey', r.columna, r.ref, r.accion);
  end loop;
end $$;
