// auth.js
//
// Autenticacion y autorizacion de SegurPanel: contrasenas (bcryptjs),
// sesiones JWT (jsonwebtoken) respaldadas por la tabla `sessions` de
// SQLite (para poder revocarlas: logout, baja de usuario, reseteo de
// clave), cookies httpOnly y las reglas de negocio de acceso
// (dominio @verisure.es, roles, bloqueo por intentos fallidos).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");

const DOMINIO_PERMITIDO = "verisure.es";
const SUPER_ADMIN_EMAIL = "fjose.cantos@verisure.es";

const NOMBRE_COOKIE = "sp_session";
const DURACION_SESION_HORAS = 8;
// Duracion de la sesion con "Recordarme" marcado en el login: 7 dias en vez
// de las 8 horas habituales. Se aplica tanto al JWT (expiresIn) como al
// Max-Age de la cookie (ver crearSesionParaUsuario/cookieSesion).
const DURACION_SESION_RECORDAR_HORAS = 24 * 7;
const RONDAS_BCRYPT = 12;

const ROLES = Object.freeze({
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  RETENCION: "retencion",
});

/* ---------- Secreto JWT ---------- */
//
// En produccion se debe fijar JWT_SECRET como variable de entorno (asi
// todas las instancias del servidor comparten el mismo secreto y las
// sesiones sobreviven a un despliegue). Si no esta definida (uso local),
// se genera un secreto aleatorio la primera vez y se guarda en
// DIR_DATOS/.jwt-secret (mismo directorio persistente que la base de datos;
// excluido de git) para que sobreviva a reinicios del servidor sin invalidar
// las sesiones activas.

function obtenerSecretoJWT() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  const rutaSecreto = path.join(db.DIR_DATOS, ".jwt-secret");
  try {
    return fs.readFileSync(rutaSecreto, "utf8").trim();
  } catch (e) {
    const secreto = crypto.randomBytes(48).toString("hex");
    fs.mkdirSync(path.dirname(rutaSecreto), { recursive: true });
    fs.writeFileSync(rutaSecreto, secreto, { mode: 0o600 });
    return secreto;
  }
}

const JWT_SECRET = obtenerSecretoJWT();

/* ---------- Contrasenas ---------- */

function hashearPassword(password) {
  return bcrypt.hashSync(password, RONDAS_BCRYPT);
}

function verificarPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(password, hash);
}

// Politica minima: 10+ caracteres, al menos una letra y un numero.
function validarPolitica(password) {
  if (typeof password !== "string" || password.length < 10) {
    return "La contraseña debe tener al menos 10 caracteres.";
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "La contraseña debe incluir al menos una letra y un número.";
  }
  return null;
}

// Politica del formulario de "restablecer contraseña" (enlace por email):
// minimo 8 caracteres, con al menos una mayuscula y un numero. Se pidio
// explicitamente asi para este flujo; es distinta de validarPolitica
// (cambio de contraseña ya autenticado), que exige 10+ caracteres.
function validarPoliticaRecuperacion(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "La contraseña debe tener al menos 8 caracteres.";
  }
  if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "La contraseña debe incluir al menos una mayúscula y un número.";
  }
  return null;
}

function generarPasswordTemporal() {
  // 12 caracteres, alfabeto sin ambiguedades (sin 0/O, 1/l/I), + 2 digitos
  // garantizados al final para cumplir siempre la politica de contrasenas.
  const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let resultado = "";
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) resultado += ALFABETO[bytes[i] % ALFABETO.length];
  const digitos = crypto.randomBytes(2);
  resultado += (digitos[0] % 10).toString() + (digitos[1] % 10).toString();
  return resultado;
}

/* ---------- Dominio y roles ---------- */

function esCorreoPermitido(email) {
  if (typeof email !== "string") return false;
  const partes = email.trim().toLowerCase().split("@");
  return partes.length === 2 && partes[1] === DOMINIO_PERMITIDO;
}

function normalizarEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function esRolValido(role) {
  return Object.values(ROLES).includes(role);
}

/* ---------- Cookies ---------- */

function parsearCookies(req) {
  const cabecera = req.headers.cookie;
  const cookies = {};
  if (!cabecera) return cookies;
  for (const par of cabecera.split(";")) {
    const idx = par.indexOf("=");
    if (idx === -1) continue;
    const nombre = par.slice(0, idx).trim();
    const valor = par.slice(idx + 1).trim();
    if (nombre) cookies[nombre] = decodeURIComponent(valor);
  }
  return cookies;
}

