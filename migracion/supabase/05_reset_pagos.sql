-- Borra TODOS los pagos para reconstruirlos desde los extractos.
--
-- NO CORRER hasta tener los 7 extractos (enero a julio). Los pagos son la
-- unica copia de esa informacion: si falta un extracto, los pagos de ese mes
-- no se pueden reconstruir y esas facturas van a figurar impagas.
--
-- Por que hace falta regenerar: los pagos que venian de la etapa anterior
-- estan mal en las dos direcciones, medido contra los movimientos reales de
-- los extractos disponibles:
--
--   extracto   cobros reales   pagos cargados
--   Abril            130            260   <- exactamente el doble
--   Febrero          116             42
--   Marzo            164             31
--   Junio            103             27
--
-- El de mas venia del matcheo viejo, que preguntaba "hay un credito de este
-- CUIT por este importe?" y marcaba TODAS las facturas que coincidieran;
-- como estos clientes son abonos mensuales y pagan lo mismo todos los meses,
-- un solo cobro daba por cobradas varias facturas.
--
-- No se tocan `clientes` ni `facturas`: esas salen de la planilla y de los
-- informes mensuales, y no dependen de este matcheo.

begin;

-- Deja constancia de cuanto se borro (queda en el output del SQL Editor).
select count(*) as pagos_a_borrar, sum(monto) as monto_total from ko.pagos;

delete from ko.pagos;

commit;
