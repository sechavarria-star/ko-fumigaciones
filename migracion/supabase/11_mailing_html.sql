-- Mailing en HTML.
--
-- El template se sigue escribiendo como texto plano (facil de editar desde el
-- Table Editor). La base arma DOS versiones de cada mail:
--   cuerpo       texto plano (lo que ven los clientes de correo sin HTML)
--   cuerpo_html  el mismo texto con formato: encabezado, tabla de facturas con
--                el total, y los datos de pago en un recuadro
--
-- Los datos de pago y la firma pasan a columnas propias del template
-- ({{datos_pago}}, {{firma}}): son lo unico que hay que completar, y asi no
-- hay que tocar el cuerpo para cargarlos.
--
-- Se puede correr mas de una vez.

alter table ko.mailing_templates
  add column if not exists datos_pago text not null default '[COMPLETAR: titular, CUIT, banco, CBU y alias]',
  add column if not exists firma text not null default E'[COMPLETAR: nombre y teléfono de contacto]\nKO Fumigaciones';

comment on column ko.mailing_templates.datos_pago is
  'Va en {{datos_pago}}. Una linea por dato; lo que este antes de ":" sale como etiqueta (ej. "Alias: ko.fumigaciones").';
comment on column ko.mailing_templates.firma is
  'Va en {{firma}}. Una linea por renglon.';

alter table ko.mailing_envios
  add column if not exists cuerpo_html text;

-- Pasa el template inicial a usar {{datos_pago}} y {{firma}}, SOLO si nadie
-- lo edito todavia (si ya lo tocaron, no se pisa).
update ko.mailing_templates
set cuerpo = $cuerpo$Estimados/as {{nombre}}:

Les escribimos desde KO Fumigaciones para informarles que, según nuestros registros, su cuenta (CUIT {{cuit}}) presenta un saldo pendiente de {{saldo}}, correspondiente a:

{{facturas}}

Pueden abonarlo por transferencia a:

{{datos_pago}}

Si ya realizaron el pago, les pedimos que nos respondan este correo con el comprobante así lo registramos, y desestimen este aviso.

Ante cualquier consulta quedamos a disposición.

Saludos cordiales,
{{firma}}$cuerpo$
where id = 'saldo-menor-300k'
  and cuerpo = $viejo$Estimados/as {{nombre}}:

Les escribimos desde KO Fumigaciones para informarles que, según nuestros registros, su cuenta (CUIT {{cuit}}) presenta un saldo pendiente de {{saldo}}, correspondiente a:

{{facturas}}

Pueden abonarlo por transferencia a:
[COMPLETAR: titular, CUIT, banco, CBU y alias]

Si ya realizaron el pago, les pedimos que nos respondan este correo con el comprobante así lo registramos, y desestimen este aviso.

Ante cualquier consulta quedamos a disposición.

Saludos cordiales,
[COMPLETAR: nombre y teléfono de contacto]
KO Fumigaciones$viejo$;

-- --- HTML ---------------------------------------------------------------------

create or replace function ko.html_esc(t text) returns text
language sql immutable as $$
  select replace(replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
$$;

-- Arma el HTML del mail a partir del template en texto plano.
--
-- Cada parrafo (separado por una linea en blanco) es un <p>. Un parrafo que
-- es solo {{facturas}} o {{datos_pago}} se reemplaza por la tabla o el
-- recuadro. Todo con estilos inline y tablas: es lo unico que respetan
-- Gmail y Outlook.
create or replace function ko.mail_html(
  plantilla     text,
  asunto        text,
  nombre        text,
  cuit          text,
  saldo         numeric,
  cantidad      int,
  facturas_html text,
  datos_pago    text,
  firma         text
) returns text
language plpgsql immutable as $$
declare
  p constant text := '<p style="margin:0 0 16px;">';
  caja_pago text;
  h text;
begin
  caja_pago :=
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">'
    || '<tr><td style="background:#f0fdfa;border-left:4px solid #14b8a6;border-radius:6px;padding:14px 18px;font-size:14px;line-height:1.7;">'
    || regexp_replace(
         replace(ko.html_esc(replace(datos_pago, E'\r\n', E'\n')), E'\n', '<br>'),
         '(^|<br>)([^:<]{1,30}):', '\1<span style="color:#6b7280;">\2:</span>', 'g')
    || '</td></tr></table>';

  h := ko.html_esc(replace(plantilla, E'\r\n', E'\n'));
  h := p || replace(replace(h, E'\n\n', '</p>' || p), E'\n', '<br>') || '</p>';

  h := replace(h, p || '{{facturas}}</p>', facturas_html);
  h := replace(h, p || '{{datos_pago}}</p>', caja_pago);
  h := replace(h, '{{facturas}}', facturas_html);
  h := replace(h, '{{datos_pago}}', caja_pago);
  h := replace(h, '{{firma}}', replace(ko.html_esc(replace(firma, E'\r\n', E'\n')), E'\n', '<br>'));
  h := replace(h, '{{nombre}}', ko.html_esc(nombre));
  h := replace(h, '{{cuit}}', ko.fmt_cuit(cuit));
  h := replace(h, '{{saldo}}', '<strong style="white-space:nowrap;">' || ko.fmt_pesos(saldo) || '</strong>');
  h := replace(h, '{{cantidad_facturas}}', cantidad::text);

  return '<!doctype html><html lang="es"><head><meta charset="utf-8">'
    || '<meta name="viewport" content="width=device-width,initial-scale=1">'
    || '<title>' || ko.html_esc(asunto) || '</title></head>'
    || '<body style="margin:0;padding:0;background:#f3f5f7;">'
    -- Texto de vista previa en la bandeja de entrada (no se ve en el mail).
    || '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Saldo pendiente: '
    || ko.fmt_pesos(saldo) || '</div>'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f7;">'
    || '<tr><td align="center" style="padding:28px 12px;">'
    || '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">'
    || '<tr><td style="background:#0f2a2e;padding:24px 32px;">'
    || '<div style="font-size:21px;font-weight:bold;color:#ffffff;letter-spacing:0.3px;">KO Fumigaciones</div>'
    || '<div style="font-size:13px;color:#99e6dc;margin-top:4px;">Estado de cuenta</div>'
    || '</td></tr>'
    || '<tr><td style="padding:30px 32px 14px;font-size:15px;line-height:1.6;">' || h || '</td></tr>'
    || '<tr><td style="padding:16px 32px 22px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">'
    || 'Aviso de saldo de la cuenta CUIT ' || ko.fmt_cuit(cuit) || ' · KO Fumigaciones'
    || '</td></tr>'
    || '</table></td></tr></table></body></html>';
end;
$$;

-- --- vista ---------------------------------------------------------------------
-- Igual que en 10_mailing.sql, mas {{datos_pago}} / {{firma}} y la columna
-- cuerpo_html al final.

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
    where e.template_id = t.id and e.cuit_cliente = s.cuit
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
