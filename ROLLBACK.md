# 크롤러 롤백 가이드

운영 서버: **iwinv VPS** (`115.68.231.137`, KR1-Z02, Ubuntu 24.04)

---

## VPS 접속

```bash
# SSH config 등록된 경우 (~/.ssh/config 에 iwinv-gmarket 항목)
ssh iwinv-gmarket

# 또는 직접
ssh -i ~/.ssh/iwinv_ed25519 root@115.68.231.137
```

---

## 1. 이전 버전으로 롤백 (최근 커밋 되돌리기)

```bash
cd /root/gmarket-lowprice

# 최근 커밋 1개 되돌리기 (히스토리 보존)
git revert HEAD --no-edit

# 빌드 (pnpm 우회 — pnpm build:worker 가 의존성 체크에서 막힐 수 있음)
./node_modules/.bin/tsc

# 서비스 재시작
sudo systemctl restart gmarket-worker
```

---

## 2. 특정 커밋으로 롤백 (강제 리셋)

```bash
cd /root/gmarket-lowprice

# 커밋 히스토리 확인
git log --oneline -10

# 특정 커밋으로 강제 이동 (예: 69a3ba7)
git reset --hard 69a3ba7

# 빌드 + 재시작
./node_modules/.bin/tsc
sudo systemctl restart gmarket-worker
```

---

## 3. 정상 작동 확인

```bash
# 서비스 상태
sudo systemctl status gmarket-worker

# 실시간 로그
sudo journalctl -u gmarket-worker -f

# 최근 100줄
sudo journalctl -u gmarket-worker -n 100 --no-pager
```

---

## 서비스 관리 명령어

```bash
# 상태 확인
sudo systemctl status gmarket-worker

# 시작 / 중지 / 재시작
sudo systemctl start gmarket-worker
sudo systemctl stop gmarket-worker
sudo systemctl restart gmarket-worker

# 부팅 시 자동 시작 활성화 / 비활성화
sudo systemctl enable gmarket-worker
sudo systemctl disable gmarket-worker

# 로그 (실시간)
sudo journalctl -u gmarket-worker -f

# 로그 (최근 N줄)
sudo journalctl -u gmarket-worker -n 100 --no-pager

# 로그 (특정 시간 이후)
sudo journalctl -u gmarket-worker --since "1 hour ago" --no-pager
```

---

## 코드 업데이트 (정상 배포 흐름)

```bash
cd /root/gmarket-lowprice
git pull

# 의존성 변경된 경우만
pnpm install --frozen-lockfile 2>/dev/null || true

# 빌드 (pnpm 우회)
./node_modules/.bin/tsc

# 서비스 재시작
sudo systemctl restart gmarket-worker

# 로그 확인
sudo journalctl -u gmarket-worker -f
```

> ⚠️ `pnpm build:worker` 가 `ERR_PNPM_IGNORED_BUILDS` 로 막히는 경우 `./node_modules/.bin/tsc` 로 직접 호출하세요.

---

## 알려진 이슈

### 1. Atomic claim race condition (worker.ts)

`src/worker.ts` 의 `pollForJobs` (L356-L369) 는 `SELECT pending` 후 별도로 `UPDATE processing` 합니다. 여러 워커가 동시 실행되면 **같은 job 을 둘 다 잡을 수 있습니다.** 향후 RPC 함수로 atomic claim 으로 교체 권장.

### 2. pnpm 빌드 스크립트 차단

`pnpm@11+` 에서 `esbuild`, `unrs-resolver` 의 빌드 스크립트가 무시되면서 `pnpm build:worker` 가 막힙니다. 위 가이드대로 `./node_modules/.bin/tsc` 직접 호출하면 됩니다.

---

## 옛 서버 정보 (deprecated)

| 항목 | 값 |
|---|---|
| Provider | Oracle Cloud (Always Free) |
| IP | `158.179.163.193` |
| User | `ubuntu` |
| Region | ap-chuncheon-1 |
| 상태 | **2026-05-27 부로 deprecated.** Cloud 콘솔 로그인 차단 + SSH 키 분실로 접근 불가 |

옛 서버 워커가 살아있는지 확인 불가능. Supabase 옛 service_role 키를 무효화하여 격리 예정.
