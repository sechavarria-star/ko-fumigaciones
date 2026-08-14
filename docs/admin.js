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
    const detail = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
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

function avisarError(err, prefijo) {
  if (esSesionInvalida(err)) {
    cerrarSesion("Tu sesión de Google expiró. Volvé a iniciar sesión.");
    return;
  }
  alert(prefijo + err.message);
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

// --- 2) subir facturas (una o muchas de una: carga masiva, número de
// factura como clave única) ---
let LOTE_FACTURAS = []; // [{archivo, draft, estado: "ok"|"error", motivo}]

document.getElementById("input-facturas").addEventListener("change", (e) => procesarArchivosFacturas([...e.target.files]));

async function procesarArchivosFacturas(files) {
  if (!files.length) return;
  const draftEl = document.getElementById("facturas-draft");
  LOTE_FACTURAS = [];
  const numerosDelLote = new Set();

  for (let i = 0; i < files.length; i++) {
    draftEl.innerHTML = `<div class="draft-card">Leyendo PDF ${i + 1} de ${files.length}…</div>`;
    const file = files[i];
    const fd = new FormData();
    fd.append("file", file);
    try {
      const draft = await llamarBackend("/api/facturas/parse", { method: "POST", body: fd });
      let estado = "ok";
      let motivo = "";
      if (!draft.cuit_encontrado) {
        estado = "error";
        motivo = `CUIT ${draft.cuit_cliente || "?"} no está en Clientes`;
      } else if (FACTURAS.some((f) => f.numero === draft.numero)) {
        estado = "error";
        motivo = "Ya existe una factura con ese número";
      } else if (numerosDelLote.has(draft.numero)) {
        estado = "error";
        motivo = "Repetida dentro de este mismo lote";
      }
      if (estado === "ok") numerosDelLote.add(draft.numero);
      LOTE_FACTURAS.push({ archivo: file.name, draft, estado, motivo });
    } catch (err) {
      if (esSesionInvalida(err)) {
        cerrarSesion(
          `Tu sesión de Google expiró mientras subías las facturas (se llegó a procesar ${i} de ${files.length}). Volvé a iniciar sesión y subí el resto.`
        );
        return;
      }
      LOTE_FACTURAS.push({ archivo: file.name, draft: null, estado: "error", motivo: err.message });
    }
  }
  renderLoteFacturas(draftEl);
}

function renderLoteFacturas(draftEl) {
  const ok = LOTE_FACTURAS.filter((it) => it.estado === "ok").length;
  const filas = LOTE_FACTURAS.map((it, i) => {
    if (it.estado === "error") {
      return `<tr>
        <td class="archivo">${it.archivo}</td>
        <td colspan="3" class="warn-text">${it.motivo}</td>
        <td></td>
      </tr>`;
    }
    const d = it.draft;
    return `<tr>
      <td><input type="checkbox" data-idx="${i}" class="chk-factura" checked></td>
      <td>${d.numero}<div class="archivo">${it.archivo}</div></td>
      <td>${d.nombre_cliente}</td>
      <td class="num">${fmtMoney(d.total)}</td>
      <td><span class="badge ok">Listo</span></td>
    </tr>`;
  });

  draftEl.innerHTML = `
    <div class="lote-resumen">
      <div class="table-wrap">
        <table>
          <thead><tr><th></th><th>Factura</th><th>Cliente</th><th class="num">Total</th><th>Estado</th></tr></thead>
          <tbody>${filas.join("")}</tbody>
        </table>
      </div>
      <div class="lote-acciones">
        <button id="btn-guardar-lote" ${ok === 0 ? "disabled" : ""}>Guardar ${ok} factura${ok === 1 ? "" : "s"}</button>
        <span class="resumen-txt">${LOTE_FACTURAS.length - ok} con problema (no se van a guardar)</span>
      </div>
    </div>`;

  const actualizarBotonLote = () => {
    const n = draftEl.querySelectorAll(".chk-factura:checked").length;
    const btn = document.getElementById("btn-guardar-lote");
    btn.disabled = n === 0;
    btn.textContent = `Guardar ${n} factura${n === 1 ? "" : "s"}`;
  };
  draftEl.querySelectorAll(".chk-factura").forEach((chk) => chk.addEventListener("change", actualizarBotonLote));

  document.getElementById("btn-guardar-lote")?.addEventListener("click", async (e) => {
    const btn = e.target;
    const seleccionadas = [...draftEl.querySelectorAll(".chk-factura:checked")].map(
      (chk) => LOTE_FACTURAS[Number(chk.dataset.idx)].draft
    );
    if (!seleccionadas.length) return;
    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      const resultado = await llamarBackend("/api/facturas/guardar-lote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facturas: seleccionadas }),
      });
      resultado.guardadas.forEach(aplicarFacturaLocal);
      const omitidasTxt = resultado.omitidas.length
        ? ` · ${resultado.omitidas.length} omitida(s): ${resultado.omitidas.map((o) => `${o.numero} (${o.motivo})`).join(", ")}`
        : "";
      draftEl.innerHTML = `<div class="draft-card">Se guardaron ${resultado.guardadas.length} factura(s).${omitidasTxt}</div>`;
      document.getElementById("input-facturas").value = "";
    } catch (err) {
      avisarError(err, "No se pudo guardar el lote: ");
      btn.disabled = false;
      btn.textContent = `Guardar ${seleccionadas.length} factura${seleccionadas.length === 1 ? "" : "s"}`;
    }
  });
}

