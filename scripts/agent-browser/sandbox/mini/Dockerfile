FROM python:3.12-slim
RUN pip install --no-cache-dir flask==3.1.0 gunicorn==23.0.0 openpyxl==3.1.5 python-docx==1.1.2
WORKDIR /app
COPY app.py .
CMD ["gunicorn", "-w", "1", "--threads", "8", "-b", "0.0.0.0:8000", "app:app"]
