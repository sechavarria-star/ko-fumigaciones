/**
 * Cartero de KO Fumigaciones.
 *
 * Vive en la cuenta cobranzas@kofumigacion.com y lo unico que hace es mandar
 * mails desde ella. No sabe nada de clientes ni de saldos: el backend del
 * panel (otro Apps Script) le pasa cada mail ya armado.
 *
 * Existe porque un Apps Script manda los mails desde la cuenta que lo
 * publica: el backend es de GIWA y los mails tienen que salir de KO.
 *
 * Seguridad: sin la clave (Script Property CLAVE_CARTERO, la misma que tiene
 * el backend en CARTERO_CLAVE) no manda nada. Sin eso cualquiera con la URL
 * podria mandar mails en nombre de KO.
 *
 * Request (POST, body JSON):
 *   { clave, accion: 'cuota' }
 *   { clave, accion: 'enviar', mails: [{ para, asunto, texto, html, nombre, responder_a }] }
 * Respuesta: { status, data | detail } - siempre HTTP 200, igual que el backend.
 */

var MAX_MAILS_POR_LLAMADA = 50;

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const clave = PropertiesService.getScriptProperties().getProperty('CLAVE_CARTERO');
    if (!clave) return salida_(500, null, 'Falta la Script Property CLAVE_CARTERO en el cartero');
    if (body.clave !== clave) return salida_(403, null, 'Clave inválida');

    if (body.accion === 'cuota') {
      return salida_(200, {
        cuenta: Session.getEffectiveUser().getEmail(),
        cuota: MailApp.getRemainingDailyQuota(),
      });
    }

    if (body.accion === 'enviar') {
      const mails = body.mails || [];
      if (!mails.length) return salida_(400, null, 'No vino ningún mail');
      if (mails.length > MAX_MAILS_POR_LLAMADA) {
        return salida_(400, null, 'Máximo ' + MAX_MAILS_POR_LLAMADA + ' mails por llamada');
      }
      // Uno por uno, informando el resultado de cada uno: si falla el 7, los
      // 6 anteriores ya salieron y el backend los tiene que registrar igual.
      const resultados = mails.map(function (m) {
        try {
          if (!m.para || !m.asunto || !m.texto) throw new Error('Faltan datos del mail');
          const mensaje = { to: m.para, subject: m.asunto, body: m.texto, name: m.nombre || 'Knockout Fumigaciones' };
          if (m.html) mensaje.htmlBody = m.html;
          if (m.responder_a) mensaje.replyTo = m.responder_a;
          MailApp.sendEmail(mensaje);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err.message || String(err) };
        }
      });
      return salida_(200, { resultados: resultados });
    }

    return salida_(400, null, 'Acción desconocida: ' + body.accion);
  } catch (err) {
    return salida_(500, null, err.message || String(err));
  }
}

function doGet() {
  return salida_(200, { salud: 'ok' });
}

function salida_(status, data, detail) {
  const cuerpo = status >= 400 ? { status: status, detail: detail } : { status: status, data: data };
  return ContentService.createTextOutput(JSON.stringify(cuerpo)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Correr UNA VEZ a mano desde el editor (Ejecutar > autorizar) y aceptar los
 * permisos, tildando "Enviar correo electrónico en tu nombre". Si loguea la
 * cuenta y la cuota, quedó listo.
 */
function autorizar() {
  console.log('Cuenta: ' + Session.getEffectiveUser().getEmail() + ' · cuota de hoy: ' + MailApp.getRemainingDailyQuota());
}
