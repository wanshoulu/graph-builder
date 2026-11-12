FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --requirement requirements.txt

COPY app ./app
COPY skills ./skills

RUN useradd --create-home --uid 10001 rsi-agent \
    && mkdir -p /app/checkpoints /app/logs /tmp/rsi-agent-attribute /tmp/rsi-agent-propose \
    && chown -R rsi-agent:rsi-agent /app/checkpoints /app/logs /tmp/rsi-agent-attribute /tmp/rsi-agent-propose

USER rsi-agent

EXPOSE 18132

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "18132", "--no-access-log"]
