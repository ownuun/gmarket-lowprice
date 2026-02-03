# 크롤러 롤백 가이드

## 문제 발생 시 롤백 방법

### 1. VPS 접속
```bash
ssh -i ~/Downloads/ssh-key-2026-01-16.key ubuntu@158.179.163.193
```

### 2. 이전 버전으로 롤백
```bash
cd /home/ubuntu/gmarket-lowprice

# 최근 커밋 1개 되돌리기
git revert HEAD --no-edit

# 빌드
pnpm build:worker

# 서비스 재시작
sudo systemctl restart gmarket-worker
```

### 3. 정상 작동 확인
```bash
sudo journalctl -u gmarket-worker -f
```

---

## 특정 버전으로 롤백

```bash
# 커밋 히스토리 확인
git log --oneline -10

# 특정 커밋으로 이동 (예: b40476a)
git reset --hard b40476a

# 빌드 및 재시작
pnpm build:worker
sudo systemctl restart gmarket-worker
```

---

## 주요 커밋 버전

| 커밋 | 설명 |
|------|------|
| `b40476a` | 브라우저 자동 재시작 (직접 URL 변경 전) |
| `77eee46` | 검색 URL 직접 접근 (75% 속도 향상) |

---

## 서비스 관리 명령어

```bash
# 상태 확인
sudo systemctl status gmarket-worker

# 재시작
sudo systemctl restart gmarket-worker

# 로그 실시간 확인
sudo journalctl -u gmarket-worker -f

# 최근 로그 100줄
sudo journalctl -u gmarket-worker -n 100 --no-pager
```
