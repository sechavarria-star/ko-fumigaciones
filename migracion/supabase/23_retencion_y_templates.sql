-- 1) Clientes que retienen impuestos.
-- 2) Templates de mailing para saldo de $300.000 o mas y para todos.
-- 3) "No repetir" entre templates.
--
-- Se puede correr mas de una vez.

-- --- 1) retencion ----------------------------------------------------------------
-- Algunos clientes (clinicas, empresas grandes, varios consorcios) son agentes
-- de retencion: transfieren menos que la factura. Al conciliar, los pagos
-- "con retencion" se buscan SOLO para los clientes marcados: a los demas, un
-- importe un poco menor que una factura suele ser otra cosa, y llenaba la
-- cola de revision de coincidencias falsas.
alter table ko.clientes
  add column if not exists retiene boolean not null default false;

comment on column ko.clientes.retiene is
  'El cliente retiene impuestos al pagar. Solo a estos se les buscan pagos con retencion al conciliar.';

-- Arranque: los que ya tuvieron algun pago con retencion confirmado.
update ko.clientes c
set retiene = true
where not c.retiene
  and exists (select 1 from ko.pagos p where p.cuit_cliente = c.cuit and p.origen = 'retencion');

-- --- 2) templates ----------------------------------------------------------------
-- Mismo texto que el de menos de $300.000 (se pueden editar cada uno despues).
-- saldo_min es exclusivo: 299999.99 => saldo de $300.000 o mas.
insert into ko.mailing_templates
  (id, descripcion, asunto, cuerpo, saldo_min, saldo_max, dias_entre_envios,
   remitente_nombre, responder_a, activo, datos_pago, firma)
select 'saldo-mayor-300k', 'Saldo pendiente de $300.000 o más', asunto, cuerpo, 299999.99, null, dias_entre_envios,
       remitente_nombre, responder_a, activo, datos_pago, firma
from ko.mailing_templates where id = 'saldo-menor-300k'
on conflict (id) do nothing;

insert into ko.mailing_templates
  (id, descripcion, asunto, cuerpo, saldo_min, saldo_max, dias_entre_envios,
   remitente_nombre, responder_a, activo, datos_pago, firma)
select 'todos', 'Todos los clientes con saldo pendiente', asunto, cuerpo, 0, null, dias_entre_envios,
       remitente_nombre, responder_a, activo, datos_pago, firma
from ko.mailing_templates where id = 'saldo-menor-300k'
on conflict (id) do nothing;

update ko.mailing_templates
set descripcion = 'Saldo pendiente menor a $300.000'
where id = 'saldo-menor-300k' and descripcion like 'Recordatorio amable%';

