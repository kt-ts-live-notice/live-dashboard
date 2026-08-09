# 역사 안내방송 실시간 시각화 PoC

청각장애인·시청각장애인을 위해 역사 안내방송을 실시간 텍스트로 변환하고, 전체 방송 단위로 분류해 웹 화면에 표시하는 PoC입니다.

```text
Raspberry Pi WAV 청크 ─┐
                       ├─ VITO 스트리밍 STT → 전체 방송 분류 → 결과 저장 → WebSocket 카드
WAV 샘플 재생 ─────────┘
```

## 준비와 실행

1. ReturnZero(VITO)에서 `client_id`/`client_secret`을, Anthropic에서 API 키를 발급합니다.
2. `.env.example`을 `.env`로 복사해 키와 `DEVICE_AUTH_TOKENS`를 설정합니다. 토큰은 저장소에 커밋하지 않습니다.
3. `npm install` 후 `npm run dev`를 실행합니다.

- 서버: `http://localhost:8787` (WebSocket `/ws`)
- 웹: `http://localhost:5173` (`/api`, `/ws`는 개발 서버가 프록시)

샘플 데모는 서비스 페이지와 분리된 `/demo/{station_id}/{역이름}`에서 실행합니다. `./scripts/make-samples.sh`로 합성 샘플을 만들거나 `./scripts/import-audio-samples.sh [원본 폴더]`로 M4A·MP3·WAV 실제 녹음을 변환한 뒤 데모 화면에서 녹음을 선택합니다. 변환본은 원본을 건드리지 않고 `samples/` 아래에 16kHz·mono·16bit PCM WAV로 생성됩니다. 버튼을 누르면 브라우저에서 실제 음성이 들리는 동시에 같은 파일이 STT·분류·WebSocket 자막 흐름으로 처리됩니다. 한 번에 한 샘플만 재생되며 `neg-*` 샘플은 분류 후 카드에서 제외됩니다. `/api/samples`, `/api/samples/:name/audio`, `/api/play/:name`에는 장치 bearer 인증이 적용되지 않습니다.

승객은 역에 설치된 QR로 `/stations/{station_id}/{역이름}`에 접속합니다. 이 서비스 주소에는 테스트 조작부가 나타나지 않습니다. PoC에서는 `station_id`를 해당 역 Raspberry Pi의 `device_id`와 동일하게 두며, 웹은 `/ws?station_id={station_id}`로 구독해 그 장치의 방송만 받습니다. 데모와 발표의 기준 역은 **영등포역**입니다. 서비스 주소는 `http://localhost:5173/stations/yeongdeungpo-01/영등포역`, 체험 주소는 `http://localhost:5173/demo/yeongdeungpo-01/영등포역`입니다. 역 식별자가 없는 루트 주소는 잘못된 QR 안내 화면을 표시합니다.

데모 화면도 표시 단계는 서버가 전달한 분류값만 사용하며 음량으로 긴급도를 올리지 않습니다. 실제 STT·분류 결과를 보려면 `.env`의 VITO·Anthropic API 키가 필요하지만, 브라우저 음성 재생 자체는 샘플 파일만 있으면 동작합니다.

확정 카드는 방송 원문을 다시 펼치게 하지 않고 `상황 맥락 → 핵심 결론 → 행동·세부정보`의 3단계로 표시합니다. STT 원문, 처리시간, 장치·세션 식별자는 저장·감사용 데이터로만 유지하며 승객과 데모 화면에는 노출하지 않습니다.

STT 결과는 정확하다고 가정하며 방송 문체를 별도로 순화하거나 재작성하지 않습니다. `하십시오`, `하시기 바랍니다` 같은 어미를 그대로 유지한 원문 연속 구절만 3단계 카드에 사용할 수 있고, 정확한 구절 분리가 불가능하면 재작성 대신 STT 전체 문장을 표시합니다.

## 안내 분류 계약

역사 안내는 다음 다섯 가지 화면 분류를 사용합니다. 실행 가능한 단일 진실원본은 `contracts/src/announcement.ts`이며, 서버 분류 스키마와 웹 타입이 이 계약을 함께 사용합니다.

| 화면 분류 | 포함 내용 |
|---|---|
| 열차 통과 | 무정차 열차 접근, 안전선 안쪽 이동 |
| 열차 진입 | 행선지, 열차 접근, 승강장 간격·발빠짐 주의 |
| 운행 변경 | 지연, 신호 대기, 운행 중단, 승강장 변경 |
| 일반 안내 | 반입 제한, 폭염, 이용수칙, 역사 시설 안내 |
| 긴급 안내 | 화재·대피 등 향후 확보할 실제 긴급방송 |

`category`는 위 enum 중 하나이고, `label`은 화면에 표시할 더 구체적인 상황명(예: `반입 제한`)입니다. `severity`의 `일반·주의·긴급`은 색상과 접근성 알림 수준을 결정하는 별도 enum이며, 방송 음량이 아니라 내용 분류 결과로 정합니다.

## Raspberry Pi 오디오 청크 계약

`POST /api/v1/audio-chunks`에 `multipart/form-data`로 정확히 아래 여섯 part를 보냅니다.

| 이름 | 값 |
|---|---|
| `audio` | WAV 파일 1개, 최대 128 KiB |
| `session_id` | 방송마다 새로 만든 UUID 또는 안전한 고유 ID |
| `chunk_index` | `0`부터 빈틈 없이 증가하는 정수 |
| `is_final` | 문자열 `true` 또는 `false` |
| `device_id` | `DEVICE_AUTH_TOKENS`의 장치 ID와 동일 |
| `recorded_at` | 실제 UTC RFC3339 시각, 반드시 `Z`로 끝남 |

