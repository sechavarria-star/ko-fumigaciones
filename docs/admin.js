// Panel de admin: login con Google + acciones que escriben datos (confirmar
// pago manual, subir factura/extracto, editar clientes). Todas las escrituras
// pasan por el backend (CONFIG.BACKEND_URL), que valida el login de Google
// contra una lista de emails permitidos y hace el commit real a GitHub - el
// navegador nunca tiene un token de GitHub.

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

async function llamarBackend(path, options = {}) {
  const res = await fetch(CONFIG.BACKEND_URL + path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${ID_TOKEN}`,
    },
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let detail = raw;
    try {
      detail = JSON.parse(raw).detail || raw;
    } catch {}
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json();
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

// El plan free de Render "duerme" el backend a los 15 min sin uso: la primera
// request tras eso puede fallar directo (network error, "Failed to fetch") o
// el backend puede devolver 503 si justo se cae la verificación del token con
// Google (fallo de red del lado del servidor). Reintentamos con aviso en vez
// de mostrar un error seco la primera vez que alguien entra después de un rato.
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
      gateError.textContent = "Despertando el servidor (plan gratis, puede tardar unos segundos)…";
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
    const pago = await llamarBackend("/api/pagos/confirmar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        factura_numero: pagoPendienteContext.factura,
        cuit_cliente: pagoPendienteContext.cuit,
        numero_transaccion: fd.get("numero_transaccion"),
        fecha_ingreso: fd.get("fecha_ingreso"),
      }),
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
  const fd = new FormData();
  fd.append("file", file);
  try {
    const resultado = await llamarBackend("/api/facturas/importar-informe", { method: "POST", body: fd });
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
function renderPendientesLista() {
  const el = document.getElementById("pendientes-lista");
  if (!PENDIENTES_VALIDAR.length) {
    el.innerHTML = `<p class="hint">No hay facturas pendientes de validar.</p>`;
    return;
  }
  el.innerHTML = PENDIENTES_VALIDAR.map(
    (p, i) => `
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
  ).join("");

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
        const resultado = await llamarBackend("/api/facturas/confirmar-cuit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cliente_informe: p.cliente_informe, cuit_cliente: cuit }),
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
let COLA_CONSOLIDACION = [];
let ULTIMOS_EXTRACTOS = []; // File[] ya subidos en esta sesión, para reintentar

document.getElementById("input-extracto").addEventListener("change", (e) => procesarArchivosExtracto([...e.target.files]));

async function procesarArchivosExtracto(files) {
  if (!files.length) return;
  const draftEl = document.getElementById("extracto-draft");

  files.forEach((f) => {
    if (!ULTIMOS_EXTRACTOS.some((x) => x.name === f.name && x.size === f.size)) ULTIMOS_EXTRACTOS.push(f);
  });

  for (let i = 0; i < files.length; i++) {
    draftEl.innerHTML = `<div class="draft-card">Leyendo extracto ${i + 1} de ${files.length}…</div>`;
    const file = files[i];
    const fd = new FormData();
    fd.append("file", file);
    try {
      const resultado = await llamarBackend("/api/extractos/parse", { method: "POST", body: fd });
      let agregadas = 0;
      resultado.matches.forEach((m) => {
        if (COLA_CONSOLIDACION.some((x) => x.factura_numero === m.factura_numero)) return;
        COLA_CONSOLIDACION.push({ ...m, extracto_label: resultado.extracto_label });
        agregadas++;
      });
      const repetidas = resultado.matches.length - agregadas;
      draftEl.innerHTML = `<div class="draft-card">${file.name}: ${agregadas} coincidencia${agregadas === 1 ? "" : "s"} nueva${agregadas === 1 ? "" : "s"} agregada${agregadas === 1 ? "" : "s"} a la cola.${repetidas ? ` (${repetidas} ya estaba${repetidas === 1 ? "" : "n"} en la cola)` : ""}</div>`;
    } catch (err) {
      if (esSesionInvalida(err)) {
        cerrarSesion(`Tu sesión de Google expiró mientras subías extractos (se llegó a procesar ${i} de ${files.length}).`);
        renderColaConsolidacion();
        return;
      }
      draftEl.innerHTML = `<div class="draft-card warn-text">${file.name}: no se pudo leer - ${err.message}</div>`;
    }
  }
  document.getElementById("input-extracto").value = "";
  renderColaConsolidacion();
}

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

  const filas = COLA_CONSOLIDACION.map(
    (m, i) => `
    <tr>
      <td><input type="checkbox" data-idx="${i}" class="chk-consolidar" checked></td>
      <td>${m.nombre_cliente}<div class="archivo">FC ${m.factura_numero}</div></td>
      <td class="num">${fmtMoney(m.monto)}</td>
      <td>${m.tipo_movimiento}</td>
      <td>${m.fecha_aprox || "—"}</td>
      <td class="archivo">${m.extracto_label}</td>
    </tr>`
  );

  el.innerHTML = `
    <div class="lote-resumen">
      <div class="table-wrap">
        <table>
          <thead><tr><th></th><th>Cliente / Factura</th><th class="num">Monto</th><th>Movimiento</th><th>Fecha</th><th>Extracto</th></tr></thead>
          <tbody>${filas.join("")}</tbody>
        </table>
      </div>
      <div class="lote-acciones">
        <button id="btn-consolidar">Consolidar ${COLA_CONSOLIDACION.length} pago${COLA_CONSOLIDACION.length === 1 ? "" : "s"}</button>
        <button id="btn-vaciar-cola" type="button" class="btn-confirmar-pago">Vaciar cola</button>
        ${reintentar}
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
      const resultado = await llamarBackend("/api/extractos/consolidar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matches: seleccionados }),
      });
      resultado.confirmados.forEach(aplicarPagoLocal);
      const yaResueltas = new Set([...resultado.confirmados.map((p) => p.factura_numero), ...resultado.omitidos]);
      COLA_CONSOLIDACION = COLA_CONSOLIDACION.filter((m) => !yaResueltas.has(m.factura_numero));
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
    await llamarBackend("/api/clientes/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cuit, ...info }),
    });
    aplicarClienteLocal(cuit, info);
    renderTablaClientesAdmin();
    e.target.reset();
  } catch (err) {
    avisarError(err, "No se pudo guardar el cliente: ");
  }
});

function renderTablaClientesAdmin() {
  const tbody = document.getElementById("tbody-clientes-admin");
  if (!tbody) return;
  const filas = Object.entries(CLIENTES)
    .sort((a, b) => a[1].nombre.localeCompare(b[1].nombre))
    .map(([cuit, info]) => `<tr><td class="cuit">${formatCuit(cuit)}</td><td>${info.nombre}</td><td>${info.condicion_iva || ""}</td></tr>`);
  tbody.innerHTML = filas.join("");
}

// --- 5) usuarios (solo admin) ---
async function cargarUsuarios() {
  if (YO.perfil !== "admin") return;
  const tbody = document.getElementById("tbody-usuarios");
  tbody.innerHTML = `<tr><td colspan="4">Cargando…</td></tr>`;
  try {
    const usuarios = await llamarBackend("/api/usuarios");
    const filas = Object.entries(usuarios)
      .sort((a, b) => a[1].nombre.localeCompare(b[1].nombre))
      .map(
        ([email, info]) => `
        <tr>
          <td>${info.nombre} ${info.apellido}</td>
          <td>${email}</td>
          <td>${etiquetaPerfil(info.perfil)}</td>
        </tr>`
      );
    tbody.innerHTML = filas.join("") || `<tr><td colspan="3">Sin usuarios cargados todavía.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="warn-text">No se pudo cargar: ${err.message}</td></tr>`;
  }
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
    await llamarBackend("/api/usuarios/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        nombre: fd.get("nombre").trim(),
        apellido: fd.get("apellido").trim(),
        perfil: fd.get("perfil"),
      }),
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
