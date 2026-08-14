# Poner en marcha el panel de admin

**Estado: completo (2026-08-14).** Los 4 pasos de abajo ya se hicieron:
- Google OAuth Client ID creado en el proyecto `n8nGiwa`.
- Token de GitHub (`ko-fumigaciones-backend`, sin expiración, solo Contents:R/W sobre este repo).
- Backend desplegado en Render: https://ko-fumigaciones-api.onrender.com (`/api/health` responde `{"status":"ok"}`).
- `docs/config.js` con ambos valores, pusheado.

Falta la prueba real de punta a punta: entrar a https://sechavarria-star.github.io/ko-fumigaciones/, iniciar sesión con Google, y confirmar un pago/subir una factura para verificar que el commit a GitHub se hace bien. Se deja el resto de esta guía como referencia por si hay que recrear algo (rotar el token, agregar otro email a `ALLOWED_EMAILS`, etc.).

---

El frontend y el motor de matching ya están andando. Falta esto, que solo lo podés hacer vos (necesita tu login en Google Cloud y en Render):

## 1. Google OAuth Client ID

1. Andá a https://console.cloud.google.com/apis/credentials (usá el proyecto de GCP que corresponda a giwa-ia, o creá uno nuevo).
2. "Crear credenciales" → "ID de cliente de OAuth" → tipo **Aplicación web**.
3. En **Orígenes de JavaScript autorizados** agregá:
   `https://sechavarria-star.github.io`
4. No hace falta URI de redirección (usamos el flujo de Google Identity Services con botón, no redirect).
5. Copiá el **Client ID** (termina en `.apps.googleusercontent.com`).

## 2. Token de GitHub para que el backend pueda commitear

1. https://github.com/settings/tokens?type=beta → "Generate new token" (fine-grained).
2. Repository access: **Only select repositories** → `ko-fumigaciones`.
3. Permissions → Repository permissions → **Contents: Read and write**.
4. Generá el token y copialo (empieza con `github_pat_...`) — no se puede volver a ver después.

## 3. Deploy del backend en Render

1. https://render.com → conectá tu cuenta de GitHub.
2. "New" → "Blueprint" → elegí el repo `ko-fumigaciones` (Render va a leer `render.yaml` solo).
3. Cuando pida las env vars marcadas `sync: false`, completá:
   - `GOOGLE_CLIENT_ID`: el Client ID del paso 1.
   - `ALLOWED_EMAILS`: emails separados por coma que pueden usar el panel de admin (ej. `s.echavarria@giwa-ia.com,facturacion@kofumigacion.com`).
   - `GITHUB_TOKEN`: el token del paso 2.
4. Deploy. Cuando termine, copiá la URL del servicio (algo como `https://ko-fumigaciones-api.onrender.com`).

Nota: el plan free de Render "duerme" el servicio tras 15 min sin uso — la primera acción de admin después de un rato puede tardar ~30s en responder mientras arranca de nuevo. Es solo para el panel de admin, el dashboard público no depende de esto.

## 4. Conectar el frontend al backend

Avisame la URL de Render y el Client ID de Google y actualizo `docs/config.js` con esos dos valores (o lo hacés vos mismo, es un archivo de 3 líneas).
