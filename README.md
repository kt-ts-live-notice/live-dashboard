# 역사 안내방송 실시간 시각화 PoC

청각장애인·시청각장애인을 위해 지하철/철도역 안내방송을 실시간 텍스트로 변환·분류하여 웹 화면에 표시하는 PoC.

```
[WAV 샘플] → 실시간 속도 스트리밍 → VITO 스트리밍 STT → LLM 분류/쉬운 문장 변환 → WebSocket → 웹 화면
```

## 준비

1. **API 키 발급**
   - ReturnZero(VITO): https://developers.rtzr.ai 에서 client_id/secret 발급
   - Anthropic API 키
2. **환경변수**: `.env.example`을 `.env`로 복사 후 키 입력
3. **의존성 설치**: `npm install`
4. **테스트 오디오 생성** (macOS 한국어 TTS 사용):
   ```
   ./scripts/make-samples.sh
   ```
   안내방송 5종(지연/무정차/승강장변경/긴급/안전) + 네거티브 2종(일상 대화)이 `samples/`에 생성됨.

## 실행

```
npm run dev
```

- 서버: http://localhost:8787 (WebSocket: `/ws`)
- 웹: http://localhost:5173 (Vite dev server, `/api`·`/ws`는 서버로 프록시)

브라우저에서 하단 샘플 버튼을 누르면 해당 WAV가 실제 재생 속도로 STT에 스트리밍되고, 분류를 통과한 안내가 카드로 표시됩니다. 네거티브 샘플(neg-*)은 `is_announcement=false`로 필터링되어 화면에 나타나지 않습니다(서버 로그로 확인).

## 검증 포인트

- 안내방송 5종이 올바른 유형/중요도로 분류되는가
- 일상 대화가 필터링되는가
- 종단 지연(STT final → 화면 표시)이 5초 이내인가 — 카드의 "원문 보기"에서 처리 지연(ms) 확인

## 테스트

```
npm test          # WAV 파서 단위 테스트 (vitest)
npm run typecheck
```

## 범위 제외 (2단계)

서울시 실시간 도착정보 API 연계, QR/NFC 물리 배포, 라이브 마이크 입력, 오디오 신호 기반 방송 판별, 진동 알림
