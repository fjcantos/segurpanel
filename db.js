// db.js
//
// Capa de datos de SegurPanel: usuarios, solicitudes de acceso y sesiones.
// Usa el modulo `node:sqlite` incorporado en Node (estable desde Node 22.5,
// sin flag experimental en Node 24), asi que no hace falta compilar nada
// nativo ni instalar un motor de base de datos aparte.
//
// El fichero de datos vive en DATA_DIR/segurpanel.db (o ./data/segurpanel.db
// si DATA_DIR no esta definida) y esta excluido del repositorio via
// .gitignore: contiene contrasenas hasheadas y no debe subirse a git ni
// compartirse.
//
// En Render (y otros PaaS con filesystem efimero) el directorio del proyecto
// se recrea en cada despliegue, así que hay que montar un disco persistente
// y apuntar DATA_DIR a su punto de montaje (p.ej. DATA_DIR=/data) para que
// los usuarios, sesiones y solicitudes sobrevivan a los despliegues.

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const cifrado = require("./cifrado");

const DIR_DATOS = process.env.DATA_DIR || path.join(__dirname, "data");
const RUTA_DB = path.join(DIR_DATOS, "segurpanel.db");

fs.mkdirSync(DIR_DATOS, { recursive: true });

const db = new DatabaseSync(RUTA_DB);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    email                 TEXT NOT NULL UNIQUE,
    name                  TEXT,
    password_hash         TEXT,
    role                  TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'retencion')),
    status                TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')) DEFAULT 'pending',
    must_change_password  INTEGER NOT NULL DEFAULT 1,
    failed_attempts        INTEGER NOT NULL DEFAULT 0,
    locked_until          TEXT,
    can_install_app       INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    approved_by           INTEGER REFERENCES users(id),
    approved_at           TEXT
  );

  CREATE TABLE IF NOT EXISTS access_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL,
    name          TEXT,
    message       TEXT,
    status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
    created_at    TEXT NOT NULL,
    resolved_at   TEXT,
    resolved_by   INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    user_agent  TEXT,
    ip          TEXT
  );

  CREATE TABLE IF NOT EXISTS alianzas (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id        TEXT NOT NULL UNIQUE,
    empresa_alarma     TEXT NOT NULL,
    sector             TEXT NOT NULL,
    socio              TEXT NOT NULL,
    tipo_acuerdo       TEXT,
    titular            TEXT,
    fuente             TEXT,
    url                TEXT,
    fecha_publicacion  TEXT,
    fecha_deteccion    TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('pending', 'published', 'discarded')) DEFAULT 'pending',
    created_at         TEXT NOT NULL,
    reviewed_at        TEXT,
    reviewed_by        INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS ofertas (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id        TEXT NOT NULL UNIQUE,
    empresa            TEXT NOT NULL,
    titulo             TEXT,
    fuente             TEXT,
    url                TEXT,
    fecha_publicacion  TEXT,
    fecha_deteccion    TEXT NOT NULL,
    created_at         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contract_stats (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    provincia           TEXT,
    empresa             TEXT,
    tipo                TEXT,
    puntuacion          INTEGER,
    clausulas_json      TEXT,
    texto_anonimizado   TEXT,
    user_id             INTEGER REFERENCES users(id),
    created_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tab_visits (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id),
    tab               TEXT NOT NULL,
    duration_seconds  INTEGER,
    copy_intentos     INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL
  );

  -- Codigos de un solo uso para el doble factor (2FA) de super_admin/admin
  -- tras un login con contraseña correcta (ver auth.js/server.js). Solo se
  -- guarda el hash del codigo, nunca el codigo en claro.
  CREATE TABLE IF NOT EXISTS two_factor_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    code_hash   TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    used        INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  -- Intentos de login fallidos por IP (independiente del bloqueo por
  -- CUENTA ya existente en users.failed_attempts/locked_until): permite
  -- frenar un ataque que pruebe muchas cuentas distintas desde la misma IP,
  -- no solo muchos intentos contra una misma cuenta.
  CREATE TABLE IF NOT EXISTS ip_login_attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ip          TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ip_blocks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ip             TEXT NOT NULL,
    blocked_until  TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS company_notes (
    empresa      TEXT PRIMARY KEY,
    nota         TEXT,
    vigilada     INTEGER NOT NULL DEFAULT 0,
    updated_by   INTEGER REFERENCES users(id),
    updated_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),
    email       TEXT,
    action      TEXT NOT NULL,
    detail      TEXT,
    ip          TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contratos_avanzados (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    provincia          TEXT,
    empresa            TEXT,
    tipo               TEXT,
    fecha_contrato     TEXT,
    puntuacion         INTEGER,
    nivel_global       TEXT,
    resumen_general    TEXT,
    clausulas_json     TEXT,
    total_anonimizado  INTEGER,
    texto_anonimizado  TEXT,
    user_id            INTEGER REFERENCES users(id),
    created_at         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contratos_avanzados_pendientes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    payload_json       TEXT NOT NULL,
    error_mensaje      TEXT,
    intentos           INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_requests_status ON access_requests(status);
  CREATE INDEX IF NOT EXISTS idx_alianzas_status ON alianzas(status);
  CREATE INDEX IF NOT EXISTS idx_ofertas_empresa ON ofertas(empresa);
  CREATE INDEX IF NOT EXISTS idx_contract_stats_provincia ON contract_stats(provincia);
  CREATE INDEX IF NOT EXISTS idx_tab_visits_user ON tab_visits(user_id);
  CREATE INDEX IF NOT EXISTS idx_two_factor_codes_user ON two_factor_codes(user_id, used, expires_at);
  CREATE INDEX IF NOT EXISTS idx_ip_login_attempts_ip ON ip_login_attempts(ip, created_at);
  CREATE INDEX IF NOT EXISTS idx_ip_blocks_ip ON ip_blocks(ip, blocked_until);
  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_contratos_avanzados_empresa_tipo ON contratos_avanzados(empresa, tipo);
`);

// Migracion defensiva: contract_stats se creo en una version anterior sin
// `tipo` ni `texto_anonimizado` (Repositorio). CREATE TABLE IF NOT EXISTS no
// anade columnas a una tabla que ya existe, asi que en despliegues con base
// de datos previa hay que anadirlas a mano una sola vez, ANTES de crear
// cualquier indice que las use.
function columnaExiste(tabla, columna) {
  return db
    .prepare(`PRAGMA table_info(${tabla})`)
    .all()
    .some((c) => c.name === columna);
}
if (!columnaExiste("contract_stats", "tipo")) {
  db.exec("ALTER TABLE contract_stats ADD COLUMN tipo TEXT");
}
if (!columnaExiste("contract_stats", "texto_anonimizado")) {
  db.exec("ALTER TABLE contract_stats ADD COLUMN texto_anonimizado TEXT");
}
if (!columnaExiste("users", "can_install_app")) {
  db.exec("ALTER TABLE users ADD COLUMN can_install_app INTEGER NOT NULL DEFAULT 0");
}
if (!columnaExiste("contratos_avanzados", "fecha_contrato")) {
  db.exec("ALTER TABLE contratos_avanzados ADD COLUMN fecha_contrato TEXT");
}
if (!columnaExiste("tab_visits", "duration_seconds")) {
  db.exec("ALTER TABLE tab_visits ADD COLUMN duration_seconds INTEGER");
}
if (!columnaExiste("tab_visits", "copy_intentos")) {
  db.exec("ALTER TABLE tab_visits ADD COLUMN copy_intentos INTEGER NOT NULL DEFAULT 0");
}

db.exec("CREATE INDEX IF NOT EXISTS idx_contract_stats_empresa_tipo ON contract_stats(empresa, tipo);");

const ahoraISO = () => new Date().toISOString();

/* ---------- Usuarios ---------- */

function buscarUsuarioPorEmail(email) {
  return db
    .prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE")
    .get(email);
}

function buscarUsuarioPorId(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function listarUsuarios() {
  return db.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
}

// Usado para notificar por email a todo super_admin activo cuando una IP
// se bloquea por demasiados intentos de login fallidos (ver server.js).
function listarSuperAdminsActivos() {
  return db.prepare("SELECT * FROM users WHERE role = 'super_admin' AND status = 'active'").all();
}

function crearUsuario({ email, name, passwordHash, role, status, mustChangePassword, approvedBy, canInstallApp }) {
  const ahora = ahoraISO();
  const info = db
    .prepare(
      `INSERT INTO users
        (email, name, password_hash, role, status, must_change_password, can_install_app, created_at, updated_at, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      email.toLowerCase(),
      name || null,
      passwordHash,
      role,
      status,
      mustChangePassword ? 1 : 0,
      canInstallApp ? 1 : 0,
      ahora,
      ahora,
      approvedBy || null,
      approvedBy ? ahora : null
    );
  return buscarUsuarioPorId(Number(info.lastInsertRowid));
}

function actualizarPassword(userId, passwordHash, { mustChangePassword }) {
  db.prepare(
    `UPDATE users
     SET password_hash = ?, must_change_password = ?, updated_at = ?, failed_attempts = 0, locked_until = NULL
     WHERE id = ?`
  ).run(passwordHash, mustChangePassword ? 1 : 0, ahoraISO(), userId);
}

function actualizarRol(userId, role) {
  db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(role, ahoraISO(), userId);
}

function actualizarEstado(userId, status) {
  db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").run(status, ahoraISO(), userId);
}

function actualizarPuedeInstalarApp(userId, canInstallApp) {
  db.prepare("UPDATE users SET can_install_app = ?, updated_at = ? WHERE id = ?").run(
    canInstallApp ? 1 : 0,
    ahoraISO(),
    userId
  );
}

function registrarIntentoFallido(userId) {
  const usuario = buscarUsuarioPorId(userId);
  const intentos = (usuario.failed_attempts || 0) + 1;
  const UMBRAL_BLOQUEO = 5;
  const MINUTOS_BLOQUEO = 15;
  let bloqueadoHasta = null;
  if (intentos >= UMBRAL_BLOQUEO) {
    bloqueadoHasta = new Date(Date.now() + MINUTOS_BLOQUEO * 60 * 1000).toISOString();
  }
  db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?").run(
    intentos,
    bloqueadoHasta,
    ahoraISO(),
    userId
  );
  return { intentos, bloqueadoHasta };
}

