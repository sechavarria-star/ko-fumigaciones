// Panel de admin: login con Google + acciones que escriben datos (confirmar
// pago manual, subir factura/extracto, editar clientes). Todas las escrituras
// pasan por el backend (CONFIG.BACKEND_URL), un Web App de Apps Script que
// valida el login de Google y escribe en Supabase - el navegador nunca tiene
// credenciales de la base.

let ID_TOKEN = null;
let SIGNED_IN_EMAIL = null;
let pagoPendienteContext = null; // {factura_numero, cuit_cliente}

function backendListo() {
  if (!CONFIG.BACKEND_URL || !CONFIG.GOOGLE_CLIENT_ID) {
    console.warn("Falta configurar CONFIG.BACKEND_URL / GOOGLE_CLIENT_ID en config.js - el panel de admin queda oculto.");
    return false;
  }
  return true;
}

// El backend es un Web App de Apps Script, y eso impone dos cosas:
//
// 1. Nada de headers custom ni Content-Type application/json: dispararían un
//    preflight (OPTIONS) que Apps Script no sabe responder. Por eso el token
//    viaja adentro del body y el Content-Type es text/plain, que la spec de
//    CORS considera "simple". El body igual es JSON.
// 2. Siempre responde HTTP 200, incluso ante un error: el status real viene
//    adentro del JSON. Mirar res.ok acá no sirve de nada.
async function llamarBackend(action, params = {}) {
  const res = await fetch(CONFIG.BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ token: ID_TOKEN, action, ...params }),
  });

  const raw = await res.text();
  let cuerpo;
  try {
    cuerpo = JSON.parse(raw);
  } catch {
    // Apps Script devuelve HTML cuando el deployment no está publicado o la
    // URL quedó vieja - mostrar el HTML crudo no le sirve a nadie.
    throw new Error(`${res.status}: el backend no devolvió JSON (¿URL o deployment mal?)`);
  }

  if (cuerpo.status >= 400) throw new Error(`${cuerpo.status}: ${cuerpo.detail}`);
  return cuerpo.data;
}

// El token de Google dura ~1 hora. Si una acción (o el medio de un lote
// grande) se topa con un 401, no es que "esa factura esté mal": es que la
// sesión venció. Los que llaman en loop (carga masiva) tienen que frenar
// apenas ven esto, en vez de reportar 401 archivo por archivo.
function esSesionInvalida(err) {
  return err.message.startsWith("401");
}

function cerrarSesion(mensaje) {
  ID_TOKEN = null;
  SIGNED_IN_EMAIL = null;
  YO = null;
  CLIENTES = {};
  FACTURAS = [];
  PAGOS = [];
  COLA_CONSOLIDACION = [];
  COLA_RETENCIONES = [];
  ULTIMOS_EXTRACTOS = [];
  document.getElementById("portal").hidden = true;
  document.getElementById("gate").hidden = false;
  document.getElementById("signed-in-as").hidden = true;
  document.querySelectorAll(".solo-editor, .solo-admin").forEach((el) => (el.hidden = true));
  irAPagina("tablero");
  if (typeof google !== "undefined") google.accounts.id.disableAutoSelect();
  const gateError = document.getElementById("gate-error");
  if (mensaje) {
    gateError.hidden = false;
    gateError.textContent = mensaje;
  } else {
    gateError.hidden = true;
  }
}

