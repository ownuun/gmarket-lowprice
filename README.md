# G마켓 최저가 크롤러

삼촌을 위한 G마켓 최저가 검색 웹 서비스

## 아키텍처

```
[웹앱 (Vercel)] → [Supabase DB] ← [크롤러 워커 (iwinv VPS)]
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
ssh -i ~/.ssh/iwinv_ed25519 root@115.68.231.137

# 또는 ~/.ssh/config 에 등록 시
ssh iwinv-gmarket
```

`~/.ssh/config` 등록 예시:

```sshconfig
Host iwinv-gmarket
    HostName 115.68.231.137
    User root
    IdentityFile ~/.ssh/iwinv_ed25519
    StrictHostKeyChecking no
    ServerAliveInterval 60
    ServerAliveCountMax 3
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
cd /root/gmarket-lowprice
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
User=root
WorkingDirectory=/root/gmarket-lowprice
ExecStart=/usr/bin/node /root/gmarket-lowprice/dist/worker.js
Restart=always
RestartSec=10
Environment=PATH=/usr/bin:/usr/local/bin
EnvironmentFile=/root/gmarket-lowprice/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable gmarket-worker
sudo systemctl start gmarket-worker
```

---

## 서버 정보

- **IP**: 115.68.231.137
- **User**: root
- **SSH Key**: `~/.ssh/iwinv_ed25519`
- **Provider**: iwinv (스마일서브)
- **Region**: KR1-Z02
- **사양**: vgna_2_n (2 vCPU / 2GB RAM / 50GB NVMe SSD)
- **비용**: 월 13,100원 (부가세 별도)
- **OS**: Ubuntu 24.04 LTS

> root 비밀번호는 SSH 키 인증으로 대체. `sshd_config` 에서 `PasswordAuthentication no` 권장.

### 마이그레이션 히스토리

- **2026-05-27**: Oracle Cloud (`158.179.163.193`, ap-chuncheon-1) → iwinv (`115.68.231.137`, KR1-Z02)
  - 원인: Oracle Cloud 콘솔 로그인 차단 + SSH 키 분실로 운영 접근 불가
  - 옛 서버 워커 상태 불명. Supabase 옛 service_role 키도 무효화하여 격리 예정

## 서비스 정보

- **웹앱**: Vercel
- **DB**: Supabase
- **크롤러**: iwinv VPS
