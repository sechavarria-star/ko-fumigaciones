-- Guarda en cada pago QUE MOVIMIENTO del extracto lo origino.
--
-- Hasta ahora, para no volver a usar un cobro ya conciliado, la firma del
-- movimiento se reconstruia desde (cuit, monto, fecha) del propio pago. Eso
-- funciona mientras el pago valga exactamente lo mismo que el movimiento,
-- pero se rompe con los pagos que cubren VARIAS facturas: ahi cada pago vale
-- lo de su factura y ninguno vale lo del movimiento, asi que al resubir el
-- extracto ese cobro parecia sin usar y volvia a imputarse.
--
-- Con la firma guardada aparte, el dato es explicito y no hay que deducirlo.
-- Como beneficio extra, los pagos que comparten mov_firma son justamente los
-- que se saldaron con la misma transferencia.

alter table ko.pagos
  add column if not exists mov_firma text;

create index if not exists pagos_mov_firma_idx on ko.pagos(mov_firma);

comment on column ko.pagos.mov_firma is
  'Movimiento del extracto que origino el pago (cuit|monto|fecha). Los pagos que la comparten se saldaron con la misma transferencia. Null en los pagos cargados antes de existir esta columna.';
