FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    curl -L -o /usr/local/bin/opa https://openpolicyagent.org/downloads/v0.67.0/opa_linux_amd64_static && \
    chmod +x /usr/local/bin/opa && \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml ./
COPY core ./core
COPY api ./api
COPY storage ./storage
COPY policies ./policies
COPY config ./config
COPY experiments ./experiments
# CPU-only torch wheel — the default PyPI index resolves a CUDA build that's
# an order of magnitude larger and useless in this (GPU-less) deployment.
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu .
# Bake the complexity classifier's weights into the image so a container
# start never depends on the network or eats a cold-download delay.
RUN python -c "from core.complexity import warm_up; warm_up()"
# Same for the redaction NER model.
RUN python -m spacy download en_core_web_sm
# Weights are already on disk from the RUN above — never let transformers
# phone home to check for a newer revision at container startup.
ENV HF_HUB_OFFLINE=1
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
