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


def put_json(path: str, value, message: str, author_email: str | None = None):
    _, sha = get_json(path)
    content = json.dumps(value, ensure_ascii=False, indent=2)
    body = {
        "message": message,
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "sha": sha,
        "branch": GITHUB_BRANCH,
    }
    if author_email:
        body["committer"] = {"name": author_email.split("@")[0], "email": author_email}
    res = requests.put(f"{API}/{path}", headers=HEADERS, json=body, timeout=15)
    res.raise_for_status()
    return res.json()
