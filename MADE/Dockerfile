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
RUN pip install --no-cache-dir .
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
