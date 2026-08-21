-- Devuelve a "pendientes de validar" dos grupos de facturas que el matcheo
-- automatico asigno al consorcio equivocado.
--
-- Los dos casos son edificios distintos que terminaron apuntando al mismo
-- CUIT, porque el matcheo por nombre/direccion encontro un solo cliente con
-- esa calle y le colgo tambien las facturas del otro:
--
--   CONSORCIO: RIVADAVIA 7088/7100  -> quedo en el consorcio de Av Rivadavia
--                                      1719 (no hay cliente cargado en 7088)
--   CONSORCIO: VALENTIN GOMEZ 3174  -> quedo en el de Valentin Gomez 3162
--
-- Importa porque cruza cobros: una transferencia del consorcio de Rivadavia
-- 7088 se acreditaba contra las facturas del de 1719.
--
-- Ninguna de las 14 tiene pago imputado, asi que desasignarlas no deja
-- ningun pago huerfano. Tambien se limpia la sugerencia: si quedara la
-- vieja, la pantalla de Pendientes volveria a proponer el CUIT equivocado.
-- Van a aparecer en Pendientes para cargarles el CUIT correcto cuando el
-- cliente lo pase.

begin;

select numero, cliente_informe, cuit_cliente, total
from ko.facturas
where cliente_informe in ('CONSORCIO: RIVADAVIA 7088/7100', 'CONSORCIO: VALENTIN GOMEZ 3174')
order by cliente_informe, numero;

update ko.facturas
set cuit_cliente = null,
    cuit_sugerido = null,
    nombre_sugerido = null
where cliente_informe in ('CONSORCIO: RIVADAVIA 7088/7100', 'CONSORCIO: VALENTIN GOMEZ 3174')
  and numero not in (select factura_numero from ko.pagos);

commit;
