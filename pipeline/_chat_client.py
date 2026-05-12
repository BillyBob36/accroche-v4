"""Azure OpenAI Chat client — séparé du client image (`_imagegen/_client.py`).

Utilisé par les pipelines `generate_questions.py`, `generate_quests.py` et
`refine_prompt.py` pour appeler le déploiement Chat configuré sur Coolify
(par défaut `gpt-5.4-ACCROCHE` sur `johannfoundry.cognitiveservices.azure.com`,
modèle gpt-5.4 v2026-03-05, capacité 250k TPM GlobalStandard).

Variables d'env attendues :
  AZURE_OPENAI_CHAT_ENDPOINT     ex. https://johannfoundry.cognitiveservices.azure.com
  AZURE_OPENAI_CHAT_DEPLOYMENT   ex. gpt-5.4-ACCROCHE
  AZURE_OPENAI_CHAT_API_VERSION  ex. 2025-01-01-preview
  AZURE_OPENAI_CHAT_API_KEY      la clé api-key

Ces variables sont distinctes des AZURE_OPENAI_* utilisées pour l'image
(qui pointent vers un autre déploiement, gpt-image-2).
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request


def _env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise RuntimeError(
            f"Variable d'environnement manquante : {name}. "
            f"Configure les AZURE_OPENAI_CHAT_* (voir _chat_client.py)."
        )
    return val


def chat(
    messages: list[dict],
    *,
    max_completion_tokens: int = 2048,
    temperature: float | None = None,
    timeout: int = 120,
    response_format_json: bool = False,
) -> dict:
    """Appelle le endpoint Chat Completions et renvoie le payload JSON brut.

    `messages` : liste OpenAI [{role, content}, ...].
    `response_format_json` : force le serveur à répondre en JSON parsable
      (utile pour la génération de questions / quêtes structurées).

    Renvoie le `dict` complet de la réponse (avec choices, usage, etc.).
    Lève RuntimeError sur erreur HTTP ou timeout.
    """
    endpoint = _env("AZURE_OPENAI_CHAT_ENDPOINT").rstrip("/")
    deploy = _env("AZURE_OPENAI_CHAT_DEPLOYMENT")
    api_version = os.environ.get("AZURE_OPENAI_CHAT_API_VERSION", "2025-01-01-preview")
    key = _env("AZURE_OPENAI_CHAT_API_KEY")

    url = f"{endpoint}/openai/deployments/{deploy}/chat/completions?api-version={api_version}"
    body: dict = {
        "messages": messages,
        "max_completion_tokens": max_completion_tokens,
    }
    if temperature is not None:
        body["temperature"] = temperature
    if response_format_json:
        body["response_format"] = {"type": "json_object"}

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={
            "api-key": key,
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8")[:600]
        except Exception:
            err_body = ""
        raise RuntimeError(f"Azure Chat HTTP {e.code} : {err_body}") from e
    except Exception as e:
        raise RuntimeError(f"Azure Chat exception : {e}") from e

    j = json.loads(payload)
    dt = time.time() - t0
    print(
        f"[chat] {deploy} {dt:.1f}s "
        f"prompt={j.get('usage',{}).get('prompt_tokens',0)} "
        f"completion={j.get('usage',{}).get('completion_tokens',0)}",
        file=sys.stderr,
    )
    return j


def chat_text(messages: list[dict], **kwargs) -> str:
    """Wrapper qui renvoie directement le texte de la 1re completion."""
    j = chat(messages, **kwargs)
    return j.get("choices", [{}])[0].get("message", {}).get("content", "")


def chat_json(messages: list[dict], **kwargs) -> dict:
    """Wrapper qui force JSON mode + parse la réponse en dict.

    Si le contenu n'est pas du JSON valide, lève RuntimeError avec
    l'extrait fautif pour debug.
    """
    kwargs["response_format_json"] = True
    txt = chat_text(messages, **kwargs)
    try:
        return json.loads(txt)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"JSON invalide retourné : {txt[:400]}") from e
