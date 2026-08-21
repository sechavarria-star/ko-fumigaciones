-- KO Fumigaciones: permisos del schema `ko` para PostgREST.
--
-- Postgres solo le da acceso automático a los roles de Supabase sobre el
-- schema `public`. Sobre un schema propio hay que otorgarlo a mano, si no
-- la REST API responde 403 "permission denied for schema ko" incluso usando
-- la service_role key (el bypass de RLS no reemplaza al GRANT: son dos
-- controles distintos - RLS filtra filas, el GRANT habilita el acceso).
--
-- A `anon` y `authenticated` NO se les da nada: nadie debería llegar a estas
-- tablas desde el navegador. El único cliente es el Apps Script, que usa la
-- service_role key del lado del servidor. RLS igual queda activo como
-- segunda barrera (ver 01_schema.sql).

grant usage on schema ko to service_role;

grant all privileges on all tables in schema ko to service_role;
grant all privileges on all sequences in schema ko to service_role;

-- Para que las tablas/secuencias que se creen más adelante hereden el mismo
-- permiso sin tener que volver a correr este archivo.
alter default privileges in schema ko grant all on tables to service_role;
alter default privileges in schema ko grant all on sequences to service_role;
