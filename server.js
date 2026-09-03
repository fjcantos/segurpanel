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
const db = require("./db");
const auth = require("./auth");

const PORT = process.env.PORT || 3000;
const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TURNOS_HISTORIAL = 12; // limita el contexto que se reenvia a la API
const MAX_LONGITUD_MENSAJE = 4000;

const SYSTEM_PROMPT = `Eres el asistente virtual de SegurPanel, una herramienta de comparación de alarmas y seguridad para el mercado español.

Tu ámbito de conocimiento es exclusivamente:
- Sistemas de alarma y seguridad para el hogar/negocio.
- Normativa española aplicable (Ley 5/2014 de Seguridad Privada, RD 195/2023, normas técnicas UNE-EN 50131 intrusión y UNE-EN 50136 transmisión, y RGPD/LOPDGDD cuando el sistema trata datos personales como vídeo o biometría).
- Equipos y ecosistemas Ajax y Jablotron (centrales, sensores, autonomía de batería, grados de seguridad EN 50131, conectividad).
- Argumentos de retención de clientes de Verisure: cómo evaluar ofertas de permanencia, descuentos de retención, y cómo un cliente puede negociar su continuidad o su baja.
- Comparativa de competencia en el sector de alarmas en España (Verisure, Sector Alarm, Sicor, Segurma, ADT, Seguridad 3D, Grupo Control, Trablisa, MPA/Prosegur): precios, permanencia, valoraciones y posicionamiento.

Responde siempre en español, de forma clara, concisa y práctica (evita párrafos largos; usa listas cuando ayude a la claridad). Si te preguntan algo fuera de este ámbito, indícalo brevemente y redirige la conversación hacia lo que sí puedes ayudar. No inventes precios, normativas o datos concretos que no conozcas con certeza: si no tienes el dato exacto, dilo explícitamente en vez de inventarlo.`;

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

  if (db.buscarUsuarioPorEmail(solicitud.email)) {
    return enviarJSON(res, 409, { error: "Ya existe un usuario con ese correo." });
  }

  const tempPassword =
    typeof cuerpo.tempPassword === "string" && cuerpo.tempPassword.trim()
      ? cuerpo.tempPassword.trim()
      : auth.generarPasswordTemporal();
  const errorPolitica = auth.validarPolitica(tempPassword);
  if (errorPolitica) return enviarJSON(res, 400, { error: errorPolitica });

  const usuario = db.crearUsuario({
    email: solicitud.email,
    name: solicitud.name,
    passwordHash: auth.hashearPassword(tempPassword),
    role,
    status: "active",
    mustChangePassword: true,
    approvedBy: sesion.usuario.id,
  });
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
        max_tokens: 1024,
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

async function manejarPeticion(req, res) {
  const url = new URL(req.url, "http://localhost");
  const ruta = decodeURIComponent(url.pathname);
  const esLectura = req.method === "GET" || req.method === "HEAD";

  try {
    if (esLectura && (ruta === "/" || ruta === "/index.html")) return servirApp(req, res);
    if (esLectura && ruta === "/admin") return servirAdmin(req, res);
    if (esLectura && ruta === "/login.html") return servirLogin(res);

    if (req.method === "POST" && ruta === "/api/auth/request-access") return apiRequestAccess(req, res);
    if (req.method === "POST" && ruta === "/api/auth/login") return apiLogin(req, res);
    if (req.method === "POST" && ruta === "/api/auth/logout") return apiLogout(req, res);
    if (req.method === "POST" && ruta === "/api/auth/change-password") return apiChangePassword(req, res);
    if (req.method === "GET" && ruta === "/api/auth/me") return apiMe(req, res);

    if (req.method === "GET" && ruta === "/api/admin/users") return apiAdminUsers(req, res);
    if (req.method === "GET" && ruta === "/api/admin/requests") return apiAdminRequests(req, res, url.searchParams);

    if (req.method === "POST") {
      let id = idAprobarSolicitud(ruta);
      if (id !== null) return apiAdminApproveRequest(req, res, id);
      id = idRechazarSolicitud(ruta);
      if (id !== null) return apiAdminRejectRequest(req, res, id);
      id = idRolUsuario(ruta);
      if (id !== null) return apiAdminSetRole(req, res, id);
      id = idEstadoUsuario(ruta);
      if (id !== null) return apiAdminSetStatus(req, res, id);
      id = idResetPasswordUsuario(ruta);
      if (id !== null) return apiAdminResetPassword(req, res, id);
    }

    if (req.method === "POST" && ruta === "/api/chat") return manejarChat(req, res);

    if (esLectura && ESTATICOS_PERMITIDOS.has(ruta)) return servirEstatico(ruta, res);

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
