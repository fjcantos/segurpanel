# SegurPanel

**SegurPanel** es una PWA (Progressive Web App) interna para el equipo de
retención y ventas de **UIC**, especializada en el sector de alarmas y
seguridad privada en España. Centraliza en una sola herramienta la
comparativa de competencia, el análisis legal de contratos con IA, material
de formación, generación de propuestas comerciales y un asistente de IA
experto en retención de clientes — todo con autenticación, control de roles
y auditoría.

Para el detalle de cada pestaña y funcionalidad, ver [DOCUMENTACION.md](DOCUMENTACION.md).
Para el diagrama de arquitectura del sistema completo (Render, Raspberry Pi,
GitHub, APIs externas), ver [ARQUITECTURA.md](ARQUITECTURA.md).

## Índice

- [Descripción](#descripción)
- [Tecnologías](#tecnologías)
- [Estructura de carpetas](#estructura-de-carpetas)
- [Instalación local](#instalación-local)
- [Variables de entorno](#variables-de-entorno)
- [Despliegue en Render](#despliegue-en-render)
- [Documentación adicional](#documentación-adicional)

## Descripción

SegurPanel exige inicio de sesión (solo correos `@verisure.es`) y ofrece,
según el rol del usuario, 13 pestañas funcionales:

| Área | Pestañas |
| --- | --- |
| Comparativa de mercado | Inicio, Comparador, Ofertas, Alianzas, Equipos, Inteligencia |
| Análisis de contratos con IA | Análisis, Análisis Avanzado, Repositorio |
| Gestión interna | Estadísticas |
| Generación de contenido con IA | Generador de Propuestas, Formaciones |
| Asistencia | IA Assistant |

Incluye además un panel de administración (`/admin`) para gestionar usuarios,
solicitudes de acceso y auditoría, y dos scrapers en Python pensados para
ejecutarse por cron en una Raspberry Pi, que alimentan las pestañas Alianzas
y Ofertas con datos actualizados a diario.

Ver [DOCUMENTACION.md](DOCUMENTACION.md) para el detalle completo de cada
pestaña.

## Tecnologías

**Backend**
- [Node.js](https://nodejs.org/) ≥ 22.5 (recomendado 24) — servidor HTTP
  hecho a mano con el módulo nativo `http`/`https` (sin framework tipo
  Express).
- [`node:sqlite`](https://nodejs.org/api/sqlite.html) — base de datos SQLite
  incorporada en Node; no requiere instalar ni compilar un motor aparte.
- `bcryptjs` — hash de contraseñas (JS puro, sin compilación nativa).
- `jsonwebtoken` — sesiones firmadas (JWT, HS256).
- `multer` — subida de archivos (contratos, PPTX).
- `pdfkit` / `exceljs` / `pptxgenjs` / `jszip` — generación de informes PDF,
  exportación a Excel y presentaciones PPTX.
- `pdf-parse`, `mammoth`, `word-extractor`, `node-tesseract-ocr` — extracción
  de texto de contratos en PDF, Word, OpenDocument e imágenes escaneadas
  (OCR).
- `sharp` — procesado de imágenes (iconos PWA, infografías).
- `web-push` / `nodemailer` — notificaciones push y correo.

**Frontend**
- HTML, CSS y JavaScript "vanilla" (sin framework ni bundler): `index.html`,
  `login.html`, `admin.html`.
- PWA instalable: `manifest.json` + `sw.js` (service worker con caché para
  uso sin conexión).

**IA / APIs externas**
- [API de Anthropic (Claude)](https://www.anthropic.com/) — chat del IA
  Assistant (`claude-haiku-4-5-20251001`), Análisis Avanzado, Generador de
  Propuestas y Formaciones (`claude-opus-5`). La clave de API nunca se envía
  al navegador: todas las llamadas pasan por `server.js`.
- [Unsplash API](https://unsplash.com/developers) — fotos de fondo reales
  para las diapositivas de Formaciones (opcional).
- [Google News RSS](https://news.google.com/) — fuente de los scrapers de
  Alianzas y Ofertas.

**Automatización**
- Python 3 (solo librería estándar) — `scraper_alianzas.py` y
  `scraper_precios.py`, pensados para ejecutarse por cron en una Raspberry
  Pi u otro equipo siempre encendido.

## Estructura de carpetas

```
segurpanel/
├── server.js              Servidor HTTP: autenticación, todas las rutas /api/*,
│                           estáticos de la PWA, proxy a la API de Anthropic
├── db.js                  Capa de datos (node:sqlite): usuarios, sesiones,
│                           alianzas, ofertas, repositorio, auditoría...
├── auth.js                Contraseñas, JWT, cookies de sesión, roles,
│                           bloqueo por intentos fallidos
├── analisis.js             Extracción de texto y anonimización de contratos,
│                           detección de empresa/provincia/tipo, informe PDF
├── formaciones.js          Generación de presentaciones PPTX con IA (battlecards,
│                           formación completa por compañía, infografías)
├── backup.js               Copia diaria de la base de datos (últimos 7 días)
├── email.js                Envío de correos (nodemailer)
├── push.js                 Notificaciones push (web-push)
├── index.html              App principal (todas las pestañas, una vez logueado)
├── login.html               Pantalla de login + solicitud de acceso
├── admin.html               Panel de gestión de usuarios y auditoría (Super Admin)
├── manifest.json            Manifiesto PWA (nombre, iconos, accesos directos)
├── sw.js                    Service worker (caché sin conexión)
├── assets/                  Logo original de UIC (fuente de los iconos)
├── icons/                   Iconos PNG generados para la PWA
├── tools/
│   └── generate-icons.js    Regenera icons/ a partir de assets/LOGO_UIC_limpio.png
├── scraper_alianzas.py      Scraper de alianzas (Raspberry Pi, cron diario)
├── scraper_precios.py       Scraper de ofertas/precios (Raspberry Pi, cron diario)
├── data/                    SQLite, secreto JWT y backups (NO se sube a git)
├── package.json
└── .gitignore
```

## Instalación local

**Requisitos:** Node.js 22.5 o superior (recomendado 24, que ya no requiere
flag experimental para `node:sqlite`).

```bash
git clone <url-del-repositorio>
cd segurpanel
npm install
```

Configura la clave de la API de Anthropic (obligatoria para que funcionen el
IA Assistant, el Análisis Avanzado, el Generador de Propuestas y
Formaciones):

```bash
setx ANTHROPIC_API_KEY "sk-ant-tu-clave-aqui"
```

Abre una terminal nueva tras ejecutar `setx` para que la variable esté
disponible, y arranca el servidor:

```bash
npm start
```

Abre `http://localhost:3000/` en el navegador (no abras `index.html`
directamente con doble clic: la app necesita hablar con `server.js`).

En el primer arranque se crea automáticamente una cuenta **Super Admin**
(`fjose.cantos@verisure.es`) con una clave temporal que se imprime una sola
vez por consola — ver detalle en [DOCUMENTACION.md](DOCUMENTACION.md#autenticación-y-roles).

## Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Sí, para las funciones de IA | Clave de la API de Anthropic. Sin ella, la app funciona pero el IA Assistant, el Análisis Avanzado, Propuestas y Formaciones muestran un aviso pidiendo que se configure. |
| `PORT` | No (por defecto `3000`) | Puerto HTTP del servidor. Render lo define automáticamente. |
| `DATA_DIR` | Recomendada en producción | Directorio persistente para `segurpanel.db`, el secreto JWT y los backups. Sin ella se usa `./data` local, que en plataformas de filesystem efímero (Render) se pierde en cada despliegue. |
| `JWT_SECRET` | Recomendada en producción | Secreto para firmar las sesiones JWT (HS256). Si no se define, se genera uno aleatorio la primera vez y se guarda en `DATA_DIR/.jwt-secret`. |
| `SCRAPER_TOKEN` | Necesaria si se usan los scrapers | Secreto compartido que autentica las peticiones de `scraper_alianzas.py` y `scraper_precios.py` a `POST /api/alianzas/sync` y `POST /api/ofertas/sync`. Sin ella, ambos endpoints responden `503`. |
| `UNSPLASH_ACCESS_KEY` | No | Clave de la API de Unsplash para las fotos de fondo de las diapositivas de Formaciones. Sin ella, Formaciones sigue funcionando (iconos y diseño corporativo) pero sin fotos. |
| `HTTPS_CERT_FILE` / `HTTPS_KEY_FILE` | No | Rutas a certificados `.pem` propios. Si se definen, `server.js` levanta HTTPS directamente en vez de HTTP (alternativa a usar un proxy inverso). |
| `NODE_ENV` | No | Si se define como `production` sin HTTPS configurado (ni certificados propios ni proxy detectable), el servidor avisa por consola al arrancar. |

## Despliegue en Render

1. **Crea un Web Service** en [Render](https://render.com/) y conéctalo a
   este repositorio de GitHub (rama `main`).
2. **Build Command:** `npm install`
   **Start Command:** `npm start` (equivalente a `node server.js`)
3. **Runtime:** Node ≥ 22.5. Fija la versión en la configuración del
   servicio si Render no la detecta automáticamente por defecto.
4. **Disco persistente:** monta un disco en `/data` (Render → tu servicio →
   *Disks* → *Add Disk*, mount path `/data`). Sin esto, la base de datos y
   las sesiones se pierden en cada despliegue, porque el filesystem del
   contenedor es efímero.
5. **Variables de entorno** (Render → tu servicio → *Environment*):
   - `ANTHROPIC_API_KEY` — obligatoria.
   - `DATA_DIR=/data` — para usar el disco persistente del paso 4.
   - `JWT_SECRET` — un secreto largo y aleatorio.
   - `SCRAPER_TOKEN` — si vas a conectar los scrapers de la Raspberry Pi.
   - `UNSPLASH_ACCESS_KEY` — opcional.
   - `NODE_ENV=production`.
6. **HTTPS:** Render ya sirve el servicio por HTTPS de forma automática
   (termina TLS en su propio proxy delante de tu contenedor), así que no
   hace falta configurar `HTTPS_CERT_FILE`/`HTTPS_KEY_FILE`.
7. **Despliegue automático:** cada `git push` a `main` dispara un nuevo
   despliegue en Render (auto-deploy activado por defecto al conectar el
   repositorio).
8. Tras el primer despliegue, revisa los logs de Render para recoger la
   clave temporal del Super Admin inicial (se imprime una sola vez).

Más detalle sobre cómo encajan Render, GitHub, la Raspberry Pi y las APIs
externas en [ARQUITECTURA.md](ARQUITECTURA.md).

## Documentación adicional

- **[DOCUMENTACION.md](DOCUMENTACION.md)** — descripción funcional de cada
  pestaña, autenticación y roles, PWA, scrapers de Alianzas y Ofertas,
  backups y auditoría.
- **[ARQUITECTURA.md](ARQUITECTURA.md)** — diagrama y explicación de la
  arquitectura del sistema completo.
