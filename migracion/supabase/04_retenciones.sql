-- Pagos con retencion.
--
-- Varios clientes (Clinica Delta, Rockwell, CUBA, consorcios grandes) actuan
-- como agentes de retencion: transfieren MENOS que el total de la factura y
-- depositan la diferencia a la AFIP/ARBA por cuenta de KO. La factura queda
-- saldada igual - la retencion es credito fiscal, no una perdida - pero el
-- importe que entra al banco no coincide con el de la factura, y por eso el
-- matcheo por importe exacto nunca los encontraba.
--
-- `monto` sigue siendo LO QUE ENTRO al banco (no cambia de significado, para
-- no invalidar los 794 pagos ya cargados, que tienen retencion 0).
-- `retencion` es la diferencia contra el total de la factura.

alter table ko.pagos
  add column if not exists retencion numeric(14,2) not null default 0;

comment on column ko.pagos.monto is
  'Importe efectivamente acreditado en el banco.';
comment on column ko.pagos.retencion is
  'Diferencia entre el total de la factura y lo acreditado (retenciones impositivas). 0 si pago el total.';
