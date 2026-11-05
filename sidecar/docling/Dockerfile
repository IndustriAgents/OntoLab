# OntoLab document-parsing sidecar (Docling, MIT).
#   docker build -t ontolab-docling sidecar/docling
#   docker run -p 8001:8001 ontolab-docling
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    OMP_NUM_THREADS=4 \
    MODELS_DIR=/opt/docling-models

# OCR (tesseract CLI + English/OSD data) and the shared libraries docling's
# vision stack needs (OpenCV: libGL, glib).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
# CPU-only PyTorch keeps the image several GB smaller than the default CUDA wheels.
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

# Pre-download the layout + table models so the first request does not hit
# Hugging Face. Guarded: if the download fails the build still succeeds and
# docling fetches models lazily at runtime (app.py ignores an empty MODELS_DIR).
RUN mkdir -p "$MODELS_DIR" \
    && ( docling-tools models download -o "$MODELS_DIR" layout tableformer \
         || docling-tools models download -o "$MODELS_DIR" \
         || echo "WARNING: docling model pre-download failed; models will be fetched at runtime" )

RUN useradd --create-home --uid 10001 app \
    && chown -R app:app "$MODELS_DIR"

COPY --chown=app:app app.py serialize.py ./

USER app
ENV HOME=/home/app \
    HF_HOME=/home/app/.cache/huggingface

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