function mostrarAviso(mensaje, tipo = "error") {
  let cont = document.getElementById("toasts");
  if (!cont) {
    cont = document.createElement("div");
    cont.id = "toasts";
    document.body.appendChild(cont);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<div class="toast-title ${tipo}">${tipo === "ok" ? "Listo" : "No se pudo completar"}</div>${mensaje}`;
  cont.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 200);
  }, 6000);
}

function avisarError(err, prefijo) {
  if (esSesionInvalida(err)) {
    cerrarSesion("Tu sesión de Google expiró. Volvé a iniciar sesión.");
    return;
  }
  mostrarAviso(prefijo + err.message, "error");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Apps Script no se "duerme" como hacía Render, pero un corte de red o un
// hipo de la infraestructura de Google siguen dando un fetch fallido
// (TypeError) o un 503. Vale reintentar antes de mostrar un error seco.
function esReintentable(err) {
  return err instanceof TypeError || err.message.startsWith("503");
}

async function cargarConReintentos(gateError) {
  const esperas = [3000, 5000, 8000, 12000, 15000];
  for (let intento = 0; intento <= esperas.length; intento++) {
    try {
      await cargarDatosAutenticado();
      return;
    } catch (err) {
      if (!esReintentable(err) || intento === esperas.length) throw err;
      gateError.hidden = false;
      gateError.textContent = "Reintentando conectar con el servidor…";
      await sleep(esperas[intento]);
    }
  }
}

async function handleGoogleCredential(response) {
  const payload = JSON.parse(atob(response.credential.split(".")[1]));
  const gateError = document.getElementById("gate-error");
  gateError.hidden = true;

  // El token lo valida de verdad el backend en cada llamada; esto es solo
  // para no mostrar el portal ni por un instante si claramente va a fallar.
  ID_TOKEN = response.credential;
  try {
    await cargarConReintentos(gateError);
  } catch (err) {
    ID_TOKEN = null;
    gateError.hidden = false;
    gateError.textContent = err.message.startsWith("403")
      ? "Tu cuenta de Google no tiene acceso a este panel."
      : esReintentable(err)
        ? "No se pudo conectar con el servidor tras varios intentos. Probá de nuevo en un momento."
        : "No se pudo validar el login: " + err.message;
    return;
  }

  SIGNED_IN_EMAIL = payload.email;
  document.getElementById("gate").hidden = true;
  document.getElementById("portal").hidden = false;
  document.getElementById("signed-in-as").hidden = false;
  document.getElementById("signed-in-email").textContent = `${payload.email} · ${etiquetaPerfil(YO.perfil)}`;

  // "usuario" es de solo lectura: solo ve la pestaña Tablero (las demás ni
  // aparecen en el menú). "supervisor" ve todo salvo Usuarios (solo admin).
  document.querySelectorAll(".solo-editor").forEach((el) => (el.hidden = !puedeEscribir()));
  document.querySelectorAll(".solo-admin").forEach((el) => (el.hidden = YO.perfil !== "admin"));
  if (puedeEscribir()) renderTablaClientesAdmin();
}

function etiquetaPerfil(perfil) {
  return { admin: "Admin", supervisor: "Supervisor", usuario: "Usuario" }[perfil] || perfil;
}

function initGoogleSignIn() {
  if (!backendListo() || typeof google === "undefined") {
    document.getElementById("gate-error").hidden = false;
    document.getElementById("gate-error").textContent =
      "Falta configurar el backend (ver SETUP.md) - el portal queda inaccesible.";
    return;
  }
  google.accounts.id.initialize({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential,
  });
  google.accounts.id.renderButton(document.getElementById("google-signin-btn"), {
    theme: "filled_black",
    size: "large",
  });
}

document.getElementById("btn-signout").addEventListener("click", () => cerrarSesion());

document.getElementById("btn-actualizar").addEventListener("click", async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = "Actualizando…";
  try {
    await cargarDatosAutenticado();
    mostrarAviso("Datos actualizados.", "ok");
  } catch (err) {
    avisarError(err, "No se pudo actualizar: ");
  }
  btn.disabled = false;
  btn.textContent = "Actualizar";
});

// --- menú principal (Tablero / Facturas / Extractos / Clientes / Usuarios) ---
function irAPagina(pagina) {
  document.querySelectorAll(".navitem").forEach((b) => b.classList.toggle("active", b.dataset.page === pagina));
  document.querySelectorAll(".page").forEach((p) => (p.hidden = p.id !== `page-${pagina}`));
}

document.getElementById("mainnav").addEventListener("click", (e) => {
  const btn = e.target.closest(".navitem");
  if (!btn) return;
  irAPagina(btn.dataset.page);
  if (btn.dataset.page === "usuarios") cargarUsuarios();
  if (btn.dataset.page === "mailing") cargarMailing();
});

// --- 1) confirmar pago manual ---
window.abrirFormConfirmarPago = function (dataset) {
  pagoPendienteContext = dataset;
  document.getElementById("confirmar-pago-sub").textContent =
    `Factura ${dataset.factura} · ${fmtMoney(Number(dataset.monto))}`;
  document.getElementById("modal-confirmar-backdrop").classList.add("open");
};

document.getElementById("modal-confirmar-close").addEventListener("click", () => {
  document.getElementById("modal-confirmar-backdrop").classList.remove("open");
});
document.getElementById("modal-confirmar-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "modal-confirmar-backdrop") e.target.classList.remove("open");
});

document.getElementById("form-confirmar-pago").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const pago = await llamarBackend("confirmar_pago", {
      factura_numero: pagoPendienteContext.factura,
      cuit_cliente: pagoPendienteContext.cuit,
      numero_transaccion: fd.get("numero_transaccion"),
      fecha_ingreso: fd.get("fecha_ingreso"),
    });
    aplicarPagoLocal(pago);
    document.getElementById("modal-confirmar-backdrop").classList.remove("open");
    document.getElementById("modal-backdrop").classList.remove("open");
    e.target.reset();
  } catch (err) {
    avisarError(err, "No se pudo confirmar el pago: ");
  }
});

// --- 2) informe consolidado de facturas ---
// Reemplaza a la carga de facturas una por una: KO exporta un único PDF con
// todos los comprobantes del período (sin CUIT). Es DESTRUCTIVO - pisa toda
// la base de facturas y pagos - por eso pide confirmación explícita acá y
// queda restringido a admin en el backend.
document.getElementById("input-informe").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) subirInformeConsolidado(file);
});
wireDropzone("dropzone-informe", (archivos) => archivos[0] && subirInformeConsolidado(archivos[0]));

async function subirInformeConsolidado(file) {
  const draftEl = document.getElementById("informe-draft");
  draftEl.innerHTML = `<div class="draft-card">Leyendo el informe y matcheando clientes… puede tardar un minuto.</div>`;
  try {
    const resultado = await llamarBackend("importar_informe", await payloadDePdf(file));
    draftEl.innerHTML = `<div class="draft-card">${resultado.agregadas} factura(s) nueva(s), ${resultado.actualizadas} actualizada(s). Quedan ${resultado.pendientes} pendiente(s) de validar en toda la base${resultado.pendientes ? " (revisalas en la pestaña Pendientes)" : ""}.</div>`;
    document.getElementById("input-informe").value = "";
    COLA_CONSOLIDACION = [];
    await cargarDatosAutenticado();
    mostrarAviso(`Informe importado: ${resultado.agregadas} nueva(s), ${resultado.actualizadas} actualizada(s).`, "ok");
  } catch (err) {
    avisarError(err, "No se pudo importar el informe: ");
    draftEl.innerHTML = "";
  }
}

// --- 3) facturas pendientes de validar (el informe no trae CUIT y el
// matcheo automático no encontró un cliente con confianza suficiente) ---
let busquedaPendientes = "";

document.getElementById("buscar-pendientes").addEventListener("input", (e) => {
  busquedaPendientes = e.target.value;
  renderPendientesLista();
});

function renderPendientesLista() {
  const el = document.getElementById("pendientes-lista");
  if (!PENDIENTES_VALIDAR.length) {
    el.innerHTML = `<p class="hint">No hay facturas pendientes de validar.</p>`;
    return;
  }
  const q = busquedaPendientes.trim().toLowerCase();
  const items = PENDIENTES_VALIDAR.map((p, i) => ({ p, i })).filter(({ p }) => !q || p.cliente_informe.toLowerCase().includes(q));
  if (!items.length) {
    el.innerHTML = `<p class="hint">Ningún nombre coincide con "${busquedaPendientes}" (hay ${PENDIENTES_VALIDAR.length} pendiente${PENDIENTES_VALIDAR.length === 1 ? "" : "s"} en total).</p>`;
    return;
  }
  el.innerHTML = items
    .map(
      ({ p, i }) => `
    <div class="pendiente-item">
      <div>
        <div class="pendiente-nombre">${p.cliente_informe}</div>
        <div class="k">${p.count} factura${p.count === 1 ? "" : "s"} · ${fmtMoney(p.total)}${p.nombre_sugerido ? ` · ¿será "${p.nombre_sugerido}"?` : ""}</div>
      </div>
      <form class="form-confirmar-cuit" data-idx="${i}">
        <input name="cuit" placeholder="CUIT (11 dígitos)" maxlength="11" value="${p.cuit_sugerido || ""}" required>
        <button type="submit">Confirmar</button>
      </form>
    </div>`
    )
    .join("");

  el.querySelectorAll(".form-confirmar-cuit").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const p = PENDIENTES_VALIDAR[Number(form.dataset.idx)];
      const cuit = new FormData(form).get("cuit").trim();
      if (!/^\d{11}$/.test(cuit)) {
        mostrarAviso("El CUIT tiene que tener 11 dígitos, sin guiones.", "error");
        return;
      }
      const btn = form.querySelector("button");
      btn.disabled = true;
      try {
        const resultado = await llamarBackend("confirmar_cuit", {
          cliente_informe: p.cliente_informe,
          cuit_cliente: cuit,
        });
        resultado.resueltas.forEach((factura) => {
          const idx = FACTURAS.findIndex((f) => f.numero === factura.numero);
          if (idx !== -1) FACTURAS[idx] = factura;
        });
        mostrarAviso(`"${p.cliente_informe}" asociado a ${resultado.resueltas.length} factura(s).`, "ok");
        recomputar();
      } catch (err) {
        avisarError(err, "No se pudo confirmar: ");
        btn.disabled = false;
      }
    });
  });
}

// --- 3) subir extracto ---
// Subir un extracto solo agrega candidatos (CUIT + monto ya coinciden) a
// COLA_CONSOLIDACION - no escribe nada. Se pueden subir varios extractos
// seguidos, la cola se va acumulando (sin duplicar factura), y recién se
// concilia de verdad cuando el usuario aprieta "Consolidar".
// Como el texto crudo del extracto nunca se persiste, si el usuario carga
// una factura DESPUÉS de haber subido el extracto, esa factura no iba a
// tener forma de aparecer en la cola. Para eso se guardan acá (en memoria
// del navegador, no en ningún lado más) los PDFs de extracto ya subidos en
// esta sesión, así se pueden volver a mandar a /parse con un solo clic.
let ULTIMOS_EXTRACTOS = []; // File[] ya subidos en esta sesión, para reintentar (no sobrevive a un F5)

// La cola de candidatos SÍ se guarda en localStorage (solo datos ya
// derivados: cliente/factura/monto/fecha - nunca el texto del extracto) para
// no perder el trabajo si se recarga la página sin haber apretado
// "Consolidar" todavía.
const COLA_STORAGE_KEY = "ko_cola_consolidacion_v1";

function guardarColaEnStorage() {
  try {
    localStorage.setItem(COLA_STORAGE_KEY, JSON.stringify(COLA_CONSOLIDACION));
  } catch (err) {
    console.warn("No se pudo guardar la cola en localStorage:", err);
  }
}

function cargarColaDeStorage() {
  try {
    const raw = localStorage.getItem(COLA_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn("No se pudo leer la cola guardada:", err);
    return [];
  }
}

let COLA_CONSOLIDACION = cargarColaDeStorage();

// Cola aparte para los cobros con retención: entró menos que el total de la
// factura porque el cliente retuvo impuestos. Van separados a propósito - los
// de arriba coinciden peso por peso y se pueden tildar de una, estos hay que
// mirarlos: un importe "parecido" también podría ser de otra factura.
const COLA_RET_KEY = "ko_cola_retenciones_v1";

function guardarRetencionesEnStorage() {
  try {
    localStorage.setItem(COLA_RET_KEY, JSON.stringify(COLA_RETENCIONES));
  } catch (err) {
    console.warn("No se pudo guardar la cola de retenciones:", err);
  }
}

let COLA_RETENCIONES = (() => {
  try {
    const raw = localStorage.getItem(COLA_RET_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn("No se pudo leer la cola de retenciones:", err);
    return [];
  }
})();

let busquedaRetenciones = "";

document.getElementById("buscar-retenciones").addEventListener("input", (e) => {
  busquedaRetenciones = e.target.value;
  renderColaRetenciones();
});

function renderColaRetenciones() {
  const el = document.getElementById("cola-retenciones");
  if (!COLA_RETENCIONES.length) {
    el.innerHTML = `<p class="hint">No hay pagos con retención para revisar.</p>`;
    return;
  }

  const q = busquedaRetenciones.trim().toLowerCase();
  const items = COLA_RETENCIONES.map((m, i) => ({ m, i })).filter(
    ({ m }) => !q || [m.nombre_cliente, m.factura_numero, m.extracto_label].some((v) => (v || "").toLowerCase().includes(q))
  );

  if (!items.length) {
    el.innerHTML = `<p class="hint">Ningún resultado coincide con "${busquedaRetenciones}" (hay ${COLA_RETENCIONES.length} para revisar).</p>`;
    return;
  }

  // Sin `checked`: estos se tildan a mano, uno por uno, a diferencia de los
  // de coincidencia exacta.
  const filas = items.map(
    ({ m, i }) => `
    <tr>
      <td><input type="checkbox" data-idx="${i}" class="chk-retencion" aria-label="Confirmar ${m.factura_numero}"></td>
      <td>${m.nombre_cliente}<div class="archivo">FC ${m.factura_numero}</div></td>
      <td class="num">${fmtMoney(m.monto_factura)}</td>
      <td class="num">${fmtMoney(m.monto)}</td>
      <td class="num warn-text">${fmtMoney(m.retencion)} <span class="archivo">(${m.porcentaje}%)</span></td>
      <td>${m.fecha_aprox || "—"}</td>
      <td class="archivo">${m.extracto_label}</td>
    </tr>`
  );

  el.innerHTML = `
    <div class="lote-resumen">
      <div class="lote-acciones lote-acciones-top">
        <button id="btn-confirmar-retenciones" disabled>Confirmar 0 pagos</button>
        <button id="btn-vaciar-retenciones" type="button" class="btn-confirmar-pago">Vaciar</button>
        <span class="resumen-txt">${items.length} para revisar</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th><input type="checkbox" id="chk-retenciones-todas" title="Seleccionar todas las que se están mostrando"></th>
            <th>Cliente / Factura</th><th class="num">Facturado</th><th class="num">Cobrado</th><th class="num">Retención</th><th>Fecha</th><th>Extracto</th>
          </tr></thead>
          <tbody>${filas.join("")}</tbody>
        </table>
      </div>
    </div>`;

  const todas = document.getElementById("chk-retenciones-todas");

  const actualizar = () => {
    const cajas = [...el.querySelectorAll(".chk-retencion")];
    const n = cajas.filter((c) => c.checked).length;
    const btn = document.getElementById("btn-confirmar-retenciones");
    btn.disabled = n === 0;
    btn.textContent = `Confirmar ${n} pago${n === 1 ? "" : "s"}`;
    // El estado intermedio evita el "todo o nada": si tildaste algunas a
    // mano, el de arriba lo muestra en vez de decir que está todo elegido.
    todas.checked = n > 0 && n === cajas.length;
    todas.indeterminate = n > 0 && n < cajas.length;
  };

  // Marca solo lo que se está mostrando, no toda la cola: si hay un filtro
  // puesto, tildar "todas" y confirmar sin querer lo que está escondido
  // sería justo lo contrario de una pantalla de revisión.
  todas.addEventListener("change", () => {
    el.querySelectorAll(".chk-retencion").forEach((c) => (c.checked = todas.checked));
    actualizar();
  });

  el.querySelectorAll(".chk-retencion").forEach((chk) => chk.addEventListener("change", actualizar));

  document.getElementById("btn-vaciar-retenciones").addEventListener("click", () => {
    COLA_RETENCIONES = [];
    guardarRetencionesEnStorage();
    renderColaRetenciones();
  });

  document.getElementById("btn-confirmar-retenciones").addEventListener("click", async (e) => {
    const btn = e.target;
    const seleccionados = [...el.querySelectorAll(".chk-retencion:checked")].map(
      (chk) => COLA_RETENCIONES[Number(chk.dataset.idx)]
    );
    if (!seleccionados.length) return;
    btn.disabled = true;
    btn.textContent = "Confirmando…";
    try {
      const resultado = await llamarBackend("consolidar_extractos", { matches: seleccionados });
      resultado.confirmados.forEach(aplicarPagoLocal);
      const resueltas = new Set([...resultado.confirmados.map((p) => p.factura_numero), ...resultado.omitidos]);
      COLA_RETENCIONES = COLA_RETENCIONES.filter((m) => !resueltas.has(m.factura_numero));
      guardarRetencionesEnStorage();
      mostrarAviso(`Se confirmaron ${resultado.confirmados.length} pago(s) con retención.`, "ok");
      renderColaRetenciones();
    } catch (err) {
      avisarError(err, "No se pudo confirmar: ");
      btn.disabled = false;
      actualizar();
    }
  });
}

document.getElementById("input-extracto").addEventListener("change", (e) => procesarArchivosExtracto([...e.target.files]));

const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// El orden importa de verdad, no es cosmético: cada cobro salda la factura
// MÁS VIEJA impaga, así que si abril se procesa antes que enero, el pago de
// abril se lleva la factura de enero y después la de enero no encuentra nada.
// El navegador entrega los archivos en el orden en que se los eligió, así que
// se reordenan por el mes que diga el nombre (los que no lo digan quedan al
// final, en el orden en que vinieron).
function ordenarPorMes(files) {
  return files
    .map((f, i) => {
      const nombre = f.name.toLowerCase();
      const mes = MESES_ES.findIndex((m) => nombre.includes(m));
      return { f, i, mes: mes === -1 ? 99 : mes };
    })
    .sort((a, b) => a.mes - b.mes || a.i - b.i)
    .map((x) => x.f);
}

async function procesarArchivosExtracto(archivos) {
  if (!archivos.length) return;
  const draftEl = document.getElementById("extracto-draft");
  const files = ordenarPorMes(archivos);

  files.forEach((f) => {
    if (!ULTIMOS_EXTRACTOS.some((x) => x.name === f.name && x.size === f.size)) ULTIMOS_EXTRACTOS.push(f);
  });

  // Con varios extractos hay que consolidar entre archivo y archivo: el
  // backend elige la factura más vieja impaga, y si no se confirma lo de
  // enero antes de leer febrero, los dos meses reclaman la MISMA factura y
  // uno de los pagos se pierde. Con un solo archivo no hace falta, y ahí
  // conviene dejar la cola para que la revises antes de confirmar.
  const enLote = files.length > 1;
  const hechas = [];

  for (let i = 0; i < files.length; i++) {
    draftEl.innerHTML = `<div class="draft-card">Leyendo extracto ${i + 1} de ${files.length} (${file_nombre(files[i])})…</div>`;
    const file = files[i];
    try {
      const payload = await payloadDePdf(file);

      // Primero se registra TODO lo que entró al banco de clientes conocidos,
      // se pueda imputar o no. Es el hecho bancario y es lo que hace cerrar el
      // arqueo: los clientes que pagan dos o tres meses juntos no matchean
      // contra ninguna factura, pero la plata entró igual.
      const cobros = await llamarBackend("registrar_cobros", payload);

      const resultado = await llamarBackend("parse_extracto", payload);
      const exactos = resultado.matches.map((m) => ({ ...m, extracto_label: resultado.extracto_label }));

      // Las retenciones NUNCA se confirman solas, ni en lote: van a la cola
      // de revisión para que alguien las mire.
      let conRetencion = 0;
      (resultado.aproximados || []).forEach((m) => {
        // Ni en una cola ni en la otra: una factura se salda una sola vez.
        if (COLA_RETENCIONES.some((x) => x.factura_numero === m.factura_numero)) return;
        if (COLA_CONSOLIDACION.some((x) => x.factura_numero === m.factura_numero)) return;
        COLA_RETENCIONES.push({ ...m, extracto_label: resultado.extracto_label });
        conRetencion++;
      });
      guardarRetencionesEnStorage();
      renderColaRetenciones();

      if (enLote) {
        let confirmados = 0;
        if (exactos.length) {
          draftEl.innerHTML = `<div class="draft-card">${file.name}: consolidando ${exactos.length} pago(s)…</div>`;
          const c = await llamarBackend("consolidar_extractos", { matches: exactos });
          c.confirmados.forEach(aplicarPagoLocal);
          confirmados = c.confirmados.length;
        }
        hechas.push(`${file.name}: ${cobros.registrados} cobro(s) registrado(s), ${confirmados} imputado(s) a una factura${conRetencion ? `, ${conRetencion} con retención a revisar` : ""}`);
      } else {
        let agregadas = 0;
        exactos.forEach((m) => {
          if (COLA_CONSOLIDACION.some((x) => x.factura_numero === m.factura_numero)) return;
          COLA_CONSOLIDACION.push(m);
          agregadas++;
        });
        const repetidas = exactos.length - agregadas;
        guardarColaEnStorage();
        hechas.push(
          `${file.name}: ${cobros.registrados} cobro(s) registrado(s), ${agregadas} coincidencia(s) nueva(s) en la cola${repetidas ? ` (${repetidas} ya estaba(n))` : ""}${conRetencion ? `, ${conRetencion} con retención a revisar` : ""}`
        );
      }

      draftEl.innerHTML = hechas.map((t) => `<div class="draft-card">${t}</div>`).join("");
    } catch (err) {
      if (esSesionInvalida(err)) {
        cerrarSesion(`Tu sesión de Google expiró mientras subías extractos (se llegó a procesar ${i} de ${files.length}).`);
        renderColaConsolidacion();
        return;
      }
      hechas.push(`<span class="warn-text">${file.name}: no se pudo leer - ${err.message}</span>`);
      draftEl.innerHTML = hechas.map((t) => `<div class="draft-card">${t}</div>`).join("");
    }
  }

  document.getElementById("input-extracto").value = "";
  renderColaConsolidacion();
}

function file_nombre(f) {
  return f.name.length > 42 ? f.name.slice(0, 40) + "…" : f.name;
}

// Cambia el cliente de una factura mal asignada, o la devuelve a "pendientes
// de validar" si se deja el CUIT vacío.
//
// Hace falta porque el matcheo automático por nombre/dirección se equivoca
// cuando hay dos edificios en la misma calle y solo uno está cargado: le
// cuelga las facturas del otro al que encuentra, y eso cruza los cobros de
// dos clientes distintos.
window.reasignarCliente = async function (factura, clienteInforme) {
  const actual = FACTURAS.find((f) => f.numero === factura);
  const nombreActual = actual && CLIENTES[actual.cuit_cliente] ? CLIENTES[actual.cuit_cliente].nombre : "—";
  const cuit = prompt(
    `Factura ${factura}\n` +
      (clienteInforme ? `En el informe figura como: ${clienteInforme}\n` : "") +
      `Hoy está asignada a: ${nombreActual}\n\n` +
      `Ingresá el CUIT correcto (11 dígitos, sin guiones).\n` +
      `Dejalo vacío para mandarla a "pendientes de validar".`,
    actual && actual.cuit_cliente ? actual.cuit_cliente : ""
  );
  if (cuit === null) return; // canceló

  const limpio = cuit.replace(/\D/g, "");
  if (limpio && limpio.length !== 11) {
    mostrarAviso("El CUIT tiene que tener 11 dígitos, sin guiones.", "error");
    return;
  }

  try {
    await llamarBackend("reasignar_cliente", { factura_numero: factura, cuit_cliente: limpio });
    await cargarDatosAutenticado();
    mostrarAviso(
      limpio ? `Factura ${factura} reasignada.` : `Factura ${factura} mandada a pendientes de validar.`,
      "ok"
    );
  } catch (err) {
    avisarError(err, "No se pudo reasignar: ");
  }
};

// Vuelve a conciliar contra los cobros ya guardados en la base, sin resubir
// los PDF: los extractos son siempre los mismos, lo que cambia es el otro
// lado (un informe nuevo, un CUIT corregido, un cliente dado de alta).
async function reconciliarCobros() {
  const btn = document.getElementById("btn-reconciliar");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Conciliando…";
  }
  try {
    const r = await llamarBackend("reconciliar");

    let agregadas = 0;
    r.matches.forEach((m) => {
      if (COLA_CONSOLIDACION.some((x) => x.factura_numero === m.factura_numero)) return;
      COLA_CONSOLIDACION.push(m);
      agregadas++;
    });
    guardarColaEnStorage();

    let conRetencion = 0;
    (r.aproximados || []).forEach((m) => {
      if (COLA_RETENCIONES.some((x) => x.factura_numero === m.factura_numero)) return;
      if (COLA_CONSOLIDACION.some((x) => x.factura_numero === m.factura_numero)) return;
      COLA_RETENCIONES.push(m);
      conRetencion++;
    });
    guardarRetencionesEnStorage();

    renderColaConsolidacion();
    renderColaRetenciones();
    mostrarAviso(
      agregadas || conRetencion
        ? `Se revisaron ${r.cobros_revisados} cobros: ${agregadas} coincidencia(s) nueva(s)${conRetencion ? ` y ${conRetencion} con retención para revisar` : ""}.`
        : `Se revisaron ${r.cobros_revisados} cobros y no apareció nada nuevo.`,
      "ok"
    );
  } catch (err) {
    avisarError(err, "No se pudo conciliar: ");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Volver a conciliar los cobros ya registrados";
    }
  }
}

let busquedaCola = "";

document.getElementById("buscar-cola").addEventListener("input", (e) => {
  busquedaCola = e.target.value;
  renderColaConsolidacion();
});

function renderColaConsolidacion() {
  const el = document.getElementById("cola-consolidacion");
  // No depende de tener los PDF a mano: los cobros ya están guardados en la
  // base, así que se puede volver a conciliar después de un F5, desde otra
  // máquina, o meses después.
  const reintentar = `<button id="btn-reconciliar" type="button" class="btn-confirmar-pago">Volver a conciliar los cobros ya registrados</button>`;

  if (!COLA_CONSOLIDACION.length) {
    el.innerHTML = `<p class="hint">Todavía no hay coincidencias en la cola. Si cargaste un informe nuevo, corregiste el CUIT de un cliente o diste de alta uno que faltaba, probá de nuevo sin resubir los extractos:</p>${reintentar}`;
    document.getElementById("btn-reconciliar").addEventListener("click", reconciliarCobros);
    return;
  }

  const q = busquedaCola.trim().toLowerCase();
  const items = COLA_CONSOLIDACION.map((m, i) => ({ m, i })).filter(
    ({ m }) => !q || [m.nombre_cliente, m.factura_numero, m.tipo_movimiento, m.extracto_label].some((v) => (v || "").toLowerCase().includes(q))
  );

  if (!items.length) {
    el.innerHTML = `<p class="hint">Ningún resultado coincide con "${busquedaCola}" (hay ${COLA_CONSOLIDACION.length} en la cola).</p>`;
    return;
  }

  const filas = items.map(
    ({ m, i }) => `
    <tr>
      <td><input type="checkbox" data-idx="${i}" class="chk-consolidar" checked></td>
      <td>${m.nombre_cliente}<div class="archivo">FC ${m.factura_numero}</div></td>
      <td class="num">${fmtMoney(m.monto)}</td>
      <td>${m.tipo_movimiento}</td>
      <td>${m.fecha_aprox || "—"}</td>
      <td class="archivo">${m.extracto_label}</td>
    </tr>`
  );

  const totalTxt = items.length === COLA_CONSOLIDACION.length ? "" : ` de ${COLA_CONSOLIDACION.length} en la cola`;
  el.innerHTML = `
    <div class="lote-resumen">
      <div class="lote-acciones lote-acciones-top">
        <button id="btn-consolidar">Consolidar ${items.length} pago${items.length === 1 ? "" : "s"}</button>
        <button id="btn-vaciar-cola" type="button" class="btn-confirmar-pago">Vaciar cola</button>
        ${reintentar}
        <span class="resumen-txt">${items.length} mostrado${items.length === 1 ? "" : "s"}${totalTxt}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th></th><th>Cliente / Factura</th><th class="num">Monto</th><th>Movimiento</th><th>Fecha</th><th>Extracto</th></tr></thead>
          <tbody>${filas.join("")}</tbody>
        </table>
      </div>
    </div>`;

  document.getElementById("btn-reconciliar")?.addEventListener("click", reconciliarCobros);

  const actualizarBotonConsolidar = () => {
    const n = el.querySelectorAll(".chk-consolidar:checked").length;
    const btn = document.getElementById("btn-consolidar");
    btn.disabled = n === 0;
    btn.textContent = `Consolidar ${n} pago${n === 1 ? "" : "s"}`;
  };
  el.querySelectorAll(".chk-consolidar").forEach((chk) => chk.addEventListener("change", actualizarBotonConsolidar));

  document.getElementById("btn-vaciar-cola").addEventListener("click", () => {
    COLA_CONSOLIDACION = [];
    guardarColaEnStorage();
    renderColaConsolidacion();
  });

  document.getElementById("btn-consolidar").addEventListener("click", async (e) => {
    const btn = e.target;
    const seleccionados = [...el.querySelectorAll(".chk-consolidar:checked")].map(
      (chk) => COLA_CONSOLIDACION[Number(chk.dataset.idx)]
    );
    if (!seleccionados.length) return;
    btn.disabled = true;
    btn.textContent = "Consolidando…";
    try {
      const resultado = await llamarBackend("consolidar_extractos", { matches: seleccionados });
      resultado.confirmados.forEach(aplicarPagoLocal);
      const yaResueltas = new Set([...resultado.confirmados.map((p) => p.factura_numero), ...resultado.omitidos]);
      COLA_CONSOLIDACION = COLA_CONSOLIDACION.filter((m) => !yaResueltas.has(m.factura_numero));
      guardarColaEnStorage();
      mostrarAviso(
        `Se consolidaron ${resultado.confirmados.length} pago${resultado.confirmados.length === 1 ? "" : "s"}.` +
          (resultado.omitidos.length ? ` ${resultado.omitidos.length} ya tenían pago registrado y se omitieron.` : ""),
        "ok"
      );
      renderColaConsolidacion();
    } catch (err) {
      avisarError(err, "No se pudo consolidar: ");
      btn.disabled = false;
      actualizarBotonConsolidar();
    }
  });
}

// --- 4) clientes ---
document.getElementById("form-cliente").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const cuit = fd.get("cuit").trim();
  if (!/^\d{11}$/.test(cuit)) {
    mostrarAviso("El CUIT tiene que tener 11 dígitos, sin guiones.", "error");
    return;
  }
  const info = {
    nombre: fd.get("nombre").trim(),
    condicion_iva: fd.get("condicion_iva").trim(),
    direccion: fd.get("direccion").trim(),
    // El form no tiene provincia: se conserva la que ya tenía, en vez de
    // pisarla con vacío cada vez que se edita el cliente.
    provincia: (CLIENTES[cuit] && CLIENTES[cuit].provincia) || "",
    email: fd.get("email").trim(),
  };
  try {
    const guardado = await llamarBackend("upsert_cliente", { cuit, ...info });
    // El backend normaliza los emails (minúsculas, separados por ", ").
    info.email = (guardado && guardado.email) || info.email;
    aplicarClienteLocal(cuit, info);
    renderTablaClientesAdmin();
    e.target.reset();
  } catch (err) {
    avisarError(err, "No se pudo guardar el cliente: ");
  }
});

let busquedaClientesAdmin = "";

document.getElementById("buscar-clientes-admin").addEventListener("input", (e) => {
  busquedaClientesAdmin = e.target.value;
  renderTablaClientesAdmin();
});

function renderTablaClientesAdmin() {
  const tbody = document.getElementById("tbody-clientes-admin");
  if (!tbody) return;
  const q = busquedaClientesAdmin.trim().toLowerCase();
  const filas = Object.entries(CLIENTES)
    .filter(([cuit, info]) => !q || cuit.includes(q) || info.nombre.toLowerCase().includes(q))
    .sort((a, b) => a[1].nombre.localeCompare(b[1].nombre))
    .map(
      ([cuit, info]) =>
        `<tr class="fila-editable" data-cuit="${cuit}"><td class="cuit">${formatCuit(cuit)}</td><td>${esc(info.nombre)}</td><td>${esc(info.condicion_iva || "")}</td><td>${info.email ? esc(info.email) : '<span class="archivo">—</span>'}</td></tr>`
    );
  tbody.innerHTML = filas.join("") || `<tr><td colspan="4">Ningún cliente coincide con la búsqueda.</td></tr>`;
}

// Clic en una fila: carga el cliente en el formulario para editarlo. Sin
// esto, cargar un email obligaba a reescribir a mano CUIT, nombre e IVA.
document.getElementById("tbody-clientes-admin").addEventListener("click", (e) => {
  const fila = e.target.closest("tr[data-cuit]");
  if (!fila) return;
  const cuit = fila.dataset.cuit;
  const info = CLIENTES[cuit] || {};
  const form = document.getElementById("form-cliente");
  form.cuit.value = cuit;
  form.nombre.value = info.nombre || "";
  form.condicion_iva.value = info.condicion_iva || "";
  form.direccion.value = info.direccion || "";
  form.email.value = info.email || "";
  form.email.focus();
  form.scrollIntoView({ behavior: "smooth", block: "center" });
});

function esc(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// --- mailing ---
// Todo lo que se muestra acá lo arma Supabase (ko.v_mailing): el panel solo
// elige a quién mandarle. Al enviar, el backend vuelve a leer la vista, así
// que el saldo que sale es el de ese momento.
// Los mails no salen en el momento: quedan en una cola que el cartero
// (Apps Script de facturacion@) revisa cada 1 minuto. Ver Mailing.gs.
let MAILING = { templates: [], destinatarios: [], cartero: null, cola: null, templateId: null };
let MAILING_ABIERTO = null;

const ESTADOS_MAILING = {
  listo: { texto: "Listo", clase: "ok" },
  sin_email: { texto: "Sin email", clase: "warn" },
  enviado_reciente: { texto: "Enviado hace poco", clase: "" },
  en_cola: { texto: "En cola", clase: "" },
};

function haceCuanto(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "hace menos de un minuto";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `el ${new Date(iso).toLocaleDateString("es-AR")}`;
}

async function cargarMailing(templateId) {
  const cont = document.getElementById("mailing-contenido");
  cont.innerHTML = `<p class="hint">Cargando…</p>`;
  try {
    const vista = await llamarBackend("mailing_vista", {});
    MAILING.templates = vista.templates;
    const sel = document.getElementById("mailing-template");
    sel.innerHTML = vista.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.id)}</option>`).join("");
    if (!vista.templates.length) {
      cont.innerHTML = `<p class="hint">No hay templates activos en <code>ko.mailing_templates</code>.</p>`;
      return;
    }
    MAILING.templateId = templateId || MAILING.templateId || vista.templates[0].id;
    if (!vista.templates.some((t) => t.id === MAILING.templateId)) MAILING.templateId = vista.templates[0].id;
    sel.value = MAILING.templateId;
    const conDatos = await llamarBackend("mailing_vista", { template_id: MAILING.templateId });
    MAILING.destinatarios = conDatos.destinatarios || [];
    MAILING.cartero = conDatos.cartero;
    MAILING.cola = conDatos.cola;
    MAILING_ABIERTO = null;
    renderMailing();
  } catch (err) {
    if (esSesionInvalida(err)) return avisarError(err, "");
    cont.innerHTML = `<p class="hint warn-text">No se pudo cargar: ${esc(err.message)}</p>`;
  }
}

