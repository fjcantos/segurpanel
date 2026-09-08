#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scraper_precios.py
====================

Busca a diario promociones y ofertas comerciales vigentes de las empresas
de alarmas comparadas en SegurPanel (Verisure, Sector Alarm, Sicor,
Segurma, ADT, Seguridad 3D, Grupo Control, Trablisa, MPA/Prosegur), usando
Google News (RSS público, sin necesidad de API key).

Pensado para ejecutarse una vez al día en una Raspberry Pi vía cron, igual
que scraper_alianzas.py. Solo usa la librería estándar de Python (urllib,
xml.etree, json) para no depender de "pip install" en el dispositivo.

Comportamiento:
  - Busca, para cada empresa, noticias que mencionen palabras propias de
    promociones comerciales (oferta, descuento, meses gratis, sin
    permanencia, etc.).
  - Descarta automáticamente las noticias cuyo titular no contenga además
    alguna palabra propia de seguridad privada / alarmas (alarma, seguridad,
    protección, instalación, monitorización, hogar, vigilancia, etc.), para
    evitar falsos positivos por coincidencia de nombre (p.ej. "ADT" en una
    crónica de fútbol).
  - Descarta automáticamente cualquier noticia cuya fecha de publicación
    (pubDate del RSS) tenga más de OFERTAS_DIAS_MAX días (30 por defecto)
    de antigüedad, o cuya fecha no se pueda interpretar: solo se consideran
    promociones "actuales".
  - Vuelca TODAS las promociones detectadas (recientes) en OFERTAS_JSON,
    que sirve de base para --force-send y --test.
  - Envía las promociones detectadas a SegurPanel (POST /api/ofertas/sync)
    para que se muestren en la pestaña "Ofertas", actualizada cada día que
    se ejecuta el scraper. A diferencia de las alianzas, las ofertas no
    pasan por revisión manual: SegurPanel se queda, por empresa, con la
    promoción detectada más reciente.

Argumentos de línea de comandos:
  --force-send  No hace ninguna búsqueda nueva: envía a SegurPanel todas las
                promociones guardadas en OFERTAS_JSON.
  --test        Igual que --force-send pero solo con las 3 primeras
                promociones de OFERTAS_JSON, para probar la conexión con
                SegurPanel (URL, token) sin reenviar todo.

Configuración (variables de entorno):
  SEGURPANEL_OFERTAS_SYNC_URL  URL completa del endpoint, p.ej.
                                https://tu-app.onrender.com/api/ofertas/sync
  SEGURPANEL_SCRAPER_TOKEN     Debe coincidir con SCRAPER_TOKEN en el
                                servidor (el mismo secreto que usa
                                scraper_alianzas.py).
  OFERTAS_JSON                 Ruta del fichero con todas las promociones
                                detectadas (por defecto, ofertas.json junto
                                a este script); es lo que leen --force-send
                                y --test.
  OFERTAS_DIAS_MAX             Antigüedad máxima en días de una promoción
                                para considerarse "actual" (por defecto 30).

Cron sugerido (todos los días a las 07:15, poco después de scraper_alianzas.py):
  15 7 * * * SEGURPANEL_OFERTAS_SYNC_URL="https://tu-app.onrender.com/api/ofertas/sync" \
             SEGURPANEL_SCRAPER_TOKEN="el-mismo-secreto-que-en-el-servidor" \
             /usr/bin/python3 /home/pi/segurpanel/scraper_precios.py \
             >> /home/pi/segurpanel/scraper_precios.log 2>&1

Probar la conexión a mano:
  SEGURPANEL_OFERTAS_SYNC_URL="..." SEGURPANEL_SCRAPER_TOKEN="..." \
    python3 scraper_precios.py --test

Reenviar todo el histórico a mano:
  SEGURPANEL_OFERTAS_SYNC_URL="..." SEGURPANEL_SCRAPER_TOKEN="..." \
    python3 scraper_precios.py --force-send
