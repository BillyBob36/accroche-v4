# Image Python minimale + libs natives nécessaires à Pillow / scikit-image
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

WORKDIR /app

# Dépendances système (Pillow + scikit-image + outils basiques)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libjpeg62-turbo \
        zlib1g \
        libpng16-16 \
        libwebp7 \
        libtiff6 \
        libopenjp2-7 \
        libgomp1 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Installer les libs Python avant le code (cache Docker plus efficace)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Code de l'app
COPY . .

# Volume pour les modules sauvegardés (persistance entre redéploiements)
RUN mkdir -p /app/public/scenes && chown -R nobody:nogroup /app/public

EXPOSE 8000

CMD ["python", "server.py"]
