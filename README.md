# G마켓 최저가 크롤러

삼촌을 위한 G마켓 최저가 검색 웹 서비스

## 아키텍처

```
[웹앱 (Vercel)] → [Supabase DB] ← [크롤러 워커 (Oracle Cloud)]
                       ↓
                [엑셀 다운로드]
```

## 사용 방법

1. 웹앱 접속 → Google 로그인
2. 모델명 입력 (줄바꿈으로 구분)
3. "크롤링 시작" 클릭
4. 진행률 확인
5. 완료 후 엑셀 다운로드

---

## VPS 워커 관리 가이드

### 서버 접속

```bash
chmod 400 /Users/ownuun/Downloads/ssh-key-2026-01-16.key
ssh -i /Users/ownuun/Downloads/ssh-key-2026-01-16.key ubuntu@158.179.163.193
```

### 워커 상태 확인

```bash
sudo systemctl status gmarket-worker
```

### 로그 확인

```bash
# 실시간 로그
sudo journalctl -u gmarket-worker -f

# 최근 100줄
sudo journalctl -u gmarket-worker -n 100
```

### 워커 제어

```bash
# 재시작
sudo systemctl restart gmarket-worker

# 중지
sudo systemctl stop gmarket-worker

# 시작
sudo systemctl start gmarket-worker
```

### 코드 업데이트

```bash
cd ~/gmarket-lowprice
git pull
pnpm build:worker
sudo systemctl restart gmarket-worker
```

---

## systemd 서비스 등록 (최초 1회)

```bash
sudo tee /etc/systemd/system/gmarket-worker.service << 'EOF'
[Unit]
Description=Gmarket Crawler Worker
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/gmarket-lowprice
ExecStart=/usr/bin/node /home/ubuntu/gmarket-lowprice/dist/worker.js
Restart=always
RestartSec=10
Environment=PATH=/usr/bin:/usr/local/bin
EnvironmentFile=/home/ubuntu/gmarket-lowprice/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable gmarket-worker
sudo systemctl start gmarket-worker
```

---

## 서버 정보

- **IP**: 158.179.163.193
- **User**: ubuntu
- **Provider**: Oracle Cloud (Always Free)
- **Region**: ap-chuncheon-1 (춘천)

## 서비스 정보

- **웹앱**: Vercel
- **DB**: Supabase
- **크롤러**: Oracle Cloud VPS
