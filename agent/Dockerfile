FROM python:3.12-slim
# Playwright serve solo come client CDP: si collega al Chromium del container "chromium",
# quindi non scarica nessun browser (niente "playwright install").
RUN pip install --no-cache-dir playwright==1.55.0 pywebpush==2.5.0
WORKDIR /app
COPY agent.py /app/agent.py
CMD ["python", "-u", "/app/agent.py"]