document.getElementById("mailing-template").addEventListener("change", (e) => cargarMailing(e.target.value));

function rangoTemplate(t) {
  const desde = t.saldo_min > 0 ? `más de ${fmtMoney(t.saldo_min)}` : "más de $0";
  return t.saldo_max === null ? `Saldo ${desde}` : `Saldo ${desde} y menos de ${fmtMoney(t.saldo_max)}`;
}

function renderMailing() {
  const cont = document.getElementById("mailing-contenido");
  const t = MAILING.templates.find((x) => x.id === MAILING.templateId);
  const ds = [...MAILING.destinatarios].sort((a, b) => a.nombre.localeCompare(b.nombre));
  const cuenta = (estado) => ds.filter((d) => d.estado === estado).length;
  const listos = ds.filter((d) => d.estado === "listo");
  const esAdmin = YO.perfil === "admin";

  // El saldo de la vista lo calcula Supabase y el del tablero el navegador,
  // con la misma fórmula escrita dos veces (SQL y JS). Si alguna vez se
  // desalinean, el mail le diría al cliente una deuda distinta de la que ve
  // KO: en ese caso no se deja mandar nada.
  const saldoTablero = new Map(CLIENTES_VIEW.map((c) => [c.cuit, c.total_pendiente]));
  const desalineados = ds.filter((d) => Math.abs((saldoTablero.get(d.cuit) ?? 0) - d.saldo) > 1);
  const puedeMandar = esAdmin && !t.sin_completar && !desalineados.length;
  const c = MAILING.cartero || {};

  const avisos = [];
  // Con el cartero caido igual se puede encolar: los mails salen cuando
  // vuelva. Pero que se sepa.
  if (!c.visto_en) {
    avisos.push("El cartero todavía no se conectó nunca: los mails van a quedar en la cola hasta que esté instalado (ver <code>migracion/cartero/README.md</code>).");
  } else if (!c.activo) {
    avisos.push(`El cartero no se reporta desde ${haceCuanto(c.visto_en)}: los mails quedan en la cola hasta que vuelva.`);
  }
  const errores = (MAILING.cola && MAILING.cola.errores) || [];
  if (errores.length) {
    avisos.push(
      `${errores.length} mail${errores.length === 1 ? "" : "s"} con error en las últimas 48 h: ` +
        errores.slice(0, 3).map((e) => `${esc(e.para)} (${esc(e.error)})`).join("; ") + (errores.length > 3 ? "…" : "")
    );
  }
  if (t.sin_completar) {
    avisos.push(`El template todavía tiene datos sin completar (<code>[COMPLETAR …]</code>). Editalo en Supabase, tabla <code>ko.mailing_templates</code>, fila <code>${esc(t.id)}</code>; hasta entonces no se puede enviar.`);
  }
  if (cuenta("sin_email")) {
    avisos.push(`${cuenta("sin_email")} cliente${cuenta("sin_email") === 1 ? "" : "s"} sin email: cargalo${cuenta("sin_email") === 1 ? "" : "s"} desde la pestaña Clientes.`);
  }
  if (desalineados.length) {
    avisos.push(
      `El saldo de Supabase no coincide con el del tablero para ${desalineados.length} cliente${desalineados.length === 1 ? "" : "s"} ` +
        `(${desalineados.slice(0, 3).map((d) => esc(d.nombre)).join(", ")}${desalineados.length > 3 ? "…" : ""}). ` +
        `Probá con Actualizar; si sigue, la fórmula de <code>ko.v_saldos_clientes</code> y la de <code>recomputar()</code> se desalinearon. No se puede enviar hasta resolverlo.`
    );
  }
  if (!esAdmin) avisos.push("Solo un admin puede enviar.");

  const filas = ds.map((d) => {
    const est = ESTADOS_MAILING[d.estado] || { texto: d.estado, clase: "" };
    const abierto = MAILING_ABIERTO === d.cuit;
    return `
      <tr class="fila-editable" data-cuit="${d.cuit}">
        <td>${d.estado === "listo" && puedeMandar ? `<input type="checkbox" class="chk-mailing" data-cuit="${d.cuit}" checked aria-label="Enviar a ${esc(d.nombre)}">` : ""}</td>
        <td>${esc(d.nombre)}<div class="archivo">${formatCuit(d.cuit)}</div></td>
        <td class="archivo">${d.email ? esc(d.email) : "—"}</td>
        <td class="num">${fmtMoney(d.saldo)}</td>
        <td><span class="badge ${est.clase}">${est.texto}</span>${d.ultimo_envio ? `<div class="archivo">último: ${new Date(d.ultimo_envio).toLocaleDateString("es-AR")}</div>` : ""}</td>
      </tr>
      ${abierto ? `<tr><td colspan="5"><div class="mail-preview"><div class="mail-asunto">${esc(d.asunto)}</div>${d.cuerpo_html ? `<iframe class="mail-html" sandbox="allow-same-origin" title="Vista previa del mail" srcdoc="${esc(d.cuerpo_html)}"></iframe>` : `<pre>${esc(d.cuerpo)}</pre>`}<button type="button" class="btn-confirmar-pago btn-mail-prueba" data-cuit="${d.cuit}">Enviarme este mail de prueba</button></div></td></tr>` : ""}`;
  });

  cont.innerHTML = `
    <div class="draft-card">
      <div class="draft-row"><span class="k">Template</span><span>${esc(t.descripcion || t.id)}</span></div>
      <div class="draft-row"><span class="k">Criterio</span><span>${rangoTemplate(t)} · no repite antes de ${t.dias_entre_envios} días</span></div>
      <div class="draft-row"><span class="k">Destinatarios</span><span>${ds.length} en total · ${listos.length} listos · ${cuenta("sin_email")} sin email · ${cuenta("en_cola")} en cola · ${cuenta("enviado_reciente")} enviados hace poco</span></div>
      <div class="draft-row"><span class="k">Sale desde</span><span>${c.cuenta ? esc(c.cuenta) : "—"}</span></div>
      <div class="draft-row"><span class="k">Cartero</span><span>${c.visto_en ? `${c.activo ? "activo" : "sin conexión"} · último contacto ${haceCuanto(c.visto_en)}` : "sin instalar"}</span></div>
      <div class="draft-row"><span class="k">Cuota de Gmail hoy</span><span>${c.cuota != null ? `${c.cuota} destinatarios` : "—"}</span></div>
      <div class="draft-row"><span class="k">En cola ahora</span><span>${(MAILING.cola && MAILING.cola.en_espera) || 0} mails</span></div>
      ${avisos.map((a) => `<div class="warn-text">${a}</div>`).join("")}
    </div>
    <div class="lote-resumen">
      ${puedeMandar ? `
      <div class="lote-acciones lote-acciones-top">
        <button id="btn-enviar-mailing" disabled>Enviar 0 mails</button>
        <span class="resumen-txt">Quedan en cola y salen desde ${esc(c.cuenta || "la cuenta de facturación")} en el próximo minuto.</span>
      </div>` : ""}
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>${puedeMandar && listos.length ? `<input type="checkbox" id="chk-mailing-todos" checked title="Seleccionar todos los listos">` : ""}</th>
            <th>Cliente</th><th>Email</th><th class="num">Saldo</th><th>Estado</th>
          </tr></thead>
          <tbody>${filas.join("") || `<tr><td colspan="5">Ningún cliente tiene saldo en este rango.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  cont.querySelectorAll("tr[data-cuit]").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.matches("input")) return;
      MAILING_ABIERTO = MAILING_ABIERTO === tr.dataset.cuit ? null : tr.dataset.cuit;
      const marcados = new Set([...cont.querySelectorAll(".chk-mailing:checked")].map((c) => c.dataset.cuit));
      renderMailing();
      cont.querySelectorAll(".chk-mailing").forEach((c) => (c.checked = marcados.has(c.dataset.cuit)));
      actualizarBotonMailing();
    })
  );
  // El iframe no ejecuta scripts (sandbox), pero con allow-same-origin se
  // puede medir el alto del mail para mostrarlo entero, sin doble scroll.
  const marco = cont.querySelector(".mail-html");
  marco?.addEventListener("load", () => {
    marco.style.height = marco.contentDocument.documentElement.scrollHeight + "px";
  });
  cont.querySelector(".btn-mail-prueba")?.addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Enviando…";
    try {
      const r = await llamarBackend("mailing_prueba", { template_id: MAILING.templateId, cuit: btn.dataset.cuit });
      mostrarAviso(
        `Puse en la cola el mail de ${esc(r.cliente)} para ${esc(r.enviado_a)}` +
          (r.cartero_activo ? ": te llega en el próximo minuto." : ", pero el cartero no está conectado: va a salir cuando vuelva.") +
          " Al cliente no le llega nada.",
        "ok"
      );
      cargarMailing(MAILING.templateId);
    } catch (err) {
      avisarError(err, "No se pudo mandar la prueba: ");
    }
    btn.disabled = false;
    btn.textContent = "Enviarme este mail de prueba";
  });
  if (!puedeMandar) return;

  const todos = document.getElementById("chk-mailing-todos");
  todos?.addEventListener("change", () => {
    cont.querySelectorAll(".chk-mailing").forEach((c) => (c.checked = todos.checked));
    actualizarBotonMailing();
  });
  cont.querySelectorAll(".chk-mailing").forEach((c) => c.addEventListener("change", actualizarBotonMailing));
  document.getElementById("btn-enviar-mailing").addEventListener("click", enviarMailing);
  actualizarBotonMailing();
}

