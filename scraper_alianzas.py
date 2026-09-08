#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scraper_alianzas.py
====================

Busca a diario acuerdos y colaboraciones entre empresas de alarmas
(Verisure, Sector Alarm, Sicor, Segurma, ADT, Seguridad 3D, Grupo Control,
Trablisa, MPA/Prosegur) y empresas de otros sectores (móviles, grandes
superficies, seguros, inmobiliarias, suministros de luz/gas/agua), usando:

  1. Google News (RSS público, sin necesidad de API key).
  2. Webs oficiales / salas de prensa configuradas en SALAS_PRENSA (rellena
     esa lista con las URLs reales que quieras vigilar; vacía por defecto).

Pensado para ejecutarse una vez al día en una Raspberry Pi vía cron. Solo
usa la librería estándar de Python (urllib, xml.etree, json) para no
depender de "pip install" en el dispositivo.

Comportamiento:
  - Descarta automáticamente cualquier noticia de Google News cuya fecha de
    publicación (pubDate del RSS) tenga más de DIAS_MAX_NOTICIA días (7 por
    defecto) de antigüedad, o cuya fecha no se pueda interpretar: solo
    llegan a alianzas.json noticias recientes.
  - Guarda en disco (ALIANZAS_CACHE) los identificadores de todas las
    alianzas detectadas en ejecuciones anteriores.
  - En cada ejecución, descarta las que ya conocía y se queda solo con las
    nuevas ("cambios respecto al día anterior").
  - Si hay alianzas nuevas, las envía a SegurPanel (POST /api/alianzas/sync)
    para que entren como pendientes de revisión del Super Admin, que activa
    el punto rojo de notificación en la pestaña "Alianzas".
  - Si SegurPanel no está configurado (o no responde), las nuevas alianzas
    quedan igualmente guardadas en el cache local y se reintentará el envío
    en la siguiente ejecución (se vuelven a considerar "nuevas" hasta que
    el envío tenga éxito).
  - Cada ejecución normal también vuelca TODAS las alianzas detectadas (sean
    novedad o no) en ALIANZAS_JSON, que sirve de base para --force-send y
    --test.

Argumentos de línea de comandos:
  --force-send  No hace ninguna búsqueda nueva: envía a SegurPanel todas las
                alianzas guardadas en ALIANZAS_JSON, aunque ya se hubieran
                enviado antes. Util para reenviar el historico completo tras
                un problema en el servidor.
  --test        Igual que --force-send pero solo con las 3 primeras alianzas
                de ALIANZAS_JSON, para probar la conexión con SegurPanel
                (URL, token) sin reenviar todo el histórico.

Configuración (variables de entorno):
  SEGURPANEL_SYNC_URL      URL completa del endpoint, p.ej.
                           https://tu-app.onrender.com/api/alianzas/sync
  SEGURPANEL_SCRAPER_TOKEN Debe coincidir con SCRAPER_TOKEN en el servidor.
  ALIANZAS_CACHE           Ruta del fichero de cache local de IDs (por
                           defecto, alianzas_cache.json junto a este script).
  ALIANZAS_JSON            Ruta del fichero con todas las alianzas detectadas
                           (por defecto, alianzas.json junto a este script);
                           es lo que leen --force-send y --test.

Cron sugerido (todos los días a las 07:00):
  0 7 * * * SEGURPANEL_SYNC_URL="https://tu-app.onrender.com/api/alianzas/sync" \
            SEGURPANEL_SCRAPER_TOKEN="el-mismo-secreto-que-en-el-servidor" \
            /usr/bin/python3 /home/pi/segurpanel/scraper_alianzas.py \
            >> /home/pi/segurpanel/scraper_alianzas.log 2>&1

Probar la conexión a mano:
  SEGURPANEL_SYNC_URL="..." SEGURPANEL_SCRAPER_TOKEN="..." \
    python3 scraper_alianzas.py --test

