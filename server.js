// server.js
//
// Servidor de SegurPanel. Hace cuatro cosas:
//   1. Sirve la app (index.html) solo a sesiones autenticadas; sin sesion
//      valida sirve login.html en su lugar (puerta de acceso).
//   2. Expone la API de autenticacion y gestion de usuarios (login, cambio
//      de contrasena obligatorio, solicitud de acceso, panel de Super
//      Admin) respaldada por SQLite (db.js) y JWT (auth.js).
//   3. Sirve los estaticos de la PWA (manifest.json, sw.js, iconos).
//   4. Expone POST /api/chat, que reenvia la conversacion a la API real de
//      Anthropic usando ANTHROPIC_API_KEY. La clave nunca se envia al
//      navegador.
//
// Uso:
//   setx ANTHROPIC_API_KEY "sk-ant-..."   (una vez, y abrir una terminal nueva)
//   node server.js
//   -> abrir http://localhost:3000/ en el navegador
//
// Dependencias externas minimas y deliberadas: bcryptjs y jsonwebtoken (JS
// puro, sin compilacion nativa). La base de datos usa el modulo `node:sqlite`
// incorporado en Node — no hace falta instalar ni compilar un motor aparte.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const JSZip = require("jszip");
const db = require("./db");
const auth = require("./auth");
const analisis = require("./analisis");

const PORT = process.env.PORT || 3000;
const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TURNOS_HISTORIAL = 12; // limita el contexto que se reenvia a la API
const MAX_LONGITUD_MENSAJE = 4000;

const SYSTEM_PROMPT = `Eres el asistente virtual de SegurPanel, y encarnas a un experto en retención de clientes con 15 años de experiencia en el sector de alarmas y seguridad en España. Quien te escribe es un agente de retención (o de atención al cliente) de una compañía de alarmas que está gestionando una llamada de baja, no el cliente final. Tu trabajo es darle argumentos y guion para esa llamada.

Dominas:
- Psicología del cliente que quiere darse de baja: qué hay realmente detrás de cada objeción, cómo bajar la fricción emocional y generar confianza antes de argumentar.
- Técnicas de negociación y fidelización: escucha activa, reformulación de la objeción, ofertas de valor (no solo descuentos), y cierre sin presionar de forma agresiva.
- Legislación española de consumo aplicable a permanencia y baja de servicios (Real Decreto Legislativo 1/2007, Texto Refundido de la Ley General para la Defensa de los Consumidores y Usuarios; límites legales a las cláusulas de permanencia; Ley 5/2014 de Seguridad Privada). Si no conoces con certeza un artículo o dato normativo exacto, dilo explícitamente en vez de inventarlo.
- Equipos y ecosistemas de alarmas (Ajax, Jablotron, Visonic, Risco, Paradox, DSC, Honeywell): fiabilidad, cobertura, servicio técnico, grados de seguridad EN 50131.
- Comparativa de competencia en el sector de alarmas en España (Verisure, Sector Alarm, Sicor, Segurma, ADT, Seguridad 3D, Grupo Control, Trablisa, MPA/Prosegur): precios, permanencia, valoraciones y posicionamiento.

Cuando el agente te indique un motivo de baja de un cliente (por botón rápido o en texto libre), responde SIEMPRE con exactamente 5 argumentos de valor, numerados del 1 al 5, listos para usar tal cual en la llamada. Cada argumento debe:
- Ser específico para ese motivo concreto, no genérico ni intercambiable con otros motivos.
- Ser profesional y empático, nunca agresivo ni manipulador: se trata de mostrar valor real, no de presionar.
- Incluir una frase o guion orientativo entre comillas que el agente pueda decir casi textualmente al cliente.
- Tener 2-4 frases de desarrollo (motivo psicológico o argumento de fondo + la frase de guion), no una línea suelta.
Cierra la respuesta con una recomendación breve de siguiente paso u oferta concreta a proponer, salvo que el motivo sea sensible (ver abajo).

Para motivos especialmente sensibles -fallecimiento del titular, separación o divorcio, problemas económicos graves- prioriza siempre la empatía y el trato correcto por encima de la insistencia comercial: en esos casos los "argumentos de valor" deben incluir opciones legítimas (cambio de titularidad, pausa temporal del servicio, plan reducido, baja sin penalización cuando proceda) en vez de presión para que no se dé de baja.

Para el resto de preguntas (normativa, equipos, comparativa de competencia, precios) responde de forma clara, concisa y práctica, con listas cuando ayude a la claridad. Si te preguntan algo fuera de tu ámbito (alarmas, seguridad, retención de clientes de este sector), indícalo brevemente y redirige la conversación. Responde siempre en español. No inventes precios, normativas o datos concretos que no conozcas con certeza.`;

/* ================================================================
   Utilidades HTTP basicas
   ================================================================ */

function enviarJSON(res, status, cuerpo, cabecerasExtra) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...cabecerasExtra });
  res.end(JSON.stringify(cuerpo));
}

