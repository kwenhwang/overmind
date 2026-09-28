#!/usr/bin/env bash
# NAN 2026 제출 영상 조립 — 컷 편집 + 자막 번인 + 엔드카드.
# 규정 준수: 배속·합성·자동조종 없음. 원본 푸티지의 화면을 자르고 이어붙이기만 한다.
#
#   사용법: tools/video/build-submission.sh
#   입력  : docs/video/raw/*.mp4 (원본 푸티지), tools/video/cutlist.txt (컷 목록)
#   자막  : docs/video/subtitles-final.srt   엔드카드: docs/video/endcard.png
#   출력  : docs/video/OVERMIND-NAN2026.mp4
set -euo pipefail

cd "$(dirname "$0")/../.."
RAW=docs/video/raw
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

FONT=/usr/share/fonts/truetype/nanum/NanumSquareB.ttf
SRT=docs/video/subtitles-final.srt
ENDCARD=docs/video/endcard.png
OUT=docs/video/OVERMIND-NAN2026.mp4
ENDCARD_SEC=3

# 모든 조각을 같은 규격으로 재인코딩해야 concat이 깨지지 않는다 (1080p30 / yuv420p / aac 48k stereo).
enc_v=(-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 30 -g 60)
enc_a=(-c:a aac -b:a 192k -ar 48000 -ac 2)

n=0
: > "$WORK/list.txt"
while read -r file start end _rest; do
  [[ -z "${file:-}" || "$file" == \#* ]] && continue
  n=$((n + 1))
  seg=$(printf '%s/seg%02d.mp4' "$WORK" "$n")
  dur=$(awk -v a="$start" -v b="$end" 'BEGIN{printf "%.3f", b-a}')
  echo "  [$n] $file  ${start}s → ${end}s  (${dur}s)"
  # -ss를 입력 앞에 두면 빠르지만 키프레임으로 스냅한다 → 정확한 컷을 위해 입력 뒤에 둔다.
  # -nostdin 필수: 없으면 ffmpeg이 stdin(=컷 리스트)을 삼켜 다음 줄부터 사라진다.
  ffmpeg -nostdin -y -v error -i "$RAW/$file" -ss "$start" -to "$end" \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1" \
    -af "afade=t=in:st=0:d=0.05,afade=t=out:st=$(awk -v d="$dur" 'BEGIN{printf "%.3f", d-0.05}'):d=0.05" \
    "${enc_v[@]}" "${enc_a[@]}" "$seg"
  echo "file '$seg'" >> "$WORK/list.txt"
done < tools/video/cutlist.txt

echo "  [엔드카드] ${ENDCARD_SEC}s"
ffmpeg -y -v error -loop 1 -t "$ENDCARD_SEC" -i "$ENDCARD" \
  -f lavfi -t "$ENDCARD_SEC" -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -vf "scale=1920:1080,setsar=1" "${enc_v[@]}" "${enc_a[@]}" "$WORK/endcard.mp4"
echo "file '$WORK/endcard.mp4'" >> "$WORK/list.txt"

echo "  [이어붙이기]"
ffmpeg -y -v error -f concat -safe 0 -i "$WORK/list.txt" -c copy "$WORK/joined.mp4"

echo "  [자막 번인 + 페이드]"
TOTAL=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/joined.mp4")
FADEOUT=$(awk -v t="$TOTAL" 'BEGIN{printf "%.3f", t-0.6}')
# 자막: 흰색 + 검은 외곽선, 하단 중앙 (콘티 지정 스타일)
# 크기 주의: SRT에는 해상도 정보가 없어 libass가 PlayResY=288로 잡는다 → 화면에는 1080/288 = 3.75배로
# 확대돼 박힌다. FontSize=12면 실제 약 45px(1080p 자막 표준). 여기 숫자를 픽셀로 착각하지 말 것.
STYLE="FontName=NanumSquare,FontSize=12,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1.4,Shadow=0.5,Alignment=2,MarginV=20"
ffmpeg -y -v error -i "$WORK/joined.mp4" \
  -vf "subtitles=${SRT}:fontsdir=$(dirname "$FONT"):force_style='${STYLE}',fade=t=in:st=0:d=0.4,fade=t=out:st=${FADEOUT}:d=0.6" \
  -af "afade=t=out:st=${FADEOUT}:d=0.6" \
  "${enc_v[@]}" "${enc_a[@]}" -movflags +faststart "$OUT"

echo
echo "완성: $OUT"
ffprobe -v error -show_entries format=duration,size -show_entries stream=width,height,r_frame_rate,codec_name \
  -of default=noprint_wrappers=1 "$OUT"