Reenviar todo el histórico a mano:
  SEGURPANEL_SYNC_URL="..." SEGURPANEL_SCRAPER_TOKEN="..." \
    python3 scraper_alianzas.py --force-send
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from hashlib import sha1

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------

ALARM_COMPANIES = [
    "Verisure",
    "Sector Alarm",
    "Sicor",
    "Segurma",
    "ADT",
    "Seguridad 3D",
    "Grupo Control",
    "Trablisa",
    "MPA/Prosegur",
]

# Nombres de sector que usa este scraper internamente. No hace falta que
# coincidan letra por letra con los que valida el servidor (SECTORES_ALIANZA
# en server.js): antes de enviar cada alianza se traducen con
# MAPEO_SECTORES_ENDPOINT, más abajo.
PARTNER_SECTORS = {
    "Telefonia movil": ["Movistar", "Vodafone", "Orange", "MásMóvil", "Masmóvil"],
    "Grandes superficies": ["Carrefour", "Leroy Merlin", "El Corte Inglés", "MediaMarkt"],
    "Seguros": ["Mapfre", "AXA", "Allianz", "Generali"],
    "Inmobiliarias": ["idealista", "Fotocasa", "pisos.com"],
    "Energia y agua": ["Endesa", "Iberdrola", "Naturgy", "Repsol"],
}

# Traduce los nombres de sector de PARTNER_SECTORS al valor EXACTO que acepta
# /api/alianzas/nueva (SECTORES_ALIANZA en server.js); si algún día llega un
# sector no listado aquí, se envía tal cual y es el servidor quien lo
# rechaza con un 400 explícito en vez de fallar en silencio en el scraper.
MAPEO_SECTORES_ENDPOINT = {
    "Telefonia movil": "Móviles",
    "Grandes superficies": "Grandes superficies",
    "Seguros": "Seguros",
    "Inmobiliarias": "Inmobiliarias",
    "Energia y agua": "Suministros (luz, gas, agua)",
}


def normalizar_sector(sector):
    return MAPEO_SECTORES_ENDPOINT.get(sector, sector)

AGREEMENT_KEYWORDS = [
    ("Alianza estratégica", ["alianza estratégica"]),
    ("Fusión / adquisición", ["fusión", "adquiere", "adquisición", "compra"]),
    ("Convenio", ["convenio"]),
    ("Acuerdo comercial", ["acuerdo comercial", "acuerdo de colaboración", "acuerdo"]),
    ("Alianza", ["alianza"]),
    ("Colaboración", ["colaboración", "colabora"]),
    ("Partnership", ["partnership", "partner"]),
]

# Webs oficiales / salas de prensa a vigilar además de Google News. Vacío por
# defecto: rellena aquí las URLs reales que quieras monitorizar, p.ej.
#   "Verisure": ["https://www.verisure.es/sobre-verisure/sala-de-prensa"],
# El scraper descarga cada URL, quita las etiquetas HTML y busca menciones
# de los sectores vigilados en el texto resultante (deteccion best-effort,
# no sustituye una revision manual).
SALAS_PRENSA = {
    "Verisure": [],
    "Sector Alarm": [],
    "Sicor": [],
    "Segurma": [],
    "ADT": [],
    "Seguridad 3D": [],
    "Grupo Control": [],
    "Trablisa": [],
    "MPA/Prosegur": [],
}

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search?q={query}&hl=es&gl=ES&ceid=ES:es"
USER_AGENT = "Mozilla/5.0 (compatible; SegurPanelScraper/1.0; +https://segurpanel.local)"
REQUEST_TIMEOUT = 15
REQUEST_DELAY_SEGUNDOS = 1.5  # pausa entre peticiones, por cortesia con los servidores consultados
MAX_CACHE_ENTRADAS = 2000  # evita que el fichero de cache crezca sin limite
DIAS_MAX_NOTICIA = 7  # descarta noticias de Google News mas antiguas que esto