function actualizarBotonMailing() {
  const cont = document.getElementById("mailing-contenido");
  const cajas = [...cont.querySelectorAll(".chk-mailing")];
  const n = cajas.filter((c) => c.checked).length;
  const btn = document.getElementById("btn-enviar-mailing");
  if (!btn) return;
  btn.disabled = n === 0;
  btn.textContent = `Enviar ${n} mail${n === 1 ? "" : "s"}`;
  const todos = document.getElementById("chk-mailing-todos");
  if (todos) {
    todos.checked = n > 0 && n === cajas.length;
    todos.indeterminate = n > 0 && n < cajas.length;
  }
}

async function enviarMailing(e) {
  const btn = e.target;
  const cuits = [...document.querySelectorAll(".chk-mailing:checked")].map((c) => c.dataset.cuit);
  if (!cuits.length) return;
  const total = cuits.reduce((s, c) => s + (MAILING.destinatarios.find((d) => d.cuit === c)?.saldo || 0), 0);
  const ok = confirm(
    `Vas a poner en la cola ${cuits.length} mail${cuits.length === 1 ? "" : "s"} con el template "${MAILING.templateId}" ` +
      `(saldo total ${fmtMoney(total)}).\n\nEsto no se puede deshacer. ¿Enviar?`
  );
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = "Enviando…";
  try {
    const r = await llamarBackend("mailing_enviar", { template_id: MAILING.templateId, cuits });
    const n = r.encolados.length;
    const partes = [
      `${n} mail${n === 1 ? "" : "s"} en la cola` +
        (r.cartero_activo ? ": salen en los próximos minutos." : ". El cartero no está conectado: salen cuando vuelva."),
    ];
    if (r.omitidos.length) partes.push(`${r.omitidos.length} se omitieron porque cambiaron desde la vista previa (ya pagaron, sin email, ya en cola o ya se les mandó).`);
    mostrarAviso(partes.join(" "), "ok");
  } catch (err) {
    avisarError(err, "No se pudo enviar: ");
  }
  cargarMailing(MAILING.templateId);
}

