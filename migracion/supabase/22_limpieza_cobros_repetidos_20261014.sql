-- Cobros cargados dos veces el 2026-10-14 (feb, mar y jun resubidos con otro
-- nombre de archivo). Un cobro de hoy es repetido si ya habia uno anterior con
-- el mismo CUIT, importe y fecha. Si en un mismo dia hubo dos movimientos
-- iguales, se cuentan: solo se borran tantos como habia antes.
begin;

create table if not exists ko.cobros_duplicados_20261014 as
  select * from ko.cobros where false;

with nuevos as (
  select id, cuit_cliente, monto, fecha,
         row_number() over (partition by cuit_cliente, monto, fecha order by orden, id) as n
  from ko.cobros where creado_en >= '2026-10-14' and creado_en < '2026-10-15'
),
previos as (
  select cuit_cliente, monto, fecha, count(*) as cant
  from ko.cobros where creado_en < '2026-10-14'
  group by cuit_cliente, monto, fecha
),
repetidos as (
  select n.id from nuevos n
  join previos p using (cuit_cliente, monto, fecha)
  where n.n <= p.cant
)
insert into ko.cobros_duplicados_20261014
select * from ko.cobros where id in (select id from repetidos);

delete from ko.cobros where id in (select id from ko.cobros_duplicados_20261014);

alter table ko.cobros_duplicados_20261014 enable row level security;
revoke all on ko.cobros_duplicados_20261014 from anon, authenticated;

commit;
