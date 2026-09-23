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
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const JSZip = require("jszip");
const ExcelJS = require("exceljs");
const officeCrypto = require("officecrypto-tool");
const PDFDocument = require("pdfkit");
const db = require("./db");
const auth = require("./auth");
const analisis = require("./analisis");
const push = require("./push");
const email = require("./email");
const backup = require("./backup");
const reportes = require("./reportes");
const formaciones = require("./formaciones");

// Carpeta donde se guarda una copia permanente del PDF de cada analisis
// avanzado completado (ver apiAnalisisAvanzado), para que el Repositorio
// pueda ofrecer descargarlo tal cual se genero en su momento sin tener que
// reconstruirlo. Cuelga de DIR_DATOS (== DATA_DIR en Render, ./data en
// local), el mismo directorio persistente que ya usa la base de datos y los
// backups (ver db.js/backup.js), asi que sobrevive a los despliegues.
const DIR_INFORMES = path.join(db.DIR_DATOS, "informes");
fs.mkdirSync(DIR_INFORMES, { recursive: true });

function rutaInformeAvanzado(id) {
  return path.join(DIR_INFORMES, `analisis-avanzado-${id}.pdf`);
}

// Vacia DIR_INFORMES por completo: se usa junto con db.borrarAnalisisAvanzado()
// (que borra TODAS las filas de contratos_avanzados de golpe, sin id a id),
// tanto en el reseteo global de datos de prueba como en el reseteo por
// pestaña, para no dejar en disco PDFs huerfanos de analisis ya borrados de
// la base de datos.
function borrarInformesGuardados() {
  fs.rmSync(DIR_INFORMES, { recursive: true, force: true });
  fs.mkdirSync(DIR_INFORMES, { recursive: true });
}

