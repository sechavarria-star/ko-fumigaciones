-- Pagos de mas del 2026-10-20.
--
-- Al reconciliar, dos transferencias iguales del mismo dia (mismo CUIT,
-- importe y fecha) se contaban como un solo movimiento ya usado, y la
-- segunda se volvia a imputar a otra factura: 2 transferencias, 3 pagos. El
-- error se corrigio en Acciones.gs (deploy @33). Aca se saca, por cada
-- movimiento, lo imputado de mas: los pagos mas nuevos que exceden lo que
-- entro al banco. Quedan respaldados en ko.pagos_de_mas_20261020.
begin;

create table if not exists ko.pagos_de_mas_20261020 as select * from ko.pagos where false;

with cobros as (
  select cuit_cliente || '|' || to_char(monto, 'FM999999990.00') || '|' || fecha as k,
         count(*) as n, max(monto) as importe
  from ko.cobros group by 1
),
pagos as (
  select p.id, p.mov_firma as k, p.monto,
         sum(p.monto) over (partition by p.mov_firma order by p.creado_en, p.id) as acumulado
  from ko.pagos p
  where p.mov_firma is not null
)
insert into ko.pagos_de_mas_20261020
select * from ko.pagos
where id in (
  select pagos.id from pagos join cobros using (k)
  where pagos.acumulado > cobros.n * cobros.importe + 0.5
);

delete from ko.pagos where id in (select id from ko.pagos_de_mas_20261020);

alter table ko.pagos_de_mas_20261020 enable row level security;
revoke all on ko.pagos_de_mas_20261020 from anon, authenticated;

commit;
