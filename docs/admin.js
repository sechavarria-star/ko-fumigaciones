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
      <td><input type="checkbox" data-idx="${i}" class="chk-retencion"></td>
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
          <thead><tr><th></th><th>Cliente / Factura</th><th class="num">Facturado</th><th class="num">Cobrado</th><th class="num">Retención</th><th>Fecha</th><th>Extracto</th></tr></thead>
          <tbody>${filas.join("")}</tbody>
        </table>
      </div>
    </div>`;

  const actualizar = () => {
    const n = el.querySelectorAll(".chk-retencion:checked").length;
    const btn = document.getElementById("btn-confirmar-retenciones");
    btn.disabled = n === 0;
    btn.textContent = `Confirmar ${n} pago${n === 1 ? "" : "s"}`;
  };
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

let busquedaCola = "";

document.getElementById("buscar-cola").addEventListener("input", (e) => {
  busquedaCola = e.target.value;
  renderColaConsolidacion();
});

function renderColaConsolidacion() {
  const el = document.getElementById("cola-consolidacion");
  const reintentar = ULTIMOS_EXTRACTOS.length
    ? `<button id="btn-reintentar-extractos" type="button" class="btn-confirmar-pago">Volver a buscar en los ${ULTIMOS_EXTRACTOS.length} extracto${ULTIMOS_EXTRACTOS.length === 1 ? "" : "s"} ya subido${ULTIMOS_EXTRACTOS.length === 1 ? "" : "s"}</button>`
    : "";

  if (!COLA_CONSOLIDACION.length) {
    el.innerHTML = `<p class="hint">Todavía no hay coincidencias en la cola.${
      ULTIMOS_EXTRACTOS.length ? " Si cargaste una factura nueva después del extracto, probá de nuevo:" : ""
    }</p>${reintentar}`;
    document.getElementById("btn-reintentar-extractos")?.addEventListener("click", () => procesarArchivosExtracto(ULTIMOS_EXTRACTOS));
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

  document.getElementById("btn-reintentar-extractos")?.addEventListener("click", () => procesarArchivosExtracto(ULTIMOS_EXTRACTOS));

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
    provincia: "",
  };
  try {
    await llamarBackend("upsert_cliente", { cuit, ...info });
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
    .map(([cuit, info]) => `<tr><td class="cuit">${formatCuit(cuit)}</td><td>${info.nombre}</td><td>${info.condicion_iva || ""}</td></tr>`);
  tbody.innerHTML = filas.join("") || `<tr><td colspan="3">Ningún cliente coincide con la búsqueda.</td></tr>`;
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
