-- Datos para transferencia del template de saldo (los paso KO, 2026-10-07).
-- Es el ultimo [COMPLETAR ...] que faltaba: con esto el template se puede mandar.
-- En el mail cada linea sale en el recuadro de pago, con lo que va antes de ":"
-- como etiqueta.

update ko.mailing_templates
set datos_pago = E'Titular: Rodrigo Camps Palacios (Knockout Fumigaciones)\n'
              || E'CUIT: 20-20956606-1\n'
              || E'Banco: Santander\n'
              || E'Cuenta: Cuenta Única en Pesos Nº 356718/4 · Sucursal Quintana Nº 203\n'
              || E'CBU: 0720203488000035671840\n'
              || E'Alias: VOLCAN.OMBU.FAUNA\n'
              || E'Comprobantes a: facturacion@kofumigacion.com'
where id = 'saldo-menor-300k';

select id, datos_pago from ko.mailing_templates where id = 'saldo-menor-300k';
