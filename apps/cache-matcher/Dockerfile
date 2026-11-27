FROM python:3.12-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY model.py prepare.py serve.py ./
USER 65534:65534
EXPOSE 8092
ENTRYPOINT ["python", "serve.py", "--host", "0.0.0.0"]
