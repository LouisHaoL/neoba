# neoba spike: claude-code + codex 基座验证镜像(用完即扔)
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/*

# 两个候选基座 CLI
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
 && npm cache clean --force

# 非 root 工作用户(顺便验证:普通用户对 root 文件的天然隔离)
RUN useradd -m -s /bin/bash worker
USER worker
WORKDIR /home/worker/work

ENV CI=1
CMD ["bash"]