RUTA_SCRIPT = os.path.dirname(os.path.abspath(__file__))
ALIANZAS_CACHE = os.environ.get("ALIANZAS_CACHE", os.path.join(RUTA_SCRIPT, "alianzas_cache.json"))
ALIANZAS_JSON = os.environ.get("ALIANZAS_JSON", os.path.join(RUTA_SCRIPT, "alianzas.json"))
SYNC_URL = os.environ.get("SEGURPANEL_SYNC_URL", "")
SYNC_TOKEN = os.environ.get("SEGURPANEL_SCRAPER_TOKEN", "")
NUM_ALIANZAS_TEST = 3


# ---------------------------------------------------------------------------
# Deteccion de socio comercial y tipo de acuerdo a partir de un texto
# ---------------------------------------------------------------------------

def detectar_socio(texto):
    texto_low = texto.lower()
    for sector, empresas in PARTNER_SECTORS.items():
        for empresa in empresas:
            if empresa.lower() in texto_low:
                return sector, empresa
    return None, None


def detectar_tipo_acuerdo(texto):
    texto_low = texto.lower()
    for tipo, palabras in AGREEMENT_KEYWORDS:
        for palabra in palabras:
            if palabra in texto_low:
                return tipo
    return "Mención conjunta"


def generar_id_externo(*partes):
    base = "|".join(p.strip().lower() for p in partes if p)
    return sha1(base.encode("utf-8")).hexdigest()[:20]


def es_noticia_reciente(fecha_pub, dias_max=DIAS_MAX_NOTICIA):
    """True si `fecha_pub` (pubDate del RSS, p.ej. "Mon, 02 Jan 2006
    15:04:05 GMT") cae dentro de los ultimos `dias_max` dias. Si la fecha
    viene vacia o no se puede interpretar, se descarta la noticia por
    precaucion: mejor perder alguna valida con formato raro que colar una
    desactualizada en alianzas.json."""
    if not fecha_pub:
        return False
    try:
        fecha = parsedate_to_datetime(fecha_pub)
    except (TypeError, ValueError):
        return False
    if fecha is None:
        return False
    if fecha.tzinfo is None:
        fecha = fecha.replace(tzinfo=timezone.utc)
    antiguedad = datetime.now(timezone.utc) - fecha
    # Margen de 1 hora para relojes ligeramente desincronizados que
    # coloquen la fecha de publicacion "en el futuro" por poco.
    return -timedelta(hours=1) <= antiguedad <= timedelta(days=dias_max)


# ---------------------------------------------------------------------------
# Fuente 1: Google News RSS
# ---------------------------------------------------------------------------

def descargar(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        return resp.read()


def buscar_en_google_news(alarma):
    query = urllib.parse.quote(f'"{alarma}" (acuerdo OR alianza OR convenio OR colaboración OR partnership)')
    url = GOOGLE_NEWS_RSS.format(query=query)
    try:
        data = descargar(url)
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"[aviso] Google News no respondió para «{alarma}»: {e}", file=sys.stderr)
        return []

    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        print(f"[aviso] RSS inválido para «{alarma}»: {e}", file=sys.stderr)
        return []

    encontradas = []
    for item in root.findall("./channel/item"):
        titulo = (item.findtext("title") or "").strip()
        enlace = (item.findtext("link") or "").strip()
        fecha_pub = (item.findtext("pubDate") or "").strip()
        fuente_el = item.find("source")
        fuente = (fuente_el.text or "Google News").strip() if fuente_el is not None else "Google News"

        if not titulo or not enlace:
            continue

        if not es_noticia_reciente(fecha_pub):
            continue  # descarta noticias de mas de DIAS_MAX_NOTICIA dias (o sin fecha fiable)

        sector, socio = detectar_socio(titulo)
        if not sector:
            continue  # la noticia no menciona ningún socio de los sectores vigilados

        encontradas.append({
            "externalId": generar_id_externo("gnews", alarma, enlace),
            "empresaAlarma": alarma,
            "sector": normalizar_sector(sector),
            "socio": socio,
            "tipoAcuerdo": detectar_tipo_acuerdo(titulo),
            "titular": titulo,
            "fuente": fuente,
            "url": enlace,
            "fechaPublicacion": fecha_pub,
            "fechaDeteccion": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        })
    return encontradas