function leerCuerpoJSON(req) {
  return new Promise((resolve, reject) => {
    let datos = "";
    req.on("data", (chunk) => {
      datos += chunk;
      if (datos.length > 1e6) {
        reject(new Error("Cuerpo de la petición demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(datos ? JSON.parse(datos) : {});
      } catch (e) {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

function servirArchivo(res, rutaAbsoluta, tipo, cabecerasExtra) {
  fs.readFile(rutaAbsoluta, (err, contenido) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("No se pudo leer " + path.basename(rutaAbsoluta) + ": " + err.message);
      return;
    }
    res.writeHead(200, { "Content-Type": tipo, ...cabecerasExtra });
    res.end(contenido);
  });
}

function redirigir(res, ubicacion) {
  res.writeHead(302, { Location: ubicacion });
  res.end();
}

/* ================================================================
   Sesion: helper para exigir autenticacion en una ruta de API
   ================================================================ */

// Comprueba la sesion y responde 401/403 si no procede. Devuelve la sesion
// ({usuario, jti}) o null (y ya ha respondido) si no se puede continuar.
function exigirSesion(req, res, { permitirCambioPendiente = false, roles = null } = {}) {
  const sesion = auth.usuarioDesdePeticion(req);
  if (!sesion) {
    enviarJSON(res, 401, { error: "No autenticado.", code: "NO_AUTENTICADO" });
    return null;
  }
  if (sesion.usuario.must_change_password && !permitirCambioPendiente) {
    enviarJSON(res, 403, {
      error: "Debes cambiar tu contraseña temporal antes de continuar.",
      code: "DEBE_CAMBIAR_PASSWORD",
    });
    return null;
  }
  if (roles && !roles.includes(sesion.usuario.role)) {
    enviarJSON(res, 403, { error: "No tienes permiso para esta acción.", code: "SIN_PERMISO" });
    return null;
  }
  return sesion;
}

function usuarioPublico(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at,
    approvedAt: u.approved_at,
  };
}

/* ================================================================
   Paginas HTML: gate de autenticacion para "/" y "/admin"
   ================================================================ */

function servirLogin(res) {
  servirArchivo(res, path.join(__dirname, "login.html"), "text/html; charset=utf-8", {
    "Cache-Control": "no-cache",
  });
}

function servirApp(req, res) {
  const sesion = auth.usuarioDesdePeticion(req);
  if (!sesion || sesion.usuario.must_change_password) {
    servirLogin(res);
    return;
  }
  servirArchivo(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8", {
    "Cache-Control": "no-cache",
  });
}

function servirAdmin(req, res) {
  const sesion = auth.usuarioDesdePeticion(req);
  if (!sesion || sesion.usuario.must_change_password) {
    redirigir(res, "/");
    return;
  }
  if (sesion.usuario.role !== auth.ROLES.SUPER_ADMIN) {
    redirigir(res, "/");
    return;
  }
  servirArchivo(res, path.join(__dirname, "admin.html"), "text/html; charset=utf-8", {
    "Cache-Control": "no-cache",
  });
}

/* ================================================================
   API: autenticacion
   ================================================================ */

async function apiRequestAccess(req, res) {
  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const email = auth.normalizarEmail(cuerpo.email);
  const name = typeof cuerpo.name === "string" ? cuerpo.name.trim().slice(0, 120) : "";
  const message = typeof cuerpo.message === "string" ? cuerpo.message.trim().slice(0, 500) : "";

  if (!auth.esCorreoPermitido(email)) {
    return enviarJSON(res, 400, {
      error: `Solo se admiten correos @${auth.DOMINIO_PERMITIDO}.`,
    });
  }

  const usuarioExistente = db.buscarUsuarioPorEmail(email);
  if (usuarioExistente && usuarioExistente.status === "active") {
    return enviarJSON(res, 200, {
      mensaje: "Ya existe una cuenta activa con ese correo. Si no puedes entrar, contacta con el administrador.",
    });
  }
  if (usuarioExistente && usuarioExistente.status === "pending") {
    return enviarJSON(res, 200, {
      mensaje: "Tu cuenta ya está pendiente de aprobación por un administrador.",
    });
  }

  const solicitudPendiente = db.solicitudPendientePorEmail(email);
  if (solicitudPendiente) {
    return enviarJSON(res, 200, {
      mensaje: "Ya existe una solicitud de acceso pendiente para ese correo.",
    });
  }

  db.crearSolicitudAcceso({ email, name, message });
  return enviarJSON(res, 200, {
    mensaje: "Solicitud enviada. Un administrador la revisará y te asignará una clave temporal.",
  });
}

async function apiLogin(req, res) {
  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const email = auth.normalizarEmail(cuerpo.email);
  const password = typeof cuerpo.password === "string" ? cuerpo.password : "";

  if (!auth.esCorreoPermitido(email) || !password) {
    return enviarJSON(res, 400, { error: "Correo o contraseña inválidos." });
  }

  const usuario = db.buscarUsuarioPorEmail(email);
  const ERROR_GENERICO = { error: "Correo o contraseña incorrectos.", code: "CREDENCIALES_INVALIDAS" };

  if (!usuario) return enviarJSON(res, 401, ERROR_GENERICO);

  if (usuario.status === "pending") {
    return enviarJSON(res, 403, {
      error: "Tu solicitud de acceso todavía está pendiente de aprobación.",
      code: "PENDIENTE_APROBACION",
    });
  }
  if (usuario.status === "disabled") {
    return enviarJSON(res, 403, {
      error: "Tu cuenta está desactivada. Contacta con el administrador.",
      code: "CUENTA_DESACTIVADA",
    });
  }

  if (usuario.locked_until && new Date(usuario.locked_until) > new Date()) {
    return enviarJSON(res, 423, {
      error: "Cuenta bloqueada temporalmente por demasiados intentos fallidos. Inténtalo de nuevo en unos minutos.",
      code: "CUENTA_BLOQUEADA",
    });
  }

  if (!auth.verificarPassword(password, usuario.password_hash)) {
    db.registrarIntentoFallido(usuario.id);
    return enviarJSON(res, 401, ERROR_GENERICO);
  }

  db.limpiarIntentosFallidos(usuario.id);
  const { token } = auth.crearSesionParaUsuario(req, usuario);

  enviarJSON(res, 200, { usuario: usuarioPublico(usuario) }, {
    "Set-Cookie": auth.cookieSesion(req, token),
  });
}

async function apiMe(req, res) {
  const sesion = auth.usuarioDesdePeticion(req);
  if (!sesion) return enviarJSON(res, 401, { error: "No autenticado." });
  enviarJSON(res, 200, { usuario: usuarioPublico(sesion.usuario) });
}

async function apiLogout(req, res) {
  const sesion = auth.usuarioDesdePeticion(req);
  if (sesion) auth.cerrarSesion(sesion.jti);
  enviarJSON(res, 200, { ok: true }, { "Set-Cookie": auth.cookieBorrarSesion(req) });
}

async function apiChangePassword(req, res) {
  const sesion = exigirSesion(req, res, { permitirCambioPendiente: true });
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const actual = typeof cuerpo.currentPassword === "string" ? cuerpo.currentPassword : "";
  const nueva = typeof cuerpo.newPassword === "string" ? cuerpo.newPassword : "";

  if (!auth.verificarPassword(actual, sesion.usuario.password_hash)) {
    return enviarJSON(res, 401, { error: "La contraseña actual no es correcta." });
  }
  const errorPolitica = auth.validarPolitica(nueva);
  if (errorPolitica) return enviarJSON(res, 400, { error: errorPolitica });
  if (nueva === actual) {
    return enviarJSON(res, 400, { error: "La nueva contraseña debe ser distinta de la actual." });
  }

  db.actualizarPassword(sesion.usuario.id, auth.hashearPassword(nueva), { mustChangePassword: false });

  // Se rota la sesion (nuevo jti) por higiene tras un cambio de contrasena;
  // las demas sesiones abiertas en otros dispositivos quedan revocadas.
  db.revocarSesionesDeUsuario(sesion.usuario.id);
  const usuarioActualizado = db.buscarUsuarioPorId(sesion.usuario.id);
  const { token } = auth.crearSesionParaUsuario(req, usuarioActualizado);

  enviarJSON(res, 200, { usuario: usuarioPublico(usuarioActualizado) }, {
    "Set-Cookie": auth.cookieSesion(req, token),
  });
}

/* ================================================================
   API: panel de administracion (solo Super Admin)
   ================================================================ */

async function apiAdminUsers(req, res) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;
  enviarJSON(res, 200, { usuarios: db.listarUsuarios().map(usuarioPublico) });
}

async function apiAdminRequests(req, res, query) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;
  const status = query.get("status");
  enviarJSON(res, 200, { solicitudes: db.listarSolicitudes(status || undefined) });
}

async function apiAdminApproveRequest(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  const solicitud = db.buscarSolicitudPorId(id);
  if (!solicitud || solicitud.status !== "pending") {
    return enviarJSON(res, 404, { error: "Solicitud no encontrada o ya resuelta." });
  }

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const role = cuerpo.role;
  if (!auth.esRolValido(role)) {
    return enviarJSON(res, 400, { error: "Rol inválido. Usa super_admin, admin o retencion." });
  }

  // Un usuario que fue desactivado (p.ej. bajó del equipo y vuelve a pedir
  // acceso) sigue teniendo su fila en `users` con ese correo. Antes esto
  // bloqueaba la aprobación con un 409 y la solicitud se quedaba "pending"
  // para siempre sin forma de resolverla desde aquí: solo se rechaza si de
  // verdad hay una cuenta activa o pendiente con ese correo.
  const usuarioExistente = db.buscarUsuarioPorEmail(solicitud.email);
  if (usuarioExistente && usuarioExistente.status !== "disabled") {
    return enviarJSON(res, 409, { error: "Ya existe un usuario con ese correo." });
  }

  const tempPassword =
    typeof cuerpo.tempPassword === "string" && cuerpo.tempPassword.trim()
      ? cuerpo.tempPassword.trim()
      : auth.generarPasswordTemporal();
  const errorPolitica = auth.validarPolitica(tempPassword);
  if (errorPolitica) return enviarJSON(res, 400, { error: errorPolitica });

  let usuario;
  if (usuarioExistente) {
    db.actualizarRol(usuarioExistente.id, role);
    db.actualizarPassword(usuarioExistente.id, auth.hashearPassword(tempPassword), { mustChangePassword: true });
    db.actualizarEstado(usuarioExistente.id, "active");
    usuario = db.buscarUsuarioPorId(usuarioExistente.id);
  } else {
    usuario = db.crearUsuario({
      email: solicitud.email,
      name: solicitud.name,
      passwordHash: auth.hashearPassword(tempPassword),
      role,
      status: "active",
      mustChangePassword: true,
      approvedBy: sesion.usuario.id,
    });
  }
  db.resolverSolicitud(id, "approved", sesion.usuario.id);

  enviarJSON(res, 200, { usuario: usuarioPublico(usuario), tempPassword });
}

async function apiAdminRejectRequest(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  const solicitud = db.buscarSolicitudPorId(id);
  if (!solicitud || solicitud.status !== "pending") {
    return enviarJSON(res, 404, { error: "Solicitud no encontrada o ya resuelta." });
  }
  db.resolverSolicitud(id, "rejected", sesion.usuario.id);
  enviarJSON(res, 200, { ok: true });
}

function contarSuperAdminsActivos() {
  return db.listarUsuarios().filter((u) => u.role === auth.ROLES.SUPER_ADMIN && u.status === "active").length;
}

async function apiAdminSetRole(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  const objetivo = db.buscarUsuarioPorId(id);
  if (!objetivo) return enviarJSON(res, 404, { error: "Usuario no encontrado." });

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  if (!auth.esRolValido(cuerpo.role)) {
    return enviarJSON(res, 400, { error: "Rol inválido." });
  }

  if (objetivo.role === auth.ROLES.SUPER_ADMIN && cuerpo.role !== auth.ROLES.SUPER_ADMIN && contarSuperAdminsActivos() <= 1) {
    return enviarJSON(res, 400, { error: "No puedes quitar el rol de Super Admin al único Super Admin activo." });
  }

  db.actualizarRol(id, cuerpo.role);
  enviarJSON(res, 200, { usuario: usuarioPublico(db.buscarUsuarioPorId(id)) });
}

async function apiAdminSetStatus(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  const objetivo = db.buscarUsuarioPorId(id);
  if (!objetivo) return enviarJSON(res, 404, { error: "Usuario no encontrado." });

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  if (!["active", "disabled"].includes(cuerpo.status)) {
    return enviarJSON(res, 400, { error: "Estado inválido. Usa active o disabled." });
  }
  if (objetivo.id === sesion.usuario.id && cuerpo.status === "disabled") {
    return enviarJSON(res, 400, { error: "No puedes desactivar tu propia cuenta." });
  }
  if (
    objetivo.role === auth.ROLES.SUPER_ADMIN &&
    cuerpo.status === "disabled" &&
    contarSuperAdminsActivos() <= 1
  ) {
    return enviarJSON(res, 400, { error: "No puedes desactivar al único Super Admin activo." });
  }

  db.actualizarEstado(id, cuerpo.status);
  if (cuerpo.status === "disabled") db.revocarSesionesDeUsuario(id);
  enviarJSON(res, 200, { usuario: usuarioPublico(db.buscarUsuarioPorId(id)) });
}

async function apiAdminResetPassword(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  const objetivo = db.buscarUsuarioPorId(id);
  if (!objetivo) return enviarJSON(res, 404, { error: "Usuario no encontrado." });

  let cuerpo = {};
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const tempPassword =
    typeof cuerpo.tempPassword === "string" && cuerpo.tempPassword.trim()
      ? cuerpo.tempPassword.trim()
      : auth.generarPasswordTemporal();
  const errorPolitica = auth.validarPolitica(tempPassword);
  if (errorPolitica) return enviarJSON(res, 400, { error: errorPolitica });

  db.actualizarPassword(id, auth.hashearPassword(tempPassword), { mustChangePassword: true });
  db.revocarSesionesDeUsuario(id);

  enviarJSON(res, 200, { usuario: usuarioPublico(db.buscarUsuarioPorId(id)), tempPassword });
}

/* ================================================================
   API: chat con Claude (protegido por sesion)
   ================================================================ */

function sanearHistorial(mensajes) {
  if (!Array.isArray(mensajes)) return [];
  const limpio = mensajes
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_LONGITUD_MENSAJE),
    }));
  return limpio.slice(-MAX_TURNOS_HISTORIAL);
}

