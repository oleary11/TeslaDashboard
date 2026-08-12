FROM golang:1.23-alpine AS builder
RUN apk add --no-cache git
RUN git clone --depth 1 https://github.com/teslamotors/vehicle-command.git /src
WORKDIR /src
RUN go build -o /tesla-http-proxy ./cmd/tesla-http-proxy

FROM alpine:3.19
RUN apk add --no-cache ca-certificates openssl
COPY --from=builder /tesla-http-proxy /usr/local/bin/tesla-http-proxy
# generate a self-signed TLS cert for internal Docker use at build time
RUN openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
    -keyout /tls.key -out /tls.crt -days 3650 -nodes \
    -subj "/CN=vehicle-command"
EXPOSE 8080
ENTRYPOINT ["tesla-http-proxy", \
    "-key-file", "/data/tesla_partner_key.pem", \
    "-cert", "/tls.crt", \
    "-tls-key", "/tls.key", \
    "-port", "8080", \
    "-host", "0.0.0.0"]