function esConexionSegura(req) {
  // Detras de un proxy TLS (habitual en produccion) express/http no ve el
  // socket cifrado directamente, asi que tambien se respeta la cabecera
  // estandar X-Forwarded-Proto si el proxy la establece.
  if (req.socket && req.socket.encrypted) return true;
  const proto = req.headers["x-forwarded-proto"];
  return typeof proto === "string" && proto.split(",")[0].trim() === "https";
}

function cabeceraSetCookie(nombre, valor, { maxAgeSegundos, seguro, borrar } = {}) {
  const partes = [`${nombre}=${encodeURIComponent(valor)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (seguro) partes.push("Secure");
  if (borrar) {
    partes.push("Max-Age=0");
  } else if (maxAgeSegundos) {
    partes.push(`Max-Age=${maxAgeSegundos}`);
  }
  return partes.join("; ");
}

// Sin "recordar": cookie DE SESION (sin Max-Age/Expires) — el navegador la
// borra al cerrarse del todo, asi que volver a abrir la app exige iniciar
// sesion de nuevo aunque el JWT en si todavia no haya caducado. Con
// "recordar": cookie persistente 7 dias. En ambos casos el JWT tiene su
// propia caducidad server-side (ver crearSesionParaUsuario) igual de larga
// que el Max-Age de la cookie, asi que aunque el navegador conservase la
// cookie mas alla de lo esperado (algunos gestores de "restaurar pestañas"
// no la borran siempre al cerrar), la sesion deja de ser valida en el
// servidor pasado ese tiempo de todos modos.
function cookieSesion(req, token, recordar) {
  return cabeceraSetCookie(NOMBRE_COOKIE, token, {
    maxAgeSegundos: recordar ? DURACION_SESION_RECORDAR_HORAS * 3600 : undefined,
    seguro: esConexionSegura(req),
  });
}

function cookieBorrarSesion(req) {
  return cabeceraSetCookie(NOMBRE_COOKIE, "", { borrar: true, seguro: esConexionSegura(req) });
}

/* ---------- Sesiones (JWT + tabla sessions para poder revocar) ---------- */

function crearSesionParaUsuario(req, usuario, recordar) {
  const jti = crypto.randomBytes(24).toString("hex");
  const duracionHoras = recordar ? DURACION_SESION_RECORDAR_HORAS : DURACION_SESION_HORAS;
  const expiraEn = new Date(Date.now() + duracionHoras * 3600 * 1000);

  db.crearSesion({
    id: jti,
    userId: usuario.id,
    expiresAt: expiraEn.toISOString(),
    userAgent: (req.headers["user-agent"] || "").slice(0, 300),
    ip: (req.socket && req.socket.remoteAddress) || null,
  });

  const token = jwt.sign({ role: usuario.role }, JWT_SECRET, {
    subject: String(usuario.id),
    jwtid: jti,
    expiresIn: `${duracionHoras}h`,
  });

  return { token, jti };
}

// Verifica la cookie de sesion: firma JWT valida, no caducada, y la sesion
// sigue viva (no revocada) en la base de datos. Devuelve el usuario o null.
function usuarioDesdePeticion(req) {
  const cookies = parsearCookies(req);
  const token = cookies[NOMBRE_COOKIE];
  if (!token) return null;

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }

  const sesion = db.buscarSesion(payload.jti);
  if (!sesion || sesion.revoked || new Date(sesion.expires_at) < new Date()) {
    return null;
  }

  const usuario = db.buscarUsuarioPorId(Number(payload.sub));
  if (!usuario || usuario.status !== "active") return null;

  return { usuario, jti: payload.jti };
}

function cerrarSesion(jti) {
  if (jti) db.revocarSesion(jti);
}

/* ---------- Doble factor (2FA) para super_admin/admin ----------
   Tras una contraseña correcta, esos dos roles no reciben todavia una
   sesion completa: reciben un token JWT de corta duracion (10 min) que
   demuestra que ya pasaron el paso 1 (contraseña), y deben aportar ademas
   el codigo de 6 digitos enviado por email para completar el login (ver
   apiLogin/apiVerificar2FA en server.js). Este token NO es una cookie de
   sesion ni da acceso a nada por si mismo: solo sirve para la llamada a
   /api/auth/verify-2fa. */

const DURACION_TOKEN_PENDIENTE_2FA = "10m";

function generarCodigo2FA() {
  // 6 digitos (000000-999999), con ceros a la izquierda si hace falta.
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// Solo se guarda (y se compara) el hash del codigo, nunca el codigo en
// claro: un hash rapido (SHA-256) es apropiado aqui porque el codigo ya
// esta protegido por su propia caducidad (10 min), un solo uso y un limite
// de intentos (ver MAX_INTENTOS_CODIGO_2FA en db.js) — no hace falta el
// coste computacional de bcrypt, pensado para contraseñas de larga vida.
function hashCodigo2FA(codigo) {
  return crypto.createHash("sha256").update(String(codigo)).digest("hex");
}

function crearTokenPendiente2FA(usuario) {
  return jwt.sign({ pending2FA: true }, JWT_SECRET, {
    subject: String(usuario.id),
    expiresIn: DURACION_TOKEN_PENDIENTE_2FA,
  });
}

// Devuelve el id de usuario si el token es valido y es realmente un token
// "pendiente de 2FA" (no una cookie de sesion normal reutilizada aqui por
// error), o null si no.
function verificarTokenPendiente2FA(token) {
  if (typeof token !== "string" || !token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.pending2FA) return null;
    return Number(payload.sub);
  } catch (e) {
    return null;
  }
}

/* ---------- Recuperacion de contraseña ("Olvidaste tu contraseña") ----------
   El token viaja en claro en el enlace del email; en la base de datos solo
   se guarda su hash (SHA-256, igual que hashCodigo2FA), asi que una fuga de
   la base de datos no permite a nadie restablecer contraseñas ajenas. */

const DURACION_RECUPERACION_MINUTOS = 30;

function generarTokenRecuperacion() {
  return crypto.randomBytes(32).toString("hex");
}

function hashTokenRecuperacion(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/* ---------- Siembra del Super Admin ---------- */
//
// Sin esto habria un problema de "huevo y gallina": nadie podria aprobar la
// primera solicitud de acceso porque no existiria ningun Super Admin. Al
// arrancar el servidor por primera vez se crea la cuenta con una clave
// temporal aleatoria (se obliga a cambiarla en el primer login) y se
// imprime una unica vez por consola / DIR_DATOS/SUPER_ADMIN_INICIAL.txt.
function asegurarSuperAdmin() {
  const existente = db.buscarUsuarioPorEmail(SUPER_ADMIN_EMAIL);
  if (existente) return null;

  const passwordTemporal = generarPasswordTemporal();
  db.crearUsuario({
    email: SUPER_ADMIN_EMAIL,
    name: "Super Admin",
    passwordHash: hashearPassword(passwordTemporal),
    role: ROLES.SUPER_ADMIN,
    status: "active",
    mustChangePassword: true,
    approvedBy: null,
  });

  const rutaAviso = path.join(db.DIR_DATOS, "SUPER_ADMIN_INICIAL.txt");
  const contenido =
    `SegurPanel - credenciales iniciales del Super Admin\n` +
    `Generadas: ${new Date().toISOString()}\n\n` +
    `Correo:            ${SUPER_ADMIN_EMAIL}\n` +
    `Clave temporal:    ${passwordTemporal}\n\n` +
    `Se pedira cambiarla en el primer inicio de sesion.\n` +
    `Borra este fichero despues de usarlo.\n`;
  fs.writeFileSync(rutaAviso, contenido, { mode: 0o600 });

  return { email: SUPER_ADMIN_EMAIL, passwordTemporal, rutaAviso };
}

module.exports = {
  ROLES,
  DOMINIO_PERMITIDO,
  SUPER_ADMIN_EMAIL,
  hashearPassword,
  verificarPassword,
  validarPolitica,
  validarPoliticaRecuperacion,
  generarPasswordTemporal,
  esCorreoPermitido,
  normalizarEmail,
  esRolValido,
  parsearCookies,
  cookieSesion,
  cookieBorrarSesion,
  crearSesionParaUsuario,
  usuarioDesdePeticion,
  cerrarSesion,
  generarCodigo2FA,
  hashCodigo2FA,
  crearTokenPendiente2FA,
  verificarTokenPendiente2FA,
  generarTokenRecuperacion,
  hashTokenRecuperacion,
  DURACION_RECUPERACION_MINUTOS,
  asegurarSuperAdmin,
};
