FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git bash build-essential cmake ffmpeg curl ca-certificates \
  && npm install -g pnpm@9.15.9 \
  && git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /opt/whisper.cpp \
  && cmake -S /opt/whisper.cpp -B /opt/whisper.cpp/build \
  && cmake --build /opt/whisper.cpp/build --config Release -j"$(nproc)" \
  && mkdir -p /opt/whisper.cpp/models \
  && curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin -o /opt/whisper.cpp/models/ggml-small.bin \
  && ln -sf /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
