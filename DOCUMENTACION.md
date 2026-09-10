# Documentación funcional de SegurPanel

Descripción detallada de cada pestaña y funcionalidad de la aplicación. Para
instalación y despliegue, ver [README.md](README.md); para la arquitectura
del sistema, ver [ARQUITECTURA.md](ARQUITECTURA.md).

## Índice

- [Autenticación y roles](#autenticación-y-roles)
- [Pestañas](#pestañas)
  - [Inicio](#inicio)
  - [Comparador](#comparador)
  - [Ofertas](#ofertas)
  - [Alianzas](#alianzas)
  - [Equipos](#equipos)
  - [Análisis](#análisis)
  - [Normativa](#normativa)
  - [Inteligencia](#inteligencia)
  - [Estadísticas](#estadísticas)
  - [Repositorio](#repositorio)
  - [Análisis Avanzado](#análisis-avanzado)
  - [Generador de Propuestas](#generador-de-propuestas)
  - [Formaciones](#formaciones)
  - [IA Assistant](#ia-assistant)
- [Panel de administración (`/admin`)](#panel-de-administración-admin)
- [App instalable (PWA)](#app-instalable-pwa)
- [Scrapers automáticos (Raspberry Pi)](#scrapers-automáticos-raspberry-pi)
- [Backups y auditoría](#backups-y-auditoría)

## Autenticación y roles

SegurPanel exige iniciar sesión antes de mostrar nada de la app. Solo se
admiten correos **@verisure.es**. `login.html` gestiona el inicio de sesión,
la solicitud de acceso y el cambio de contraseña obligatorio; `auth.js`
implementa las contraseñas (bcrypt), las sesiones JWT y las reglas de rol.

**Primer arranque:** al no existir todavía `segurpanel.db`, se crea
automáticamente la cuenta **Super Admin** (`fjose.cantos@verisure.es`) con
una clave temporal aleatoria, impresa una sola vez por consola y guardada en
`SUPER_ADMIN_INICIAL.txt` (dentro de `data/` o `DATA_DIR`). La app obliga a
cambiarla en el primer inicio de sesión.

**Solicitud de acceso:** cualquiera con correo `@verisure.es` puede pedir
acceso desde la pantalla de login. El Super Admin la ve y la aprueba (o
rechaza) desde `/admin`, asignando un rol y una clave temporal que debe
compartirse por un canal seguro; esa persona la cambia en su primer acceso.

**Roles:**

| Rol | Acceso |
| --- | --- |
| **Super Admin** | Todas las pestañas + `/admin` (gestión de usuarios, solicitudes, auditoría, reseteo de datos de prueba). Es el único rol que ve los nombres de empresa en las leyendas privadas de Comparador, Ofertas, Alianzas y Equipos. |
| **Admin** | Todas las pestañas, salvo `/admin`. |
| **Retención** | Sin acceso a Análisis, Análisis Avanzado, Estadísticas ni Repositorio (se eliminan del DOM, no solo se ocultan, para que tampoco sean accesibles vía `?tab=` en la URL). El resto de pestañas en solo lectura, con los controles bloqueados. Sí tiene acceso completo al IA Assistant. |

**Sesiones:** JWT firmado (HS256) en cookie `httpOnly`, `SameSite=Lax` (y
`Secure` si la conexión es HTTPS). Cada sesión se registra también en SQLite
para poder revocarla (logout, desactivación de usuario, reseteo de
contraseña) aunque el JWT en sí no haya caducado. Bloqueo automático de la
cuenta 15 minutos tras 5 intentos fallidos de contraseña.

**Identificación de empresas por color:** en Comparador, Ofertas, Alianzas y
Equipos, cada empresa de alarmas competidora se identifica solo por un
círculo de color corporativo; el nombre real de la empresa solo se muestra
en una leyenda privada visible exclusivamente para el rol **Super Admin**.

## Pestañas

### Inicio

Panel de bienvenida con:
- **Resumen del día** — 4 tarjetas (alianzas nuevas pendientes, contratos
  analizados hoy, alertas activas, usuarios conectados hoy), ocultas para el
  rol Retención.
- **Noticias del sector** — feed de novedades relevantes.
- **Accesos rápidos** — botones directos a Comparador, Ofertas, Análisis
  (si el rol lo permite), Equipos, Normativa y Alianzas.

### Comparador

Tabla comparativa orientativa de las principales compañías de alarmas
(Verisure, Sector Alarm, Sicor, Segurma, ADT, Seguridad 3D, Grupo Control,
Trablisa, MPA/Prosegur): instalación, cuota mensual, permanencia, equipos
incluidos y valoración. Permite ordenar por precio, permanencia o
valoración, y exportar a Excel. El Super Admin puede además añadir notas
privadas y marcar "vigilar" por empresa.

### Ofertas

Tarjetas con la promoción comercial vigente detectada más recientemente
para cada empresa de alarmas, alimentadas por `scraper_precios.py`. A
diferencia de Alianzas, no hay cola de moderación: las promociones
detectadas se muestran directamente, porque son un listado de referencia
que siempre pide "confirmar vigencia" antes de usarse con un cliente.

### Alianzas

Acuerdos y colaboraciones detectados entre las empresas de alarmas
comparadas y compañías de otros sectores (móviles, grandes superficies,
seguros, inmobiliarias, suministros de luz/gas/agua), alimentados por
`scraper_alianzas.py`.

**Flujo de moderación (pendiente → publicado):**
1. El scraper envía acuerdos nuevos a `POST /api/alianzas/sync`; cada uno
   entra en SQLite con estado `pending`.
2. Solo el Super Admin ve las alianzas pendientes, en la sección
   "Pendientes de revisar", junto con un punto rojo de notificación en la
   propia pestaña.
3. El Super Admin decide, alianza por alianza: **Publicar** (pasa a
   `published` y la ven todos los roles) o **Descartar** (pasa a
   `discarded` y desaparece para siempre, sin volver a proponerse aunque el
   scraper la detecte de nuevo).
4. Admin y Retención solo ven las alianzas ya publicadas.

### Equipos

Ficha técnica de equipos de alarma por marca (Ajax, Jablotron, Risco,
Paradox, DSC, Honeywell): centrales, sensores, conectividad, batería de
respaldo, certificación EN 50131, etc., a partir de información pública.
Incluye también qué equipos usa cada compañía de alarmas comparada.

### Análisis

Punto de entrada para analizar contratos con IA. Admite subir uno o varios
archivos a la vez (PDF, Word, OpenDocument, texto plano o fotos/escaneos
JPG/PNG; máx. 20 archivos, 20 MB cada uno). Por cada archivo, el servidor:

1. Extrae el texto (`analisis.js`, con OCR para imágenes vía
   `node-tesseract-ocr`).
2. **Anonimiza automáticamente** los datos sensibles (nombres, DNI/NIE/NIF/
   CIF, direcciones, teléfonos, emails, datos bancarios, nombre de empresa)
   antes de generar ningún informe.
3. Detecta automáticamente la empresa, la provincia y si el contrato es de
   **Hogar** o **Negocio**, para guardarlo ya clasificado en el
   Repositorio; solo si no hay certeza se pregunta al usuario.
4. Genera y descarga un informe PDF, y dispara automáticamente el
   **Análisis Avanzado** (análisis legal cláusula por cláusula) para ese
   mismo contrato.

Con varios archivos, se procesan uno por uno con una cola de progreso visual
y, al terminar, se descarga un ZIP con todos los informes.

### Normativa

Referencia divulgativa de legislación, normas técnicas (UNE-EN 50131),
derechos del consumidor y organismos aplicables a la seguridad privada y los
sistemas de alarma en España, con buscador. Contenido de apoyo comercial que
no sustituye el asesoramiento legal (remite siempre al BOE/AENOR/organismo
correspondiente).

### Inteligencia

Panel de gráficos de referencia derivados del Comparador: cuota mensual
media por compañía, equipos más solicitados y margen competitivo (diferencia
de cada empresa frente a la media de mercado). Exportable a Excel.

### Estadísticas

*(Solo Super Admin y Admin.)* Panel interno de actividad del equipo, sin
ningún dato personal de clientes:
- Contratos analizados, riesgo promedio, cláusula más frecuente, usuarios
  activos.
- Mapa de España con contratos por provincia y compañía dominante (provincia
  + empresa + fecha, detectadas automáticamente antes de anonimizar; sin
  datos personales).
- Cláusulas más frecuentes y evolución de precios de competencia.
- Tabla de actividad del equipo (última conexión, pestañas más usadas) y
  actividad en tiempo real (pestaña activa y última acción de cada usuario,
  refrescada cada 20 s).

### Repositorio

*(Solo Super Admin y Admin.)* Cada contrato analizado en Análisis se guarda
aquí ya anonimizado: empresa, tipo (hogar/negocio), provincia, fecha, nivel
de riesgo y cláusulas detectadas. Se compara automáticamente con contratos
anteriores de la misma empresa y tipo para avisar de cláusulas nuevas,
modificadas o eliminadas — útil para detectar cambios de condiciones de la
competencia con el tiempo. Filtrable por empresa, tipo, provincia, nivel de
riesgo y rango de fechas; incluye una vista de "evolución por compañía" en
línea de tiempo. Exportable a Excel.

### Análisis Avanzado

*(Solo Super Admin y Admin.)* Análisis legal cláusula por cláusula generado
con IA (modelo `claude-opus-5`), que actúa como un abogado experto en
contratos de seguridad privada y derecho del consumidor español, en lenguaje
sencillo. Se dispara automáticamente al subir un contrato en la pestaña
Análisis (no hace falta repetir la subida aquí). Muestra una puntuación de
riesgo de 1 a 10 con recomendación, y permite descargar el informe completo
en PDF.

### Generador de Propuestas

Genera una propuesta comercial personalizada en PDF con IA, a partir de
tipo de cliente (hogar/negocio), zona geográfica, presupuesto aproximado y
necesidades específicas en texto libre. El PDF incluye el logo de UIC,
argumentos de valor, comparativa con la competencia y un precio
recomendado.

### Formaciones

Genera material de formación en `.pptx` para el equipo de retención/ventas,
con diseño corporativo UIC (`formaciones.js`):

- **Conoce a tu competencia** — un *battlecard* completo por empresa
  competidora: quiénes son, qué ofrecen, puntos débiles, cómo rebatirlos,
  alianzas actuales y equipos que usan.
- **Formación Completa por Compañía** — curso de 15 diapositivas por
  empresa (quiénes son, oferta comercial, puntos fuertes/débiles, cómo
  rebatirlos, 3 roleplays con cliente difícil, ejercicios prácticos con
  respuesta, notas de moderador en cada diapositiva e infografía final para
  imprimir). Se genera en varios pasos, con barra de progreso, dado el
  volumen de contenido.
- **Otras formaciones** — cinco plantillas temáticas: técnicas maestras de
  retención, rebate de motivos de baja, normativa aplicable, comparativa
  Verisure vs. competencia y casos prácticos.
- **Crear Infografía desde PPTX** — sube una presentación `.pptx` ya
  existente y la IA la resume en una sola diapositiva con los puntos clave,
  iconos y diseño corporativo UIC, lista para imprimir.

Cada diapositiva puede incluir una foto de fondo real obtenida de la
**API de Unsplash** (`UNSPLASH_ACCESS_KEY`; opcional — sin ella, Formaciones
sigue funcionando con diseño e iconos, sin fotos). Las consultas usan un
catálogo cerrado de 12 temas en inglés para no agotar el límite del plan
gratuito de Unsplash (50 peticiones/hora), con caché en memoria por tema.

### IA Assistant

Chat con IA (modelo `claude-haiku-4-5-20251001`) que simula 15 años de
experiencia en retención de clientes del sector de alarmas: rebate
objeciones de baja con argumentos profesionales y empáticos, apoyados en
psicología del cliente, técnicas de negociación y legislación española de
consumidores. Ofrece botones rápidos con los motivos de baja más habituales
("Me voy a vivir a otro lado", "Es muy caro", "Me han ofrecido algo mejor",
casos sensibles como fallecimiento o divorcio, etc.) o admite texto libre;
también responde preguntas sobre normativa, equipos o comparativa de
competencia. Es la única pestaña de análisis con IA a la que el rol
Retención tiene acceso completo.

## Panel de administración (`/admin`)

*(Solo Super Admin; cualquier otra sesión que intente entrar es redirigida a
`/`.)* `admin.html` ofrece:

- **Solicitudes pendientes** — aprobar o rechazar solicitudes de acceso,
  asignando rol y clave temporal.
- **Usuarios** — cambiar rol, activar/desactivar cuentas, resetear
  contraseña, permitir o no instalar la app (PWA) a cada usuario.
- **Panel de auditoría** — registro de acciones importantes (login, logout,
  análisis de contrato, publicación de alianza, cambio de rol), leído de la
  tabla SQLite `audit_log`.
- **Zona de peligro** — reseteo de datos de prueba y reseteo de datos por
  pestaña, para dejar la app limpia antes de una demo o de pasar a
  producción real.

## App instalable (PWA)

SegurPanel es una Progressive Web App: se instala en la pantalla de inicio
del móvil o la tablet y, una vez visitada, abre y funciona sin conexión.

- **Android/Chrome/Edge:** botón "Instalar app" automático (o menú ⋮ →
  Instalar aplicación).
- **iPhone/iPad (Safari):** Safari no permite el diálogo automático; la app
  muestra los pasos manuales (Compartir → Añadir a pantalla de inicio).
- El Super Admin controla, por usuario, si puede ver el botón de instalar
  (`admin.html` → gestión de usuarios).
- **Modo sin conexión:** interfaz, pestañas, comparador, ofertas, equipos y
  normativa funcionan sin conexión; el **IA Assistant necesita internet**
  (habla con la API de Anthropic a través de `server.js`).
- Los service workers solo funcionan en contexto seguro (`localhost` o
  `https://`); para probar la instalación desde un móvil real sobre la red
  local, hace falta exponer el servidor por HTTPS (p. ej. con un túnel).

## Scrapers automáticos (Raspberry Pi)

Dos scripts en Python (solo librería estándar, sin `pip install`),
pensados para ejecutarse a diario por cron en una Raspberry Pi u otro
equipo siempre encendido, que alimentan Alianzas y Ofertas vía HTTP
autenticado con un secreto compartido (`SCRAPER_TOKEN`):

- **`scraper_alianzas.py`** — busca en Google News (RSS público) menciones
  conjuntas de cada empresa de alarmas con compañías de sectores vigilados
  (telecos, grandes superficies, seguros, inmobiliarias, suministros).
  Descarta noticias de más de 7 días. Envía lo nuevo a
  `POST /api/alianzas/sync`. Cron recomendado: 07:00.
- **`scraper_precios.py`** — busca menciones de cada empresa de alarmas
  junto a palabras propias de promociones comerciales (oferta, descuento,
  meses gratis, sin permanencia...). Descarta promociones de más de 30
  días. Envía lo nuevo a `POST /api/ofertas/sync`. Cron recomendado: 07:15.

Ambos guardan una caché local de lo ya detectado para enviar solo lo que
cambia de un día a otro, y ambos endpoints responden `503` si
`SCRAPER_TOKEN` no está definido en el servidor (evita dejarlos abiertos por
descuido). Detalle de configuración y cron en
[README.md](README.md#variables-de-entorno) y en las cabeceras de cada
script.

## Backups y auditoría

- **`backup.js`** copia `segurpanel.db` cada día a las 02:00 (hora local del
  servidor) a `DATA_DIR/backups/` (o `./data/backups/` en local), con la
  fecha en el nombre, y mantiene solo los últimos 7. No depende de ningún
  cron externo: `server.js` arranca un `setInterval` de 60 s que comprueba
  la hora actual.
- Todas las acciones importantes (login, logout, análisis de contrato,
  publicar alianza, cambio de rol) quedan registradas en la tabla SQLite
  `audit_log` y son visibles en el Panel de auditoría de `admin.html`, solo
  para Super Admin.