async function manejarChat(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const mensajes = sanearHistorial(cuerpo.messages);
  if (mensajes.length === 0 || mensajes[mensajes.length - 1].role !== "user") {
    return enviarJSON(res, 400, { error: "Falta el mensaje del usuario." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return enviarJSON(res, 500, {
      error: "El servidor no tiene configurada la variable de entorno ANTHROPIC_API_KEY.",
    });
  }

  try {
    const respuestaAnthropic = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1536,
        system: SYSTEM_PROMPT,
        messages: mensajes,
      }),
    });

    const datos = await respuestaAnthropic.json();

    if (!respuestaAnthropic.ok) {
      const mensajeError =
        (datos && datos.error && datos.error.message) ||
        `Error ${respuestaAnthropic.status} al llamar a la API de Anthropic.`;
      return enviarJSON(res, respuestaAnthropic.status, { error: mensajeError });
    }

    const texto = (datos.content || [])
      .filter((bloque) => bloque.type === "text")
      .map((bloque) => bloque.text)
      .join("\n")
      .trim();

    enviarJSON(res, 200, { reply: texto || "(Sin respuesta del modelo)" });
  } catch (e) {
    enviarJSON(res, 502, { error: "No se pudo contactar con la API de Anthropic: " + e.message });
  }
}

