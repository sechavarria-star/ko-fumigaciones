-- Permite `origen = 'retencion'` en ko.pagos.
--
-- 01_schema.sql solo aceptaba 'manual' y 'auto', que eran los dos casos que
-- existian antes. Los cobros con retencion son un tercer caso y conviene
-- distinguirlo: se detectan solos (como 'auto') pero los confirma una persona
-- desde la cola de revision (como 'manual'), y ademas traen retencion > 0.
--
-- Sin esto, confirmar una retencion falla con:
--   new row for relation "pagos" violates check constraint "pagos_origen_check"

alter table ko.pagos drop constraint if exists pagos_origen_check;

alter table ko.pagos
  add constraint pagos_origen_check
  check (origen in ('manual', 'auto', 'retencion'));

-- Coherencia entre las dos columnas: si hubo retencion el origen tiene que
-- decirlo, y si no hubo no puede decir que si.
alter table ko.pagos drop constraint if exists pagos_retencion_coherente;

alter table ko.pagos
  add constraint pagos_retencion_coherente
  check ((origen = 'retencion') = (retencion > 0));
