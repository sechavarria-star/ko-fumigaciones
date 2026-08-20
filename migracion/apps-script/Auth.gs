/**
 * Valida el id_token de Google contra el endpoint público de Google (no
 * hace falta ninguna librería de JWT) y resuelve el perfil del usuario
 * contra ko.usuarios. Mismo comportamiento que usuario_autorizado() en
 * backend/main.py.
 */
function ApiError(status, mensaje) {
  this.name = 'ApiError';
  this.status = status;
  this.message = mensaje;
}
ApiError.prototype = Object.create(Error.prototype);

function usuarioAutorizado_(token) {
  if (!token) throw new ApiError(401, 'Falta el token de Google');

  let payload;
  try {
    const res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      throw new ApiError(401, 'Token de Google inválido');
    }
    payload = JSON.parse(res.getContentText());
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // fallo de red al validar con Google (no que el token esté mal)
    throw new ApiError(503, 'No se pudo validar el login con Google, probá de nuevo');
  }

  if (payload.aud !== GOOGLE_CLIENT_ID()) {
    throw new ApiError(401, 'Token de Google inválido');
  }
  if (payload.email_verified !== 'true' && payload.email_verified !== true) {
    throw new ApiError(403, 'Tu cuenta de Google no tiene el email verificado');
  }

  const email = String(payload.email || '').toLowerCase();
  const filas = sbGet('usuarios', 'select=email,nombre,apellido,perfil&email=eq.' + encodeURIComponent(email));
  const info = filas && filas[0];

  if (ALLOWED_EMAILS().indexOf(email) !== -1) {
    return {
      email: email,
      nombre: info ? info.nombre : payload.given_name || '',
      apellido: info ? info.apellido : payload.family_name || '',
      perfil: 'admin',
    };
  }
  if (info) {
    return { email: email, nombre: info.nombre, apellido: info.apellido, perfil: info.perfil };
  }
  throw new ApiError(403, 'Tu cuenta no está dada de alta en KO Fumigaciones');
}

function requerirPerfil_(usuario, perfilesPermitidos) {
  if (perfilesPermitidos.indexOf(usuario.perfil) === -1) {
    throw new ApiError(403, 'Tu perfil no tiene permiso para hacer esto');
  }
}
