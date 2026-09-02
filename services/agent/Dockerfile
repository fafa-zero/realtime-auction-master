FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY services/agent/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services ./services
EXPOSE 8100
HEALTHCHECK --interval=10s --timeout=3s --retries=10 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=2)"

CMD ["uvicorn", "services.agent.app.main:app", "--host", "0.0.0.0", "--port", "8100"]

