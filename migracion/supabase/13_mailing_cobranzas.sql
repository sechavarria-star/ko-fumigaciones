-- Los mails pasan a salir de cobranzas@kofumigacion.com (via el cartero, ver
-- migracion/cartero/). Las respuestas de los clientes vuelven a esa misma
-- cuenta, asi que responder_a queda vacio, y la firma muestra ese mail.
-- Se puede correr mas de una vez.

update ko.mailing_templates
set responder_a = ''
where responder_a = 'fumigaciondeplagas@gmail.com';

update ko.mailing_templates
set firma = replace(firma, 'fumigaciondeplagas@gmail.com', 'cobranzas@kofumigacion.com')
where firma like '%fumigaciondeplagas@gmail.com%';