/* ================================================================
   API: analisis de contratos (protegido por sesion)
   ================================================================ */

const EXTENSIONES_ANALISIS_PERMITIDAS = new Set([
  ".pdf", ".doc", ".docx", ".odt", ".txt", ".jpg", ".jpeg", ".png",
]);
const MIMES_ANALISIS_PERMITIDOS = new Set([
  analisis.MIME_PDF,
  analisis.MIME_DOCX,
  analisis.MIME_DOC,
  analisis.MIME_ODT,
  analisis.MIME_TXT,
  ...analisis.MIMES_IMAGEN,
]);

const uploadAnalisis = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (MIMES_ANALISIS_PERMITIDOS.has(file.mimetype) || EXTENSIONES_ANALISIS_PERMITIDAS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Formato no admitido. Sube un PDF, un Word (.doc/.docx), un OpenDocument (.odt), un texto (.txt) o una imagen JPG/PNG."));
    }
  },
}).single("file");

function ejecutarMulter(req, res) {
  return new Promise((resolve, reject) => {
    uploadAnalisis(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

async function apiAnalisis(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  try {
    await ejecutarMulter(req, res);
  } catch (e) {
    const mensaje =
      e.code === "LIMIT_FILE_SIZE"
        ? "El archivo supera el tamaño máximo permitido (20 MB)."
        : e.message || "No se pudo procesar el archivo.";
    return enviarJSON(res, 400, { error: mensaje });
  }

  if (!req.file) {
    return enviarJSON(res, 400, { error: "No se ha recibido ningún archivo." });
  }

  try {
    const textoOriginal = await analisis.extraerTexto(req.file.buffer, req.file.mimetype, req.file.originalname);
    if (!textoOriginal || !textoOriginal.trim()) {
      return enviarJSON(res, 422, {
        error: "No se ha podido extraer texto legible del archivo. Comprueba que el documento no esté vacío, protegido o ilegible.",
      });
    }

    // Provincia y empresa se extraen del texto ORIGINAL (antes de anonimizar,
    // que sustituye justamente el CP y el nombre de la empresa) y son lo
    // unico que se guarda para la pestana Estadisticas: nunca el texto del
    // contrato ni ningun dato personal.
    const { provincia, empresa } = analisis.extraerProvinciaYEmpresa(textoOriginal);

    const { texto: textoAnonimizado, total: totalAnonimizado } = analisis.anonimizarTexto(textoOriginal);
    const { clausulas, puntuacionGlobal, nivel } = analisis.detectarClausulas(textoAnonimizado);

    db.registrarContratoAnalizado({
      provincia,
      empresa,
      puntuacion: puntuacionGlobal,
      clausulas: clausulas.map((c) => ({ id: c.id, label: c.label })),
      userId: sesion.usuario.id,
    });

    const resumen = {
      puntuacionGlobal,
      nivel,
      totalAnonimizado,
      clausulas: clausulas.map((c) => ({
        id: c.id,
        label: c.label,
        score: c.score,
        descripcion: c.descripcion,
        fragmento: c.fragmento,
      })),
    };
    const cabeceraResumen = Buffer.from(JSON.stringify(resumen), "utf-8").toString("base64");

    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="informe-analisis-uic.pdf"',
      "X-Analysis-Summary": cabeceraResumen,
      "Access-Control-Expose-Headers": "X-Analysis-Summary",
      "Cache-Control": "no-store",
    });

    const doc = analisis.generarInformePDF({
      clausulas,
      puntuacionGlobal,
      nivel,
      totalAnonimizado,
    });
    doc.pipe(res);
  } catch (e) {
    console.error("Error al analizar el contrato:", e);
    if (!res.headersSent) {
      if (e.ocrNoDisponible) {
        return enviarJSON(res, 503, { error: e.message });
      }
      enviarJSON(res, 500, { error: "No se pudo analizar el archivo: " + e.message });
    } else {
      res.end();
    }
  }
}

/* ================================================================
   API: empaquetar en ZIP los informes de un lote (protegido por sesion)
   ================================================================ */
//
// El frontend sube uno a uno hasta 20 archivos a /api/analisis (para poder
// mostrar una barra de progreso por archivo) y guarda los PDF resultantes en
// memoria del navegador; al terminar el lote envia aqui esos PDF ya
// generados (no los documentos originales) para que el servidor los
// comprima en un unico ZIP con JSZip, que ya es dependencia del proyecto
// para leer .odt.

const uploadInformesZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
}).array("files", 20);

