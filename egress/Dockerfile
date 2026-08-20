FROM python:3.12-slim

# curl_cffi ships prebuilt wheels with its own patched libcurl, so no
# build toolchain is needed here.
RUN pip install --no-cache-dir "curl_cffi==0.15.0"

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8000
CMD ["python", "-u", "/app/server.py"]