function limpiarIntentosFallidos(userId) {
  db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?").run(
    ahoraISO(),
    userId
  );
}

/* ---------- Rate limiting de login por IP ----------
   Independiente del bloqueo por CUENTA de arriba (failed_attempts/
   locked_until): aqui se cuenta por IP, para frenar un ataque que pruebe
   muchas cuentas distintas desde la misma direccion, no solo muchos
   intentos contra una misma cuenta. */

const UMBRAL_INTENTOS_IP = 5;
const MINUTOS_VENTANA_IP = 15;
const MINUTOS_BLOQUEO_IP = 30;

// Fecha (ISO) hasta la que esa IP esta bloqueada, o null si no hay ningun
// bloqueo activo ahora mismo.
function ipBloqueadaHasta(ip) {
  if (!ip) return null;
  const fila = db
    .prepare("SELECT blocked_until FROM ip_blocks WHERE ip = ? AND blocked_until > ? ORDER BY blocked_until DESC LIMIT 1")
    .get(ip, ahoraISO());
  return fila ? fila.blocked_until : null;
}

// Registra un intento fallido de login desde esta IP. Si en los ultimos
// MINUTOS_VENTANA_IP minutos ya hay UMBRAL_INTENTOS_IP intentos o mas, crea
// un bloqueo de MINUTOS_BLOQUEO_IP minutos. El bloqueo se crea UNA sola vez
// por racha (yaAvisada=true en los intentos siguientes mientras siga
// bloqueada), para que el aviso por email a super_admin en server.js no se
// dispare mas de una vez por bloqueo.
function registrarIntentoFallidoIP(ip) {
  if (!ip) return { bloqueada: false, intentos: 0 };
  db.prepare("INSERT INTO ip_login_attempts (ip, created_at) VALUES (?, ?)").run(ip, ahoraISO());

  const desde = new Date(Date.now() - MINUTOS_VENTANA_IP * 60 * 1000).toISOString();
  const { n: intentos } = db
    .prepare("SELECT COUNT(*) AS n FROM ip_login_attempts WHERE ip = ? AND created_at > ?")
    .get(ip, desde);

  if (intentos < UMBRAL_INTENTOS_IP) return { bloqueada: false, intentos };

  const bloqueoExistente = ipBloqueadaHasta(ip);
  if (bloqueoExistente) return { bloqueada: true, intentos, bloqueadaHasta: bloqueoExistente, yaAvisada: true };

  const bloqueadaHasta = new Date(Date.now() + MINUTOS_BLOQUEO_IP * 60 * 1000).toISOString();
  db.prepare("INSERT INTO ip_blocks (ip, blocked_until, created_at) VALUES (?, ?, ?)").run(ip, bloqueadaHasta, ahoraISO());
  return { bloqueada: true, intentos, bloqueadaHasta, yaAvisada: false };
}

