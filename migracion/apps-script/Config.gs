/**
 * Nunca hardcodear secretos acá - todo sale de Script Properties
 * (Project Settings > Script Properties en el editor de Apps Script).
 */
function cfg_(clave) {
  const valor = PropertiesService.getScriptProperties().getProperty(clave);
  if (!valor) throw new Error('Falta la Script Property "' + clave + '"');
  return valor;
}

function SUPABASE_URL() { return cfg_('SUPABASE_URL'); }
function SUPABASE_SERVICE_ROLE_KEY() { return cfg_('SUPABASE_SERVICE_ROLE_KEY'); }
function GOOGLE_CLIENT_ID() { return cfg_('GOOGLE_CLIENT_ID'); }

// Allowlist de "romper vidrio" (mismo rol que ALLOWED_EMAILS en Render):
// estos emails son admin siempre, exista o no fila en ko.usuarios - para no
// quedar nunca afuera del propio sistema. Separados por coma.
function ALLOWED_EMAILS() {
  const raw = PropertiesService.getScriptProperties().getProperty('ALLOWED_EMAILS') || '';
  return raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}
