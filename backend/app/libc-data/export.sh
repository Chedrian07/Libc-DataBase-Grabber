#!/bin/bash

# export.sh

if [ $# -ne 1 ]; then
    echo "Usage: $0 <docker-image-tag>"
    exit 1
fi

DOCKER_TAG=$1
TMP_DIR=$(mktemp -d)
EXTRACT_DIR="/usr/src/libc-data/data/$DOCKER_TAG"

# 디렉토리 생성 및 권한 확인
if [ ! -d "/usr/src/libc-data" ]; then
    mkdir -p "/usr/src/libc-data"
    echo "Created base directory: /usr/src/libc-data"
fi

if [ ! -d "/usr/src/libc-data/data" ]; then
    mkdir -p "/usr/src/libc-data/data"
    echo "Created data directory: /usr/src/libc-data/data"
fi

mkdir -p "$EXTRACT_DIR"
echo "Created extract directory: $EXTRACT_DIR"

# 디렉토리 쓰기 권한 확인
if [ ! -w "$EXTRACT_DIR" ]; then
    echo "Error: No write permission for directory $EXTRACT_DIR"
    chmod -R 755 "/usr/src/libc-data"
    echo "Applied permissions to /usr/src/libc-data"
fi

DOCKER_IMAGE=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep ":$DOCKER_TAG$")

if [ -z "$DOCKER_IMAGE" ]; then
    echo "Error: Docker image with tag '$DOCKER_TAG' is not available locally."
    exit 1
fi

echo "Found Docker image: $DOCKER_IMAGE"

CONTAINER_ID=$(docker create "$DOCKER_IMAGE")
docker export "$CONTAINER_ID" | tar -C "$TMP_DIR" -xf - || {
    echo "Error: Failed to export root filesystem."
    docker rm "$CONTAINER_ID" &>/dev/null
    rm -rf "$TMP_DIR"
    exit 1
}

docker rm "$CONTAINER_ID" &>/dev/null

LIBC_PATH=$(find "$TMP_DIR" -type f -name "libc.so*" | head -n 1)
LD_LOADER_PATH=$(find "$TMP_DIR" -type f -name "ld-linux-*.so*" | head -n 1)

if [ -n "$LIBC_PATH" ]; then
    cp "$LIBC_PATH" "$EXTRACT_DIR/libc.so.6"
    echo "Extracted: libc.so.6 -> $EXTRACT_DIR/"
else
    echo "Error: libc.so not found in the image."
fi

if [ -n "$LD_LOADER_PATH" ]; then
    cp "$LD_LOADER_PATH" "$EXTRACT_DIR/ld-linux-x86-64.so.2"
    echo "Extracted: ld-linux-x86-64.so.2 -> $EXTRACT_DIR/"
else
    echo "Error: ld loader not found in the image."
fi

# 파일 권한 설정
chmod 644 "$EXTRACT_DIR/libc.so.6" "$EXTRACT_DIR/ld-linux-x86-64.so.2" 2>/dev/null

rm -rf "$TMP_DIR"
echo "Extraction complete. Files saved to $EXTRACT_DIR."