/* ---------- Codigos de doble factor (2FA) ---------- */

const DURACION_CODIGO_2FA_MINUTOS = 10;
const MAX_INTENTOS_CODIGO_2FA = 5;

// Crea un codigo nuevo e invalida (marca como usados) los codigos previos
// sin usar de ese mismo usuario: solo el ultimo emitido es valido, aunque
// el usuario haya pedido reenviarlo varias veces.
function crearCodigo2FA({ userId, codeHash }) {
  db.prepare("UPDATE two_factor_codes SET used = 1 WHERE user_id = ? AND used = 0").run(userId);
  const expiraEn = new Date(Date.now() + DURACION_CODIGO_2FA_MINUTOS * 60 * 1000).toISOString();
  const info = db
    .prepare("INSERT INTO two_factor_codes (user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(userId, codeHash, expiraEn, ahoraISO());
  return Number(info.lastInsertRowid);
}

function buscarCodigo2FAVigente(userId) {
  return db
    .prepare("SELECT * FROM two_factor_codes WHERE user_id = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1")
    .get(userId, ahoraISO());
}

function incrementarIntentosCodigo2FA(id) {
  db.prepare("UPDATE two_factor_codes SET attempts = attempts + 1 WHERE id = ?").run(id);
}

function marcarCodigo2FAUsado(id) {
  db.prepare("UPDATE two_factor_codes SET used = 1 WHERE id = ?").run(id);
}

/* ---------- Solicitudes de acceso ---------- */

function crearSolicitudAcceso({ email, name, message }) {
  const ahora = ahoraISO();
  const info = db
    .prepare(
      `INSERT INTO access_requests (email, name, message, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`
    )
    .run(email.toLowerCase(), name || null, message || null, ahora);
  return db.prepare("SELECT * FROM access_requests WHERE id = ?").get(Number(info.lastInsertRowid));
}

function solicitudPendientePorEmail(email) {
  return db
    .prepare("SELECT * FROM access_requests WHERE email = ? COLLATE NOCASE AND status = 'pending'")
    .get(email);
}

function listarSolicitudes(status) {
  if (status) {
    return db
      .prepare("SELECT * FROM access_requests WHERE status = ? ORDER BY created_at DESC")
      .all(status);
  }
  return db.prepare("SELECT * FROM access_requests ORDER BY created_at DESC").all();
}

function buscarSolicitudPorId(id) {
  return db.prepare("SELECT * FROM access_requests WHERE id = ?").get(id);
}

function resolverSolicitud(id, status, resolvedBy) {
  db.prepare(
    "UPDATE access_requests SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?"
  ).run(status, ahoraISO(), resolvedBy, id);
}

/* ---------- Sesiones ---------- */

function crearSesion({ id, userId, expiresAt, userAgent, ip }) {
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked, user_agent, ip)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).run(id, userId, ahoraISO(), expiresAt, userAgent || null, ip || null);
}

function buscarSesion(id) {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
}

function revocarSesion(id) {
  db.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?").run(id);
}

function revocarSesionesDeUsuario(userId) {
  db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(userId);
}

function limpiarSesionesCaducadas() {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(ahoraISO());
}

/* ---------- Alianzas (acuerdos entre empresas de alarmas y otros sectores) ---------- */
//
// El scraper de la Raspberry Pi (scraper_alianzas.py) envia periodicamente
// las alianzas que detecta a POST /api/alianzas/sync. Cada una entra como
// 'pending': solo el Super Admin las ve hasta que las publica (visibles para
// todos) o las descarta (ocultas para siempre). `external_id` es un hash
// estable generado por el scraper a partir de la URL de la noticia, para no
// duplicar la misma alianza en sucesivas ejecuciones diarias.

