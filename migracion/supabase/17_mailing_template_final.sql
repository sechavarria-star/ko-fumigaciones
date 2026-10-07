-- Deja el template de saldo con sus valores finales, de una.
--
-- Hubo dos problemas al aplicar los SQL anteriores a mano:
--   - los que se pasaron por el portapapeles (pbcopy) llegaron con los
--     acentos y simbolos rotos ("Única" -> "√önica", "·" -> "¬∑");
--   - los cambios de marca (12) y de firma (13, 15) no llegaron a la base.
-- Este SQL no depende de lo que haya: escribe los valores finales. Se puede
-- correr mas de una vez. Se aplica con el CLI (`supabase db query -f`), que
-- lee el archivo en UTF-8.

update ko.mailing_templates
set remitente_nombre = 'Knockout Fumigaciones',
    -- vacio: las respuestas vuelven a la cuenta que manda (facturacion@)
    responder_a      = '',
    asunto           = replace(asunto, 'KO Fumigaciones', 'Knockout Fumigaciones'),
    cuerpo           = replace(cuerpo, 'KO Fumigaciones', 'Knockout Fumigaciones'),
    firma            = E'Administración\nKnockout Fumigaciones\nTel. 11 4972-6343 · facturacion@kofumigacion.com',
    datos_pago       = E'Titular: Rodrigo Camps Palacios (Knockout Fumigaciones)\n'
                    || E'CUIT: 20-20956606-1\n'
                    || E'Banco: Santander\n'
                    || E'Cuenta: Cuenta Única en Pesos Nº 356718/4 · Sucursal Quintana Nº 203\n'
                    || E'CBU: 0720203488000035671840\n'
                    || E'Alias: VOLCAN.OMBU.FAUNA\n'
                    || E'Comprobantes a: facturacion@kofumigacion.com'
where id = 'saldo-menor-300k';
