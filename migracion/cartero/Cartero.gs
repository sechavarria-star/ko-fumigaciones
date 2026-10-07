/**
 * Cartero de KO Fumigaciones.
 *
 * Vive en la cuenta facturacion@kofumigacion.com y lo unico que hace es mandar
 * mails desde ella. No sabe nada de clientes ni de saldos ni tiene acceso a
 * la base: le pide al backend del panel los mails que estan en la cola, ya
 * armados, los manda y le avisa como le fue.
 *
 * Existe porque un Apps Script manda los mails desde la cuenta que lo corre:
 * el backend es de GIWA y los mails tienen que salir de KO.
 *
 * Corre solo, con un activador de cada 1 minuto (ver instalarActivador). No
 * hace falta publicarlo como app web: es el cartero el que llama al backend,
 * nunca al reves.
 *
 * Script Property: CLAVE_CARTERO (la misma que CARTERO_CLAVE en el backend).
 */

// Web App del backend del panel (Apps Script de GIWA). Es la misma URL que
// usa el panel en docs/config.js.
var BACKEND_URL = 'https://script.google.com/macros/s/AKfycbxoRncX1uo-DeuwmW84fi0LI2A9Z2AmKOIAMFMo_EGMS0Oo4l6bhhhExPplQ9RvKYqN/exec';

// Mails por pasada. Con el activador de cada minuto alcanza y sobra, y una
// pasada corta nunca choca con el limite de 6 minutos de Apps Script.
var MAILS_POR_PASADA = 25;

/** Lo llama el activador cada 1 minuto. */
function revisarCola() {
  // Si una pasada todavia no termino, la siguiente no arranca: dos pasadas
  // a la vez podrian mandar el mismo mail dos veces.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const cuota = MailApp.getRemainingDailyQuota();
    const pedido = llamarBackend_({
      action: 'cartero_tomar',
      cuenta: Session.getEffectiveUser().getEmail(),
      cuota: cuota,
      max: Math.min(MAILS_POR_PASADA, cuota),
    });
    const mails = pedido.mails || [];
    if (!mails.length) return;

    // Uno por uno: si falla uno, los demas salen igual y cada resultado se
    // informa por separado.
    const resultados = mails.map(function (m) {
      try {
        const mensaje = { to: m.para, subject: m.asunto, body: m.texto, name: m.nombre || 'Knockout Fumigaciones' };
        if (m.html) mensaje.htmlBody = m.html;
        if (m.responder_a) mensaje.replyTo = m.responder_a;
        MailApp.sendEmail(mensaje);
        return { id: m.id, ok: true };
      } catch (err) {
        return { id: m.id, ok: false, error: err.message || String(err) };
      }
    });

    llamarBackend_({ action: 'cartero_resultado', resultados: resultados });
  } finally {
    lock.releaseLock();
  }
}

function llamarBackend_(params) {
  const clave = PropertiesService.getScriptProperties().getProperty('CLAVE_CARTERO');
  if (!clave) throw new Error('Falta la Script Property CLAVE_CARTERO');
  const res = UrlFetchApp.fetch(BACKEND_URL, {
    method: 'post',
    contentType: 'text/plain;charset=utf-8',
    payload: JSON.stringify(Object.assign({ clave: clave }, params)),
    muteHttpExceptions: true,
  });
  const cuerpo = JSON.parse(res.getContentText());
  if (cuerpo.status >= 400) throw new Error('Backend ' + cuerpo.status + ': ' + cuerpo.detail);
  return cuerpo.data;
}

/**
 * Correr UNA VEZ a mano desde el editor (Ejecutar > instalarActivador).
 * Pide los permisos (tildar "Enviar correo electrónico en tu nombre"), crea
 * el activador de cada 1 minuto y hace una primera pasada. Si se corre de
 * nuevo no duplica el activador.
 */
function instalarActivador() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'revisarCola') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('revisarCola').timeBased().everyMinutes(1).create();
  revisarCola();
  console.log('Listo: el cartero revisa la cola cada 1 minuto, mandando desde ' +
    Session.getEffectiveUser().getEmail() + ' (cuota de hoy: ' + MailApp.getRemainingDailyQuota() + ').');
}

/** Para apagar el cartero: borra el activador. */
function desinstalarActivador() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'revisarCola') ScriptApp.deleteTrigger(t);
  });
  console.log('Cartero apagado: ya no revisa la cola.');
}
