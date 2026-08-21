// Completar después de desplegar el backend (ver SETUP.md).
//
// BACKEND_URL es el /exec del Web App de Apps Script (reemplazó a Render).
// Ojo al actualizarlo: cada "New deployment" en el editor genera una URL
// nueva; para que la URL siga siendo esta hay que editar el deployment
// existente ("Manage deployments" > lápiz > New version), o usar
// `clasp deploy -i <id>` como hace migracion/apps-script/probar.sh.
const CONFIG = {
  BACKEND_URL:
    "https://script.google.com/macros/s/AKfycbxoRncX1uo-DeuwmW84fi0LI2A9Z2AmKOIAMFMo_EGMS0Oo4l6bhhhExPplQ9RvKYqN/exec",
  GOOGLE_CLIENT_ID: "527644613244-5linjiqufnn12gol453gvii2oqdhlbls.apps.googleusercontent.com",
};
