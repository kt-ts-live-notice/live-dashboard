#!/bin/bash
# 실제 녹음 M4A를 기존 샘플 재생기가 읽는 16kHz mono 16bit PCM WAV로 변환한다.
# 사용법: ./scripts/import-audio-samples.sh [원본 폴더]
set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SOURCE_DIR=${1:-"$PROJECT_DIR/../../data"}
OUTPUT_DIR="$PROJECT_DIR/samples"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "오류: ffmpeg가 필요합니다." >&2
  exit 1
fi

if [ ! -d "$SOURCE_DIR" ]; then
  echo "오류: 원본 폴더를 찾을 수 없습니다: $SOURCE_DIR" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
converted=0

while IFS= read -r -d '' input; do
  name=$(basename "${input%.*}")
  output="$OUTPUT_DIR/$name.wav"
  ffmpeg -hide_banner -loglevel error -y -i "$input" \
    -ar 16000 -ac 1 -c:a pcm_s16le "$output"
  echo "  $name.wav"
  converted=$((converted + 1))
done < <(find "$SOURCE_DIR" -maxdepth 1 -type f \( -iname '*.m4a' -o -iname '*.mp3' -o -iname '*.wav' \) -print0 | sort -z)

if [ "$converted" -eq 0 ]; then
  echo "오류: 변환할 M4A, MP3, WAV 파일이 없습니다." >&2
  exit 1
fi

echo "완료: ${converted}개 실제 녹음을 $OUTPUT_DIR 에 준비했습니다."
