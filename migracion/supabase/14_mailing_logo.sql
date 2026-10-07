-- Encabezado del mail con el logo de Knockout y el telefono de contacto,
-- como en las facturas que emite KO.
--
-- El logo (docs/marca/knockout-logo.png) esta recortado de una factura y lo
-- sirve GitHub Pages; los mails no pueden llevar imagenes embebidas en
-- base64 porque Gmail las bloquea.
--
-- Misma funcion que en 12_mailing_knockout.sql, cambia solo el encabezado.
-- Se puede correr mas de una vez.

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
  violeta   constant text := '#5b1f55';
  amarillo  constant text := '#f5b323';
  -- Recortado de las facturas de KO; lo sirve GitHub Pages junto al panel.
  logo      constant text := 'https://sechavarria-star.github.io/ko-fumigaciones/marca/knockout-logo.png';
  tel       constant text := '11 4972-6343';
  tel_link  constant text := '+541149726343';
  p constant text := '<p style="margin:0 0 16px;">';
  caja_pago text;
  h text;
begin
  caja_pago :=
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">'
    || '<tr><td style="background:#fff8e6;border-left:4px solid ' || amarillo || ';border-radius:6px;padding:14px 18px;font-size:14px;line-height:1.7;">'
    || regexp_replace(
         replace(ko.html_esc(replace(datos_pago, E'\r\n', E'\n')), E'\n', '<br>'),
         '(^|<br>)([^:<]{1,30}):', '\1<span style="color:#6b7280;">\2:</span>', 'g')
    || '</td></tr></table>';

  -- La tabla de facturas viene armada desde ko.v_mailing con el total en el
  -- color anterior: se lo pasa al de la marca aca, para no tener que
  -- recrear la vista entera por un color.
  facturas_html := replace(facturas_html, 'color:#0f766e', 'color:' || violeta);

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
    || '<body style="margin:0;padding:0;background:#f4f2f5;">'
    -- Texto de vista previa en la bandeja de entrada (no se ve en el mail).
    || '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Saldo pendiente: '
    || ko.fmt_pesos(saldo) || '</div>'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2f5;">'
    || '<tr><td align="center" style="padding:28px 12px;">'
    || '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">'
    -- Encabezado blanco como el de las facturas: el logo es violeta y sobre
    -- fondo violeta no se veria.
    || '<tr><td style="background:#ffffff;padding:18px 28px 16px;">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
    || '<td width="68" valign="middle"><img src="' || logo || '" width="68" height="65" alt="Knockout Fumigaciones" style="display:block;border:0;"></td>'
    || '<td valign="middle" style="padding-left:12px;">'
    || '<div style="font-size:20px;font-weight:bold;color:' || violeta || ';letter-spacing:1.5px;">KNOCKOUT</div>'
    || '<div style="font-size:14px;color:#b7791f;font-style:italic;">fumigaciones</div></td>'
    || '<td align="right" valign="middle" style="font-size:12px;color:#6b7280;line-height:1.6;">'
    || '<div style="font-size:13px;font-weight:bold;color:#1f2937;">Estado de cuenta</div>'
    || 'Tel. <a href="tel:' || tel_link || '" style="color:' || violeta || ';text-decoration:none;white-space:nowrap;">' || tel || '</a>'
    || '</td></tr></table></td></tr>'
    || '<tr><td style="height:5px;line-height:5px;font-size:0;background:' || violeta || ';">&nbsp;</td></tr>'
    || '<tr><td style="height:3px;line-height:3px;font-size:0;background:' || amarillo || ';">&nbsp;</td></tr>'
    || '<tr><td style="padding:30px 32px 14px;font-size:15px;line-height:1.6;">' || h || '</td></tr>'
    || '<tr><td style="padding:16px 32px 22px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">'
    || 'Aviso de saldo de la cuenta CUIT ' || ko.fmt_cuit(cuit) || ' · Knockout Fumigaciones'
    || '</td></tr>'
    || '</table></td></tr></table></body></html>';
end;
$$;
