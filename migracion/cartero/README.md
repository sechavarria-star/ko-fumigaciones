# Cartero — manda los mails desde facturacion@kofumigacion.com

Apps Script chico que vive en la cuenta **facturacion@kofumigacion.com** (una
cuenta real del Workspace de KO, no un alias: un alias mandaría desde la cuenta
principal) y solo manda mails.

Cada 1 minuto, con un activador, le pide al backend del panel los mails que
están en la cola (`ko.mailing_cola`), los manda desde esa cuenta y le avisa
cómo le fue. **No se publica como app web**: es el cartero el que llama al
backend, nunca al revés. No tiene acceso a la base ni a nada más que los mails
que le pasan; se autentica con una clave compartida.

## Instalarlo (una sola vez, logueado como facturacion@kofumigacion.com)

1. https://script.google.com con **facturacion@kofumigacion.com** → **Nuevo
   proyecto**. Nombre: `KO Cartero`.
2. Borrar el contenido de `Código.gs`, pegar el de `Cartero.gs` y guardar.
3. **Configuración del proyecto** (engranaje) → **Propiedades de la secuencia
   de comandos** → agregar `CLAVE_CARTERO` con la clave compartida.
4. Volver al editor, elegir la función **`instalarActivador`** → **Ejecutar** →
   aceptar los permisos (tildar "Enviar correo electrónico en tu nombre").
   En el registro tiene que aparecer
   `Listo: el cartero revisa la cola cada 1 minuto, mandando desde facturacion@kofumigacion.com`.

Del lado del backend (Apps Script de GIWA) → Script Properties:
`CARTERO_CLAVE` = la misma clave.

En el panel, pestaña Mailing, tiene que decir **Sale desde
facturacion@kofumigacion.com · Cartero activo**.

## Operación

- **Apagarlo**: correr `desinstalarActivador`. Los mails que se encolen
  quedan esperando hasta que se vuelva a instalar.
- **Cambiar el código**: pegar la versión nueva y guardar. No hay que volver a
  instalar nada (el activador llama a `revisarCola` del código actual).
- **Si un mail queda "tomado"** y el cartero no confirma en 10 minutos (por
  ejemplo, se cortó), se vuelve a ofrecer; a los 3 intentos queda como error.