// --- 5) usuarios (solo admin) ---
let USUARIOS_CACHE = {};
let busquedaUsuarios = "";

document.getElementById("buscar-usuarios").addEventListener("input", (e) => {
  busquedaUsuarios = e.target.value;
  renderTablaUsuarios();
});

async function cargarUsuarios() {
  if (YO.perfil !== "admin") return;
  const tbody = document.getElementById("tbody-usuarios");
  tbody.innerHTML = `<tr><td colspan="4">Cargando…</td></tr>`;
  try {
    USUARIOS_CACHE = await llamarBackend("listar_usuarios");
    renderTablaUsuarios();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="warn-text">No se pudo cargar: ${err.message}</td></tr>`;
  }
}

function renderTablaUsuarios() {
  const tbody = document.getElementById("tbody-usuarios");
  const q = busquedaUsuarios.trim().toLowerCase();
  const filas = Object.entries(USUARIOS_CACHE)
    .filter(([email, info]) => !q || `${info.nombre} ${info.apellido}`.toLowerCase().includes(q) || email.toLowerCase().includes(q))
    .sort((a, b) => a[1].nombre.localeCompare(b[1].nombre))
    .map(
      ([email, info]) => `
      <tr>
        <td>${info.nombre} ${info.apellido}</td>
        <td>${email}</td>
        <td>${etiquetaPerfil(info.perfil)}</td>
      </tr>`
    );
  tbody.innerHTML = filas.join("") || `<tr><td colspan="3">Ningún usuario coincide con la búsqueda.</td></tr>`;
}

document.getElementById("form-usuario").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get("email").trim().toLowerCase();
  if (!email.includes("@")) {
    mostrarAviso("Ingresá un email válido.", "error");
    return;
  }
  try {
    await llamarBackend("upsert_usuario", {
      email,
      nombre: fd.get("nombre").trim(),
      apellido: fd.get("apellido").trim(),
      perfil: fd.get("perfil"),
    });
    e.target.reset();
    cargarUsuarios();
  } catch (err) {
    avisarError(err, "No se pudo guardar el usuario: ");
  }
});

// --- arrastrar y soltar en las zonas de carga (además del clic normal, que
// ya funciona solo por la asociación <label for>/<input>) ---
function wireDropzone(zoneId, onFiles) {
  const zona = document.getElementById(zoneId);
  ["dragenter", "dragover"].forEach((evt) =>
    zona.addEventListener(evt, (e) => {
      e.preventDefault();
      zona.classList.add("dragover");
    })
  );
  ["dragleave", "dragend"].forEach((evt) => zona.addEventListener(evt, () => zona.classList.remove("dragover")));
  zona.addEventListener("drop", (e) => {
    e.preventDefault();
    zona.classList.remove("dragover");
    const archivos = [...e.dataTransfer.files].filter((f) => f.type === "application/pdf");
    if (archivos.length) onFiles(archivos);
  });
}

wireDropzone("dropzone-extracto", procesarArchivosExtracto);

window.addEventListener("load", initGoogleSignIn);
