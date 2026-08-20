#!/bin/bash

set -e

IMAGE="ghcr.io/gaouravpatil/nexus-backend:latest"
CONTAINER="nexus-backend"

echo "Pulling latest Nexus image..."

sudo docker pull "$IMAGE"

echo "Stopping old container..."

sudo docker stop "$CONTAINER" 2>/dev/null || true
sudo docker rm "$CONTAINER" 2>/dev/null || true

echo "Starting new container..."

sudo docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --env-file /home/ubuntu/Nexus/.env \
  -p 127.0.0.1:8080:8080 \
  "$IMAGE"

echo "Deployment complete."

sudo docker ps --filter "name=$CONTAINER"