# ---------------------------------------------------------------------------
# Fuente 2: webs oficiales / salas de prensa (best-effort)
# ---------------------------------------------------------------------------

TAG_RE = re.compile(r"<[^>]+>")
LINK_RE = re.compile(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)


def buscar_en_sala_prensa(alarma, url_pagina):
    try:
        html = descargar(url_pagina).decode("utf-8", errors="ignore")
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"[aviso] No se pudo consultar la web oficial de «{alarma}» ({url_pagina}): {e}", file=sys.stderr)
        return []

    encontradas = []
    for href, texto_enlace in LINK_RE.findall(html):
        texto_plano = TAG_RE.sub(" ", texto_enlace).strip()
        if not texto_plano:
            continue
        sector, socio = detectar_socio(texto_plano)
        if not sector:
            continue

        enlace_absoluto = urllib.parse.urljoin(url_pagina, href)
        encontradas.append({
            "externalId": generar_id_externo("prensa", alarma, enlace_absoluto),
            "empresaAlarma": alarma,
            "sector": normalizar_sector(sector),
            "socio": socio,
            "tipoAcuerdo": detectar_tipo_acuerdo(texto_plano),
            "titular": texto_plano,
            "fuente": "Web oficial",
            "url": enlace_absoluto,
            "fechaPublicacion": "",
            "fechaDeteccion": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        })
    return encontradas


# ---------------------------------------------------------------------------
# Cache local (para calcular "cambios respecto al día anterior")
# ---------------------------------------------------------------------------

def cargar_cache():
    if not os.path.exists(ALIANZAS_CACHE):
        return {"vistos": [], "enviados": []}
    try:
        with open(ALIANZAS_CACHE, "r", encoding="utf-8") as f:
            datos = json.load(f)
            datos.setdefault("vistos", [])
            datos.setdefault("enviados", [])
            return datos
    except (json.JSONDecodeError, OSError):
        return {"vistos": [], "enviados": []}


def guardar_cache(cache):
    cache["vistos"] = cache["vistos"][-MAX_CACHE_ENTRADAS:]
    cache["enviados"] = cache["enviados"][-MAX_CACHE_ENTRADAS:]
    tmp = ALIANZAS_CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    os.replace(tmp, ALIANZAS_CACHE)


# ---------------------------------------------------------------------------
# Volcado completo de alianzas detectadas (base de --force-send y --test)
# ---------------------------------------------------------------------------

