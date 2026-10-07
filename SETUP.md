# Cómo está armado y cómo se opera

**Estado: migrado a Apps Script + Supabase (2026-08-20).**

El sistema ya no usa Render ni los JSON de GitHub como base de datos. Hoy son
tres piezas:

| pieza | qué es | dónde |
| --- | --- | --- |
| Frontend | sitio estático (`docs/`) | GitHub Pages: https://sechavarria-star.github.io/ko-fumigaciones/ |
| Backend | Web App de Apps Script | `migracion/apps-script/` (script id en `.clasp.json`) |
| Base | Postgres, schema `ko` | Supabase |

El detalle de por qué el backend es así (el formato raro de request, el
status adentro del JSON, por qué el texto de los PDFs se extrae en el
navegador) está en `migracion/apps-script/README.md`.

## Operación del día a día

**Publicar un cambio del frontend**: `git push`. GitHub Pages sirve `docs/`
directo; tarda menos de un minuto.

**Publicar un cambio del backend**: desde `migracion/apps-script/`

```bash
clasp push -f && clasp deploy -i AKfycbxoRncX1uo-DeuwmW84fi0LI2A9Z2AmKOIAMFMo_EGMS0Oo4l6bhhhExPplQ9RvKYqN -d "que cambio"
```

Importante el `-i <id>`: crea una **versión nueva del deployment que ya
existe**, así la URL no cambia. Un `clasp deploy` sin `-i` genera una URL
nueva y habría que tocar `docs/config.js`.

**Probar el backend sin pasar por la web**: copiá el token en la consola del
sitio (`copy(ID_TOKEN)` — hay que estar recién logueado, dura 1 hora) y

```bash
cd migracion/apps-script && ./probar.sh obtener_datos
```

`probar_texto.sh` manda texto ya extraído y `probar_pdf.sh` manda un PDF
para probar el OCR de respaldo.

## Dar de alta a alguien

Desde la pestaña **Usuarios** del panel (solo admin). Los perfiles son
`admin`, `supervisor` y `usuario` (este último es de solo lectura).

`ALLOWED_EMAILS` en las Script Properties es una allowlist de "romper
vidrio": esos emails son admin siempre, exista o no la fila en `ko.usuarios`
— para no quedarse afuera del propio sistema.

## Mailing a clientes

Pestaña **Mailing** del panel. Arma un mail por cliente con su saldo y las
facturas que lo componen, y lo manda desde la cuenta dueña del Apps Script.

- **Quién recibe y qué dice** sale de Supabase, de la vista `ko.v_mailing`. El
  saldo usa la misma fórmula que el tablero (`ko.v_saldos_clientes`); si no
  coinciden, el panel no deja mandar.
- **El texto** se edita en la tabla `ko.mailing_templates` (Table Editor de
  Supabase). Variables: `{{nombre}}`, `{{cuit}}`, `{{saldo}}`, `{{facturas}}`,
  `{{cantidad_facturas}}`. El rango de saldo es `saldo_min` < saldo <
  `saldo_max`. Para otro corte (otro rango, otro tono) se agrega una fila.
- **Un texto con `[COMPLETAR` no se puede mandar**: el backend lo rechaza.
- **No se repite**: a un cliente no se le vuelve a mandar el mismo template
  antes de `dias_entre_envios` (30 por defecto). Todo lo enviado queda en
  `ko.mailing_envios`, con el saldo y el texto de ese día.
- **Emails**: se cargan en la pestaña Clientes (clic en la fila para editar).
  Varios separados por coma.
- **Permisos**: la vista previa la ve admin y supervisor; enviar, solo admin.
- **Cuota de Gmail**: 100 destinatarios por día en una cuenta gmail.com,
  1.500 en Workspace. El panel muestra cuánto queda.

## Configuración (por si hay que recrearla)

**Script Properties** (editor de Apps Script > Project Settings):
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_ID`,
`ALLOWED_EMAILS`.

**Servicio avanzado**: Drive API (v2), para el OCR de respaldo.

**Permiso de Gmail**: el mailing usa `MailApp`. Con la cuenta que deploya,
correr `autorizarGmail` desde el editor y, en la pantalla de permisos,
tildar "Enviar correo electrónico en tu nombre". Correr otra función (como
`doGet`) no alcanza: el permiso puede quedar sin otorgar y la pestaña
Mailing falla con "No cuentas con el permiso para llamar a MailApp".

**Deployment**: tipo *Web app*, "Execute as: Me", "Who has access: Anyone".
Tiene que crearse desde el editor la primera vez (Deploy > New deployment):
`clasp deploy` sin un deployment previo genera un link de librería que da
403.

**Supabase**: schema `ko` agregado a "Exposed schemas" en Data API settings,
y los SQL de `migracion/supabase/` corridos en orden (`01_schema`,
`02_datos`, `03_grants`, y después los numerados siguientes).

**Google OAuth Client ID** (proyecto `n8nGiwa` en Google Cloud): tipo
Aplicación web, con `https://sechavarria-star.github.io` en "Orígenes de
JavaScript autorizados". No usa URI de redirección.

## Lo que quedó de la etapa anterior

`backend/` (FastAPI) y `data/*.json` siguen en el repo como referencia y
como respaldo del estado al momento de migrar. El servicio de Render y su
token de GitHub ya no los usa nadie: se pueden dar de baja.
