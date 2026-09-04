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

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_requests_status ON access_requests(status);
  CREATE INDEX IF NOT EXISTS idx_alianzas_status ON alianzas(status);
`);

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

function crearUsuario({ email, name, passwordHash, role, status, mustChangePassword, approvedBy }) {
  const ahora = ahoraISO();
  const info = db
    .prepare(
      `INSERT INTO users
        (email, name, password_hash, role, status, must_change_password, created_at, updated_at, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      email.toLowerCase(),
      name || null,
      passwordHash,
      role,
      status,
      mustChangePassword ? 1 : 0,
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

function insertarAlianzasPendientes(lista) {
  const ahora = ahoraISO();
  const insertar = db.prepare(
    `INSERT OR IGNORE INTO alianzas
      (external_id, empresa_alarma, sector, socio, tipo_acuerdo, titular, fuente, url, fecha_publicacion, fecha_deteccion, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  );
  let insertadas = 0;
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
    if (info.changes > 0) insertadas++;
  }
  return insertadas;
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

module.exports = {
  db,
  DIR_DATOS,
  buscarUsuarioPorEmail,
  buscarUsuarioPorId,
  listarUsuarios,
  crearUsuario,
  actualizarPassword,
  actualizarRol,
  actualizarEstado,
  registrarIntentoFallido,
  limpiarIntentosFallidos,
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
};
