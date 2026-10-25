#!/usr/bin/env bash
# QA for a finished edit (narrative / motion-graphics path). Exits 1 on any hard failure.
#
#   qa_edit.sh renders/v01.mp4 [keyframes_dir]
#
# Checks: black frames > 0.3 s and freezes > 1.5 s anywhere except the last 3 s, integrated
# loudness within -16..-14 LUFS, audio present. Writes renders/<name>.contact.jpg (one frame every
# 2 s) and, when a keyframes dir is given, renders/keyframes.contact.jpg to compare the hero's face,
# hair and outfit across shots — look at both images before publishing.
set -euo pipefail
video="${1:?usage: qa_edit.sh <video.mp4> [keyframes_dir]}"
kf="${2:-}"
dir="$(dirname "$video")"
base="$(basename "$video" .mp4)"
dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$video")"
tail_start="$(python3 -c "print(max(0.0, $dur - 3.0))")"
fail=0

if [[ -z "$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$video")" ]]; then
  echo "FAIL no audio stream"; fail=1
fi

ffmpeg -hide_banner -nostats -i "$video" \
  -vf "blackdetect=d=0.3:pix_th=0.08,freezedetect=n=0.003:d=1.5" -an -f null - 2>&1 |
  python3 -c "
import re, sys
tail = float(sys.argv[1]); bad = 0
for line in sys.stdin:
    m = re.search(r'black_start:([\d.]+) black_end:([\d.]+)', line)
    if m and 0.2 < float(m.group(1)) < tail:
        print(f'FAIL black {m.group(1)}-{m.group(2)}s'); bad = 1
    m = re.search(r'freeze_start: ([\d.]+)', line)
    if m and float(m.group(1)) < tail:
        print(f'FAIL freeze from {m.group(1)}s'); bad = 1
sys.exit(bad)
" "$tail_start" || fail=1

lufs="$(ffmpeg -hide_banner -nostats -i "$video" -af ebur128=framelog=quiet -f null - 2>&1 | awk '/ I:/{print $2}' | tail -1)"
if ! python3 -c "import sys; sys.exit(0 if -16.5 <= float('$lufs') <= -13.5 else 1)"; then
  echo "FAIL loudness ${lufs} LUFS (target -16..-14; adjust music/VO volume)"; fail=1
fi

ffmpeg -hide_banner -loglevel error -y -i "$video" -vf "fps=1/2,scale=320:-2,tile=6x5" -frames:v 1 "$dir/$base.contact.jpg"
if [[ -n "$kf" ]]; then
  ffmpeg -hide_banner -loglevel error -y -pattern_type glob -i "$kf/*.jpg" -vf "scale=320:-2,tile=5x3" -frames:v 1 "$dir/keyframes.contact.jpg" || true
fi
echo "duration ${dur}s, loudness ${lufs} LUFS; look at $dir/$base.contact.jpg${kf:+ and $dir/keyframes.contact.jpg}"
[[ $fail -eq 0 ]] && echo "QA PASS" || { echo "QA FAIL"; exit 1; }