const PORT = process.env.PORT || 3000;
// Base publica de la app, usada para construir enlaces absolutos en emails
// (aviso de nueva solicitud de acceso, enlace de recuperacion de
// contraseña). Orden de preferencia:
//   1. APP_URL / BASE_URL: configuracion manual explicita (cualquiera de
//      los dos nombres, por si el proveedor de hosting o quien despliega usa
//      uno u otro).
//   2. RENDER_EXTERNAL_URL: Render la define automaticamente en todo
//      servicio web con la URL publica real (p.ej.
//      https://segurpanel.onrender.com) sin necesidad de configurar nada;
//      sirve de deteccion automatica en produccion sin depender de que
//      alguien recuerde fijar APP_URL a mano.
//   3. http://localhost:PORT: uso local, unico caso en el que no hay URL
//      publica real.
const APP_URL = (
  process.env.APP_URL ||
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`
).replace(/\/+$/, "");
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

// Cuenta, por usuario y en memoria, los intentos SEGUIDOS de acceder a una
// accion/pestaña para la que su rol no tiene permiso (rama SIN_PERMISO de
// abajo). Un contador en memoria (no en base de datos) es suficiente porque
// es una señal en tiempo real de alguien "probando puertas": una peticion
// PERMITIDA de por medio corta la racha (se borra la entrada del Map), y un
// reinicio del servidor tambien la corta, lo cual es aceptable para este
// proposito. Al superar UMBRAL_ACTIVIDAD_SOSPECHOSA intentos seguidos se
// avisa por email a todo super_admin activo y se reinicia el contador, para
// no enviar un email por cada intento siguiente mientras la racha continua.
const UMBRAL_ACTIVIDAD_SOSPECHOSA = 3;
const contadoresPermisoDenegado = new Map();

function notificarActividadSospechosaSegura(usuario, req, ip, intentos) {
  const ruta = `${req.method} ${req.url}`;
  const destinatarios = db.listarSuperAdminsActivos().map((u) => u.email).filter(Boolean);
  email
    .enviarEmailActividadSospechosa({ usuario, ruta, intentos, ip, destinatarios })
    .catch((e) => console.error("Error enviando email de actividad sospechosa:", e));

  registrarAuditoriaSegura({
    userId: usuario.id,
    email: usuario.email,
    action: "actividad_sospechosa",
    detail: { ruta, intentos },
    ip,
  });
}

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
    const userId = sesion.usuario.id;
    const intentos = (contadoresPermisoDenegado.get(userId) || 0) + 1;
    if (intentos > UMBRAL_ACTIVIDAD_SOSPECHOSA) {
      contadoresPermisoDenegado.delete(userId);
      notificarActividadSospechosaSegura(sesion.usuario, req, obtenerIP(req), intentos);
    } else {
      contadoresPermisoDenegado.set(userId, intentos);
    }
    enviarJSON(res, 403, { error: "No tienes permiso para esta acción.", code: "SIN_PERMISO" });
    return null;
  }
  contadoresPermisoDenegado.delete(sesion.usuario.id);
  return sesion;
}

function obtenerIP(req) {
  // Detras de un proxy TLS (Render en produccion) req.socket.remoteAddress
  // es la IP del propio proxy para TODAS las peticiones, no la del cliente
  // real: eso inutilizaria el rate limiting por IP (ver
  // registrarIntentoFallidoIP/ipBloqueadaHasta en db.js), que agruparia a
  // todo el mundo bajo la misma IP. Mismo patron que esConexionSegura con
  // X-Forwarded-Proto: se respeta X-Forwarded-For si el proxy lo establece
  // (el primer valor de la lista es la IP original del cliente; el resto
  // son los proxies intermedios), y si no existe se cae al socket directo
  // (uso local, sin proxy delante).
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || null;
}

// Log de auditoria (panel de Super Admin): fire-and-forget, nunca debe
// romper el flujo que la origina (login, analisis, publicar alianza...).
function registrarAuditoriaSegura({ userId, email, action, detail, ip }) {
  try {
    db.registrarAuditoria({
      userId,
      email,
      action,
      detail: detail ? JSON.stringify(detail) : null,
      ip,
    });
  } catch (e) {
    console.error("Error registrando auditoría:", e);
  }
}

function usuarioPublico(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    mustChangePassword: !!u.must_change_password,
    canInstallApp: !!u.can_install_app,
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

// Fire-and-forget: la solicitud ya ha quedado guardada en access_requests
// (db.crearSolicitudAcceso) pase lo que pase con el email, asi que un fallo
// de envio nunca debe alterar la respuesta que ya recibio el solicitante.
function notificarSolicitudAccesoSegura({ correo, name, message }) {
  email
    .enviarEmailSolicitudAcceso({ correo, name, message, enlaceAdmin: `${APP_URL}/admin` })
    .catch((e) => console.error("Error enviando email de solicitud de acceso:", e));
}

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
  notificarSolicitudAccesoSegura({ correo: email, name, message });
  return enviarJSON(res, 200, {
    mensaje: "Solicitud enviada. Un administrador la revisará y te asignará una clave temporal.",
  });
}

/* ---------- Recuperacion de contraseña ("Olvidaste tu contraseña") ---------- */

// Fire-and-forget, igual que notificarSolicitudAccesoSegura: apiForgotPassword
// siempre responde el mismo mensaje generico, asi que un fallo de envio aqui
// nunca debe alterar esa respuesta.
function notificarRecuperacionSegura(usuario, enlace) {
  email
    .enviarEmailRecuperacion(usuario, enlace)
    .catch((e) => console.error("Error enviando email de recuperación de contraseña:", e));
}

// Responde SIEMPRE el mismo mensaje generico, exista o no esa cuenta y este
// activa o no: revelar la diferencia permitiria a un atacante enumerar
// correos validos. Solo si el usuario existe y esta activo se genera de
// verdad un token y se envia el email.
async function apiForgotPassword(req, res) {
  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const correo = auth.normalizarEmail(cuerpo.email);
  if (!auth.esCorreoPermitido(correo)) {
    return enviarJSON(res, 400, { error: `Solo se admiten correos @${auth.DOMINIO_PERMITIDO}.` });
  }

  const usuario = db.buscarUsuarioPorEmail(correo);
  if (usuario && usuario.status === "active") {
    const token = auth.generarTokenRecuperacion();
    db.crearTokenRecuperacion({ userId: usuario.id, tokenHash: auth.hashTokenRecuperacion(token) });
    const enlace = `${APP_URL}/reset-password?token=${token}`;
    notificarRecuperacionSegura(usuario, enlace);
    registrarAuditoriaSegura({
      userId: usuario.id,
      email: usuario.email,
      action: "solicitud_recuperacion_password",
      ip: obtenerIP(req),
    });
  }

  return enviarJSON(res, 200, {
    mensaje: "Si el correo está registrado y la cuenta está activa, te hemos enviado un enlace de recuperación. Caduca en 30 minutos.",
  });
}

// Comprobacion ligera para la pantalla de "nueva contraseña": permite
// avisar de un enlace caducado o ya usado ANTES de que el usuario rellene
// el formulario, sin gastar el token (eso solo ocurre en apiResetPassword).
async function apiValidateResetToken(req, res, query) {
  const token = query.get("token") || "";
  const registro = token ? db.buscarTokenRecuperacionVigente(auth.hashTokenRecuperacion(token)) : null;
  enviarJSON(res, 200, { valid: !!registro });
}

async function apiResetPassword(req, res) {
  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const token = typeof cuerpo.token === "string" ? cuerpo.token : "";
  const nueva = typeof cuerpo.newPassword === "string" ? cuerpo.newPassword : "";

  const registro = token ? db.buscarTokenRecuperacionVigente(auth.hashTokenRecuperacion(token)) : null;
  if (!registro) {
    return enviarJSON(res, 400, {
      error: "El enlace de recuperación no es válido o ha caducado. Solicita uno nuevo.",
      code: "TOKEN_INVALIDO",
    });
  }

  const errorPolitica = auth.validarPoliticaRecuperacion(nueva);
  if (errorPolitica) return enviarJSON(res, 400, { error: errorPolitica });

  const usuario = db.buscarUsuarioPorId(registro.user_id);
  if (!usuario || usuario.status !== "active") {
    return enviarJSON(res, 400, { error: "No se pudo restablecer la contraseña." });
  }

  // El token se marca usado ANTES de tocar la contraseña: si algo falla a
  // mitad de la escritura, es preferible que el enlace quede inservible (el
  // usuario pide uno nuevo) a que quede reutilizable indefinidamente.
  db.marcarTokenRecuperacionUsado(registro.id);
  db.actualizarPassword(usuario.id, auth.hashearPassword(nueva), { mustChangePassword: false });
  // Rota todas las sesiones abiertas de esta cuenta: si alguien mas tenia
  // acceso con la contraseña antigua (el motivo mas probable de este
  // restablecimiento), queda desconectado de inmediato.
  db.revocarSesionesDeUsuario(usuario.id);

  registrarAuditoriaSegura({
    userId: usuario.id,
    email: usuario.email,
    action: "password_restablecida",
    ip: obtenerIP(req),
  });

  enviarJSON(res, 200, { ok: true, mensaje: "Contraseña actualizada. Ya puedes iniciar sesión." });
}

// Registra un intento de login fallido contra la IP de origen (rate
// limiting independiente del bloqueo por cuenta de arriba) y, si eso
// dispara un bloqueo NUEVO (no si ya estaba bloqueada de un intento
// anterior en la misma racha), avisa por email a todo super_admin activo
// y deja constancia en el panel de auditoria.
function registrarFalloLoginIP(ip) {
  if (!ip) return;
  const resultado = db.registrarIntentoFallidoIP(ip);
  if (!resultado.bloqueada || resultado.yaAvisada) return;

  const destinatarios = db.listarSuperAdminsActivos().map((u) => u.email).filter(Boolean);
  email
    .enviarEmailIPBloqueada({
      ip,
      intentos: resultado.intentos,
      bloqueadaHasta: resultado.bloqueadaHasta,
      destinatarios,
    })
    .catch((e) => console.error("Error enviando email de aviso de IP bloqueada:", e));

  registrarAuditoriaSegura({
    userId: null,
    email: null,
    action: "ip_bloqueada",
    detail: { ip, intentos: resultado.intentos, bloqueadaHasta: resultado.bloqueadaHasta },
    ip,
  });
}

// Se llama justo ANTES de crear la sesion completa (auth.crearSesionParaUsuario),
// tanto si el login no necesita 2FA como tras superarlo, para que la sesion
// que se esta a punto de crear no cuente ella misma como "ya conocida" al
// comparar contra el historial en la tabla sessions (ver
// db.dispositivoConocidoDeUsuario). Fire-and-forget: nunca debe retrasar ni
// romper el login.
function notificarSiDispositivoNuevoSegura(req, usuario, ip) {
  try {
    const userAgent = (req.headers["user-agent"] || "").slice(0, 300);
    if (db.dispositivoConocidoDeUsuario(usuario.id, ip, userAgent)) return;

    const fecha = new Date();
    email
      .enviarEmailDispositivoNuevo({ usuario, ip, userAgent, fecha })
      .catch((e) => console.error("Error enviando email de dispositivo nuevo:", e));

    registrarAuditoriaSegura({
      userId: usuario.id,
      email: usuario.email,
      action: "login_dispositivo_nuevo",
      detail: { ip, userAgent },
      ip,
    });
  } catch (e) {
    console.error("Error comprobando dispositivo nuevo:", e);
  }
}

async function apiLogin(req, res) {
  const ip = obtenerIP(req);

  // Rate limiting por IP: se comprueba ANTES de leer/validar credenciales,
  // para no gastar ni un solo intento de verificacion de contraseña (ni
  // dar ninguna pista sobre si el correo existe) mientras la IP este
  // bloqueada.
  const bloqueadaHasta = db.ipBloqueadaHasta(ip);
  if (bloqueadaHasta) {
    return enviarJSON(res, 429, {
      error: "Demasiados intentos fallidos desde esta conexión. Inténtalo de nuevo más tarde.",
      code: "IP_BLOQUEADA",
      bloqueadaHasta,
    });
  }

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const correo = auth.normalizarEmail(cuerpo.email);
  const password = typeof cuerpo.password === "string" ? cuerpo.password : "";
  const recordar = !!cuerpo.recordar;

  if (!auth.esCorreoPermitido(correo) || !password) {
    return enviarJSON(res, 400, { error: "Correo o contraseña inválidos." });
  }

  const usuario = db.buscarUsuarioPorEmail(correo);
  const ERROR_GENERICO = { error: "Correo o contraseña incorrectos.", code: "CREDENCIALES_INVALIDAS" };

  if (!usuario) {
    registrarFalloLoginIP(ip);
    return enviarJSON(res, 401, ERROR_GENERICO);
  }

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
    registrarFalloLoginIP(ip);
    return enviarJSON(res, 401, ERROR_GENERICO);
  }

  db.limpiarIntentosFallidos(usuario.id);

  // Doble factor (2FA): solo super_admin/admin, y solo cuando el login ya
  // esta completo por lo demas (si tiene pendiente el cambio de la
  // contraseña temporal, ese flujo aparte termina de loguear en
  // apiChangePassword, no aqui).
  const necesita2FA =
    !usuario.must_change_password &&
    (usuario.role === auth.ROLES.SUPER_ADMIN || usuario.role === auth.ROLES.ADMIN);

  if (necesita2FA) {
    const codigo = auth.generarCodigo2FA();
    db.crearCodigo2FA({ userId: usuario.id, codeHash: auth.hashCodigo2FA(codigo) });

    const envio = await email.enviarEmailCodigo2FA(usuario, codigo);
    if (!envio.ok) {
      return enviarJSON(res, 503, {
        error: "No se pudo enviar el código de verificación por email. Inténtalo de nuevo en unos minutos.",
        code: "ERROR_ENVIO_2FA",
      });
    }

    return enviarJSON(res, 200, {
      requiresTwoFactor: true,
      pendingToken: auth.crearTokenPendiente2FA(usuario),
      email: usuario.email,
    });
  }

  notificarSiDispositivoNuevoSegura(req, usuario, ip);
  const { token } = auth.crearSesionParaUsuario(req, usuario, recordar);

  registrarAuditoriaSegura({
    userId: usuario.id,
    email: usuario.email,
    action: "login",
    ip,
  });

  enviarJSON(res, 200, { usuario: usuarioPublico(usuario) }, {
    "Set-Cookie": auth.cookieSesion(req, token, recordar),
  });
}

// Segundo paso del login para super_admin/admin: el codigo de 6 digitos
// enviado por email (ver apiLogin). pendingToken es el token de corta
// duracion devuelto por apiLogin, que demuestra que ya se paso el paso 1
// (contraseña correcta) para ese usuario concreto.
async function apiVerificar2FA(req, res) {
  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const pendingToken = typeof cuerpo.pendingToken === "string" ? cuerpo.pendingToken : "";
  const codigo = typeof cuerpo.code === "string" ? cuerpo.code.trim() : "";
  const recordar = !!cuerpo.recordar;

  const userId = auth.verificarTokenPendiente2FA(pendingToken);
  if (!userId) {
    return enviarJSON(res, 401, {
      error: "La verificación ha caducado o no es válida. Vuelve a iniciar sesión.",
      code: "PENDIENTE_2FA_INVALIDO",
    });
  }

  const usuario = db.buscarUsuarioPorId(userId);
  if (!usuario || usuario.status !== "active") {
    return enviarJSON(res, 401, { error: "No se pudo completar el inicio de sesión." });
  }

  const registro = db.buscarCodigo2FAVigente(userId);
  if (!registro) {
    return enviarJSON(res, 401, {
      error: "El código ha caducado. Pide que se reenvíe.",
      code: "CODIGO_2FA_CADUCADO",
    });
  }

  if (registro.attempts >= db.MAX_INTENTOS_CODIGO_2FA) {
    return enviarJSON(res, 401, {
      error: "Demasiados intentos con este código. Pide que se reenvíe.",
      code: "CODIGO_2FA_BLOQUEADO",
    });
  }

  if (!codigo || auth.hashCodigo2FA(codigo) !== registro.code_hash) {
    db.incrementarIntentosCodigo2FA(registro.id);
    return enviarJSON(res, 401, { error: "Código incorrecto.", code: "CODIGO_2FA_INCORRECTO" });
  }

  db.marcarCodigo2FAUsado(registro.id);
  const ip = obtenerIP(req);
  notificarSiDispositivoNuevoSegura(req, usuario, ip);
  const { token } = auth.crearSesionParaUsuario(req, usuario, recordar);

  registrarAuditoriaSegura({
    userId: usuario.id,
    email: usuario.email,
    action: "login",
    ip,
  });

  enviarJSON(res, 200, { usuario: usuarioPublico(usuario) }, {
    "Set-Cookie": auth.cookieSesion(req, token, recordar),
  });
}

// Reenvia el codigo de 2FA (por si el primero se pierde/tarda), invalidando
// el anterior. Mismo pendingToken que ya tiene la pantalla de verificacion.
async function apiReenviar2FA(req, res) {
  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const pendingToken = typeof cuerpo.pendingToken === "string" ? cuerpo.pendingToken : "";
  const userId = auth.verificarTokenPendiente2FA(pendingToken);
  if (!userId) {
    return enviarJSON(res, 401, {
      error: "La verificación ha caducado o no es válida. Vuelve a iniciar sesión.",
      code: "PENDIENTE_2FA_INVALIDO",
    });
  }

  const usuario = db.buscarUsuarioPorId(userId);
  if (!usuario || usuario.status !== "active") {
    return enviarJSON(res, 401, { error: "No se pudo reenviar el código." });
  }

  const codigo = auth.generarCodigo2FA();
  db.crearCodigo2FA({ userId: usuario.id, codeHash: auth.hashCodigo2FA(codigo) });

  const envio = await email.enviarEmailCodigo2FA(usuario, codigo);
  if (!envio.ok) {
    return enviarJSON(res, 503, { error: "No se pudo reenviar el código por email. Inténtalo de nuevo en unos minutos." });
  }
  enviarJSON(res, 200, { ok: true });
}

async function apiMe(req, res) {
  const sesion = auth.usuarioDesdePeticion(req);
  if (!sesion) return enviarJSON(res, 401, { error: "No autenticado." });
  enviarJSON(res, 200, { usuario: usuarioPublico(sesion.usuario) });
}

async function apiLogout(req, res) {
  const sesion = auth.usuarioDesdePeticion(req);
  if (sesion) {
    auth.cerrarSesion(sesion.jti);
    registrarAuditoriaSegura({
      userId: sesion.usuario.id,
      email: sesion.usuario.email,
      action: "logout",
      ip: obtenerIP(req),
    });
  }
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
   API: notificaciones push (protegido por sesion)
   ================================================================ */

async function apiPushClavePublica(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;
  enviarJSON(res, 200, { publicKey: push.clavePublicaVapid });
}

async function apiPushSuscribir(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const endpoint = typeof cuerpo.endpoint === "string" ? cuerpo.endpoint : "";
  const claves = cuerpo.keys || {};
  const p256dh = typeof claves.p256dh === "string" ? claves.p256dh : "";
  const authKey = typeof claves.auth === "string" ? claves.auth : "";

  if (!endpoint || !p256dh || !authKey) {
    return enviarJSON(res, 400, { error: "Suscripción push incompleta." });
  }

  db.guardarSuscripcionPush({ userId: sesion.usuario.id, endpoint, p256dh, auth: authKey });
  enviarJSON(res, 200, { ok: true });
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

  const canInstallApp = !!cuerpo.canInstallApp;

  let usuario;
  if (usuarioExistente) {
    db.actualizarRol(usuarioExistente.id, role);
    db.actualizarPassword(usuarioExistente.id, auth.hashearPassword(tempPassword), { mustChangePassword: true });
    db.actualizarEstado(usuarioExistente.id, "active");
    db.actualizarPuedeInstalarApp(usuarioExistente.id, canInstallApp);
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
      canInstallApp,
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

  const rolAnterior = objetivo.role;
  db.actualizarRol(id, cuerpo.role);
  registrarAuditoriaSegura({
    userId: sesion.usuario.id,
    email: sesion.usuario.email,
    action: "cambio_rol",
    detail: { usuarioObjetivo: objetivo.email, rolAnterior, rolNuevo: cuerpo.role },
    ip: obtenerIP(req),
  });
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

// Marca si un usuario puede ver e instalar la PWA (boton flotante "Instalar
// app"). Solo el Super Admin puede concederlo/revocarlo, tanto al aprobar
// una solicitud de acceso (ver apiAdminApproveRequest) como despues, en
// cualquier momento, desde el panel de gestion de usuarios.
async function apiAdminSetInstallApp(req, res, id) {
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

  db.actualizarPuedeInstalarApp(id, !!cuerpo.canInstallApp);
  enviarJSON(res, 200, { usuario: usuarioPublico(db.buscarUsuarioPorId(id)) });
}

// Borrado permanente de una cuenta desde el panel de gestion de usuarios.
// Solo permitido sobre cuentas ya DESACTIVADAS (defensa en profundidad: el
// boton correspondiente en admin.html tampoco se muestra para active/
// pending), para que desactivar siga siendo el paso previo obligatorio antes
// de un borrado que no se puede deshacer.
async function apiAdminDeleteUser(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  const objetivo = db.buscarUsuarioPorId(id);
  if (!objetivo) return enviarJSON(res, 404, { error: "Usuario no encontrado." });

  if (objetivo.id === sesion.usuario.id) {
    return enviarJSON(res, 400, { error: "No puedes eliminar tu propia cuenta." });
  }
  if (objetivo.status !== "disabled") {
    return enviarJSON(res, 400, { error: "Solo se pueden eliminar cuentas desactivadas." });
  }

  db.eliminarUsuario(id);

  registrarAuditoriaSegura({
    userId: sesion.usuario.id,
    email: sesion.usuario.email,
    action: "usuario_eliminado",
    detail: { usuarioEliminado: objetivo.email },
    ip: obtenerIP(req),
  });

  enviarJSON(res, 200, { ok: true });
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

// Borra de un golpe todo el Repositorio de contratos, contract_stats y (al
// ser la misma tabla) el historial que alimenta el mapa de provincias.
// Exige confirmar con la CONTRASEÑA ACTUAL de quien ejecuta la accion (no
// basta con ser super_admin: es una operacion destructiva e irreversible),
// asi que reutiliza el mismo verificarPassword que el cambio de contrasena.
async function apiAdminResetDatosPrueba(req, res) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const password = typeof cuerpo.password === "string" ? cuerpo.password : "";
  if (!auth.verificarPassword(password, sesion.usuario.password_hash)) {
    return enviarJSON(res, 401, {
      error: "Contraseña incorrecta.",
      code: "CREDENCIALES_INVALIDAS",
    });
  }

  const eliminados = db.borrarContractStats() + db.borrarAnalisisAvanzado();
  db.borrarAnalisisAvanzadoPendientes();
  borrarInformesGuardados();
  enviarJSON(res, 200, {
    ok: true,
    eliminados,
    mensaje: `Datos de prueba eliminados: ${eliminados} contrato(s)/análisis avanzado(s) borrado(s) del Repositorio (Contratos y Análisis Avanzados), Estadísticas y el mapa de provincias.`,
  });
}

// Reseteo por pestaña (boton "Resetear datos" visible solo para super_admin
// en Comparador, Alianzas, Análisis, Repositorio y Estadísticas). A
// diferencia de apiAdminResetDatosPrueba (panel de Admin, borra siempre
// contract_stats entero) este endpoint se llama desde dentro de cada
// pestaña de la app y solo toca los datos de ESA pestaña:
//   - comparador: notas internas y marcas de "vigilar" por empresa.
//   - alianzas: alianzas pendientes, publicadas y descartadas (incluye las
//     noticias del sector mostradas en Inicio, que reutilizan las publicadas).
//   - contratos: Análisis, Repositorio (Contratos y Análisis Avanzados) y
//     Estadísticas comparten las tablas contract_stats/contratos_avanzados,
//     asi que las tres pestañas borran lo mismo.
// Misma exigencia que el reseteo global: confirmar con la contraseña actual
// de quien ejecuta la accion.
const AMBITOS_RESET_TAB = new Set(["comparador", "alianzas", "contratos"]);

async function apiAdminResetTabData(req, res) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const tab = typeof cuerpo.tab === "string" ? cuerpo.tab : "";
  if (!AMBITOS_RESET_TAB.has(tab)) {
    return enviarJSON(res, 400, { error: "Ámbito de reseteo inválido." });
  }

  const password = typeof cuerpo.password === "string" ? cuerpo.password : "";
  if (!auth.verificarPassword(password, sesion.usuario.password_hash)) {
    return enviarJSON(res, 401, {
      error: "Contraseña incorrecta.",
      code: "CREDENCIALES_INVALIDAS",
    });
  }

  let eliminados = 0;
  let mensaje = "";
  if (tab === "comparador") {
    eliminados = db.borrarNotasEmpresas();
    mensaje = `Datos eliminados: ${eliminados} nota(s)/marca(s) de vigilancia del Comparador.`;
  } else if (tab === "alianzas") {
    eliminados = db.borrarAlianzas();
    mensaje = `Datos eliminados: ${eliminados} alianza(s) borrada(s) (pendientes, publicadas y descartadas).`;
  } else if (tab === "contratos") {
    eliminados = db.borrarContractStats() + db.borrarAnalisisAvanzado();
    db.borrarAnalisisAvanzadoPendientes();
    borrarInformesGuardados();
    mensaje = `Datos eliminados: ${eliminados} contrato(s)/análisis avanzado(s) borrado(s) de Análisis, Repositorio (Contratos y Análisis Avanzados) y Estadísticas.`;
  }

  registrarAuditoriaSegura({
    userId: sesion.usuario.id,
    email: sesion.usuario.email,
    action: "reset_datos_tab",
    detail: { tab, eliminados },
    ip: obtenerIP(req),
  });

  enviarJSON(res, 200, { ok: true, eliminados, mensaje });
}

/* ================================================================
   API: panel de auditoria (solo super_admin)
   ================================================================ */

function auditoriaPublica(a) {
  let detail = null;
  if (a.detail) {
    try {
      detail = JSON.parse(a.detail);
    } catch (e) {
      detail = a.detail;
    }
  }
  return { id: a.id, email: a.email, action: a.action, detail, ip: a.ip, createdAt: a.created_at };
}

async function apiAdminAuditoria(req, res, query) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  const limit = query.get("limit");
  const before = query.get("before");
  const registros = db.listarAuditoria({ limit, before }).map(auditoriaPublica);
  enviarJSON(res, 200, { registros });
}

// "Limpiar logs de auditoría" (panel de Super Admin): borra TODO el
// historial de audit_log, confirmado con la contraseña de quien lo pide
// (mismo patron que apiAdminResetDatosPrueba). Tras borrar, se registra la
// propia accion de limpieza como una nueva entrada: asi el log nunca queda
// completamente vacio sin rastro de quien lo vacio y cuando, que es
// justo la informacion que mas interesa conservar en un borrado asi.
async function apiAdminLimpiarAuditoria(req, res) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const password = typeof cuerpo.password === "string" ? cuerpo.password : "";
  if (!auth.verificarPassword(password, sesion.usuario.password_hash)) {
    return enviarJSON(res, 401, {
      error: "Contraseña incorrecta.",
      code: "CREDENCIALES_INVALIDAS",
    });
  }

  const eliminados = db.borrarAuditoria();
  registrarAuditoriaSegura({
    userId: sesion.usuario.id,
    email: sesion.usuario.email,
    action: "limpiar_auditoria",
    detail: { eliminados },
    ip: obtenerIP(req),
  });

  enviarJSON(res, 200, {
    ok: true,
    eliminados,
    mensaje: `Logs de auditoría eliminados: ${eliminados} registro(s) borrado(s).`,
  });
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
    // que sustituye justamente el CP y el nombre de la empresa). Junto con
    // el texto ya anonimizado se guardan en contract_stats para alimentar
    // tanto Estadisticas como el Repositorio (nunca el texto original ni
    // ningun dato personal: el texto guardado es el que ya paso por
    // anonimizarTexto).
    const { provincia, empresa } = analisis.extraerProvinciaYEmpresa(textoOriginal);
    // Igual que provincia/empresa: se busca en el texto ORIGINAL (la fecha
    // de firma no es un dato personal) para mostrarla en la cabecera del PDF.
    const fechaContrato = analisis.extraerFechaContrato(textoOriginal);

    const { texto: textoAnonimizado, total: totalAnonimizado } = analisis.anonimizarTexto(textoOriginal);
    const { clausulas, puntuacionGlobal, nivel } = analisis.detectarClausulas(textoAnonimizado);

    const clausulasCompletas = clausulas.map((c) => ({
      id: c.id,
      label: c.label,
      score: c.score,
      descripcion: c.descripcion,
      fragmento: c.fragmento,
    }));

    // El tipo (hogar/negocio) se detecta automaticamente por palabras clave
    // en el texto ORIGINAL (antes de anonimizar: esas palabras no son un dato
    // sensible). Si hay empate (incluido 0-0, sin ninguna palabra clave) no
    // hay certeza y se guarda sin tipo: el frontend ofrece entonces elegirlo
    // a mano via /api/repositorio/:id/tipo (ver renderFilaClasificar).
    const { tipo, certeza: tipoDetectadoConCerteza } = analisis.detectarTipoContrato(textoOriginal);

    const contratoId = db.registrarContratoAnalizado({
      provincia,
      empresa,
      puntuacion: puntuacionGlobal,
      clausulas: clausulasCompletas,
      textoAnonimizado,
      userId: sesion.usuario.id,
      tipo,
    });

    registrarAuditoriaSegura({
      userId: sesion.usuario.id,
      email: sesion.usuario.email,
      action: "analisis_contrato",
      detail: { contratoId, empresa, tipo },
      ip: obtenerIP(req),
    });

    // Aviso por email si este contrato tiene clausulas distintas a la
    // version anterior de la misma empresa+tipo (construirRepositorioCompleto
    // ya calcula esa comparacion para el Repositorio; aqui se reutiliza en
    // caliente justo tras insertar el contrato nuevo).
    if (empresa) {
      try {
        const repositorio = construirRepositorioCompleto();
        const actual = repositorio.find((c) => c.id === contratoId);
        if (actual && actual.cambios && actual.cambios.tieneCambios) {
          email
            .enviarEmailCambioClausulas({
              empresa,
              tipo,
              nuevas: actual.cambios.nuevas,
              modificadas: actual.cambios.modificadas,
              eliminadas: actual.cambios.eliminadas,
              fecha: new Date(actual.fecha).toLocaleString("es-ES"),
            })
            .catch((e) => console.error("Error enviando email de cambio de cláusulas:", e));
        }
      } catch (e) {
        console.error("Error comprobando cambios de cláusulas:", e);
      }
    }

    const resumen = {
      contratoId,
      puntuacionGlobal,
      nivel,
      totalAnonimizado,
      clausulas: clausulasCompletas,
      tipo,
      tipoDetectadoConCerteza,
    };
    const cabeceraResumen = Buffer.from(JSON.stringify(resumen), "utf-8").toString("base64");

    // Envio "fire and forget": no debe retrasar ni poder romper la
    // descarga del PDF, que es la respuesta real de este endpoint.
    push
      .enviarNotificacionAUsuario(sesion.usuario.id, {
        titulo: "Análisis completado",
        cuerpo: "Tu contrato ya está analizado. Consulta el informe para ver el detalle.",
        etiqueta: "analisis-completado",
        url: "/",
      })
      .catch((e) => console.error("Error enviando notificación push de análisis:", e));

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
      empresa,
      tipo,
      fechaContrato,
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

    // Provincia y empresa se extraen del texto ORIGINAL (antes de anonimizar,
    // que sustituye justamente el CP y el nombre de la empresa), igual que en
    // apiAnalisis.
    const { provincia, empresa } = analisis.extraerProvinciaYEmpresa(textoOriginal);
    const { tipo, certeza: tipoDetectadoConCerteza } = analisis.detectarTipoContrato(textoOriginal);
    const fechaContrato = analisis.extraerFechaContrato(textoOriginal);

    const { texto: textoAnonimizado, total: totalAnonimizado } = analisis.anonimizarTexto(textoOriginal);
    const analisisIA = await analisis.analizarConIA(textoAnonimizado);
    // Segunda pasada de anonimizacion sobre el TEXTO GENERADO por la IA: la
    // IA solo ve texto ya anonimizado, pero esta red de seguridad evita que
    // el informe final pueda reintroducir algun dato identificable si el
    // modelo reformulase o citase algo del contexto.
    const { resumenGeneral, puntuacionGlobal, nivelGlobal, clausulas } = analisis.anonimizarResumenIA(analisisIA);

    // El guardado en el Repositorio debe ocurrir SIEMPRE antes de entregar el
    // PDF (para que "Analisis Avanzados" refleje cada analisis completado),
    // pero un fallo al guardar (disco lleno, fila corrupta, etc.) no debe
    // dejar al usuario sin su informe: se registra el error y el analisis
    // completo se encola en contratos_avanzados_pendientes para que un
    // super_admin/admin pueda reintentar el guardado despues (ver
    // /api/repositorio-avanzado/pendientes) sin repetir la llamada a la IA.
    let analisisAvanzadoId = null;
    let errorGuardado = null;
    const payloadAnalisis = {
      provincia,
      empresa,
      tipo,
      fechaContrato,
      puntuacion: puntuacionGlobal,
      nivelGlobal,
      resumenGeneral,
      clausulas,
      totalAnonimizado,
      textoAnonimizado,
      userId: sesion.usuario.id,
    };
    try {
      analisisAvanzadoId = db.registrarAnalisisAvanzado(payloadAnalisis);
    } catch (e) {
      errorGuardado = e;
      console.error("Error guardando el análisis avanzado en el Repositorio:", e);
      try {
        db.registrarAnalisisAvanzadoPendiente(payloadAnalisis, e.message);
      } catch (e2) {
        console.error("Error encolando el análisis avanzado pendiente de reintento:", e2);
      }
    }

    registrarAuditoriaSegura({
      userId: sesion.usuario.id,
      email: sesion.usuario.email,
      action: errorGuardado ? "analisis_avanzado_error_guardado" : "analisis_avanzado",
      detail: errorGuardado
        ? { empresa, tipo, error: errorGuardado.message }
        : { analisisAvanzadoId, empresa, tipo },
      ip: obtenerIP(req),
    });

    // Aviso por email si este analisis avanzado tiene clausulas distintas al
    // anterior de la misma empresa+tipo (mismo patron que apiAnalisis con
    // construirRepositorioCompleto, aqui con la version avanzada). Solo
    // aplica si el guardado anterior tuvo exito: sin id no hay nada que
    // localizar en el repositorio.
    let cambios = null;
    if (empresa && analisisAvanzadoId) {
      try {
        const repositorioAvanzado = construirRepositorioAvanzadoCompleto();
        const actual = repositorioAvanzado.find((c) => c.id === analisisAvanzadoId);
        if (actual && actual.cambios) {
          cambios = actual.cambios;
          if (cambios.tieneCambios) {
            email
              .enviarEmailCambioClausulas({
                empresa,
                tipo,
                nuevas: cambios.nuevas,
                modificadas: cambios.modificadas,
                eliminadas: cambios.eliminadas,
                fecha: new Date(actual.fecha).toLocaleString("es-ES"),
              })
              .catch((e) => console.error("Error enviando email de cambio de cláusulas (avanzado):", e));
          }
        }
      } catch (e) {
        console.error("Error comprobando cambios de cláusulas (avanzado):", e);
      }
    }

    const resumen = {
      analisisAvanzadoId,
      provincia,
      empresa,
      tipo,
      tipoDetectadoConCerteza,
      resumenGeneral,
      puntuacionGlobal,
      nivelGlobal,
      totalAnonimizado,
      clausulas,
      cambios,
      guardadoEnRepositorio: !errorGuardado,
    };
    const cabeceraResumen = Buffer.from(JSON.stringify(resumen), "utf-8").toString("base64");

    push
      .enviarNotificacionAUsuario(sesion.usuario.id, {
        titulo: "Análisis avanzado completado",
        cuerpo: "Tu análisis legal avanzado ya está listo. Consulta el informe para ver el detalle.",
        etiqueta: "analisis-completado",
        url: "/",
      })
      .catch((e) => console.error("Error enviando notificación push de análisis avanzado:", e));

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
      empresa,
      tipo,
      fechaContrato,
    });
    doc.pipe(res);
    // Copia permanente en disco (ver DIR_INFORMES): el PDFDocument de
    // pdfkit es un stream de lectura normal, admite mas de un .pipe() sin
    // duplicar el trabajo de generacion. Un fallo al escribir a disco (p.ej.
    // sin espacio) no debe romper la descarga en curso, asi que se captura
    // aparte y solo se registra en el log. Sin analisisAvanzadoId (el
    // guardado en el Repositorio falló, ver más arriba) no hay fila con la
    // que asociar esta copia, así que se omite: el PDF sigue llegando al
    // usuario por el pipe de arriba.
    if (analisisAvanzadoId) {
      const escrituraInforme = fs.createWriteStream(rutaInformeAvanzado(analisisAvanzadoId));
      escrituraInforme.on("error", (e) =>
        console.error(`No se pudo guardar el PDF del análisis avanzado ${analisisAvanzadoId} en disco:`, e)
      );
      doc.pipe(escrituraInforme);
    }
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
   API: formaciones (presentaciones PPTX generadas con IA, protegido
   por sesion, cualquier rol)
   ================================================================ */
//
// Delega en formaciones.js (mismo patron que analisis.js): genera el
// contenido de las diapositivas con la API de Anthropic
// (JSON Schema generico, ver formaciones.js) y construye el .pptx con
// pptxgenjs. El cliente aporta el contexto que ya tiene en pantalla
// (fila del Comparador, ficha de equipos, tabla de precios, motivos de
// baja...) para que la IA no invente datos que contradigan al resto de la
// app; el servidor solo añade las alianzas publicadas de la empresa
// elegida (tipo "competencia"), que no estan expuestas tal cual en el DOM.

function contextoFormacionValido(contexto) {
  return contexto === undefined || (contexto !== null && typeof contexto === "object" && !Array.isArray(contexto));
}

async function apiFormacionesGenerar(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const tipo = typeof cuerpo.tipo === "string" ? cuerpo.tipo : "";
  if (!formaciones.TIPOS_VALIDOS.includes(tipo)) {
    return enviarJSON(res, 400, { error: "Tipo de formación no válido." });
  }
  // La formacion "completa" (15 diapositivas, esquema + varios lotes) se
  // genera de forma asincrona con barra de progreso (ver mas abajo
  // apiFormacionCompletaIniciar/Progreso/Descargar); este endpoint
  // sincrono solo sirve a los 6 tipos "cortos" de una unica llamada.
  if (tipo === "completa") {
    return enviarJSON(res, 400, {
      error: "La formación completa se genera de forma asíncrona: usa /api/formaciones/completa/iniciar.",
    });
  }
  if (tipo === "competencia" && !formaciones.EMPRESAS_COMPETENCIA.includes(cuerpo.empresa)) {
    return enviarJSON(res, 400, { error: "Empresa no válida." });
  }
  if (!contextoFormacionValido(cuerpo.contexto)) {
    return enviarJSON(res, 400, { error: "Contexto inválido." });
  }

  try {
    const slides = await formaciones.generarFormacion({ tipo, empresa: cuerpo.empresa, contexto: cuerpo.contexto });
    const buffer = await formaciones.construirPPTX(slides);

    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": 'attachment; filename="formacion-uic.pptx"',
      "Cache-Control": "no-store",
    });
    res.end(buffer);
  } catch (e) {
    console.error("Error generando la formación:", e);
    if (!res.headersSent) {
      if (e instanceof formaciones.FormacionError) return enviarJSON(res, 502, { error: e.message });
      enviarJSON(res, 500, { error: "No se pudo generar la formación: " + e.message });
    } else {
      res.end();
    }
  }
}

/* ================================================================
   API: formacion "completa" por compañia (asincrona, con progreso)
   ================================================================ */
//
// La formacion "completa" (15 diapositivas: esquema + contenido en varios
// lotes en paralelo, ver generarFormacionCompletaConProgreso en
// formaciones.js) puede tardar mas de lo razonable para un unico ciclo
// request/response HTTP bloqueante. En vez de eso, este flujo arranca la
// generacion en segundo plano y devuelve un jobId al instante; el cliente
// hace polling del progreso (apiFormacionCompletaProgreso) y descarga el
// .pptx cuando esta listo (apiFormacionCompletaDescargar). Almacen en
// memoria (Map): un unico proceso Node, no hace falta persistir jobs entre
// reinicios del servidor.

const TRABAJOS_FORMACION_COMPLETA = new Map();
const TTL_TRABAJO_FORMACION_MS = 30 * 60 * 1000; // 30 minutos: limpia jobs abandonados (nunca descargados)

function limpiarTrabajosFormacionCaducados() {
  const ahora = Date.now();
  for (const [id, trabajo] of TRABAJOS_FORMACION_COMPLETA) {
    if (ahora - trabajo.creado > TTL_TRABAJO_FORMACION_MS) TRABAJOS_FORMACION_COMPLETA.delete(id);
  }
}

async function apiFormacionCompletaIniciar(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }
  if (!formaciones.EMPRESAS_COMPETENCIA.includes(cuerpo.empresa)) {
    return enviarJSON(res, 400, { error: "Empresa no válida." });
  }
  if (!contextoFormacionValido(cuerpo.contexto)) {
    return enviarJSON(res, 400, { error: "Contexto inválido." });
  }

  limpiarTrabajosFormacionCaducados();
  const jobId = crypto.randomUUID();
  const trabajo = {
    userId: sesion.usuario.id,
    estado: "procesando",
    progreso: 0,
    mensaje: "Iniciando…",
    buffer: null,
    error: null,
    creado: Date.now(),
  };
  TRABAJOS_FORMACION_COMPLETA.set(jobId, trabajo);

  // Fire-and-forget: este POST responde de inmediato con el jobId; la
  // generacion sigue en segundo plano y el cliente hace polling del
  // progreso (ver apiFormacionCompletaProgreso mas abajo).
  (async () => {
    try {
      const slides = await formaciones.generarFormacionCompletaConProgreso({
        empresa: cuerpo.empresa,
        contexto: cuerpo.contexto,
        onProgreso: (progreso, mensaje) => {
          trabajo.progreso = progreso;
          trabajo.mensaje = mensaje;
        },
      });
      trabajo.progreso = 92;
      trabajo.mensaje = "Maquetando la presentación…";
      const buffer = await formaciones.construirPPTX(slides);
      trabajo.buffer = buffer;
      trabajo.progreso = 100;
      trabajo.mensaje = "Formación generada.";
      trabajo.estado = "listo";
    } catch (e) {
      console.error("Error generando la formación completa:", e);
      trabajo.estado = "error";
      trabajo.error = e instanceof formaciones.FormacionError ? e.message : "No se pudo generar la formación: " + e.message;
    }
  })();

  enviarJSON(res, 200, { jobId });
}

// Comun a progreso/descarga: valida sesion y que el job exista Y pertenezca
// al usuario que lo pidio (nunca debe poder consultarse/descargarse el job
// de otra persona por jobId adivinado). Responde el error y devuelve null
// si no procede continuar.
function obtenerTrabajoFormacionDeSesion(req, res, jobId) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return null;
  const trabajo = jobId ? TRABAJOS_FORMACION_COMPLETA.get(jobId) : null;
  if (!trabajo || trabajo.userId !== sesion.usuario.id) {
    enviarJSON(res, 404, { error: "Formación no encontrada." });
    return null;
  }
  return trabajo;
}

async function apiFormacionCompletaProgreso(req, res, searchParams) {
  const trabajo = obtenerTrabajoFormacionDeSesion(req, res, searchParams.get("id"));
  if (!trabajo) return;
  enviarJSON(res, 200, {
    estado: trabajo.estado,
    progreso: trabajo.progreso,
    mensaje: trabajo.mensaje,
    error: trabajo.error,
  });
}

async function apiFormacionCompletaDescargar(req, res, searchParams) {
  const jobId = searchParams.get("id") || "";
  const trabajo = obtenerTrabajoFormacionDeSesion(req, res, jobId);
  if (!trabajo) return;
  if (trabajo.estado !== "listo" || !trabajo.buffer) {
    return enviarJSON(res, 409, { error: "La formación todavía no está lista." });
  }
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "Content-Disposition": 'attachment; filename="formacion-uic.pptx"',
    "Cache-Control": "no-store",
  });
  res.end(trabajo.buffer);
  TRABAJOS_FORMACION_COMPLETA.delete(jobId);
}

/* ================================================================
   API: "Crear Infografía" (subir un .pptx, resumen de 1 diapositiva)
   ================================================================ */
//
// El usuario sube una presentacion .pptx ya existente; formaciones.js la
// lee con JSZip (ver generarInfografiaDesdePptx) y la IA la resume en una
// unica diapositiva imprimible con el diseño corporativo UIC. Mismo patron
// de subida que apiAnalisis (multer en memoria, un unico fichero).

const MIME_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const uploadInfografia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (file.mimetype === MIME_PPTX || ext === ".pptx") {
      cb(null, true);
    } else {
      cb(new Error("Formato no admitido. Sube una presentación PowerPoint (.pptx)."));
    }
  },
}).single("file");

function ejecutarMulterInfografia(req, res) {
  return new Promise((resolve, reject) => {
    uploadInfografia(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

async function apiFormacionInfografia(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  try {
    await ejecutarMulterInfografia(req, res);
  } catch (e) {
    const mensaje =
      e.code === "LIMIT_FILE_SIZE"
        ? "El archivo supera el tamaño máximo permitido (25 MB)."
        : e.message || "No se pudo procesar el archivo.";
    return enviarJSON(res, 400, { error: mensaje });
  }

  if (!req.file) {
    return enviarJSON(res, 400, { error: "No se ha recibido ningún archivo." });
  }

  try {
    const buffer = await formaciones.generarInfografiaDesdePptx({
      buffer: req.file.buffer,
      nombreArchivo: req.file.originalname,
    });

    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": 'attachment; filename="infografia-uic.pptx"',
      "Cache-Control": "no-store",
    });
    res.end(buffer);
  } catch (e) {
    console.error("Error generando la infografía:", e);
    if (!res.headersSent) {
      if (e instanceof formaciones.FormacionError) return enviarJSON(res, 502, { error: e.message });
      enviarJSON(res, 500, { error: "No se pudo generar la infografía: " + e.message });
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

  // "Actividad en tiempo real": ultima pestana visitada + ultima accion de
  // auditoria por usuario activo (ver db.actividadTiempoReal), a diferencia
  // de `actividad` arriba que es historico agregado.
  const actividadTiempoReal = db.actividadTiempoReal().map((u) => ({
    email: u.email,
    name: u.name,
    role: u.role,
    pestanaActiva: u.pestana_activa,
    horaPestana: u.hora_pestana,
    ultimaAccion: u.ultima_accion,
    horaAccion: u.hora_accion,
  }));

  enviarJSON(res, 200, {
    resumen: {
      totalContratos: db.contarContratosAnalizados(),
      contratosHoy: db.contarContratosAnalizadosHoy(),
      alertasActivas: db.contarAlertasActivasHoy(),
      riesgoPromedio,
      clausulaMasFrecuente: clausulas[0] || null,
      usuariosActivos: db.contarUsuariosActivos(),
    },
    provincias,
    clausulas,
    actividad,
    actividadTiempoReal,
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

  // Se devuelve el id de la visita: el frontend lo guarda para poder
  // reportar mas tarde, contra ESTA visita concreta, cuanto tiempo estuvo
  // (ver apiActividadTabDuracion) y si intento copiar texto mientras la
  // tenia abierta (ver apiActividadTabCopia). Solo tiene efecto visible
  // para el rol retencion (ver medidas de seguridad en index.html), pero
  // se registra para cualquier rol igual que ya hacia esta ruta.
  const visitaId = db.registrarVisitaTab({ userId: sesion.usuario.id, tab });
  enviarJSON(res, 200, { ok: true, visitaId });
}

// Se llama al salir de una pestaña (cambio a otra, cambio de pestaña del
// navegador, cierre de la app) con cuanto tiempo estuvo abierta. El id es
// el que devolvio apiActividadTab al entrar; exigirSesion + el WHERE por
// user_id en finalizarVisitaTab evitan que se pueda alterar la duracion de
// la visita de otra persona.
async function apiActividadTabDuracion(req, res, id) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  db.finalizarVisitaTab({ id, userId: sesion.usuario.id, duracionSegundos: cuerpo.segundos });
  enviarJSON(res, 200, { ok: true });
}

// Se llama cuando el navegador bloquea un intento de copiar/cortar/abrir el
// menu contextual en una pestaña de contenido sensible mientras el rol
// retencion la tiene abierta (ver medidas de seguridad en index.html).
async function apiActividadTabCopia(req, res, id) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  db.registrarIntentoCopiaTab({ id, userId: sesion.usuario.id });
  enviarJSON(res, 200, { ok: true });
}

// Actividad detallada del rol retencion (panel de Super Admin): a
// diferencia de /api/estadisticas (solo la ultima pestaña de cada usuario
// activo, visible tambien para admin), esto es el HISTORICO completo de
// pestaña + duracion + intentos de copia, y solo lo puede consultar
// super_admin.
async function apiAdminActividadRetencion(req, res, query) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  const limit = query.get("limit");
  const before = query.get("before");
  const registros = db.listarActividadRetencion({ limit, before }).map((f) => ({
    id: f.id,
    email: f.email,
    name: f.name,
    tab: f.tab,
    duracionSegundos: f.duration_seconds,
    copyIntentos: f.copy_intentos,
    createdAt: f.created_at,
  }));
  enviarJSON(res, 200, { registros });
}

/* ================================================================
   API: exportar a Excel (protegido por sesion, cualquier rol autenticado)
   ================================================================ */
//
// Endpoint generico y reutilizable desde las pestañas Comparador,
// Inteligencia y Estadisticas: el cliente ya tiene los datos que esta
// mostrando en pantalla (tabla del comparador, graficas de inteligencia,
// resumen/provincias/clausulas de estadisticas) y solo pide que se
// formateen como .xlsx con el logo y los colores corporativos; el servidor
// no vuelve a consultar la base de datos aqui, solo construye el fichero.
// Por eso no hace falta restringir por rol mas alla de exigir sesion: no
// expone nada que el cliente no tuviera ya delante.
//
// Todo Excel exportado sale cifrado con contraseña de apertura (Microsoft
// Office ECMA-376 Agile Encryption, via officecrypto-tool): la contraseña es
// el email de quien lo exporta, para que el archivo solo se pueda abrir
// sabiendo quien lo generó y quede algo de rastro si circula fuera de la
// empresa.

const COLOR_VERISURE_BURDEOS = "FF8B0026";
const COLOR_VERISURE_BURDEOS_SUAVE = "FFF2E3E7";
const RUTA_LOGO_UIC = path.join(__dirname, "assets", "LOGO_UIC_limpio.png");
const MAX_FILAS_EXPORT = 5000;
const MAX_COLUMNAS_EXPORT = 30;
const MAX_HOJAS_EXPORT = 6;

// coloresEmpresa es opcional: { [nombreEmpresa]: "FFRRGGBB" } para pintar la
// celda de la primera columna (Empresa) de cada fila con el mismo color que
// su swatch en el Comparador (ver COLORES_EMPRESA en index.html). Si no se
// envia, la hoja se exporta igual que antes (solo zebra-striping).
function coloresEmpresaValido(coloresEmpresa) {
  if (coloresEmpresa === undefined || coloresEmpresa === null) return true;
  return (
    typeof coloresEmpresa === "object" &&
    !Array.isArray(coloresEmpresa) &&
    Object.values(coloresEmpresa).every((v) => typeof v === "string" && /^[0-9A-Fa-f]{6,8}$/.test(v))
  );
}

function hojaExportValida(hoja) {
  return (
    hoja &&
    typeof hoja.titulo === "string" &&
    hoja.titulo.trim().length > 0 &&
    Array.isArray(hoja.columnas) &&
    hoja.columnas.length > 0 &&
    hoja.columnas.length <= MAX_COLUMNAS_EXPORT &&
    hoja.columnas.every((c) => typeof c === "string") &&
    Array.isArray(hoja.filas) &&
    hoja.filas.length <= MAX_FILAS_EXPORT &&
    hoja.filas.every((f) => Array.isArray(f)) &&
    coloresEmpresaValido(hoja.coloresEmpresa)
  );
}

async function apiExportarExcel(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const nombreArchivo =
    typeof cuerpo.nombreArchivo === "string" && cuerpo.nombreArchivo.trim()
      ? cuerpo.nombreArchivo.trim().replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 80)
      : "segurpanel-export";
  const hojas = Array.isArray(cuerpo.hojas) ? cuerpo.hojas.slice(0, MAX_HOJAS_EXPORT) : [];

  if (hojas.length === 0 || !hojas.every(hojaExportValida)) {
    return enviarJSON(res, 400, { error: "Datos de exportación inválidos." });
  }

  try {
    const libro = new ExcelJS.Workbook();
    libro.creator = "SegurPanel";
    libro.created = new Date();

    let logoId = null;
    try {
      logoId = libro.addImage({ filename: RUTA_LOGO_UIC, extension: "png" });
    } catch (e) {
      logoId = null; // sin el logo tambien se exporta correctamente
    }

    const fechaExportacion = new Date().toLocaleString("es-ES");
    const FILA_CABECERA = 5; // deja hueco (filas 1-4) para el logo + titulo + fecha

    hojas.forEach((hoja) => {
      const ws = libro.addWorksheet(hoja.titulo.slice(0, 31)); // limite de Excel para nombres de hoja

      if (logoId !== null) {
        ws.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 130, height: 74 } });
      }
      ws.getRow(1).getCell(3).value = "SegurPanel";
      ws.getRow(1).getCell(3).font = { bold: true, size: 14, color: { argb: COLOR_VERISURE_BURDEOS } };
      ws.getRow(2).getCell(3).value = `Exportado: ${fechaExportacion}`;
      ws.getRow(2).getCell(3).font = { italic: true, size: 9, color: { argb: "FF5B6B7C" } };

      const filaCabecera = ws.getRow(FILA_CABECERA);
      hoja.columnas.forEach((titulo, i) => {
        const celda = filaCabecera.getCell(i + 1);
        celda.value = titulo;
        celda.font = { bold: true, color: { argb: "FFFFFFFF" } };
        celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_VERISURE_BURDEOS } };
        celda.alignment = { vertical: "middle", horizontal: "left" };
      });
      filaCabecera.commit();

      hoja.filas.forEach((fila, i) => {
        const r = ws.addRow(fila);
        if (i % 2 === 1) {
          r.eachCell((celda) => {
            celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_VERISURE_BURDEOS_SUAVE } };
          });
        }
        if (hoja.coloresEmpresa) {
          const colorEmpresa = hoja.coloresEmpresa[fila[0]];
          if (colorEmpresa) {
            const argb = colorEmpresa.length === 8 ? colorEmpresa : `FF${colorEmpresa}`;
            r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
            r.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
          }
        }
      });

      hoja.columnas.forEach((titulo, i) => {
        const anchoMax = hoja.filas.reduce((m, f) => Math.max(m, String(f[i] ?? "").length), titulo.length);
        ws.getColumn(i + 1).width = Math.min(50, Math.max(12, anchoMax + 2));
      });
    });

    const buffer = await libro.xlsx.writeBuffer();
    const bufferCifrado = officeCrypto.encrypt(Buffer.from(buffer), { password: sesion.usuario.email });

    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${nombreArchivo}.xlsx"`,
      "Cache-Control": "no-store",
    });
    res.end(bufferCifrado);
  } catch (e) {
    console.error("Error generando el Excel:", e);
    if (!res.headersSent) enviarJSON(res, 500, { error: "No se pudo generar el archivo Excel." });
  }
}

