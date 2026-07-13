#!/bin/bash
# 테스트 오디오 샘플 생성: macOS say(한국어 TTS)로 16kHz mono LINEAR16 WAV 생성
# 사용법: ./scripts/make-samples.sh
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p samples

# 한국어 음성 선택 (Yuna 우선 — 일부 novelty 음성은 WAV 출력이 깨짐)
if say -v '?' | grep -q '^Yuna '; then
  VOICE=Yuna
else
  VOICE=$(say -v '?' | awk '/ko_KR/ {print $1; exit}')
fi
if [ -z "$VOICE" ]; then
  echo "오류: 한국어 TTS 음성이 없습니다. 시스템 설정 > 손쉬운 사용 > 콘텐츠 말하기에서 한국어 음성을 추가하세요." >&2
  exit 1
fi
echo "TTS 음성: $VOICE"

gen() {
  local name="$1" text="$2"
  say -v "$VOICE" -o "samples/${name}.wav" --file-format=WAVE --data-format=LEI16@16000 "$text"
  local size
  size=$(stat -f%z "samples/${name}.wav")
  if [ "$size" -lt 20000 ]; then
    echo "오류: samples/${name}.wav 생성 실패 (${size} bytes) — 다른 음성으로 시도하세요" >&2
    exit 1
  fi
  echo "  samples/${name}.wav (${size} bytes)"
}

# 안내방송 샘플 5종
gen delay "고객 여러분께 안내 말씀드립니다. 현재 전방 열차 고장으로 인하여 열차가 약 십 분 정도 지연되고 있습니다. 열차 이용에 참고하시기 바랍니다."
gen skip-stop "지금 들어오는 열차는 급행열차로 세류역에는 정차하지 않습니다. 세류역으로 가실 고객께서는 다음 일반열차를 이용하시기 바랍니다."
gen platform-change "안내 말씀드립니다. 부산 방면 케이티엑스 열차의 타는 곳이 삼 번 승강장에서 오 번 승강장으로 변경되었습니다. 오 번 승강장으로 이동하여 주시기 바랍니다."
gen emergency "긴급 상황입니다. 역사 내 화재가 발생하였습니다. 고객 여러분께서는 직원의 안내에 따라 가까운 비상구로 침착하게 대피하여 주시기 바랍니다."
gen safety "우리 역은 열차와 승강장 사이가 넓습니다. 타고 내리실 때 발이 빠지지 않도록 주의하시기 바랍니다."

# 네거티브 샘플 2종 (안내방송 아님 — 필터링 검증용)
gen neg-chat "야 우리 이따가 점심 뭐 먹을까. 나는 그냥 김치찌개 먹고 싶은데. 어제 본 드라마 진짜 재밌더라."
gen neg-ask "저기요 혹시 이 근처에 화장실이 어디 있는지 아세요. 아 네 감사합니다."

echo "완료: $(ls samples/*.wav | wc -l | tr -d ' ')개 샘플 생성"