WAV는 PCM 16 kHz, mono, 16-bit여야 합니다. 일반 청크의 PCM은 정확히 2초(64,000 bytes)이고 마지막 청크만 0초 초과 2초 이하일 수 있습니다. WAV 헤더는 서버에서 제거되며 PCM만 STT로 전달됩니다.

```bash
curl --fail-with-body \
  -H 'Authorization: Bearer <device-token>' \
  -F 'session_id=550e8400-e29b-41d4-a716-446655440000' \
  -F 'chunk_index=0' \
  -F 'is_final=false' \
  -F 'device_id=yeongdeungpo-01' \
  -F 'recorded_at=2026-08-03T03:00:00.000Z' \
  -F 'audio=@chunk-0000.wav;type=audio/wav' \
  http://localhost:8787/api/v1/audio-chunks
```

최초 수락과 바이트·메타데이터가 완전히 같은 재시도 모두 `202 Accepted`입니다.

```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "accepted_chunk_index": 0,
  "next_chunk_index": 1,
  "is_duplicate": false,
  "finalized": false
}
```

`finalized`는 마지막 입력이 수락돼 세션이 봉인됐다는 뜻이며 STT/분류 완료를 의미하지 않습니다. `202`는 현재 프로세스의 제한된 메모리 큐와 receipt에 원자적으로 수락됐다는 확인입니다. 프로세스 장애를 견디는 영속적 exactly-once는 이 PoC 범위가 아니며, 운영 단계에서는 외부 트랜잭션 저장소와 outbox가 필요합니다.

### Raspberry Pi 전송 절차

1. 1단계에서는 운영자가 방송 시작/종료를 수동으로 구분합니다. 시작할 때 절대 재사용하지 않을 UUID를 만들고 index `0`을 녹음합니다.
2. 각 WAV와 동일한 메타데이터를 `202`를 받을 때까지 보관합니다. ACK가 없으면 같은 바이트와 메타데이터로 0.5초, 1초, 2초 간격으로 최대 세 번 재시도합니다.
3. 미확인 index를 건너뛰지 않습니다. `409`의 `expected_chunk_index`를 확인하되, 이미 보낸 청크를 임의로 다시 생성하지 않습니다.
4. 운영자가 종료하면 마지막 청크에 `is_final=true`를 설정합니다. 마지막 청크는 2초보다 짧아도 됩니다.
5. 마지막 `202`가 유실돼도 동일 요청은 완료 receipt가 유지되는 기본 60초 동안 duplicate `202`를 받습니다. 이 기간 뒤 같은 UUID를 재사용해서는 안 됩니다.

자동 VAD/음향 기반 방송 경계 감지는 2단계 작업이며 Raspberry Pi 소스 코드는 이 저장소 범위 밖입니다.

## 오류와 처리 결과

청크 API 오류는 `application/problem+json`입니다. 주요 상태는 잘못된 필드/날짜 `400`, 인증 실패 또는 장치 불일치 `401`, 순서/재시도 충돌 `409`, 크기·part·세션 청크 한도 초과 `413`, 잘못된 외부 media type `415`, WAV 형식/길이 오류 `422`, 활성 세션·큐 포화 `429`, 첫 VITO 연결 실패 `502`, 인증 미설정 또는 종료 중 `503`입니다. 오류에는 토큰이나 오디오가 포함되지 않습니다.

장치 세션은 WebSocket으로 identity가 포함된 `stt-interim`, `stt-final`, `filtered`, `announcement`, `session-error` 이벤트를 보냅니다. 역별 승객 페이지는 `station_id`와 같은 `device_id` 이벤트만 서버에서 전달받고, 웹에서도 한 번 더 확인합니다. 마지막 청크 수신부터 카드 방출까지 `final_to_card_ms`를 구조화 로그로 남기며 p95 6초 이하는 측정 목표이지 SLA가 아닙니다. 비활성 세션은 기본 15초 뒤 분류나 카드 없이 종료됩니다. 최종 EOS/상류 종료 확인, 분류, 결과 저장 중 하나라도 실패하면 `session-error`만 보내고 부분 오디오로 카드를 만들지 않습니다.

## 한도와 배포

기본값은 활성 세션 8개, 세션별 PCM 큐 8초, 세션당 청크 1,800개, 완료 receipt 1,024개/60초, VITO frame 100 ms, VITO 인증·연결 및 EOS/최종 결과 대기 각각 10초입니다. HTTP 요청 전체는 최대 160 KiB이고 파일 1개, 텍스트 필드 5개, 전체 part 6개만 허용합니다. 환경변수 전체 목록과 기본값은 `.env.example`에 있습니다.

외부 배포에서는 listener를 인터넷에 직접 노출하지 말고 HTTPS reverse proxy 뒤에 둡니다. 신뢰하는 proxy가 `X-Forwarded-Proto: https`를 덮어쓰도록 제한한 뒤 `REQUIRE_HTTPS=true`를 설정합니다. 장치 토큰은 git 밖에서 관리·회전하고 Authorization header를 로그에 남기지 않습니다.

승객 웹을 정적 호스팅할 때는 `/stations/*`와 `/demo/*` 요청을 `index.html`로 보내는 SPA fallback을 설정해야 역별 QR·데모 URL을 새로 열거나 새로고침해도 같은 페이지가 표시됩니다.

## 검증

```bash
npm test
npm run typecheck
```

테스트는 외부 VITO/Anthropic 호출 없이 WAV 구조, HTTP/auth/multipart 계약, 순서·중복·동시 초기화, 큐/활성 용량, 전송 실패, 전체 transcript 단일 분류·저장·카드 발행과 기존 샘플 라우트를 검증합니다.

실시간 도착정보 API, QR/NFC 배포, 진동 알림, 외부 영속 저장소/outbox, 자동 방송 경계 감지는 후속 범위입니다.
