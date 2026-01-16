# Playwright가 포함된 Node.js 이미지 사용
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# package.json 복사 및 의존성 설치
COPY package*.json ./
RUN npm ci --only=production

# 소스코드 복사
COPY dist ./dist

# Playwright 브라우저 경로 설정
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Worker 실행
CMD ["node", "dist/worker.js"]