function ejecutarMulterZip(req, res) {
  return new Promise((resolve, reject) => {
    uploadInformesZip(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

async function apiAnalisisZip(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  try {
    await ejecutarMulterZip(req, res);
  } catch (e) {
    const mensaje =
      e.code === "LIMIT_FILE_SIZE"
        ? "Uno de los informes supera el tamaño máximo permitido."
        : e.message || "No se pudo generar el ZIP.";
    return enviarJSON(res, 400, { error: mensaje });
  }

  if (!req.files || req.files.length === 0) {
    return enviarJSON(res, 400, { error: "No se ha recibido ningún informe para comprimir." });
  }

  try {
    const zip = new JSZip();
    const nombresUsados = new Set();
    req.files.forEach((f, i) => {
      let nombre = path.basename(f.originalname || `informe-${i + 1}.pdf`).replace(/[/\\]/g, "_");
      if (!/\.pdf$/i.test(nombre)) nombre += ".pdf";
      let candidato = nombre;
      let sufijo = 1;
      while (nombresUsados.has(candidato.toLowerCase())) {
        sufijo++;
        candidato = nombre.replace(/\.pdf$/i, `-${sufijo}.pdf`);
      }
      nombresUsados.add(candidato.toLowerCase());
      zip.file(candidato, f.buffer);
    });

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="informes-analisis-uic.zip"',
      "Cache-Control": "no-store",
    });
    res.end(zipBuffer);
  } catch (e) {
    console.error("Error generando el ZIP de informes:", e);
    if (!res.headersSent) enviarJSON(res, 500, { error: "No se pudo generar el ZIP de informes." });
  }
}

/* ================================================================
   API: analisis legal avanzado con IA (protegido por sesion)
   ================================================================ */

// Se dispara automaticamente desde el frontend justo despues de subir un
// contrato en la pestana "Analisis": extrae y anonimiza el texto igual que
// apiAnalisis, pero en vez de la deteccion de clausulas por patrones, envia
// el texto a Claude (analisis.analizarConIA) actuando como abogado experto
// en contratos de seguridad privada y derecho del consumidor español, y
// genera un informe PDF UIC con la explicacion clausula por clausula.
async function apiAnalisisAvanzado(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  try {
    await ejecutarMulter(req, res);
  } catch (e) {
    const mensaje =
      e.code === "LIMIT_FILE_SIZE"
        ? "El archivo supera el tamaño máximo permitido (20 MB)."
        : e.message || "No se pudo procesar el archivo.";
    return enviarJSON(res, 400, { error: mensaje });
  }

  if (!req.file) {
    return enviarJSON(res, 400, { error: "No se ha recibido ningún archivo." });
  }

  try {
    const textoOriginal = await analisis.extraerTexto(req.file.buffer, req.file.mimetype, req.file.originalname);
    if (!textoOriginal || !textoOriginal.trim()) {
      return enviarJSON(res, 422, {
        error: "No se ha podido extraer texto legible del archivo. Comprueba que el documento no esté vacío, protegido o ilegible.",
      });
    }

    const { texto: textoAnonimizado, total: totalAnonimizado } = analisis.anonimizarTexto(textoOriginal);
    const { resumenGeneral, puntuacionGlobal, nivelGlobal, clausulas } = await analisis.analizarConIA(textoAnonimizado);

    const resumen = { resumenGeneral, puntuacionGlobal, nivelGlobal, totalAnonimizado, clausulas };
    const cabeceraResumen = Buffer.from(JSON.stringify(resumen), "utf-8").toString("base64");

    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="informe-analisis-avanzado-uic.pdf"',
      "X-Analysis-Summary": cabeceraResumen,
      "Access-Control-Expose-Headers": "X-Analysis-Summary",
      "Cache-Control": "no-store",
    });

    const doc = analisis.generarInformePDFAvanzado({
      resumenGeneral,
      puntuacionGlobal,
      nivelGlobal,
      clausulas,
      totalAnonimizado,
    });
    doc.pipe(res);
  } catch (e) {
    console.error("Error en el análisis legal avanzado:", e);
    if (!res.headersSent) {
      if (e.ocrNoDisponible) {
        return enviarJSON(res, 503, { error: e.message });
      }
      if (e instanceof analisis.AnalisisAvanzadoError) {
        return enviarJSON(res, 502, { error: e.message });
      }
      enviarJSON(res, 500, { error: "No se pudo completar el análisis avanzado: " + e.message });
    } else {
      res.end();
    }
  }
}

