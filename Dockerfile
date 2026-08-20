# --- Stage 1: Build ---
FROM golang:1.25.11-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -p 1 -o /nexus ./cmd/api

# --- Stage 2: Run ---
FROM alpine:3.20

RUN apk --no-cache add ca-certificates

WORKDIR /app

COPY --from=builder /nexus .

EXPOSE 8080

ENTRYPOINT ["./nexus"]