/* ================================================================
   API: notas privadas y vigilancia de empresas (Comparador, solo super_admin)
   ================================================================ */

async function apiComparadorNotasGet(req, res) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;
  enviarJSON(res, 200, { notas: db.listarNotasEmpresas() });
}

async function apiComparadorNotasPost(req, res) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const empresa = typeof cuerpo.empresa === "string" ? cuerpo.empresa.trim().slice(0, 120) : "";
  if (!empresa) return enviarJSON(res, 400, { error: "Falta la empresa." });
  const nota = typeof cuerpo.nota === "string" ? cuerpo.nota.slice(0, 2000) : "";

  const fila = db.guardarNotaEmpresa({ empresa, nota, userId: sesion.usuario.id });
  enviarJSON(res, 200, { nota: fila });
}

async function apiComparadorVigilarPost(req, res) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  const empresa = typeof cuerpo.empresa === "string" ? cuerpo.empresa.trim().slice(0, 120) : "";
  if (!empresa) return enviarJSON(res, 400, { error: "Falta la empresa." });

  const fila = db.alternarVigilanciaEmpresa({ empresa, vigilada: !!cuerpo.vigilada, userId: sesion.usuario.id });
  enviarJSON(res, 200, { nota: fila });
}

/* ================================================================
   API: repositorio de contratos (solo super_admin y admin)
   ================================================================ */