/* ================================================================
   API: estadisticas internas (solo super_admin y admin)
   ================================================================ */
//
// Agrega datos que ya existen en la base de datos sin exponer nunca texto de
// contratos ni datos personales: contract_stats solo guarda provincia +
// empresa + puntuacion + clausulas detectadas (ver apiAnalisis), y
// tab_visits solo guarda que un usuario abrio una pestana. El rol retencion
// no tiene acceso a este endpoint (ademas de no ver la pestana en la UI).

const ROLES_ESTADISTICAS = [auth.ROLES.SUPER_ADMIN, auth.ROLES.ADMIN];

function calcularClausulasMasFrecuentes() {
  const conteo = {};
  db.listarClausulasContratos().forEach((fila) => {
    let lista;
    try {
      lista = JSON.parse(fila.clausulas_json);
    } catch (e) {
      return;
    }
    if (!Array.isArray(lista)) return;
    lista.forEach((c) => {
      if (!c || !c.id) return;
      if (!conteo[c.id]) conteo[c.id] = { id: c.id, label: c.label || c.id, count: 0 };
      conteo[c.id].count++;
    });
  });
  return Object.values(conteo).sort((a, b) => b.count - a.count);
}

async function apiEstadisticas(req, res) {
  const sesion = exigirSesion(req, res, { roles: ROLES_ESTADISTICAS });
  if (!sesion) return;

  const clausulas = calcularClausulasMasFrecuentes();
  const riesgoPromedio = db.riesgoPromedioContratos();

  const provincias = db.estadisticasPorProvincia().map((f) => ({
    provincia: f.provincia,
    empresaDominante: f.empresa,
    total: f.n,
  }));

  const visitasPorUsuario = {};
  db.conteoVisitasPorUsuarioYTab().forEach((v) => {
    if (!visitasPorUsuario[v.user_id]) visitasPorUsuario[v.user_id] = [];
    visitasPorUsuario[v.user_id].push({ tab: v.tab, count: v.n });
  });

  const actividad = db.actividadUsuariosActivos().map((u) => ({
    email: u.email,
    name: u.name,
    role: u.role,
    ultimaConexion: u.ultima_conexion,
    pestanasTop: (visitasPorUsuario[u.id] || []).sort((a, b) => b.count - a.count).slice(0, 3),
  }));

  enviarJSON(res, 200, {
    resumen: {
      totalContratos: db.contarContratosAnalizados(),
      riesgoPromedio,
      clausulaMasFrecuente: clausulas[0] || null,
      usuariosActivos: db.contarUsuariosActivos(),
    },
    provincias,
    clausulas,
    actividad,
  });
}

// Se llama desde el frontend cada vez que se activa una pestana (cualquier
// rol autenticado, no solo super_admin/admin: la idea es medir el uso real
// del equipo completo, aunque solo super_admin/admin puedan luego consultar
// el agregado en /api/estadisticas).
async function apiActividadTab(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const tab = typeof cuerpo.tab === "string" ? cuerpo.tab.trim().slice(0, 60) : "";
  if (!tab) return enviarJSON(res, 400, { error: "Falta la pestaña visitada." });

  db.registrarVisitaTab({ userId: sesion.usuario.id, tab });
  enviarJSON(res, 200, { ok: true });
}

/* ================================================================
   API: alianzas entre empresas de alarmas y otros sectores
   ================================================================ */
