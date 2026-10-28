-- Tipos de retencion por cliente.
--
-- En vez de un solo tilde "retiene impuestos", el panel marca que retiene
-- cada cliente: IVA, Ingresos Brutos (ARBA y/o AGIP) y Ganancias.
--
-- `retiene` (23_retencion_y_templates.sql) sigue siendo lo que mira la
-- conciliacion para buscar pagos con retencion. El backend lo calcula al
-- guardar: true si el cliente tiene al menos un tipo tildado. Los clientes
-- marcados antes de esto quedan con retiene = true y ningun tipo ("tipo sin
-- especificar") hasta que alguien los edite.
--
-- Se puede correr mas de una vez.

alter table ko.clientes
  add column if not exists ret_iva        boolean not null default false,
  add column if not exists ret_iibb_arba  boolean not null default false,
  add column if not exists ret_iibb_agip  boolean not null default false,
  add column if not exists ret_ganancias  boolean not null default false;

comment on column ko.clientes.ret_iva       is 'Retiene IVA.';
comment on column ko.clientes.ret_iibb_arba is 'Retiene Ingresos Brutos de Provincia de Buenos Aires (ARBA).';
comment on column ko.clientes.ret_iibb_agip is 'Retiene Ingresos Brutos de CABA (AGIP).';
comment on column ko.clientes.ret_ganancias is 'Retiene Ganancias.';