"""

import argparse
import json
import os
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

# Palabras que delatan una promoción u oferta comercial (no una noticia
# corporativa cualquiera). Basta con que el titular contenga una de ellas.
PROMO_KEYWORDS = [
    "oferta", "ofertas", "promoción", "promocion", "promociones",
    "descuento", "descuentos", "rebaja", "rebajas", "gratis", "gratuita",
    "gratuito", "2x1", "black friday", "cyber monday", "meses gratis",
    "mes gratis", "instalación gratis", "instalacion gratis", "sin coste",
    "sin permanencia", "cuota gratis", "regalo", "bono",
]

# Palabras que indican que la noticia trata realmente de seguridad privada /
# alarmas, y no de una coincidencia de nombre (p.ej. "ADT" en una crónica de
# fútbol). El titular debe contener al menos una de ellas, además de mencionar
# la empresa, para considerarse una promoción relevante.
RELEVANCIA_KEYWORDS = [
    "alarma", "alarmas", "seguridad", "protección", "proteccion",
    "instalación", "instalacion", "monitorización", "monitorizacion",
    "monitoreo", "hogar", "empresa de seguridad", "seguridad privada",
    "vigilancia", "videovigilancia", "domótica", "domotica",
    "cámaras", "camaras", "sistema de seguridad", "central receptora",
    "antirrobo", "anti-robo",
]

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search?q={query}&hl=es&gl=ES&ceid=ES:es"
USER_AGENT = "Mozilla/5.0 (compatible; SegurPanelScraper/1.0; +https://segurpanel.local)"
REQUEST_TIMEOUT = 15
REQUEST_DELAY_SEGUNDOS = 1.5  # pausa entre peticiones, por cortesia con los servidores consultados
OFERTAS_DIAS_MAX = int(os.environ.get("OFERTAS_DIAS_MAX", "30"))

RUTA_SCRIPT = os.path.dirname(os.path.abspath(__file__))
OFERTAS_JSON = os.environ.get("OFERTAS_JSON", os.path.join(RUTA_SCRIPT, "ofertas.json"))
SYNC_URL = os.environ.get("SEGURPANEL_OFERTAS_SYNC_URL", "")
SYNC_TOKEN = os.environ.get("SEGURPANEL_SCRAPER_TOKEN", "")
NUM_OFERTAS_TEST = 3


# ---------------------------------------------------------------------------
# Deteccion de menciones a promociones a partir de un texto
# ---------------------------------------------------------------------------

def contiene_promocion(texto):
    texto_low = texto.lower()
    return any(palabra in texto_low for palabra in PROMO_KEYWORDS)


def es_relevante_seguridad(texto):
    """True si el texto (normalmente el titular) contiene alguna palabra
    propia de seguridad privada / alarmas. Descarta coincidencias de nombre
    ajenas al sector, como "ADT" en una noticia de fútbol."""
    texto_low = texto.lower()
    return any(palabra in texto_low for palabra in RELEVANCIA_KEYWORDS)


def generar_id_externo(*partes):
    base = "|".join(p.strip().lower() for p in partes if p)
    return sha1(base.encode("utf-8")).hexdigest()[:20]


def es_oferta_reciente(fecha_pub, dias_max=OFERTAS_DIAS_MAX):
    """True si `fecha_pub` (pubDate del RSS) cae dentro de los ultimos
    `dias_max` dias. Si la fecha viene vacia o no se puede interpretar, se
    descarta por precaucion: mejor perder alguna valida con formato raro
    que mostrar una promocion caducada como "actual" en la pestaña Ofertas."""
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
    return -timedelta(hours=1) <= antiguedad <= timedelta(days=dias_max)


# ---------------------------------------------------------------------------
# Fuente: Google News RSS
# ---------------------------------------------------------------------------

def descargar(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        return resp.read()


def buscar_ofertas_de_empresa(alarma):
    query = urllib.parse.quote(
        f'"{alarma}" (oferta OR ofertas OR promoción OR promocion OR descuento OR '
        f'"meses gratis" OR "sin permanencia" OR rebaja)'
    )
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
        if not contiene_promocion(titulo):
            continue  # la noticia no menciona ninguna palabra de oferta/promoción
        if not es_relevante_seguridad(titulo):
            continue  # el titular no habla de seguridad/alarmas (coincidencia de nombre, ej. futbol)
        if not es_oferta_reciente(fecha_pub):
            continue  # descarta promociones de mas de OFERTAS_DIAS_MAX dias (o sin fecha fiable)

        encontradas.append({
            "externalId": generar_id_externo("gnews-oferta", alarma, enlace),
            "empresa": alarma,
            "titulo": titulo,
            "fuente": fuente,
            "url": enlace,
            "fechaPublicacion": fecha_pub,
            "fechaDeteccion": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        })
    return encontradas


# ---------------------------------------------------------------------------
# Volcado completo de ofertas detectadas (base de --force-send y --test)
# ---------------------------------------------------------------------------

def cargar_ofertas_json():
    if not os.path.exists(OFERTAS_JSON):
        return []
    try:
        with open(OFERTAS_JSON, "r", encoding="utf-8") as f:
            datos = json.load(f)
            return datos if isinstance(datos, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def guardar_ofertas_json(ofertas):
    tmp = OFERTAS_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(ofertas, f, ensure_ascii=False, indent=2)
    os.replace(tmp, OFERTAS_JSON)


# ---------------------------------------------------------------------------
# Envio a SegurPanel
# ---------------------------------------------------------------------------

def sincronizar_con_segurpanel(ofertas):
    if not SYNC_URL or not SYNC_TOKEN:
        print("[info] SEGURPANEL_OFERTAS_SYNC_URL / SEGURPANEL_SCRAPER_TOKEN no configurados: "
              "las ofertas detectadas se han guardado en OFERTAS_JSON pero no se han enviado.")
        return False

    cuerpo = json.dumps({"ofertas": ofertas}).encode("utf-8")
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
        description="Scraper de ofertas de SegurPanel (busca promociones vigentes y las sincroniza con el panel)."
    )
    parser.add_argument(
        "--force-send",
        action="store_true",
        help=(
            "No busca ofertas nuevas: envía a SegurPanel TODAS las guardadas en "
            f"{OFERTAS_JSON}, aunque ya se hubieran enviado antes."
        ),
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help=(
            f"Igual que --force-send pero solo con las {NUM_OFERTAS_TEST} primeras ofertas "
            f"de {OFERTAS_JSON}, para probar la conexión con SegurPanel sin reenviar todo."
        ),
    )
    return parser.parse_args()


def enviar_desde_archivo(solo_prueba):
    ofertas_guardadas = cargar_ofertas_json()
    if not ofertas_guardadas:
        print(
            f"[error] No hay ofertas guardadas en {OFERTAS_JSON}. "
            "Ejecuta el scraper una vez sin --force-send/--test para generarlo.",
            file=sys.stderr,
        )
        return False

    a_enviar = ofertas_guardadas[:NUM_OFERTAS_TEST] if solo_prueba else ofertas_guardadas
    etiqueta = f"prueba de conexión ({len(a_enviar)} primeras)" if solo_prueba else "reenvío forzado"
    print(f"[info] {etiqueta}: enviando {len(a_enviar)} de {len(ofertas_guardadas)} ofertas guardadas en {OFERTAS_JSON}.")
    return sincronizar_con_segurpanel(a_enviar)


def main():
    args = parsear_argumentos()

    if args.force_send or args.test:
        enviado_ok = enviar_desde_archivo(solo_prueba=args.test)
        sys.exit(0 if enviado_ok else 1)

    todas_detectadas = []
    for alarma in ALARM_COMPANIES:
        todas_detectadas.extend(buscar_ofertas_de_empresa(alarma))
        time.sleep(REQUEST_DELAY_SEGUNDOS)

    # Deduplicar dentro de esta misma ejecución (misma promoción vista
    # varias veces en el RSS).
    por_id = {}
    for o in todas_detectadas:
        por_id.setdefault(o["externalId"], o)
    todas_detectadas = list(por_id.values())

    # Volcado completo: es lo que leen --force-send y --test.
    guardar_ofertas_json(todas_detectadas)

    print(f"[info] {len(todas_detectadas)} promociones actuales detectadas en total.")

    if todas_detectadas:
        sincronizar_con_segurpanel(todas_detectadas)
    else:
        print("[info] No se ha detectado ninguna promoción vigente en esta ejecución. No se envía nada.")


if __name__ == "__main__":
    main()
