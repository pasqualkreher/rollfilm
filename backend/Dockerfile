FROM python:3.12-slim

# libraw for RAW decoding (rawpy), exiftool for uniform EXIF across RAW+JPEG,
# libgl/glib for Pillow/torch runtime deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libraw-dev \
    libimage-exiftool-perl \
    libgl1 \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir --upgrade pip \
    # CPU-only torch/torchvision, installed together from the same index so their
    # ABIs match (open_clip pulling in a mismatched torchvision from PyPI otherwise
    # breaks with "operator torchvision::nms does not exist" at import time).
    && pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -e .

COPY app ./app
COPY alembic.ini ./

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8000

CMD ["./entrypoint.sh"]