-- --- 3) no repetir entre templates -----------------------------------------------
-- Igual que en 11_mailing_html.sql, salvo el ultimo envio, que ahora cuenta
-- el de cualquier template.
create or replace view ko.v_mailing with (security_invoker = on) as
with base as (
  select t.id as template_id,
         t.asunto,
         t.cuerpo,
         t.datos_pago,
         t.firma,
         t.remitente_nombre,
         t.responder_a,
         t.dias_entre_envios,
         s.cuit,
         s.nombre,
         trim(s.email) as email,
         s.saldo,
         coalesce(fx.lineas, '') as facturas,
         coalesce(fx.filas_html, '') as filas_html,
         coalesce(fx.cantidad, 0) as cantidad_facturas,
         ult.enviado_en as ultimo_envio
  from ko.mailing_templates t
  join ko.v_saldos_clientes s
    on s.saldo > t.saldo_min
   and (t.saldo_max is null or s.saldo < t.saldo_max)
  left join lateral (
    select string_agg(
             '- Factura ' || sf.numero || ' del ' || to_char(sf.fecha_emision, 'DD/MM/YYYY') || ': '
               || ko.fmt_pesos(sf.pendiente)
               || case when sf.pendiente < sf.total
                       then ' (saldo de un total de ' || ko.fmt_pesos(sf.total) || ')'
                       else '' end,
             E'\n' order by sf.orden
           ) as lineas,
           string_agg(
             '<tr>'
               || '<td style="padding:10px;border-bottom:1px solid #e5e7eb;">' || ko.html_esc(sf.numero) || '</td>'
               || '<td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#6b7280;">' || to_char(sf.fecha_emision, 'DD/MM/YYYY') || '</td>'
               || '<td align="right" style="padding:10px;border-bottom:1px solid #e5e7eb;white-space:nowrap;">' || ko.fmt_pesos(sf.pendiente)
               || case when sf.pendiente < sf.total
                       then '<div style="font-size:12px;color:#9ca3af;">de un total de ' || ko.fmt_pesos(sf.total) || '</div>'
                       else '' end
               || '</td></tr>',
             '' order by sf.orden
           ) as filas_html,
           count(*) as cantidad
    from ko.v_saldo_facturas sf
    where sf.cuit = s.cuit
  ) fx on true
  left join lateral (
    select max(e.enviado_en) as enviado_en
    from ko.mailing_envios e
    -- de cualquier template: con "menor a 300 mil", "mayor" y "todos" un
    -- cliente puede entrar en mas de uno, y no tiene que recibir dos avisos
    where e.cuit_cliente = s.cuit
  ) ult on true
  where t.activo
),
texto as (
  select b.*,
         -- {{datos_pago}} y {{firma}} van primero: pueden traer otras variables
         replace(replace(replace(replace(replace(replace(replace(b.cuerpo,
           '{{datos_pago}}', b.datos_pago),
           '{{firma}}', b.firma),
           '{{nombre}}', b.nombre),
           '{{cuit}}', ko.fmt_cuit(b.cuit)),
           '{{saldo}}', ko.fmt_pesos(b.saldo)),
           '{{cantidad_facturas}}', b.cantidad_facturas::text),
           '{{facturas}}', b.facturas) as cuerpo_txt,
         replace(replace(replace(replace(replace(b.asunto,
           '{{nombre}}', b.nombre),
           '{{cuit}}', ko.fmt_cuit(b.cuit)),
           '{{saldo}}', ko.fmt_pesos(b.saldo)),
           '{{cantidad_facturas}}', b.cantidad_facturas::text),
           '{{facturas}}', '') as asunto_txt
  from base b
)
select template_id,
       cuit,
       nombre,
       email,
       saldo,
       cantidad_facturas,
       asunto_txt as asunto,
       cuerpo_txt as cuerpo,
       remitente_nombre,
       responder_a,
       ultimo_envio,
       case
         when email = '' then 'sin_email'
         when ultimo_envio > now() - make_interval(days => dias_entre_envios) then 'enviado_reciente'
         else 'listo'
       end as estado,
       ko.mail_html(
         cuerpo,
         asunto_txt,
         nombre,
         cuit,
         saldo,
         cantidad_facturas::int,
         '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;font-size:14px;">'
           || '<tr>'
           || '<th align="left" style="padding:8px 10px;background:#f3f5f7;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Factura</th>'
           || '<th align="left" style="padding:8px 10px;background:#f3f5f7;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Fecha</th>'
           || '<th align="right" style="padding:8px 10px;background:#f3f5f7;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Pendiente</th>'
           || '</tr>'
           || filas_html
           || '<tr><td colspan="2" style="padding:12px 10px;font-weight:bold;">Total pendiente</td>'
           || '<td align="right" style="padding:12px 10px;font-weight:bold;font-size:17px;color:#0f766e;white-space:nowrap;">'
           || ko.fmt_pesos(saldo) || '</td></tr>'
           || '</table>',
         datos_pago,
         firma
       ) as cuerpo_html
from texto;


grant select on ko.v_mailing to service_role;
revoke all on ko.v_mailing from anon, authenticated;
