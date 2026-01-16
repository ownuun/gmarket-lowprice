# G마켓 크롤러 워커 Dockerfile
FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app

# pnpm 설치
RUN npm install -g pnpm

# package.json 및 설정 파일 복사
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./

# 의존성 설치
RUN pnpm install --frozen-lockfile

# 소스 코드 복사
COPY src/ ./src/

# TypeScript 빌드
RUN pnpm build:worker

# 환경변수 (실행 시 주입)
ENV SUPABASE_URL=""
ENV SUPABASE_SERVICE_KEY=""

# 워커 실행
CMD ["node", "dist/worker.js"]