//
// Reutiliza contract_stats (la misma tabla que alimenta Estadisticas): cada
// fila ya tiene provincia, empresa, puntuacion, clausulas y, desde esta
// funcionalidad, tipo (hogar/negocio, opcional) y el texto ya anonimizado.
// La deteccion de cambios (nueva/modificada/eliminada) SIEMPRE se calcula
// sobre el historial COMPLETO en orden cronologico, comparando cada
// contrato con el anterior de su mismo grupo empresa+tipo, y solo despues
// se aplican los filtros de la peticion — asi el resultado no depende de
// que filtros esten activos en cada momento.

function nivelDesdeRiesgo(puntuacion) {
  if (puntuacion == null) return null;
  if (puntuacion <= 3) return "bajo";
  if (puntuacion <= 6) return "medio";
  if (puntuacion <= 8) return "alto";
  return "muy_alto";
}

function calcularCambiosClausulas(anteriores, actuales) {
  const mapaAnterior = new Map(anteriores.map((c) => [c.id, c]));
  const mapaActual = new Map(actuales.map((c) => [c.id, c]));

  const nuevas = [];
  const modificadas = [];
  const eliminadas = [];

  mapaActual.forEach((c, id) => {
    if (!mapaAnterior.has(id)) {
      nuevas.push(c.label);
    } else if ((mapaAnterior.get(id).fragmento || "") !== (c.fragmento || "")) {
      modificadas.push(c.label);
    }
  });
  mapaAnterior.forEach((c, id) => {
    if (!mapaActual.has(id)) eliminadas.push(c.label);
  });

  return { nuevas, modificadas, eliminadas, tieneCambios: nuevas.length + modificadas.length + eliminadas.length > 0 };
}

