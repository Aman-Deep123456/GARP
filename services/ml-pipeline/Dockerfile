FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN mkdir -p /app/models
COPY . .
EXPOSE 8004
CMD ["python", "main.py"]