// Devuelve { count, filas }: filas son los elementos de `lista` que
// realmente se han insertado (no las que ya existian y INSERT OR IGNORE ha
// descartado), para que el llamador pueda avisar (push/email) solo de las
// alianzas que de verdad son nuevas.
function insertarAlianzasPendientes(lista) {
  const ahora = ahoraISO();
  const insertar = db.prepare(
    `INSERT OR IGNORE INTO alianzas
      (external_id, empresa_alarma, sector, socio, tipo_acuerdo, titular, fuente, url, fecha_publicacion, fecha_deteccion, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  );
  const filas = [];
  for (const a of lista) {
    const info = insertar.run(
      a.externalId,
      a.empresaAlarma,
      a.sector,
      a.socio,
      a.tipoAcuerdo || null,
      a.titular || null,
      a.fuente || null,
      a.url || null,
      a.fechaPublicacion || null,
      a.fechaDeteccion || ahora,
      ahora
    );
    if (info.changes > 0) filas.push(a);
  }
  return { count: filas.length, filas };
}

function alianzaPublica(a) {
  return {
    id: a.id,
    empresaAlarma: a.empresa_alarma,
    sector: a.sector,
    socio: a.socio,
    tipoAcuerdo: a.tipo_acuerdo,
    titular: a.titular,
    fuente: a.fuente,
    url: a.url,
    fechaPublicacion: a.fecha_publicacion,
    fechaDeteccion: a.fecha_deteccion,
    // Fecha en la que un super_admin publico esta alianza (la hizo visible
    // como "noticia" en Inicio para todos los roles); distinta de
    // fecha_publicacion (fecha del articulo original detectado por el
    // scraper). Ver tambien borrarAlianzasPublicadasCaducadas: usa esta
    // misma fecha para el borrado automatico a los 7 dias.
    publicadaEn: a.reviewed_at,
    status: a.status,
  };
}

function listarAlianzasPorEstado(status) {
  return db
    .prepare("SELECT * FROM alianzas WHERE status = ? ORDER BY fecha_deteccion DESC, id DESC")
    .all(status)
    .map(alianzaPublica);
}

function buscarAlianzaPorId(id) {
  return db.prepare("SELECT * FROM alianzas WHERE id = ?").get(id);
}

function resolverAlianza(id, status, reviewedBy) {
  db.prepare(
    "UPDATE alianzas SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?"
  ).run(status, ahoraISO(), reviewedBy, id);
}

function fechaUltimaAlianza() {
  const fila = db.prepare("SELECT MAX(created_at) AS ultima FROM alianzas").get();
  return (fila && fila.ultima) || null;
}

// Las "noticias del sector" de Inicio son las alianzas publicadas: dejan de
// mostrarse pasados 7 dias desde que un super_admin las publico, borrandolas
// definitivamente en vez de solo ocultarlas. Se llama en cada GET
// /api/alianzas (ver server.js) para no depender de un cron aparte.
function borrarAlianzasPublicadasCaducadas() {
  const limite = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const info = db
    .prepare("DELETE FROM alianzas WHERE status = 'published' AND reviewed_at < ?")
    .run(limite);
  return info.changes;
}

// Borrado manual e inmediato de una alianza/noticia concreta (boton
// "Eliminar" de Inicio, solo super_admin), sin esperar a los 7 dias.
function eliminarAlianza(id) {
  const info = db.prepare("DELETE FROM alianzas WHERE id = ?").run(id);
  return info.changes;
}

// Usado por "Resetear datos" de la pestana Alianzas (solo super_admin):
// borra pendientes, publicadas y descartadas de un golpe.
function borrarAlianzas() {
  const info = db.prepare("DELETE FROM alianzas").run();
  return info.changes;
}

/* ---------- Ofertas (promociones vigentes por empresa de alarmas) ---------- */
//
// El scraper de la Raspberry Pi (scraper_precios.py) envia periodicamente
// las promociones que detecta a POST /api/ofertas/sync. A diferencia de
// alianzas no hay cola de moderacion: se guardan directamente y la pestaña
// "Ofertas" muestra, por cada empresa, la promocion detectada mas reciente.
// `external_id` es un hash estable generado por el scraper a partir de la
// URL de la noticia, para no duplicar la misma promocion en sucesivas
// ejecuciones diarias.

function insertarOfertas(lista) {
  const ahora = ahoraISO();
  const insertar = db.prepare(
    `INSERT OR IGNORE INTO ofertas
      (external_id, empresa, titulo, fuente, url, fecha_publicacion, fecha_deteccion, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const filas = [];
  for (const o of lista) {
    const info = insertar.run(
      o.externalId,
      o.empresa,
      o.titulo || null,
      o.fuente || null,
      o.url || null,
      o.fechaPublicacion || null,
      o.fechaDeteccion || ahora,
      ahora
    );
    if (info.changes > 0) filas.push(o);
  }
  return { count: filas.length, filas };
}

function ofertaPublica(o) {
  return {
    id: o.id,
    empresa: o.empresa,
    titulo: o.titulo,
    fuente: o.fuente,
    url: o.url,
    fechaPublicacion: o.fecha_publicacion,
    fechaDeteccion: o.fecha_deteccion,
  };
}

// Una fila por empresa: la promocion detectada mas reciente (por fecha de
// deteccion; a igualdad de fecha, la de id mayor).
function listarUltimaOfertaPorEmpresa() {
  return db
    .prepare(
      `SELECT o.* FROM ofertas o
       WHERE o.id = (
         SELECT id FROM ofertas o2
         WHERE o2.empresa = o.empresa
         ORDER BY o2.fecha_deteccion DESC, o2.id DESC
         LIMIT 1
       )
       ORDER BY o.empresa ASC`
    )
    .all()
    .map(ofertaPublica);
}

function fechaUltimaOferta() {
  const fila = db.prepare("SELECT MAX(created_at) AS ultima FROM ofertas").get();
  return (fila && fila.ultima) || null;
}

/* ---------- Estadisticas y Repositorio (contract_stats) ---------- */
//
// contract_stats guarda, por cada contrato pasado por /api/analisis,
// provincia + empresa detectadas (antes de anonimizar), la puntuacion y
// clausulas de riesgo ya calculadas, y el texto YA ANONIMIZADO completo
// (Repositorio): nunca el texto original ni ningun dato personal, porque la
// anonimizacion ya sustituyo nombres/DNI/IBAN/telefono/email/direccion/CP
// antes de que este texto se genere. `tipo` (hogar/negocio) se detecta
// automaticamente por palabras clave (ver detectarTipoContrato en
// analisis.js) y se guarda ya en el INSERT; si no hay certeza (o para
// contratos antiguos de antes de esta deteccion), llega vacio y se puede
// rellenar despues desde la pestana Analisis o Repositorio.
// tab_visits registra que un usuario ha abierto una pestana de la app, para
// poder mostrar "pestañas mas usadas" en la actividad del equipo.

function registrarContratoAnalizado({ provincia, empresa, puntuacion, clausulas, textoAnonimizado, userId, tipo }) {
  const info = db
    .prepare(
      `INSERT INTO contract_stats (provincia, empresa, puntuacion, clausulas_json, texto_anonimizado, user_id, created_at, tipo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      provincia || null,
      empresa || null,
      Number.isFinite(puntuacion) ? puntuacion : null,
      JSON.stringify(clausulas || []),
      cifrado.cifrar(textoAnonimizado || null),
      userId || null,
      ahoraISO(),
      tipo === "hogar" || tipo === "negocio" ? tipo : null
    );
  return Number(info.lastInsertRowid);
}

function contarContratosAnalizados() {
  return db.prepare("SELECT COUNT(*) AS n FROM contract_stats").get().n;
}

// created_at se guarda en UTC (new Date().toISOString()); date('now') de
// SQLite tambien es UTC por defecto, asi que ambas fechas son comparables
// sin conversion de zona horaria.
function contarContratosAnalizadosHoy() {
  return db
    .prepare("SELECT COUNT(*) AS n FROM contract_stats WHERE date(created_at) = date('now')")
    .get().n;
}

// "Alerta activa" = contrato de riesgo alto o muy alto detectado hoy
// (mismo umbral que nivelDesdeRiesgo en server.js: puntuacion > 6).
function contarAlertasActivasHoy() {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM contract_stats WHERE date(created_at) = date('now') AND puntuacion > 6"
    )
    .get().n;
}

function riesgoPromedioContratos() {
  const fila = db.prepare("SELECT AVG(puntuacion) AS media FROM contract_stats WHERE puntuacion IS NOT NULL").get();
  return fila && fila.media !== null ? fila.media : null;
}

function listarClausulasContratos() {
  return db.prepare("SELECT clausulas_json FROM contract_stats WHERE clausulas_json IS NOT NULL").all();
}

/* ---------- Repositorio de contratos ---------- */
//
// Vista completa (no solo agregada) de contract_stats: listado para
// filtrar/clasificar/detectar cambios, y detalle individual con el texto
// anonimizado completo. Se listan SIEMPRE en orden cronologico ascendente
// para que la deteccion de cambios (server.js) compare cada contrato con el
// inmediatamente anterior de su mismo grupo empresa+tipo.

function listarRepositorioResumen() {
  return db
    .prepare(
      `SELECT id, provincia, empresa, tipo, puntuacion, clausulas_json, created_at, user_id
       FROM contract_stats
       ORDER BY created_at ASC, id ASC`
    )
    .all();
}

function obtenerContratoDetalle(id) {
  const fila = db.prepare("SELECT * FROM contract_stats WHERE id = ?").get(id);
  if (fila) fila.texto_anonimizado = cifrado.descifrar(fila.texto_anonimizado);
  return fila;
}

function clasificarContrato(id, tipo) {
  db.prepare("UPDATE contract_stats SET tipo = ? WHERE id = ?").run(tipo, id);
  return db.prepare("SELECT id, tipo FROM contract_stats WHERE id = ?").get(id);
}

// Usado por "Resetear datos de prueba" (panel de Super Admin): contract_stats
// es la unica tabla que alimenta Repositorio, Estadisticas y el mapa de
// provincias (estadisticasPorProvincia lee de aqui), asi que borrarla entera
// limpia los tres a la vez sin tocar usuarios, sesiones ni alianzas.
function borrarContractStats() {
  const info = db.prepare("DELETE FROM contract_stats").run();
  return info.changes;
}

/* ---------- Repositorio de analisis avanzados (contratos_avanzados) ---------- */
//
// Analogo a contract_stats/Repositorio pero para el analisis legal avanzado
// con IA (clausula por clausula, con resumen y base legal): cada llamada a
// /api/analisis-avanzado guarda aqui su resultado ya anonimizado. Se lista
// SIEMPRE en orden cronologico ascendente por el mismo motivo que
// listarRepositorioResumen: la deteccion de cambios (server.js) compara cada
// analisis con el inmediatamente anterior de su mismo grupo empresa+tipo.

function registrarAnalisisAvanzado({
  provincia,
  empresa,
  tipo,
  fechaContrato,
  puntuacion,
  nivelGlobal,
  resumenGeneral,
  clausulas,
  totalAnonimizado,
  textoAnonimizado,
  userId,
}) {
  const insertar = (uid) =>
    db
      .prepare(
        `INSERT INTO contratos_avanzados
          (provincia, empresa, tipo, fecha_contrato, puntuacion, nivel_global, resumen_general, clausulas_json, total_anonimizado, texto_anonimizado, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        provincia || null,
        empresa || null,
        tipo === "hogar" || tipo === "negocio" ? tipo : null,
        fechaContrato || null,
        Number.isFinite(puntuacion) ? puntuacion : null,
        nivelGlobal || null,
        resumenGeneral || null,
        JSON.stringify(clausulas || []),
        Number.isFinite(totalAnonimizado) ? totalAnonimizado : null,
        cifrado.cifrar(textoAnonimizado || null),
        uid || null,
        ahoraISO()
      );

  try {
    return Number(insertar(userId).lastInsertRowid);
  } catch (e) {
    // FK contratos_avanzados.user_id -> users(id): si el usuario que lanzo el
    // analisis se elimino entre el inicio de la peticion (ya autenticada) y
    // este guardado (el analisis con IA puede tardar decenas de segundos), la
    // insercion con ese user_id viola la FK. El analisis en si sigue siendo
    // valido: se guarda igual, sin usuario, en vez de perderlo.
    if (userId && /FOREIGN KEY/i.test(e.message || "")) {
      return Number(insertar(null).lastInsertRowid);
    }
    throw e;
  }
}

// Cola de reintento para analisis avanzados cuyo guardado en
// contratos_avanzados fallo (disco lleno, fila corrupta, etc.): apiAnalisisAvanzado
// entrega el PDF al usuario igualmente y encola aqui el analisis completo para
// que un super_admin/admin pueda reintentar el guardado desde el Repositorio
// (ver apiRepositorioAvanzadoPendientes* en server.js) sin tener que repetir
// la llamada a la IA.
function registrarAnalisisAvanzadoPendiente(payload, errorMensaje) {
  const paraGuardar = { ...payload, textoAnonimizado: cifrado.cifrar(payload.textoAnonimizado || null) };
  const info = db
    .prepare(
      `INSERT INTO contratos_avanzados_pendientes (payload_json, error_mensaje, intentos, created_at)
       VALUES (?, ?, 0, ?)`
    )
    .run(JSON.stringify(paraGuardar), errorMensaje || null, ahoraISO());
  return Number(info.lastInsertRowid);
}

function listarAnalisisAvanzadoPendientes() {
  return db
    .prepare(
      `SELECT id, payload_json, error_mensaje, intentos, created_at
       FROM contratos_avanzados_pendientes
       ORDER BY created_at ASC, id ASC`
    )
    .all();
}

function borrarAnalisisAvanzadoPendiente(id) {
  db.prepare("DELETE FROM contratos_avanzados_pendientes WHERE id = ?").run(id);
}

// Usado junto con borrarAnalisisAvanzado() en los reseteos (global y por
// pestaña "contratos"): sin esto, un reseteo dejaria en la cola analisis
// pendientes de guardar que ya no tienen sentido reintentar.
function borrarAnalisisAvanzadoPendientes() {
  db.prepare("DELETE FROM contratos_avanzados_pendientes").run();
}

function marcarReintentoFallidoPendiente(id, errorMensaje) {
  db.prepare("UPDATE contratos_avanzados_pendientes SET intentos = intentos + 1, error_mensaje = ? WHERE id = ?").run(
    errorMensaje || null,
    id
  );
}

// Reintenta guardar en contratos_avanzados un analisis avanzado de la cola
// de pendientes, sin volver a llamar a la IA (el analisis ya se hizo: solo
// se reintenta la escritura en la base de datos). Con exito, retira la fila
// de la cola; si vuelve a fallar, deja constancia del intento y el error
// para el siguiente reintento.
function reintentarAnalisisAvanzadoPendiente(id) {
  const fila = db.prepare("SELECT * FROM contratos_avanzados_pendientes WHERE id = ?").get(id);
  if (!fila) return { ok: false, error: "No encontrado" };

  let payload;
  try {
    payload = JSON.parse(fila.payload_json);
    payload.textoAnonimizado = cifrado.descifrar(payload.textoAnonimizado);
  } catch (e) {
    marcarReintentoFallidoPendiente(id, "Datos pendientes corruptos: " + e.message);
    return { ok: false, error: e.message };
  }

  try {
    const nuevoId = registrarAnalisisAvanzado(payload);
    borrarAnalisisAvanzadoPendiente(id);
    return { ok: true, id: nuevoId };
  } catch (e) {
    marcarReintentoFallidoPendiente(id, e.message);
    return { ok: false, error: e.message };
  }
}

function listarAnalisisAvanzadoResumen() {
  return db
    .prepare(
      `SELECT id, provincia, empresa, tipo, puntuacion, nivel_global, resumen_general, clausulas_json, total_anonimizado, created_at, user_id
       FROM contratos_avanzados
       ORDER BY created_at ASC, id ASC`
    )
    .all();
}

function obtenerAnalisisAvanzadoDetalle(id) {
  const fila = db.prepare("SELECT * FROM contratos_avanzados WHERE id = ?").get(id);
  if (fila) fila.texto_anonimizado = cifrado.descifrar(fila.texto_anonimizado);
  return fila;
}

function clasificarAnalisisAvanzado(id, tipo) {
  db.prepare("UPDATE contratos_avanzados SET tipo = ? WHERE id = ?").run(tipo, id);
  return db.prepare("SELECT id, tipo FROM contratos_avanzados WHERE id = ?").get(id);
}

// Usado por "Resetear datos de prueba" y el reseteo por pestana (ambito
// "contratos"): contratos_avanzados solo alimenta la vista "Analisis
// Avanzados" del Repositorio, asi que se borra junto con contract_stats.
function borrarAnalisisAvanzado() {
  const info = db.prepare("DELETE FROM contratos_avanzados").run();
  return info.changes;
}

function estadisticasPorProvincia() {
  return db
    .prepare(
      `SELECT provincia, empresa, COUNT(*) AS n
       FROM contract_stats
       WHERE provincia IS NOT NULL AND empresa IS NOT NULL
       GROUP BY provincia, empresa
       ORDER BY provincia ASC, n DESC`
    )
    .all();
}

function contarUsuariosActivos() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").get().n;
}

// Devuelve el id de la fila insertada: el frontend lo guarda para poder
// reportar mas tarde, contra ESA visita concreta, cuanto tiempo estuvo en
// la pestaña (finalizarVisitaTab, al salir de ella) y si intento copiar
// texto mientras estaba en ella (registrarIntentoCopiaTab). Ver medidas de
// seguridad del rol retencion en index.html.
function registrarVisitaTab({ userId, tab }) {
  const info = db
    .prepare("INSERT INTO tab_visits (user_id, tab, created_at) VALUES (?, ?, ?)")
    .run(userId, tab, ahoraISO());
  return Number(info.lastInsertRowid);
}

// Se llama al salir de una pestaña (cambio a otra pestaña, cierre de la
// app o de la sesion) con el tiempo transcurrido desde que se registro esa
// visita. El WHERE por user_id, ademas del id, evita que un usuario pueda
// sobrescribir la duracion de una visita de otra persona falseando el id.
function finalizarVisitaTab({ id, userId, duracionSegundos }) {
  db.prepare("UPDATE tab_visits SET duration_seconds = ? WHERE id = ? AND user_id = ?").run(
    Math.max(0, Math.round(Number(duracionSegundos) || 0)),
    id,
    userId
  );
}

// Se llama cuando el navegador bloquea un intento de copiar/cortar/menu
// contextual en una pestaña de contenido sensible (ver medidas de
// seguridad del rol retencion en index.html): suma 1 al contador de esa
// visita concreta, para poder mostrar en el panel de Super Admin cuantas
// veces lo intento mientras estaba en esa pestaña.
function registrarIntentoCopiaTab({ id, userId }) {
  db.prepare("UPDATE tab_visits SET copy_intentos = copy_intentos + 1 WHERE id = ? AND user_id = ?").run(id, userId);
}

// Actividad detallada del rol retencion para el panel de Super Admin:
// una fila por cada pestaña que abrio, con cuanto tiempo estuvo y cuantas
// veces intento copiar texto mientras la tenia abierta. A diferencia de
// actividadTiempoReal() (solo la ULTIMA pestaña de cada usuario, para el
// resumen de Estadisticas), esto es el HISTORICO completo, solo del rol
// retencion, paginado igual que listarAuditoria.
function listarActividadRetencion({ limit, before } = {}) {
  const tope = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const base = `SELECT tv.id, tv.tab, tv.duration_seconds, tv.copy_intentos, tv.created_at,
                       u.id AS user_id, u.email, u.name
                FROM tab_visits tv
                JOIN users u ON u.id = tv.user_id
                WHERE u.role = 'retencion'`;
  if (before) {
    return db.prepare(`${base} AND tv.id < ? ORDER BY tv.id DESC LIMIT ?`).all(Number(before), tope);
  }
  return db.prepare(`${base} ORDER BY tv.id DESC LIMIT ?`).all(tope);
}

function actividadUsuariosActivos() {
  return db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role,
              (SELECT MAX(created_at) FROM sessions WHERE user_id = u.id) AS ultima_conexion
       FROM users u
       WHERE u.status = 'active'
       ORDER BY ultima_conexion DESC`
    )
    .all();
}

function conteoVisitasPorUsuarioYTab() {
  return db
    .prepare(
      `SELECT user_id, tab, COUNT(*) AS n
       FROM tab_visits
       GROUP BY user_id, tab`
    )
    .all();
}

/* ---------- Notas privadas y vigilancia de empresas (Comparador) ---------- */
//
// Solo super_admin puede leer/escribir (ver server.js): notas internas por
// empresa del comparador (texto libre) y marca de "vigilar", con quien la
// actualizo por ultima vez. `empresa` es la clave (coincide con el texto de
// data-company en index.html), asi que una fila por empresa basta.

function listarNotasEmpresas() {
  return db.prepare("SELECT * FROM company_notes").all();
}

function guardarNotaEmpresa({ empresa, nota, userId }) {
  db.prepare(
    `INSERT INTO company_notes (empresa, nota, vigilada, updated_by, updated_at)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(empresa) DO UPDATE SET
       nota = excluded.nota, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(empresa, nota || null, userId || null, ahoraISO());
  return db.prepare("SELECT * FROM company_notes WHERE empresa = ?").get(empresa);
}

function alternarVigilanciaEmpresa({ empresa, vigilada, userId }) {
  db.prepare(
    `INSERT INTO company_notes (empresa, nota, vigilada, updated_by, updated_at)
     VALUES (?, NULL, ?, ?, ?)
     ON CONFLICT(empresa) DO UPDATE SET
       vigilada = excluded.vigilada, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(empresa, vigilada ? 1 : 0, userId || null, ahoraISO());
  return db.prepare("SELECT * FROM company_notes WHERE empresa = ?").get(empresa);
}

// Usado por "Resetear datos" de la pestana Comparador (solo super_admin):
// borra todas las notas internas y marcas de vigilancia por empresa.
function borrarNotasEmpresas() {
  const info = db.prepare("DELETE FROM company_notes").run();
  return info.changes;
}

/* ---------- Actividad en tiempo real (Estadisticas) ---------- */
//
// Combina la ultima pestana visitada (tab_visits) con la ultima accion de
// auditoria (audit_log) por usuario activo, para la tabla "Actividad en
// tiempo real". A diferencia de actividadUsuariosActivos() (conexion mas
// reciente historica), esto refleja lo que el usuario esta haciendo ahora.

function actividadTiempoReal() {
  return db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role,
              (SELECT tab FROM tab_visits WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS pestana_activa,
              (SELECT created_at FROM tab_visits WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS hora_pestana,
              (SELECT action FROM audit_log WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS ultima_accion,
              (SELECT created_at FROM audit_log WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS hora_accion
       FROM users u
       WHERE u.status = 'active'
       ORDER BY hora_pestana DESC`
    )
    .all();
}

/* ---------- Logs de auditoria ---------- */
//
// Registra acciones importantes (login, logout, analisis de contrato,
// publicar alianza, cambio de rol) para el panel de Super Admin. Nunca debe
// romper el flujo que la origina: el llamador (server.js) envuelve cada
// llamada en try/catch. `email` se guarda desnormalizado (ademas de
// user_id) para que el registro siga siendo legible aunque el usuario se
// borre en el futuro.

function registrarAuditoria({ userId, email, action, detail, ip }) {
  db.prepare(
    `INSERT INTO audit_log (user_id, email, action, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId || null, email || null, action, cifrado.cifrar(detail || null), ip || null, ahoraISO());
}

function listarAuditoria({ limit, before } = {}) {
  const tope = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const filas = before
    ? db.prepare("SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?").all(Number(before), tope)
    : db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(tope);
  filas.forEach((f) => { f.detail = cifrado.descifrar(f.detail); });
  return filas;
}

// Usado por "Limpiar logs de auditoría" (panel de Super Admin, confirmado
// con contraseña en server.js): borra TODO el historial de audit_log.
function borrarAuditoria() {
  const info = db.prepare("DELETE FROM audit_log").run();
  return info.changes;
}

/* ---------- Suscripciones push (notificaciones web) ---------- */
//
// Un mismo usuario puede tener varias suscripciones (una por navegador o
// dispositivo); `endpoint` es unico porque lo genera el navegador y ya
// identifica de forma univoca esa suscripcion concreta. Si el usuario ya
// tenia una suscripcion con ese mismo endpoint (recarga de pagina, permiso
// vuelto a conceder), se actualiza en vez de duplicarla.

function guardarSuscripcionPush({ userId, endpoint, p256dh, auth }) {
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth`
  ).run(userId, endpoint, p256dh, auth, ahoraISO());
}

// Se llama cuando el envio a un endpoint falla con 404/410: el navegador ya
// no reconoce esa suscripcion (desinstalada, permiso revocado, perfil
// borrado...) y hay que dejar de intentar enviarle nada.
function borrarSuscripcionPush(endpoint) {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

function listarSuscripcionesPorUsuario(userId) {
  return db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(userId);
}

function listarSuscripcionesPorRoles(roles) {
  const marcadores = roles.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT ps.* FROM push_subscriptions ps
       JOIN users u ON u.id = ps.user_id
       WHERE u.role IN (${marcadores}) AND u.status = 'active'`
    )
    .all(...roles);
}

module.exports = {
  db,
  DIR_DATOS,
  buscarUsuarioPorEmail,
  buscarUsuarioPorId,
  listarUsuarios,
  listarSuperAdminsActivos,
  crearUsuario,
  actualizarPassword,
  actualizarRol,
  actualizarEstado,
  actualizarPuedeInstalarApp,
  registrarIntentoFallido,
  limpiarIntentosFallidos,
  ipBloqueadaHasta,
  registrarIntentoFallidoIP,
  crearCodigo2FA,
  buscarCodigo2FAVigente,
  incrementarIntentosCodigo2FA,
  marcarCodigo2FAUsado,
  MAX_INTENTOS_CODIGO_2FA,
  crearSolicitudAcceso,
  solicitudPendientePorEmail,
  listarSolicitudes,
  buscarSolicitudPorId,
  resolverSolicitud,
  crearSesion,
  buscarSesion,
  revocarSesion,
  revocarSesionesDeUsuario,
  limpiarSesionesCaducadas,
  insertarAlianzasPendientes,
  listarAlianzasPorEstado,
  buscarAlianzaPorId,
  resolverAlianza,
  fechaUltimaAlianza,
  borrarAlianzasPublicadasCaducadas,
  eliminarAlianza,
  borrarAlianzas,
  insertarOfertas,
  listarUltimaOfertaPorEmpresa,
  fechaUltimaOferta,
  registrarContratoAnalizado,
  contarContratosAnalizados,
  contarContratosAnalizadosHoy,
  contarAlertasActivasHoy,
  riesgoPromedioContratos,
  listarClausulasContratos,
  listarRepositorioResumen,
  obtenerContratoDetalle,
  clasificarContrato,
  borrarContractStats,
  registrarAnalisisAvanzado,
  listarAnalisisAvanzadoResumen,
  obtenerAnalisisAvanzadoDetalle,
  clasificarAnalisisAvanzado,
  borrarAnalisisAvanzado,
  registrarAnalisisAvanzadoPendiente,
  listarAnalisisAvanzadoPendientes,
  borrarAnalisisAvanzadoPendiente,
  borrarAnalisisAvanzadoPendientes,
  marcarReintentoFallidoPendiente,
  reintentarAnalisisAvanzadoPendiente,
  estadisticasPorProvincia,
  contarUsuariosActivos,
  registrarVisitaTab,
  finalizarVisitaTab,
  registrarIntentoCopiaTab,
  listarActividadRetencion,
  actividadUsuariosActivos,
  conteoVisitasPorUsuarioYTab,
  listarNotasEmpresas,
  guardarNotaEmpresa,
  alternarVigilanciaEmpresa,
  borrarNotasEmpresas,
  actividadTiempoReal,
  registrarAuditoria,
  listarAuditoria,
  borrarAuditoria,
  guardarSuscripcionPush,
  borrarSuscripcionPush,
  listarSuscripcionesPorUsuario,
  listarSuscripcionesPorRoles,
};