//
// Flujo: un script externo (scraper_alianzas.py, pensado para ejecutarse a
// diario en una Raspberry Pi) detecta acuerdos en Google News y webs
// oficiales y los envia a POST /api/alianzas/sync protegido por un secreto
// compartido (SCRAPER_TOKEN), no por sesion de usuario, porque quien llama
// no es un navegador con cookie. Cada alianza nueva entra como 'pending':
// solo el Super Admin la ve (con botones Publicar/Descartar) hasta que la
// aprueba explicitamente; el resto de roles solo ve las que ya estan
// 'published'. Publicar/Descartar si exige sesion de Super Admin.

const SECTORES_ALIANZA = new Set([
  "Móviles",
  "Grandes superficies",
  "Seguros",
  "Inmobiliarias",
  "Suministros (luz, gas, agua)",
]);
const MAX_ALIANZAS_POR_SYNC = 200;

async function apiAlianzasGet(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  const respuesta = {
    publicadas: db.listarAlianzasPorEstado("published"),
    actualizado: db.fechaUltimaAlianza(),
  };
  if (sesion.usuario.role === auth.ROLES.SUPER_ADMIN) {
    respuesta.pendientes = db.listarAlianzasPorEstado("pending");
  }
  enviarJSON(res, 200, respuesta);
}

async function apiAlianzasResolver(req, res, id, status) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  const alianza = db.buscarAlianzaPorId(id);
  if (!alianza) return enviarJSON(res, 404, { error: "Alianza no encontrada." });
  if (alianza.status !== "pending") {
    return enviarJSON(res, 409, { error: "Esta alianza ya ha sido revisada." });
  }

  db.resolverAlianza(id, status, sesion.usuario.id);
  enviarJSON(res, 200, { ok: true });
}

function alianzaValida(a) {
  return (
    a &&
    typeof a.externalId === "string" &&
    a.externalId.trim() &&
    typeof a.empresaAlarma === "string" &&
    a.empresaAlarma.trim() &&
    typeof a.sector === "string" &&
    SECTORES_ALIANZA.has(a.sector) &&
    typeof a.socio === "string" &&
    a.socio.trim()
  );
}

async function apiAlianzasSync(req, res) {
  const tokenEsperado = process.env.SCRAPER_TOKEN;
  if (!tokenEsperado) {
    return enviarJSON(res, 503, {
      error: "El servidor no tiene configurada la variable de entorno SCRAPER_TOKEN.",
    });
  }
  const tokenRecibido = req.headers["x-scraper-token"];
  if (tokenRecibido !== tokenEsperado) {
    return enviarJSON(res, 401, { error: "Token de scraper inválido." });
  }

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const lista = Array.isArray(cuerpo.alianzas) ? cuerpo.alianzas : [];
  if (lista.length === 0) {
    return enviarJSON(res, 200, { insertadas: 0, mensaje: "Sin alianzas nuevas que sincronizar." });
  }
  if (lista.length > MAX_ALIANZAS_POR_SYNC) {
    return enviarJSON(res, 400, { error: `Demasiadas alianzas en una sola sincronización (máximo ${MAX_ALIANZAS_POR_SYNC}).` });
  }

  const validas = lista.filter(alianzaValida);
  if (validas.length === 0) {
    return enviarJSON(res, 400, { error: "Ninguna alianza del envío tiene un formato válido." });
  }

  const insertadas = db.insertarAlianzasPendientes(validas);
  enviarJSON(res, 200, { insertadas, recibidas: lista.length, validas: validas.length });
}

/* ================================================================
   Estaticos de la PWA
   ================================================================ */

const TIPOS_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// Solo estos archivos son publicos: evita exponer server.js, .git, la base
// de datos, etc.
const ESTATICOS_PERMITIDOS = new Set([
  "/manifest.json",
  "/sw.js",
  "/icons/icon-32.png",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-192-maskable.png",
  "/icons/icon-512-maskable.png",
]);

function servirEstatico(rutaUrl, res) {
  const rutaArchivo = path.join(__dirname, rutaUrl);

  if (!rutaArchivo.startsWith(__dirname + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Prohibido");
    return;
  }

  const cabeceras = {
    "Content-Type": TIPOS_MIME[path.extname(rutaArchivo).toLowerCase()] || "application/octet-stream",
  };
  if (rutaUrl === "/sw.js") {
    cabeceras["Cache-Control"] = "no-cache, no-store, must-revalidate";
    cabeceras["Service-Worker-Allowed"] = "/";
  } else {
    cabeceras["Cache-Control"] = "no-cache";
  }

  fs.readFile(rutaArchivo, (err, contenido) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("No encontrado");
      return;
    }
    res.writeHead(200, cabeceras);
    res.end(contenido);
  });
}

/* ================================================================
   Router
   ================================================================ */

const RUTA_CON_ID = (prefijo, sufijo) => {
  const re = new RegExp(`^${prefijo}/(\\d+)${sufijo}$`);
  return (ruta) => {
    const m = ruta.match(re);
    return m ? Number(m[1]) : null;
  };
};

const idAprobarSolicitud = RUTA_CON_ID("/api/admin/requests", "/approve");
const idRechazarSolicitud = RUTA_CON_ID("/api/admin/requests", "/reject");
const idRolUsuario = RUTA_CON_ID("/api/admin/users", "/role");
const idEstadoUsuario = RUTA_CON_ID("/api/admin/users", "/status");
const idResetPasswordUsuario = RUTA_CON_ID("/api/admin/users", "/reset-password");
const idPublicarAlianza = RUTA_CON_ID("/api/alianzas", "/publicar");
const idDescartarAlianza = RUTA_CON_ID("/api/alianzas", "/descartar");

