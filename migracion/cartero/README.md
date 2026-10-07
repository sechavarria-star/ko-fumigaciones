# Cartero — manda los mails desde cobranzas@kofumigacion.com

Apps Script chico que vive en la cuenta **cobranzas@kofumigacion.com** y solo
manda mails. El backend del panel le pasa cada mail ya armado (ver
`../apps-script/Mailing.gs`). No toca Supabase ni ve nada más que los mails
que le mandan.

## Crearlo (una sola vez, logueado como cobranzas@kofumigacion.com)

1. Entrar a https://script.google.com con **cobranzas@kofumigacion.com** →
   **Nuevo proyecto**. Nombre: `KO Cartero`.
2. Borrar el contenido de `Código.gs` y pegar el de `Cartero.gs`. Guardar.
3. **Configuración del proyecto** (engranaje) → **Propiedades de la secuencia
   de comandos** → agregar `CLAVE_CARTERO` con la clave compartida.
4. Volver al editor, elegir la función **`autorizar`** → **Ejecutar** →
   aceptar los permisos (tildar "Enviar correo electrónico en tu nombre").
   En el registro tiene que aparecer `Cuenta: cobranzas@kofumigacion.com`.
5. **Implementar → Nueva implementación** → tipo **Aplicación web**:
   - Ejecutar como: **Yo (cobranzas@kofumigacion.com)**
   - Quién tiene acceso: **Cualquier usuario**
   → **Implementar** y copiar la **URL de la aplicación web** (termina en `/exec`).

## Conectarlo al backend

En el Apps Script del backend (el de GIWA) → Configuración del proyecto →
Propiedades:

- `CARTERO_URL` = la URL `/exec` del paso 5
- `CARTERO_CLAVE` = la misma clave del paso 3

En el panel, pestaña Mailing, tiene que decir **Sale desde
cobranzas@kofumigacion.com**.

## Si se cambia el código del cartero

Pegar la versión nueva en el editor y **Implementar → Gestionar
implementaciones → editar (lápiz) → Versión: nueva**. Así la URL no cambia.
Una implementación nueva genera otra URL y hay que actualizar `CARTERO_URL`.