// Construye la lista completa de contratos con nivel de riesgo y cambios ya
// calculados, en orden cronologico ascendente (imprescindible para que la
// comparacion de cambios sea correcta).
function construirRepositorioCompleto() {
  const filas = db.listarRepositorioResumen();
  const ultimoPorGrupo = new Map();

  return filas.map((f) => {
    let clausulas = [];
    try {
      clausulas = JSON.parse(f.clausulas_json) || [];
    } catch (e) {
      clausulas = [];
    }

    const contrato = {
      id: f.id,
      fecha: f.created_at,
      provincia: f.provincia,
      empresa: f.empresa,
      tipo: f.tipo,
      puntuacion: f.puntuacion,
      nivel: nivelDesdeRiesgo(f.puntuacion),
      clausulas,
      cambios: null,
    };

    if (f.empresa && f.tipo) {
      const clave = f.empresa + "||" + f.tipo;
      const anterior = ultimoPorGrupo.get(clave);
      if (anterior) {
        contrato.cambios = calcularCambiosClausulas(anterior.clausulas, clausulas);
      }
      ultimoPorGrupo.set(clave, contrato);
    }

    return contrato;
  });
}

async function apiRepositorioGet(req, res, query) {
  const sesion = exigirSesion(req, res, { roles: ROLES_ESTADISTICAS });
  if (!sesion) return;

  let contratos = construirRepositorioCompleto();

  const empresa = query.get("empresa");
  const tipo = query.get("tipo");
  const provincia = query.get("provincia");
  const nivel = query.get("nivel");
  const fechaDesde = query.get("fechaDesde");
  const fechaHasta = query.get("fechaHasta");

  if (empresa) contratos = contratos.filter((c) => c.empresa === empresa);
  if (tipo) contratos = contratos.filter((c) => c.tipo === tipo);
  if (provincia) contratos = contratos.filter((c) => c.provincia === provincia);
  if (nivel) contratos = contratos.filter((c) => c.nivel === nivel);
  if (fechaDesde) contratos = contratos.filter((c) => c.fecha.slice(0, 10) >= fechaDesde);
  if (fechaHasta) contratos = contratos.filter((c) => c.fecha.slice(0, 10) <= fechaHasta);

  contratos.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));

  enviarJSON(res, 200, { contratos });
}

async function apiRepositorioDetalle(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: ROLES_ESTADISTICAS });
  if (!sesion) return;

  const fila = db.obtenerContratoDetalle(id);
  if (!fila) return enviarJSON(res, 404, { error: "Contrato no encontrado." });

  let clausulas = [];
  try {
    clausulas = JSON.parse(fila.clausulas_json) || [];
  } catch (e) {
    clausulas = [];
  }

  enviarJSON(res, 200, {
    id: fila.id,
    fecha: fila.created_at,
    provincia: fila.provincia,
    empresa: fila.empresa,
    tipo: fila.tipo,
    puntuacion: fila.puntuacion,
    nivel: nivelDesdeRiesgo(fila.puntuacion),
    clausulas,
    textoAnonimizado: fila.texto_anonimizado,
  });
}

const TIPOS_CONTRATO_VALIDOS = new Set(["hogar", "negocio"]);

async function apiRepositorioClasificar(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: ROLES_ESTADISTICAS });
  if (!sesion) return;

  const fila = db.obtenerContratoDetalle(id);
  if (!fila) return enviarJSON(res, 404, { error: "Contrato no encontrado." });

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  if (!TIPOS_CONTRATO_VALIDOS.has(cuerpo.tipo)) {
    return enviarJSON(res, 400, { error: "Tipo inválido. Usa 'hogar' o 'negocio'." });
  }

  const actualizado = db.clasificarContrato(id, cuerpo.tipo);
  enviarJSON(res, 200, { ok: true, id: actualizado.id, tipo: actualizado.tipo });
}

/* ================================================================
   API: repositorio de analisis avanzados (solo super_admin y admin)
   ================================================================ */
