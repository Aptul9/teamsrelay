FROM python:3.12-slim
RUN pip install --no-cache-dir fastapi==0.141.1 "uvicorn[standard]==0.53.0"
WORKDIR /app
COPY app.py index.html login.html /app/
COPY static /app/static
EXPOSE 8090
CMD ["python", "-u", "app.py"]