async function manejarPeticion(req, res) {
  // Todo el cuerpo va dentro del try, incluido el parseo de la URL (una ruta
  // mal formada puede hacer que decodeURIComponent lance) y cada `await` a
  // un handler: como estos handlers son async, un `return handler(...)` sin
  // await deja el catch de abajo sin posibilidad de capturar un rechazo que
  // llegue mas tarde (la promesa se devuelve tal cual, fuera del alcance del
  // try/catch) y la peticion se queda colgada -o, peor, tumba el proceso
  // entero por una unhandledRejection- en vez de responder con un 500.
  try {
    const url = new URL(req.url, "http://localhost");
    const ruta = decodeURIComponent(url.pathname);
    const esLectura = req.method === "GET" || req.method === "HEAD";

    if (esLectura && (ruta === "/" || ruta === "/index.html")) return await servirApp(req, res);
    if (esLectura && ruta === "/admin") return await servirAdmin(req, res);
    if (esLectura && ruta === "/login.html") return await servirLogin(res);

    if (req.method === "POST" && ruta === "/api/auth/request-access") return await apiRequestAccess(req, res);
    if (req.method === "POST" && ruta === "/api/auth/login") return await apiLogin(req, res);
    if (req.method === "POST" && ruta === "/api/auth/logout") return await apiLogout(req, res);
    if (req.method === "POST" && ruta === "/api/auth/change-password") return await apiChangePassword(req, res);
    if (req.method === "GET" && ruta === "/api/auth/me") return await apiMe(req, res);

    if (req.method === "GET" && ruta === "/api/admin/users") return await apiAdminUsers(req, res);
    if (req.method === "GET" && ruta === "/api/admin/requests") return await apiAdminRequests(req, res, url.searchParams);

    if (req.method === "POST") {
      let id = idAprobarSolicitud(ruta);
      if (id !== null) return await apiAdminApproveRequest(req, res, id);
      id = idRechazarSolicitud(ruta);
      if (id !== null) return await apiAdminRejectRequest(req, res, id);
      id = idRolUsuario(ruta);
      if (id !== null) return await apiAdminSetRole(req, res, id);
      id = idEstadoUsuario(ruta);
      if (id !== null) return await apiAdminSetStatus(req, res, id);
      id = idResetPasswordUsuario(ruta);
      if (id !== null) return await apiAdminResetPassword(req, res, id);
    }

    if (req.method === "POST" && ruta === "/api/chat") return await manejarChat(req, res);
    if (req.method === "POST" && ruta === "/api/analisis") return await apiAnalisis(req, res);
    if (req.method === "POST" && ruta === "/api/analisis/zip") return await apiAnalisisZip(req, res);
    if (req.method === "POST" && ruta === "/api/analisis-avanzado") return await apiAnalisisAvanzado(req, res);

    if (req.method === "GET" && ruta === "/api/estadisticas") return await apiEstadisticas(req, res);
    if (req.method === "POST" && ruta === "/api/actividad/tab") return await apiActividadTab(req, res);

    if (req.method === "GET" && ruta === "/api/alianzas") return await apiAlianzasGet(req, res);
    if (req.method === "POST" && ruta === "/api/alianzas/sync") return await apiAlianzasSync(req, res);
    if (req.method === "POST") {
      let id = idPublicarAlianza(ruta);
      if (id !== null) return await apiAlianzasResolver(req, res, id, "published");
      id = idDescartarAlianza(ruta);
      if (id !== null) return await apiAlianzasResolver(req, res, id, "discarded");
    }

    if (esLectura && ESTATICOS_PERMITIDOS.has(ruta)) return await servirEstatico(ruta, res);

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No encontrado");
  } catch (e) {
    console.error("Error no controlado:", e);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Error interno del servidor." }));
    }
  }
}

/* ================================================================
   Arranque
   ================================================================ */

const seed = auth.asegurarSuperAdmin();
db.limpiarSesionesCaducadas();

let servidor;
const certFile = process.env.HTTPS_CERT_FILE;
const keyFile = process.env.HTTPS_KEY_FILE;

if (certFile && keyFile) {
  servidor = https.createServer(
    { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
    manejarPeticion
  );
} else {
  servidor = http.createServer(manejarPeticion);
}

servidor.listen(PORT, () => {
  const protocolo = certFile && keyFile ? "https" : "http";
  console.log(`SegurPanel escuchando en ${protocolo}://localhost:${PORT}/`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "AVISO: ANTHROPIC_API_KEY no está configurada. El IA Assistant no podrá responder hasta que la definas (setx ANTHROPIC_API_KEY \"sk-ant-...\") y reinicies este servidor."
    );
  }

  if (!process.env.SCRAPER_TOKEN) {
    console.warn(
      "AVISO: SCRAPER_TOKEN no está configurada. POST /api/alianzas/sync (usado por scraper_alianzas.py en la Raspberry Pi) rechazará todas las peticiones hasta que la definas."
    );
  }

  if (process.env.NODE_ENV === "production" && protocolo === "http") {
    console.warn(
      "AVISO: NODE_ENV=production sin HTTPS_CERT_FILE/HTTPS_KEY_FILE configurados. " +
        "En producción sirve SegurPanel detrás de HTTPS (certificados propios o un proxy inverso como Nginx/Caddy que termine TLS)."
    );
  }

  if (seed) {
    console.log("\n============================================================");
    console.log(" Super Admin inicial creado");
    console.log(` Correo:         ${seed.email}`);
    console.log(` Clave temporal: ${seed.passwordTemporal}`);
    console.log(` (guardada también en ${seed.rutaAviso}; bórrala tras usarla)`);
    console.log(" Se pedirá cambiarla en el primer inicio de sesión.");
    console.log("============================================================\n");
  }
});