// --- 3) subir extracto ---
document.getElementById("input-extracto").addEventListener("change", (e) => procesarArchivoExtracto(e.target.files[0]));

async function procesarArchivoExtracto(file) {
  if (!file) return;
  const draftEl = document.getElementById("extracto-draft");
  draftEl.innerHTML = `<div class="draft-card">Leyendo PDF y buscando coincidencias…</div>`;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const resultado = await llamarBackend("/api/extractos/parse", { method: "POST", body: fd });
    if (!resultado.matches.length) {
      draftEl.innerHTML = `<div class="draft-card">No se encontraron coincidencias de CUIT contra facturas pendientes en este extracto.</div>`;
      return;
    }
    draftEl.innerHTML = `<div class="draft-card">${resultado.matches
      .map(
        (m, i) => `
        <div class="match-item">
          <div>
            <div>${m.nombre_cliente} · FC ${m.factura_numero}</div>
            <div class="k" style="font-size:0.78rem">${m.tipo_movimiento} · ${m.fecha_aprox || "sin fecha"} · ${fmtMoney(m.monto)}</div>
          </div>
          <button data-idx="${i}" class="btn-aceptar-match">Aceptar</button>
        </div>`
      )
      .join("")}</div>`;
    draftEl.querySelectorAll(".btn-aceptar-match").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const m = resultado.matches[Number(btn.dataset.idx)];
        try {
          const pago = await llamarBackend("/api/extractos/confirmar-match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...m, extracto_label: resultado.extracto_label }),
          });
          aplicarPagoLocal(pago);
          btn.closest(".match-item").remove();
        } catch (err) {
          avisarError(err, "No se pudo confirmar: ");
        }
      });
    });
  } catch (err) {
    if (esSesionInvalida(err)) {
      cerrarSesion("Tu sesión de Google expiró. Volvé a iniciar sesión.");
      return;
    }
    draftEl.innerHTML = `<div class="draft-card warn-text">No se pudo leer el PDF: ${err.message}</div>`;
  }
}

// --- 4) clientes ---
document.getElementById("form-cliente").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const cuit = fd.get("cuit").trim();
  if (!/^\d{11}$/.test(cuit)) {
    alert("El CUIT tiene que tener 11 dígitos, sin guiones.");
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
    alert("Ingresá un email válido.");
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

wireDropzone("dropzone-facturas", procesarArchivosFacturas);
wireDropzone("dropzone-extracto", (archivos) => procesarArchivoExtracto(archivos[0]));

window.addEventListener("load", initGoogleSignIn);