//
// Analogo a la seccion anterior (Repositorio de contratos) pero para
// contratos_avanzados: el analisis legal clausula por clausula generado con
// IA. A diferencia del detector de clausulas por patrones (que usa un `id`
// fijo por regla), la IA no sigue una taxonomia fija de clausulas, asi que
// la comparacion entre versiones se hace por titulo normalizado.

// Tabla de acentos en vez de normalize('NFD') + rango combinante: mas simple
// y explicita, y evita depender de escapes unicode en el codigo fuente.
const MAPA_ACENTOS_TITULO = {
  á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u", à: "a", è: "e", ì: "i", ò: "o", ù: "u",
};

function normalizarTitulo(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[áéíóúüàèìòù]/g, (c) => MAPA_ACENTOS_TITULO[c] || c)
    .trim()
    .replace(/\s+/g, " ");
}

function calcularCambiosClausulasAvanzado(anteriores, actuales) {
  const mapaAnterior = new Map(anteriores.map((c) => [normalizarTitulo(c.titulo), c]));
  const mapaActual = new Map(actuales.map((c) => [normalizarTitulo(c.titulo), c]));

  const nuevas = [];
  const modificadas = [];
  const eliminadas = [];

  mapaActual.forEach((c, titulo) => {
    if (!mapaAnterior.has(titulo)) {
      nuevas.push(c.titulo);
    } else {
      const previa = mapaAnterior.get(titulo);
      if (
        (previa.explicacion || "") !== (c.explicacion || "") ||
        (previa.baseLegal || "") !== (c.baseLegal || "") ||
        (previa.riesgo || "") !== (c.riesgo || "")
      ) {
        modificadas.push(c.titulo);
      }
    }
  });
  mapaAnterior.forEach((c, titulo) => {
    if (!mapaActual.has(titulo)) eliminadas.push(c.titulo);
  });

  return { nuevas, modificadas, eliminadas, tieneCambios: nuevas.length + modificadas.length + eliminadas.length > 0 };
}

// Construye la lista completa de analisis avanzados con los cambios ya
// calculados, en orden cronologico ascendente (igual que
// construirRepositorioCompleto). A diferencia de la version basica, el
// nivel de riesgo no se recalcula: viene ya clasificado por la IA en
// nivel_global.
function construirRepositorioAvanzadoCompleto() {
  const filas = db.listarAnalisisAvanzadoResumen();
  const ultimoPorGrupo = new Map();

  return filas.map((f) => {
    let clausulas = [];
    try {
      clausulas = JSON.parse(f.clausulas_json) || [];
    } catch (e) {
      clausulas = [];
    }

    const analisisAvanzado = {
      id: f.id,
      fecha: f.created_at,
      provincia: f.provincia,
      empresa: f.empresa,
      tipo: f.tipo,
      puntuacion: f.puntuacion,
      nivel: f.nivel_global,
      resumenGeneral: f.resumen_general,
      totalAnonimizado: f.total_anonimizado,
      clausulas,
      cambios: null,
    };

    if (f.empresa && f.tipo) {
      const clave = f.empresa + "||" + f.tipo;
      const anterior = ultimoPorGrupo.get(clave);
      if (anterior) {
        analisisAvanzado.cambios = calcularCambiosClausulasAvanzado(anterior.clausulas, clausulas);
      }
      ultimoPorGrupo.set(clave, analisisAvanzado);
    }

    return analisisAvanzado;
  });
}

async function apiRepositorioAvanzadoGet(req, res, query) {
  const sesion = exigirSesion(req, res, { roles: ROLES_ESTADISTICAS });
  if (!sesion) return;

  let analisisAvanzados = construirRepositorioAvanzadoCompleto();

  const empresa = query.get("empresa");
  const tipo = query.get("tipo");
  const provincia = query.get("provincia");
  const nivel = query.get("nivel");
  const fechaDesde = query.get("fechaDesde");
  const fechaHasta = query.get("fechaHasta");

  if (empresa) analisisAvanzados = analisisAvanzados.filter((c) => c.empresa === empresa);
  if (tipo) analisisAvanzados = analisisAvanzados.filter((c) => c.tipo === tipo);
  if (provincia) analisisAvanzados = analisisAvanzados.filter((c) => c.provincia === provincia);
  if (nivel) analisisAvanzados = analisisAvanzados.filter((c) => c.nivel === nivel);
  if (fechaDesde) analisisAvanzados = analisisAvanzados.filter((c) => c.fecha.slice(0, 10) >= fechaDesde);
  if (fechaHasta) analisisAvanzados = analisisAvanzados.filter((c) => c.fecha.slice(0, 10) <= fechaHasta);

  analisisAvanzados.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));

  enviarJSON(res, 200, { analisisAvanzados });
}

async function apiRepositorioAvanzadoDetalle(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: ROLES_ESTADISTICAS });
  if (!sesion) return;

  const fila = db.obtenerAnalisisAvanzadoDetalle(id);
  if (!fila) return enviarJSON(res, 404, { error: "Análisis avanzado no encontrado." });

  let clausulas = [];
  try {
    clausulas = JSON.parse(fila.clausulas_json) || [];
  } catch (e) {
    clausulas = [];
  }

  enviarJSON(res, 200, {
    id: fila.id,
    fecha: fila.created_at,
    provincia: fila.provincia,
    empresa: fila.empresa,
    tipo: fila.tipo,
    puntuacion: fila.puntuacion,
    nivel: fila.nivel_global,
    resumenGeneral: fila.resumen_general,
    totalAnonimizado: fila.total_anonimizado,
    clausulas,
    textoAnonimizado: fila.texto_anonimizado,
  });
}

async function apiRepositorioAvanzadoClasificar(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: ROLES_ESTADISTICAS });
  if (!sesion) return;

  const fila = db.obtenerAnalisisAvanzadoDetalle(id);
  if (!fila) return enviarJSON(res, 404, { error: "Análisis avanzado no encontrado." });

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  if (!TIPOS_CONTRATO_VALIDOS.has(cuerpo.tipo)) {
    return enviarJSON(res, 400, { error: "Tipo inválido. Usa 'hogar' o 'negocio'." });
  }

  const actualizado = db.clasificarAnalisisAvanzado(id, cuerpo.tipo);
  enviarJSON(res, 200, { ok: true, id: actualizado.id, tipo: actualizado.tipo });
}

async function apiRepositorioAvanzadoPdf(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: ROLES_ESTADISTICAS });
  if (!sesion) return;

  const fila = db.obtenerAnalisisAvanzadoDetalle(id);
  if (!fila) return enviarJSON(res, 404, { error: "Análisis avanzado no encontrado." });

  // Si se guardo una copia en disco en el momento del analisis (ver
  // DIR_INFORMES en apiAnalisisAvanzado), se sirve esa copia tal cual en vez
  // de reconstruir el PDF: es el informe EXACTO que se genero entonces, y
  // evita rehacer el trabajo. Los analisis avanzados de antes de que
  // existiera este guardado (o si el fichero se ha perdido) no tienen copia
  // en disco: se cae al camino antiguo, reconstruyendo el PDF al vuelo a
  // partir de los datos guardados en la base de datos.
  const rutaGuardada = rutaInformeAvanzado(fila.id);
  if (fs.existsSync(rutaGuardada)) {
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="informe-analisis-avanzado-uic-${fila.id}.pdf"`,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(rutaGuardada).pipe(res);
    return;
  }

  let clausulas = [];
  try {
    clausulas = JSON.parse(fila.clausulas_json) || [];
  } catch (e) {
    clausulas = [];
  }

  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="informe-analisis-avanzado-uic-${fila.id}.pdf"`,
    "Cache-Control": "no-store",
  });

  const doc = analisis.generarInformePDFAvanzado({
    resumenGeneral: fila.resumen_general,
    puntuacionGlobal: fila.puntuacion,
    nivelGlobal: fila.nivel_global,
    clausulas,
    totalAnonimizado: fila.total_anonimizado,
    empresa: fila.empresa,
    tipo: fila.tipo,
    fechaContrato: fila.fecha_contrato,
  });
  doc.pipe(res);
}

// Analisis avanzados cuyo guardado en contratos_avanzados fallo en su
// momento (ver apiAnalisisAvanzado): el usuario ya recibio su PDF, pero el
// analisis no aparece en "Analisis Avanzados" hasta que se reintenta el
// guardado desde aqui. Devuelve solo los metadatos basicos (sin el texto
// anonimizado completo, que no hace falta para decidir si reintentar).
async function apiRepositorioAvanzadoPendientesGet(req, res) {
  const sesion = exigirSesion(req, res, { roles: ROLES_ESTADISTICAS });
  if (!sesion) return;

  const pendientes = db.listarAnalisisAvanzadoPendientes().map((p) => {
    let payload = {};
    try {
      payload = JSON.parse(p.payload_json) || {};
    } catch (e) {
      payload = {};
    }
    return {
      id: p.id,
      empresa: payload.empresa || null,
      tipo: payload.tipo || null,
      provincia: payload.provincia || null,
      fecha: p.created_at,
      intentos: p.intentos,
      error: p.error_mensaje,
    };
  });

  enviarJSON(res, 200, { pendientes });
}