def cargar_alianzas_json():
    if not os.path.exists(ALIANZAS_JSON):
        return []
    try:
        with open(ALIANZAS_JSON, "r", encoding="utf-8") as f:
            datos = json.load(f)
            return datos if isinstance(datos, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def guardar_alianzas_json(alianzas):
    tmp = ALIANZAS_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(alianzas, f, ensure_ascii=False, indent=2)
    os.replace(tmp, ALIANZAS_JSON)


# ---------------------------------------------------------------------------
# Envio a SegurPanel
# ---------------------------------------------------------------------------

def sincronizar_con_segurpanel(alianzas):
    if not SYNC_URL or not SYNC_TOKEN:
        print("[info] SEGURPANEL_SYNC_URL / SEGURPANEL_SCRAPER_TOKEN no configurados: "
              "las alianzas nuevas se han guardado en el cache local pero no se han enviado.")
        return False

    cuerpo = json.dumps({"alianzas": alianzas}).encode("utf-8")
    req = urllib.request.Request(
        SYNC_URL,
        data=cuerpo,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Scraper-Token": SYNC_TOKEN,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            respuesta = json.loads(resp.read().decode("utf-8"))
            print(f"[ok] SegurPanel confirmó la sincronización: {respuesta}")
            return True
    except urllib.error.HTTPError as e:
        print(f"[error] SegurPanel rechazó la sincronización (HTTP {e.code}): {e.read().decode('utf-8', 'ignore')}", file=sys.stderr)
        return False
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"[error] No se pudo contactar con SegurPanel: {e}", file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parsear_argumentos():
    parser = argparse.ArgumentParser(
        description="Scraper de alianzas de SegurPanel (busca acuerdos y los sincroniza con el panel)."
    )
    parser.add_argument(
        "--force-send",
        action="store_true",
        help=(
            "No busca alianzas nuevas: envía a SegurPanel TODAS las guardadas en "
            f"{ALIANZAS_JSON}, aunque ya se hubieran enviado antes."
        ),
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help=(
            f"Igual que --force-send pero solo con las {NUM_ALIANZAS_TEST} primeras alianzas "
            f"de {ALIANZAS_JSON}, para probar la conexión con SegurPanel sin reenviar todo."
        ),
    )
    return parser.parse_args()


def enviar_desde_archivo(solo_prueba):
    alianzas_guardadas = cargar_alianzas_json()
    if not alianzas_guardadas:
        print(
            f"[error] No hay alianzas guardadas en {ALIANZAS_JSON}. "
            "Ejecuta el scraper una vez sin --force-send/--test para generarlo.",
            file=sys.stderr,
        )
        return False

    a_enviar = alianzas_guardadas[:NUM_ALIANZAS_TEST] if solo_prueba else alianzas_guardadas
    etiqueta = f"prueba de conexión ({len(a_enviar)} primeras)" if solo_prueba else "reenvío forzado"
    print(f"[info] {etiqueta}: enviando {len(a_enviar)} de {len(alianzas_guardadas)} alianzas guardadas en {ALIANZAS_JSON}.")
    return sincronizar_con_segurpanel(a_enviar)


def main():
    args = parsear_argumentos()

    if args.force_send or args.test:
        enviado_ok = enviar_desde_archivo(solo_prueba=args.test)
        sys.exit(0 if enviado_ok else 1)

    cache = cargar_cache()
    vistos = set(cache["vistos"])
    enviados = set(cache["enviados"])

    todas_detectadas = []
    for alarma in ALARM_COMPANIES:
        todas_detectadas.extend(buscar_en_google_news(alarma))
        time.sleep(REQUEST_DELAY_SEGUNDOS)
        for url_pagina in SALAS_PRENSA.get(alarma, []):
            todas_detectadas.extend(buscar_en_sala_prensa(alarma, url_pagina))
            time.sleep(REQUEST_DELAY_SEGUNDOS)

    # Deduplicar dentro de esta misma ejecución (misma alianza vista por
    # varias fuentes o varias veces en el RSS).
    por_id = {}
    for a in todas_detectadas:
        por_id.setdefault(a["externalId"], a)
    todas_detectadas = list(por_id.values())

    # Volcado completo (novedad o no): es lo que leen --force-send y --test.
    guardar_alianzas_json(todas_detectadas)

    # "Cambios respecto al día anterior": lo que no estaba ya en el cache de
    # ejecuciones previas, o que sí estaba pero aún no se había podido enviar
    # con éxito a SegurPanel (reintento).
    nuevas = [a for a in todas_detectadas if a["externalId"] not in vistos or a["externalId"] not in enviados]

    print(f"[info] {len(todas_detectadas)} alianzas detectadas en total, {len(nuevas)} nuevas o pendientes de envío.")

    if nuevas:
        enviado_ok = sincronizar_con_segurpanel(nuevas)
        if enviado_ok:
            enviados.update(a["externalId"] for a in nuevas)
    else:
        print("[info] Sin cambios respecto a ejecuciones anteriores. No se envía nada.")

    vistos.update(a["externalId"] for a in todas_detectadas)
    guardar_cache({"vistos": list(vistos), "enviados": list(enviados)})


if __name__ == "__main__":
    main()
