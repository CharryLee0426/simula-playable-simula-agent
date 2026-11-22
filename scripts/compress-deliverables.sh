#!/usr/bin/env bash
# Re-encode exported highlights for the repository: same spec (1080x1920, H.264 High, 30 fps, AAC), bitrate capped
# at ~5 Mbps (typical ad-delivery bitrate) so each 20 s highlight is ~10-13 MB instead of ~20+ MB. The full-quality
# render stays in the session directory (runs/<session>/highlight.mp4). Re-checks the spec with ffprobe afterwards.
set -euo pipefail
DIR="${1:-deliverables}"
for f in "$DIR"/*/highlight.mp4; do
	[[ -f "$f" ]] || continue
	size=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")
	if (( size < 14000000 )); then echo "ok      $f ($((size / 1000000)) MB)"; continue; fi
	tmp="${f%.mp4}.tmp.mp4"
	ffmpeg -loglevel error -y -i "$f" -c:v libx264 -profile:v high -preset slow -crf 21 -maxrate 5M -bufsize 10M \
		-pix_fmt yuv420p -r 30 -g 30 -c:a copy -movflags +faststart "$tmp"
	mv "$tmp" "$f"
	spec=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate -show_entries format=duration -of csv=p=0 "$f" | tr '\n' ' ')
	echo "re-enc  $f ($(( $(stat -c %s "$f" 2>/dev/null || stat -f %z "$f") / 1000000 )) MB) → $spec"
done