// Reintenta guardar en contratos_avanzados cada analisis avanzado encolado
// en contratos_avanzados_pendientes (sin volver a llamar a la IA: el
// analisis ya se hizo, solo se reintenta la escritura en la base de datos).
// Los que tengan exito se retiran de la cola; los que sigan fallando se
// quedan con el intento y el error actualizados para el siguiente reintento.
async function apiRepositorioAvanzadoPendientesReintentar(req, res) {
  const sesion = exigirSesion(req, res, { roles: ROLES_ESTADISTICAS });
  if (!sesion) return;

  const pendientes = db.listarAnalisisAvanzadoPendientes();
  let guardados = 0;
  let fallidos = 0;

  for (const p of pendientes) {
    const resultado = db.reintentarAnalisisAvanzadoPendiente(p.id);
    if (resultado.ok) {
      guardados++;
    } else {
      fallidos++;
      console.error(`Error reintentando guardar el análisis avanzado pendiente ${p.id}:`, resultado.error);
    }
  }

  registrarAuditoriaSegura({
    userId: sesion.usuario.id,
    email: sesion.usuario.email,
    action: "analisis_avanzado_reintento_guardado",
    detail: { total: pendientes.length, guardados, fallidos },
    ip: obtenerIP(req),
  });

  enviarJSON(res, 200, { total: pendientes.length, guardados, fallidos });
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

// Periodos con los que se agrupan las alianzas en el panel: cada alianza
// cae en exactamente un periodo, evaluados en este orden de prioridad (mas
// reciente primero) para no mostrarla duplicada en dos secciones. "Esta
// semana" son los ultimos 7 dias SIN contar hoy, y "este mes" es el resto
// del mes en curso sin contar esos 7 dias.
const MS_POR_DIA = 24 * 60 * 60 * 1000;

function periodoDeAlianza(fechaDeteccion, ahora) {
  const fecha = new Date(fechaDeteccion);
  if (Number.isNaN(fecha.getTime())) return "historico";

  if (fecha.toISOString().slice(0, 10) === ahora.toISOString().slice(0, 10)) {
    return "hoy";
  }
  if (ahora.getTime() - fecha.getTime() <= 7 * MS_POR_DIA) {
    return "semana";
  }
  if (fecha.getUTCFullYear() === ahora.getUTCFullYear() && fecha.getUTCMonth() === ahora.getUTCMonth()) {
    return "mes";
  }
  return "historico";
}

function agruparAlianzasPorPeriodo(lista, ahora) {
  const grupos = { hoy: [], semana: [], mes: [], historico: [] };
  for (const a of lista) {
    grupos[periodoDeAlianza(a.fechaDeteccion, ahora)].push(a);
  }
  return grupos;
}

// Fire and forget: nunca debe retrasar ni romper la respuesta del endpoint
// de sincronizacion (sync/nueva), que ademas puede recibir un lote de varias
// alianzas de golpe y solo debe avisar una vez por lote, no una vez por
// alianza.
function notificarAlianzasNuevas(insertadas) {
  if (insertadas <= 0) return;
  push
    .enviarNotificacionARoles([auth.ROLES.SUPER_ADMIN, auth.ROLES.ADMIN], {
      titulo: "Nuevas alianzas pendientes",
      cuerpo: `${insertadas} alianza${insertadas === 1 ? "" : "s"} nueva${insertadas === 1 ? "" : "s"} en espera de revisión.`,
      etiqueta: "alianzas-pendientes",
      url: "/",
    })
    .catch((e) => console.error("Error enviando notificación push de alianzas:", e));
}

async function apiAlianzasGet(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  // Las noticias del sector (alianzas publicadas, ver Inicio) caducan a los
  // 7 dias de publicarse: se borran aqui mismo, en cada carga, para no
  // depender de un cron aparte (ver borrarAlianzasPublicadasCaducadas).
  db.borrarAlianzasPublicadasCaducadas();

  const ahora = new Date();
  const respuesta = {
    publicadas: agruparAlianzasPorPeriodo(db.listarAlianzasPorEstado("published"), ahora),
    actualizado: db.fechaUltimaAlianza(),
  };
  if (sesion.usuario.role === auth.ROLES.SUPER_ADMIN) {
    const pendientes = agruparAlianzasPorPeriodo(db.listarAlianzasPorEstado("pending"), ahora);
    respuesta.pendientes = pendientes;
    // El punto rojo de la pestaña solo debe encenderse por alianzas nuevas
    // de HOY: una vez revisadas las de hoy, aunque queden pendientes mas
    // antiguas sin resolver, no debe seguir parpadeando.
    respuesta.pendientesHoy = pendientes.hoy.length;
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
  if (status === "published") {
    registrarAuditoriaSegura({
      userId: sesion.usuario.id,
      email: sesion.usuario.email,
      action: "publicar_alianza",
      detail: { empresaAlarma: alianza.empresa_alarma, socio: alianza.socio },
      ip: obtenerIP(req),
    });
  }
  enviarJSON(res, 200, { ok: true });
}

// Borrado manual e inmediato de una noticia/alianza publicada (boton
// "Eliminar" en Inicio > Noticias del sector, solo super_admin), sin
// esperar al borrado automatico a los 7 dias (ver
// borrarAlianzasPublicadasCaducadas en apiAlianzasGet).
async function apiAlianzasEliminar(req, res, id) {
  const sesion = exigirSesion(req, res, { roles: [auth.ROLES.SUPER_ADMIN] });
  if (!sesion) return;

  const alianza = db.buscarAlianzaPorId(id);
  if (!alianza) return enviarJSON(res, 404, { error: "Alianza no encontrada." });

  db.eliminarAlianza(id);
  registrarAuditoriaSegura({
    userId: sesion.usuario.id,
    email: sesion.usuario.email,
    action: "eliminar_alianza",
    detail: { empresaAlarma: alianza.empresa_alarma, socio: alianza.socio },
    ip: obtenerIP(req),
  });
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

// Lee y normaliza los campos opcionales que los scrapers (Raspberry Pi)
// mandan junto al lote de alianzas/ofertas, y que sirven solo para el
// reporte diario de las 09:00 (ver db.registrarEjecucionScraper / reportes.js):
// `encontradas` (total detectado en la ejecucion, antes de filtrar lo ya
// conocido) y `errores` (avisos no fatales durante el scraping, p.ej. Google
// News sin responder para alguna empresa). Ninguno de los dos afecta a que
// la sincronizacion se acepte o no: son solo metadatos informativos.
function metadatosEjecucionScraper(cuerpo, totalRecibido) {
  const encontradas = Number.isFinite(cuerpo.encontradas) ? cuerpo.encontradas : totalRecibido;
  const errores = Array.isArray(cuerpo.errores)
    ? cuerpo.errores.filter((e) => typeof e === "string" && e.trim()).slice(0, 20)
    : [];
  return { encontradas, erroresTexto: errores.length ? errores.join("\n").slice(0, 4000) : null };
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
  const { encontradas, erroresTexto } = metadatosEjecucionScraper(cuerpo, lista.length);

  if (lista.length === 0) {
    db.registrarEjecucionScraper({ tipo: "alianzas", encontradas, enviadas: 0, errores: erroresTexto });
    return enviarJSON(res, 200, { insertadas: 0, mensaje: "Sin alianzas nuevas que sincronizar." });
  }
  if (lista.length > MAX_ALIANZAS_POR_SYNC) {
    return enviarJSON(res, 400, { error: `Demasiadas alianzas en una sola sincronización (máximo ${MAX_ALIANZAS_POR_SYNC}).` });
  }

  const validas = lista.filter(alianzaValida);
  if (validas.length === 0) {
    db.registrarEjecucionScraper({
      tipo: "alianzas",
      encontradas,
      enviadas: 0,
      errores: [erroresTexto, "Ninguna alianza del envío tiene un formato válido."].filter(Boolean).join("\n"),
    });
    return enviarJSON(res, 400, { error: "Ninguna alianza del envío tiene un formato válido." });
  }

  const { count } = db.insertarAlianzasPendientes(validas);
  notificarAlianzasNuevas(count);
  db.registrarEjecucionScraper({ tipo: "alianzas", encontradas, enviadas: count, errores: erroresTexto });
  enviarJSON(res, 200, { insertadas: count, recibidas: lista.length, validas: validas.length });
}

/* ================================================================
   API: ofertas / promociones vigentes por empresa de alarmas
   ================================================================ */
//
// Flujo: scraper_precios.py (Raspberry Pi) busca a diario promociones
// vigentes en Google News y las envia a POST /api/ofertas/sync, protegido
// por el mismo secreto compartido (SCRAPER_TOKEN) que /api/alianzas/sync.
// A diferencia de alianzas no hay cola de moderacion: las promociones
// entran directamente y la pestaña "Ofertas" muestra, por cada empresa, la
// mas reciente detectada (ver db.listarUltimaOfertaPorEmpresa).

const EMPRESAS_ALARMA_VALIDAS = new Set([
  "Verisure",
  "Sector Alarm",
  "Sicor",
  "Segurma",
  "ADT",
  "Seguridad 3D",
  "Grupo Control",
  "Trablisa",
  "MPA/Prosegur",
]);
const MAX_OFERTAS_POR_SYNC = 200;

async function apiOfertasGet(req, res) {
  const sesion = exigirSesion(req, res);
  if (!sesion) return;

  enviarJSON(res, 200, {
    ofertas: db.listarUltimaOfertaPorEmpresa(),
    actualizado: db.fechaUltimaOferta(),
  });
}

function ofertaValida(o) {
  return (
    o &&
    typeof o.externalId === "string" &&
    o.externalId.trim() &&
    typeof o.empresa === "string" &&
    EMPRESAS_ALARMA_VALIDAS.has(o.empresa) &&
    typeof o.titulo === "string" &&
    o.titulo.trim()
  );
}

async function apiOfertasSync(req, res) {
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

  const lista = Array.isArray(cuerpo.ofertas) ? cuerpo.ofertas : [];
  const { encontradas, erroresTexto } = metadatosEjecucionScraper(cuerpo, lista.length);

  if (lista.length === 0) {
    db.registrarEjecucionScraper({ tipo: "ofertas", encontradas, enviadas: 0, errores: erroresTexto });
    return enviarJSON(res, 200, { insertadas: 0, mensaje: "Sin ofertas que sincronizar." });
  }
  if (lista.length > MAX_OFERTAS_POR_SYNC) {
    return enviarJSON(res, 400, { error: `Demasiadas ofertas en una sola sincronización (máximo ${MAX_OFERTAS_POR_SYNC}).` });
  }

  const validas = lista.filter(ofertaValida);
  if (validas.length === 0) {
    db.registrarEjecucionScraper({
      tipo: "ofertas",
      encontradas,
      enviadas: 0,
      errores: [erroresTexto, "Ninguna oferta del envío tiene un formato válido."].filter(Boolean).join("\n"),
    });
    return enviarJSON(res, 400, { error: "Ninguna oferta del envío tiene un formato válido." });
  }

  const { count } = db.insertarOfertas(validas);
  db.registrarEjecucionScraper({ tipo: "ofertas", encontradas, enviadas: count, errores: erroresTexto });
  enviarJSON(res, 200, { insertadas: count, recibidas: lista.length, validas: validas.length });
}

// ---------------------------------------------------------------
// POST /api/alianzas/nueva: variante de ingesta pensada para el scraper de
// la Raspberry Pi tal y como esta escrito hoy: un array JSON con todas las
// alianzas nuevas detectadas en la misma ejecucion, cada una con los campos
// id, empresa_alarma, socio_comercial, sector, tipo_acuerdo, fecha, fuente,
// titulo, resumen y origen. Por compatibilidad con envios antiguos tambien
// se acepta un unico objeto suelto (sin envolver en array).
// Se autentica con "Authorization: Bearer <ALIANZAS_TOKEN>" en vez del
// header a medida x-scraper-token que usa /sync, y escribe en la misma
// tabla `alianzas` como 'pending' -> el punto rojo de la pestaña Alianzas
// (ver actualizarNotifDot en index.html) se activa solo, porque ya lee su
// recuento de pendientes desde GET /api/alianzas en cada carga de sesion.

const SECTOR_POR_SOCIO = new Map([
  ["movistar", "Móviles"],
  ["vodafone", "Móviles"],
  ["orange", "Móviles"],
  ["masmovil", "Móviles"],
  ["másmóvil", "Móviles"],
  ["carrefour", "Grandes superficies"],
  ["leroy merlin", "Grandes superficies"],
  ["el corte inglés", "Grandes superficies"],
  ["el corte ingles", "Grandes superficies"],
  ["mediamarkt", "Grandes superficies"],
  ["mapfre", "Seguros"],
  ["axa", "Seguros"],
  ["allianz", "Seguros"],
  ["generali", "Seguros"],
  ["idealista", "Inmobiliarias"],
  ["fotocasa", "Inmobiliarias"],
  ["pisos.com", "Inmobiliarias"],
  ["endesa", "Suministros (luz, gas, agua)"],
  ["iberdrola", "Suministros (luz, gas, agua)"],
  ["naturgy", "Suministros (luz, gas, agua)"],
  ["repsol", "Suministros (luz, gas, agua)"],
]);

function inferirSectorPorSocio(socio) {
  return SECTOR_POR_SOCIO.get(String(socio || "").trim().toLowerCase()) || null;
}

// Acepta tanto "Authorization: Bearer <token>" como "Authorization: <token>"
// a secas: algunos scripts del scraper (siguiendo el mismo estilo que el
// header a medida X-Scraper-Token de /sync, que no lleva prefijo) mandan el
// token directo sin anteponer "Bearer ", y eso no debe traducirse en un 401.
function extraerTokenBearer(req) {
  const cabecera = String(req.headers["authorization"] || "").trim();
  if (!cabecera) return null;
  const m = /^Bearer\s+(.+)$/i.exec(cabecera);
  return m ? m[1].trim() : cabecera;
}

function extraerDominio(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function generarExternalIdAlianza({ empresaAlarma, socio, fuente }) {
  return crypto
    .createHash("sha256")
    .update(`${empresaAlarma}|${socio}|${fuente}`.toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

// Normaliza un elemento del array que envia el scraper (campos en
// snake_case) al formato interno que usa insertarAlianzasPendientes. El
// scraper ya calcula "sector" y aporta un "id" propio para deduplicar, asi
// que se usan directamente en vez de inferirlos; "fuente" es la URL de la
// noticia y "origen" el nombre legible de la fuente (p.ej. "Google News"),
// igual que antes distinguian "url" y "fuente" internamente.
function normalizarAlianzaNueva(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { error: "Cada alianza debe ser un objeto." };
  }

  const empresaAlarma = typeof item.empresa_alarma === "string" ? item.empresa_alarma.trim() : "";
  const socio = typeof item.socio_comercial === "string" ? item.socio_comercial.trim() : "";
  const fuenteUrl = typeof item.fuente === "string" ? item.fuente.trim() : "";

  if (!empresaAlarma || !socio || !fuenteUrl) {
    return { error: "Faltan campos obligatorios: empresa_alarma, socio_comercial y fuente." };
  }

  let sector = typeof item.sector === "string" ? item.sector.trim() : "";
  if (!SECTORES_ALIANZA.has(sector)) {
    sector = inferirSectorPorSocio(socio) || "";
  }
  if (!sector) {
    return { error: `No se reconoce el sector del socio comercial "${socio}".` };
  }

  const idRecibido = item.id !== undefined && item.id !== null ? String(item.id).trim() : "";
  const externalId = idRecibido || generarExternalIdAlianza({ empresaAlarma, socio, fuente: fuenteUrl });

  const titulo = typeof item.titulo === "string" ? item.titulo.trim() : "";
  const resumen = typeof item.resumen === "string" ? item.resumen.trim() : "";
  const origen = typeof item.origen === "string" ? item.origen.trim() : "";

  return {
    alianza: {
      externalId,
      empresaAlarma,
      sector,
      socio,
      tipoAcuerdo: typeof item.tipo_acuerdo === "string" ? item.tipo_acuerdo.trim() : null,
      titular: (titulo || resumen).slice(0, 500) || null,
      fuente: origen || extraerDominio(fuenteUrl) || fuenteUrl,
      url: fuenteUrl,
      fechaPublicacion: typeof item.fecha === "string" ? item.fecha.trim() : null,
    },
  };
}

async function apiAlianzasNueva(req, res) {
  const tokenEsperado = (process.env.ALIANZAS_TOKEN || "").trim();
  if (!tokenEsperado) {
    return enviarJSON(res, 503, {
      error: "El servidor no tiene configurada la variable de entorno ALIANZAS_TOKEN.",
    });
  }
  const tokenRecibido = extraerTokenBearer(req);
  if (!tokenRecibido || tokenRecibido !== tokenEsperado) {
    return enviarJSON(res, 401, { error: "Token de autenticación inválido." });
  }

  let cuerpo;
  try {
    cuerpo = await leerCuerpoJSON(req);
  } catch (e) {
    return enviarJSON(res, 400, { error: e.message });
  }

  // El scraper envia un array con todas las alianzas nuevas de la ejecucion;
  // un objeto suelto tambien se acepta por compatibilidad.
  const lista = Array.isArray(cuerpo) ? cuerpo : [cuerpo];
  if (lista.length === 0) {
    return enviarJSON(res, 400, { error: "El envío no contiene ninguna alianza." });
  }
  if (lista.length > MAX_ALIANZAS_POR_SYNC) {
    return enviarJSON(res, 400, { error: `Demasiadas alianzas en un solo envío (máximo ${MAX_ALIANZAS_POR_SYNC}).` });
  }

  const validas = [];
  let primerError = null;
  for (const item of lista) {
    const resultado = normalizarAlianzaNueva(item);
    if (resultado.error) {
      if (!primerError) primerError = resultado.error;
    } else {
      validas.push(resultado.alianza);
    }
  }

  if (validas.length === 0) {
    return enviarJSON(res, 400, { error: primerError || "Ninguna alianza del envío tiene un formato válido." });
  }

  const { count, filas } = db.insertarAlianzasPendientes(validas);
  notificarAlianzasNuevas(count);
  if (count > 0) {
    email
      .enviarEmailAlianzasNuevas(filas)
      .catch((e) => console.error("Error enviando email de nuevas alianzas:", e));
  }
  enviarJSON(res, 200, {
    ok: true,
    recibidas: lista.length,
    validas: validas.length,
    insertadas: count,
    mensaje:
      count > 0
        ? `${count} alianza${count === 1 ? "" : "s"} registrada${count === 1 ? "" : "s"} como pendiente${count === 1 ? "" : "s"} de revisión.`
        : "Ninguna alianza nueva (ya existían o fueron ignoradas).",
  });
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
  "/assets/LOGO_UIC_limpio.png",
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
const idInstallAppUsuario = RUTA_CON_ID("/api/admin/users", "/install-app");
const idResetPasswordUsuario = RUTA_CON_ID("/api/admin/users", "/reset-password");
const idEliminarUsuario = RUTA_CON_ID("/api/admin/users", "/delete");
const idPublicarAlianza = RUTA_CON_ID("/api/alianzas", "/publicar");
const idDescartarAlianza = RUTA_CON_ID("/api/alianzas", "/descartar");
const idEliminarAlianza = RUTA_CON_ID("/api/alianzas", "/eliminar");
const idDetalleRepositorio = RUTA_CON_ID("/api/repositorio", "");
const idClasificarRepositorio = RUTA_CON_ID("/api/repositorio", "/tipo");
const idDetalleRepositorioAvanzado = RUTA_CON_ID("/api/repositorio-avanzado", "");
const idClasificarRepositorioAvanzado = RUTA_CON_ID("/api/repositorio-avanzado", "/tipo");
const idPdfRepositorioAvanzado = RUTA_CON_ID("/api/repositorio-avanzado", "/pdf");
const idDuracionVisitaTab = RUTA_CON_ID("/api/actividad/tab", "/duracion");
const idCopiaVisitaTab = RUTA_CON_ID("/api/actividad/tab", "/copia");

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
    if (esLectura && ruta === "/reset-password") return await servirLogin(res);

    if (req.method === "POST" && ruta === "/api/auth/request-access") return await apiRequestAccess(req, res);
    if (req.method === "POST" && ruta === "/api/auth/forgot-password") return await apiForgotPassword(req, res);
    if (req.method === "GET" && ruta === "/api/auth/validate-reset-token") {
      return await apiValidateResetToken(req, res, url.searchParams);
    }
    if (req.method === "POST" && ruta === "/api/auth/reset-password") return await apiResetPassword(req, res);
    if (req.method === "POST" && ruta === "/api/auth/login") return await apiLogin(req, res);
    if (req.method === "POST" && ruta === "/api/auth/verify-2fa") return await apiVerificar2FA(req, res);
    if (req.method === "POST" && ruta === "/api/auth/resend-2fa") return await apiReenviar2FA(req, res);
    if (req.method === "POST" && ruta === "/api/auth/logout") return await apiLogout(req, res);
    if (req.method === "POST" && ruta === "/api/auth/change-password") return await apiChangePassword(req, res);
    if (req.method === "GET" && ruta === "/api/auth/me") return await apiMe(req, res);

    if (req.method === "GET" && ruta === "/api/push/public-key") return await apiPushClavePublica(req, res);
    if (req.method === "POST" && ruta === "/api/push/subscribe") return await apiPushSuscribir(req, res);

    if (req.method === "POST" && ruta === "/api/export/excel") return await apiExportarExcel(req, res);

    if (req.method === "GET" && ruta === "/api/comparador/notas") return await apiComparadorNotasGet(req, res);
    if (req.method === "POST" && ruta === "/api/comparador/notas") return await apiComparadorNotasPost(req, res);
    if (req.method === "POST" && ruta === "/api/comparador/vigilar") return await apiComparadorVigilarPost(req, res);

    if (req.method === "GET" && ruta === "/api/admin/users") return await apiAdminUsers(req, res);
    if (req.method === "GET" && ruta === "/api/admin/requests") return await apiAdminRequests(req, res, url.searchParams);
    if (req.method === "GET" && ruta === "/api/admin/audit") return await apiAdminAuditoria(req, res, url.searchParams);
    if (req.method === "POST" && ruta === "/api/admin/audit/clear") return await apiAdminLimpiarAuditoria(req, res);

    if (req.method === "POST") {
      let id = idAprobarSolicitud(ruta);
      if (id !== null) return await apiAdminApproveRequest(req, res, id);
      id = idRechazarSolicitud(ruta);
      if (id !== null) return await apiAdminRejectRequest(req, res, id);
      id = idRolUsuario(ruta);
      if (id !== null) return await apiAdminSetRole(req, res, id);
      id = idEstadoUsuario(ruta);
      if (id !== null) return await apiAdminSetStatus(req, res, id);
      id = idInstallAppUsuario(ruta);
      if (id !== null) return await apiAdminSetInstallApp(req, res, id);
      id = idResetPasswordUsuario(ruta);
      if (id !== null) return await apiAdminResetPassword(req, res, id);
      id = idEliminarUsuario(ruta);
      if (id !== null) return await apiAdminDeleteUser(req, res, id);
    }
    if (req.method === "POST" && ruta === "/api/admin/reset-test-data") return await apiAdminResetDatosPrueba(req, res);
    if (req.method === "POST" && ruta === "/api/admin/reset-tab-data") return await apiAdminResetTabData(req, res);

    if (req.method === "POST" && ruta === "/api/chat") return await manejarChat(req, res);
    if (req.method === "POST" && ruta === "/api/analisis") return await apiAnalisis(req, res);
    if (req.method === "POST" && ruta === "/api/analisis/zip") return await apiAnalisisZip(req, res);
    if (req.method === "POST" && ruta === "/api/analisis-avanzado") return await apiAnalisisAvanzado(req, res);
    if (req.method === "POST" && ruta === "/api/formaciones/generar") return await apiFormacionesGenerar(req, res);
    if (req.method === "POST" && ruta === "/api/formaciones/completa/iniciar") return await apiFormacionCompletaIniciar(req, res);
    if (req.method === "GET" && ruta === "/api/formaciones/completa/progreso") return await apiFormacionCompletaProgreso(req, res, url.searchParams);
    if (req.method === "GET" && ruta === "/api/formaciones/completa/descargar") return await apiFormacionCompletaDescargar(req, res, url.searchParams);
    if (req.method === "POST" && ruta === "/api/formaciones/infografia") return await apiFormacionInfografia(req, res);

    if (req.method === "GET" && ruta === "/api/estadisticas") return await apiEstadisticas(req, res);
    if (req.method === "POST" && ruta === "/api/actividad/tab") return await apiActividadTab(req, res);
    if (req.method === "POST") {
      const idDur = idDuracionVisitaTab(ruta);
      if (idDur !== null) return await apiActividadTabDuracion(req, res, idDur);
      const idCopia = idCopiaVisitaTab(ruta);
      if (idCopia !== null) return await apiActividadTabCopia(req, res, idCopia);
    }
    if (req.method === "GET" && ruta === "/api/admin/actividad-retencion") {
      return await apiAdminActividadRetencion(req, res, url.searchParams);
    }

    if (req.method === "GET" && ruta === "/api/repositorio") return await apiRepositorioGet(req, res, url.searchParams);
    if (req.method === "POST") {
      const idTipo = idClasificarRepositorio(ruta);
      if (idTipo !== null) return await apiRepositorioClasificar(req, res, idTipo);
    }
    if (req.method === "GET") {
      const idDetalle = idDetalleRepositorio(ruta);
      if (idDetalle !== null) return await apiRepositorioDetalle(req, res, idDetalle);
    }

    if (req.method === "GET" && ruta === "/api/repositorio-avanzado") return await apiRepositorioAvanzadoGet(req, res, url.searchParams);
    if (req.method === "GET" && ruta === "/api/repositorio-avanzado/pendientes") {
      return await apiRepositorioAvanzadoPendientesGet(req, res);
    }
    if (req.method === "POST" && ruta === "/api/repositorio-avanzado/pendientes/reintentar") {
      return await apiRepositorioAvanzadoPendientesReintentar(req, res);
    }
    if (req.method === "POST") {
      const idTipoAvz = idClasificarRepositorioAvanzado(ruta);
      if (idTipoAvz !== null) return await apiRepositorioAvanzadoClasificar(req, res, idTipoAvz);
    }
    if (req.method === "GET") {
      const idPdfAvz = idPdfRepositorioAvanzado(ruta);
      if (idPdfAvz !== null) return await apiRepositorioAvanzadoPdf(req, res, idPdfAvz);
      const idDetalleAvz = idDetalleRepositorioAvanzado(ruta);
      if (idDetalleAvz !== null) return await apiRepositorioAvanzadoDetalle(req, res, idDetalleAvz);
    }

    if (req.method === "GET" && ruta === "/api/alianzas") return await apiAlianzasGet(req, res);
    if (req.method === "POST" && ruta === "/api/alianzas/sync") return await apiAlianzasSync(req, res);
    if (req.method === "POST" && ruta === "/api/alianzas/nueva") return await apiAlianzasNueva(req, res);
    if (req.method === "POST") {
      let id = idPublicarAlianza(ruta);
      if (id !== null) return await apiAlianzasResolver(req, res, id, "published");
      id = idDescartarAlianza(ruta);
      if (id !== null) return await apiAlianzasResolver(req, res, id, "discarded");
      id = idEliminarAlianza(ruta);
      if (id !== null) return await apiAlianzasEliminar(req, res, id);
    }

    if (req.method === "GET" && ruta === "/api/ofertas") return await apiOfertasGet(req, res);
    if (req.method === "POST" && ruta === "/api/ofertas/sync") return await apiOfertasSync(req, res);

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

backup.iniciarProgramador();
reportes.iniciarProgramador();

servidor.listen(PORT, () => {
  const protocolo = certFile && keyFile ? "https" : "http";
  console.log(`SegurPanel escuchando en ${protocolo}://localhost:${PORT}/`);
  console.log(`Backup automático diario a las 02:00 en ${backup.DIR_BACKUPS} (últimos 7).`);
  console.log("Reporte diario de scrapers a las 09:00 a fjose.cantos@verisure.es.");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "AVISO: ANTHROPIC_API_KEY no está configurada. El IA Assistant no podrá responder hasta que la definas (setx ANTHROPIC_API_KEY \"sk-ant-...\") y reinicies este servidor."
    );
  }

  if (!process.env.SCRAPER_TOKEN) {
    console.warn(
      "AVISO: SCRAPER_TOKEN no está configurada. POST /api/alianzas/sync y POST /api/ofertas/sync (usados por scraper_alianzas.py y scraper_precios.py en la Raspberry Pi) rechazarán todas las peticiones hasta que la definas."
    );
  }

  if (!process.env.ALIANZAS_TOKEN) {
    console.warn(
      "AVISO: ALIANZAS_TOKEN no está configurada. POST /api/alianzas/nueva (usado por scraper_alianzas.py) rechazará todas las peticiones hasta que la definas."
    );
  }

  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
    console.warn(
      "AVISO: SMTP_USER/SMTP_PASSWORD no están configuradas. No se enviarán emails cuando el scraper detecte alianzas nuevas."
    );
  }

  if (!process.env.UNSPLASH_ACCESS_KEY) {
    console.warn(
      "AVISO: UNSPLASH_ACCESS_KEY no está configurada. Las presentaciones de Formaciones se generarán sin imágenes de fondo hasta que la definas."
    );
  }

  if (
    process.env.NODE_ENV === "production" &&
    !process.env.APP_URL &&
    !process.env.BASE_URL &&
    !process.env.RENDER_EXTERNAL_URL
  ) {
    console.warn(
      `AVISO: APP_URL/BASE_URL no están configuradas y no se detectó RENDER_EXTERNAL_URL. Los enlaces en emails (p.ej. el aviso de nueva solicitud de acceso o el de recuperación de contraseña) usarán ${APP_URL}, que no es una URL pública válida.`
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
