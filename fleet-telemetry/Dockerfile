FROM golang:1.23-bullseye AS build

WORKDIR /build

RUN wget -q https://github.com/jedisct1/libsodium/releases/download/1.0.19-RELEASE/libsodium-1.0.19.tar.gz && \
    tar -xzf libsodium-1.0.19.tar.gz && \
    cd libsodium-stable && \
    ./configure --disable-shared --enable-static && \
    make -j$(nproc) && make install

RUN wget -q https://github.com/zeromq/libzmq/releases/download/v4.3.4/zeromq-4.3.4.tar.gz && \
    tar -xf zeromq-4.3.4.tar.gz && \
    cd zeromq-4.3.4 && \
    ./configure --enable-static --disable-shared --disable-Werror && \
    make -j$(nproc) && make install

RUN git clone --depth 1 --branch v0.9.0 https://github.com/teslamotors/fleet-telemetry /src

WORKDIR /src
ENV CGO_ENABLED=1
ENV CGO_LDFLAGS="-lstdc++"
RUN make

FROM gcr.io/distroless/cc-debian11
COPY --from=build /go/bin/fleet-telemetry /fleet-telemetry
CMD ["/fleet-telemetry", "-config", "/etc/fleet-telemetry/config.json"]
