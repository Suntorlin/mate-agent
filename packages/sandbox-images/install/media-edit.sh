#!/usr/bin/env bash
# Editing toolchain for the media-edit skill: ASR with word timing (faster-whisper with
# the small and large-v3-turbo models baked in), YuNet face tracking, MODNet portrait matting, scene detection, beat
# detection, OCR, image tools, and the rnnoise model for ffmpeg's arnndn. Run by install/media.sh
# after the media phase (it needs ffmpeg, fonts and the copied skills); re-runnable on its own with
# `install.sh media-edit`. Every download is pinned by version, commit or sha256.
set -euo pipefail
source "$OI_INSTALL_DIR/common.sh"
uv=/opt/openinspect/uv/uv
python=/opt/openinspect/python/bin/python
models=/opt/media/models
HF=https://huggingface.co
# faster-whisper 1.2.1's own model ids ("small", "large-v3-turbo") at fixed commits.
WHISPER_SMALL_REPO=Systran/faster-whisper-small
WHISPER_SMALL_REV=536b0662742c02347bc0e980a01041f333bce120
WHISPER_SMALL_SHA256=3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671
WHISPER_TURBO_REPO=dropbox-dash/faster-whisper-large-v3-turbo
WHISPER_TURBO_REV=0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf
WHISPER_TURBO_SHA256=e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da
YUNET_URL=https://media.githubusercontent.com/media/opencv/opencv_zoo/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
YUNET_SHA256=8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4
# MODNet portrait matting (ZHKKKe/MODNet, Apache-2.0) as ONNX, for fxcaptions' words behind the speaker.
MODNET_URL=$HF/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model.onnx
MODNET_SHA256=07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9
RNNOISE_URL=https://raw.githubusercontent.com/GregorR/rnnoise-models/3eee541a283fd3b8f81b85b1748e3b9ccbefa04d/somnolent-hogwash-2018-09-01/sh.rnnn
RNNOISE_SHA256=70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0

case "$OI_OS" in
  debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    # bc, file, GNU time (/usr/bin/time) and ghostscript are everyday shell tools agents reach for
    # (arithmetic, type sniffing, timing a render, PDF to image) that the base image lacks.
    # poppler-utils and catdoc read the documents users attach: PDF text and pages, and the old
    # Office formats (.doc, .ppt) no Python library opens.
    apt-get install -y --no-install-recommends imagemagick librsvg2-bin libvips-tools frei0r-plugins \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim tesseract-ocr-kor pandoc zip \
      bc file time ghostscript poppler-utils catdoc
    ;;
  *)
    echo "The media-edit toolchain supports Debian/Ubuntu images only (got $OI_OS)" >&2
    exit 1
    ;;
esac

# Exactly the locked set; --no-deps because the lock drops scenedetect's opencv-python in favour of
# opencv-python-headless (the same cv2 module without GUI libraries).
"$uv" pip install --python "$python" --no-cache --no-deps --require-hashes \
  -r "$OI_BUNDLE/packages/sandbox-images/locks/media-edit.txt"

whisper_model() {
  local name="$1" repo="$2" rev="$3" digest="$4" dir="$models/whisper/$1" file
  mkdir -p "$dir"
  for file in config.json tokenizer.json vocabulary.txt vocabulary.json preprocessor_config.json; do
    # Each repo has either vocabulary.txt or vocabulary.json; preprocessor_config.json is optional.
    curl --fail --silent --show-error --location --retry 3 --output "$dir/$file" \
      "$HF/$repo/resolve/$rev/$file" || rm -f "$dir/$file"
  done
  [[ -f "$dir/config.json" && -f "$dir/tokenizer.json" ]]
  download_checked "$HF/$repo/resolve/$rev/model.bin" "$digest" "$dir/model.bin"
  echo "$name $repo@$rev" >"$dir/SOURCE"
}
rm -rf "$models"
whisper_model small "$WHISPER_SMALL_REPO" "$WHISPER_SMALL_REV" "$WHISPER_SMALL_SHA256"
whisper_model large-v3-turbo "$WHISPER_TURBO_REPO" "$WHISPER_TURBO_REV" "$WHISPER_TURBO_SHA256"
download_checked "$YUNET_URL" "$YUNET_SHA256" "$models/yunet.onnx"
download_checked "$RNNOISE_URL" "$RNNOISE_SHA256" "$models/rnnoise-sh.rnnn"
download_checked "$MODNET_URL" "$MODNET_SHA256" "$models/modnet.onnx"
chmod -R a+rX "$models"

# jieba builds its dictionary cache on first use; build it now into a readable location.
JIEBA_CACHE="$models/jieba.cache" "$python" -c \
  'import os, jieba; jieba.dt.tmp_dir = None; jieba.dt.cache_file = os.environ["JIEBA_CACHE"]; jieba.initialize()'
chmod a+r "$models/jieba.cache"

ln -sf /app/sandbox_runtime/skills/media-edit/scripts/media-edit /usr/local/bin/media-edit

# Verify: libraries import, models load, binaries run, and every media-edit command answers --help.
"$python" - <<'PY'
import cv2, faster_whisper, ctranslate2, av, scenedetect, librosa, PIL, jieba, docx, soundfile
assert cv2.__version__.startswith("4."), cv2.__version__
assert int(av.__version__.split(".")[0]) < 16, av.__version__
cv2.FaceDetectorYN.create("/opt/media/models/yunet.onnx", "", (320, 320))
from faster_whisper import WhisperModel
WhisperModel("/opt/media/models/whisper/small", device="cpu", compute_type="int8")
import numpy as np, onnxruntime as ort
modnet = ort.InferenceSession("/opt/media/models/modnet.onnx", providers=["CPUExecutionProvider"])
assert modnet.run(None, {"input": np.zeros((1, 3, 64, 64), np.float32)})[0].shape == (1, 1, 64, 64)
print("media-edit python ok:", "faster-whisper", faster_whisper.__version__, "ctranslate2", ctranslate2.__version__,
      "av", av.__version__, "opencv", cv2.__version__, "scenedetect", scenedetect.__version__,
      "librosa", librosa.__version__, "pillow", PIL.__version__, "jieba", jieba.__version__)
PY
[[ -s "$models/whisper/large-v3-turbo/model.bin" && -s "$models/whisper/small/model.bin" ]]
ffmpeg -hide_banner -filters | grep -qE ' arnndn ' && ffmpeg -hide_banner -filters | grep -qE ' ass '
langs="$(tesseract --list-langs 2>&1)"
[[ "$langs" == *chi_sim* && "$langs" == *kor* && "$langs" == *eng* ]]
magick -version | head -1
rsvg-convert --version
vips --version
pandoc --version | head -1
zip -v | sed -n 2p
[[ "$(echo '6*7' | bc)" == 42 ]]
file --version | head -1
/usr/bin/time --version 2>&1 | head -1
gs --version
ls /usr/lib/frei0r-1/ | grep -q '\.so$'
for command in transcribe captions fxcaptions jumpcut reframe beatcut voice loudness scenes contact; do
  media-edit "$command" --help >/dev/null
done
du -sh "$models"
