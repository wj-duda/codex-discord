FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git gh bash build-essential cmake ffmpeg curl ca-certificates tini \
  && npm install -g pnpm@9.15.9 \
  && git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /opt/whisper.cpp \
  && cmake -S /opt/whisper.cpp -B /opt/whisper.cpp/build \
  && cmake --build /opt/whisper.cpp/build --config Release -j"$(nproc)" \
  && mkdir -p /opt/piper \
  && curl -L https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_amd64.tar.gz -o /tmp/piper_amd64.tar.gz \
  && tar -xzf /tmp/piper_amd64.tar.gz -C /opt/piper \
  && ln -sf /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli \
  && ln -sf /opt/piper/piper/piper /usr/local/bin/piper \
  && rm -f /tmp/piper_amd64.tar.gz \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
