FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/dagster

WORKDIR /opt/beadswebui-automation

COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --disable-pip-version-check --requirement requirements.txt \
    && groupadd --system --gid 10001 dagster \
    && useradd --system --uid 10001 --gid dagster --home-dir /home/dagster --create-home --shell /usr/sbin/nologin dagster

COPY --chown=10001:10001 beadswebui_automation/ ./beadswebui_automation/
USER 10001:10001

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["dagster", "api", "grpc-health-check", "--host", "127.0.0.1", "--port", "4000"]

CMD ["dagster", "api", "grpc", "--host", "0.0.0.0", "--port", "4000", "--module-name", "beadswebui_automation"]
