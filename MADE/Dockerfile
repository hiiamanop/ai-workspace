FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    curl -L -o /usr/local/bin/opa https://openpolicyagent.org/downloads/v0.67.0/opa_linux_amd64_static && \
    chmod +x /usr/local/bin/opa && \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
# Deps + model weights are installed BEFORE the app source is copied, so an
# edit to core/ or api/ doesn't bust the cache and re-download ~1.5 GB of
# models on every rebuild. The dependency list mirrors pyproject.toml — keep
# the two in sync; likewise the model ids below mirror core/complexity.py and
# core/privacy/detectors.py.
COPY pyproject.toml ./
# CPU-only torch wheel — the default PyPI index resolves a CUDA build that's
# an order of magnitude larger and useless in this (GPU-less) deployment.
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu \
      "fastapi>=0.115" "uvicorn[standard]>=0.32" "pydantic>=2.9" "sqlmodel>=0.0.22" \
      "pyyaml>=6.0" "httpx>=0.27" "python-dotenv>=1.0" "scipy>=1.13" "torch>=2.13" \
      "transformers>=4.44" "spacy>=3.8" "cryptography>=43.0"
# Bake model weights into the image so container start never hits the network.
RUN python -m spacy download en_core_web_sm
RUN python -c "from transformers import pipeline; \
    pipeline('text-classification', model='BCN001/llm-complexity-router'); \
    pipeline('token-classification', model='cahya/bert-base-indonesian-NER', aggregation_strategy='simple')"
# Weights are already on disk — never let transformers phone home at startup.
ENV HF_HUB_OFFLINE=1

COPY core ./core
COPY api ./api
COPY storage ./storage
COPY policies ./policies
COPY config ./config
COPY experiments ./experiments
RUN pip install --no-cache-dir --no-deps .
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
