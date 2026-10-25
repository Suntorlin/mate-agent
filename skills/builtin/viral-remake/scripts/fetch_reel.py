#!/usr/bin/env python3
"""Download a public Instagram reel/post video as MP4 without login.

    python3 fetch_reel.py https://www.instagram.com/reel/<code>/ reference/source.mp4

yt-dlp needs cookies for Instagram; the public embed page (/reel/<code>/embed/captioned/) carries a
JSON-escaped `video_url` on the CDN that downloads without cookies. Also writes <out>.caption.txt
with the post caption when present. Exits 2 when the page has no video (private post, image post).
"""
import json
import re
import sys
import urllib.request

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def js_string(raw: str) -> str:
    """Decode a JSON string body that may be escaped once or twice."""
    value = raw
    for _ in range(2):
        try:
            value = json.loads(f'"{value}"')
        except json.JSONDecodeError:
            break
        if "\\" not in value:
            break
    return value.replace("\\/", "/")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 64
    page, out = sys.argv[1], sys.argv[2]
    m = re.search(r"instagram\.com/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)", page)
    if not m:
        print(f"not an Instagram post URL: {page}", file=sys.stderr)
        return 64
    html = fetch(f"https://www.instagram.com/reel/{m.group(1)}/embed/captioned/").decode("utf-8", "ignore")
    found = re.search(r'video_url\\*"\s*:\s*\\*"(https:.+?)\\*"', html)
    if not found:
        print("no video_url on the embed page (private post, image post, or layout change)", file=sys.stderr)
        return 2
    video_url = js_string(found.group(1))
    data = fetch(video_url)
    with open(out, "wb") as f:
        f.write(data)
    cap = re.search(r'<div class="Caption">(.*?)</div>', html, re.S)
    if cap:
        text = re.sub(r"<[^>]+>", " ", cap.group(1))
        with open(out + ".caption.txt", "w") as f:
            f.write(re.sub(r"\s+", " ", text).strip())
    print(f"saved {out} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
