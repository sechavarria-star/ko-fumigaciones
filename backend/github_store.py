"""
Lee y escribe los JSON de docs/data/ directamente en GitHub vía la Contents API,
usando un token de servidor (GITHUB_TOKEN). Cada escritura es un commit real -
no hay base de datos, GitHub es la fuente de verdad.
"""
import base64
import json
import os

import requests

GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]
GITHUB_REPO = os.environ.get("GITHUB_REPO", "sechavarria-star/ko-fumigaciones")
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main")

API = f"https://api.github.com/repos/{GITHUB_REPO}/contents"
HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
}


def get_json(path: str):
    res = requests.get(f"{API}/{path}", headers=HEADERS, params={"ref": GITHUB_BRANCH}, timeout=15)
    res.raise_for_status()
    data = res.json()
    content = base64.b64decode(data["content"]).decode("utf-8")
    return json.loads(content), data["sha"]


def put_json_con_reintento(path: str, transformar, author_email: str | None = None, intentos: int = 4):
    """Lee value+sha, llama a `transformar(value) -> (nuevo_value, mensaje, resultado)`
    e intenta escribir con esa sha.

    Dos requests concurrentes (dos admins, o dos clics rápidos) pueden leer el
    mismo archivo y despues las dos intentar escribir - GitHub rechaza la
    segunda con 409 porque su sha ya quedó vieja. Reintentar la escritura a
    ciegas con el mismo contenido sería peor: pisaría en silencio el cambio
    del otro request. Por eso ante un 409 se vuelve a leer el estado más
    nuevo y se llama a `transformar` de nuevo desde cero, para que el cambio
    se aplique sobre los datos actuales.

    `transformar` puede devolver `nuevo_value=None` para indicar que no hay
    nada que escribir (ej. no había pagos nuevos para consolidar) - en ese
    caso no se pega nada a GitHub y se devuelve `resultado` directo.
    """
    ultimo_error = None
    for intento in range(intentos):
        value, sha = get_json(path)
        nuevo_value, mensaje, resultado = transformar(value)
        if nuevo_value is None:
            return resultado

        content = json.dumps(nuevo_value, ensure_ascii=False, indent=2)
        body = {
            "message": mensaje,
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
            "sha": sha,
            "branch": GITHUB_BRANCH,
        }
        if author_email:
            body["committer"] = {"name": author_email.split("@")[0], "email": author_email}
        res = requests.put(f"{API}/{path}", headers=HEADERS, json=body, timeout=15)
        if res.status_code == 409:
            ultimo_error = requests.exceptions.HTTPError(
                f"409 Conflict en {path} (intento {intento + 1}/{intentos})", response=res
            )
            continue
        res.raise_for_status()
        return resultado
    raise ultimo_error
