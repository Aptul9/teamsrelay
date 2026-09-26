FROM python:3.14-slim
# Playwright is only a CDP client here: it attaches to the Chromium of the slot,
# so no browser is downloaded (no "playwright install").
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY agent.py /app/agent.py
CMD ["python", "-u", "/app/agent.py"]
