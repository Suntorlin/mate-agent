"""media-edit reframe: landscape to 9:16 (or another narrower aspect) following the main face.

YuNet finds faces about 5 times a second; the crop follows the largest face (sticking with the
current one when two are similar), holds briefly when the face is lost, then falls back to the
frame center or to the moving subject. The path is smoothed offline (zero lag) and cuts instantly
where the subject jumps (a shot change) instead of panning across.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from .common import AAC, FASTSTART, MODELS, X264, Timer, emit, ffmpeg, log, parse_size, probe

SAMPLES_PER_SECOND = 5
DETECT_WIDTH = 640
HOLD_SECONDS = 1.0
SMOOTH_SECONDS = 0.5
JUMP_FRACTION = 0.25


def pick_face(faces, previous_x: float | None, scale: float):
    """Largest face, unless one near the previous position is at least 60% as large."""
    if faces is None or not len(faces):
        return None
    faces = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)
    best = faces[0]
    if previous_x is not None:
        for face in faces:
            cx = (face[0] + face[2] / 2) * scale
            if (
                abs(cx - previous_x) < DETECT_WIDTH * scale * 0.1
                and face[2] * face[3] >= 0.6 * best[2] * best[3]
            ):
                best = face
                break
    x, y, w, h = (float(v) * scale for v in best[:4])
    return x, y, w, h


def fill_targets(
    centers: list[float | None], motion: list[float | None], width: int, fallback: str
) -> list[float]:
    """Per-sample crop centers: face, else the last face for HOLD_SECONDS, else the fallback."""
    hold = round(HOLD_SECONDS * SAMPLES_PER_SECOND)
    targets, last, missing = [], None, 0
    for center, moving in zip(centers, motion, strict=True):
        if center is not None:
            last, missing = center, 0
            targets.append(center)
            continue
        missing += 1
        if last is not None and missing <= hold:
            targets.append(last)
        elif fallback == "subject" and moving is not None:
            targets.append(moving)
        else:
            targets.append(width / 2)
    return targets


def smooth_path(targets: list[float], width: int):
    """Gaussian smoothing per stretch, split where the target jumps (a cut, not a pan)."""
    import numpy as np
    from scipy.ndimage import gaussian_filter1d

    values = np.asarray(targets, dtype=float)
    if len(values) == 0:
        return values
    jumps = np.flatnonzero(np.abs(np.diff(values)) > JUMP_FRACTION * width) + 1
    pieces = np.split(values, jumps)
    sigma = SMOOTH_SECONDS * SAMPLES_PER_SECOND
    return np.concatenate(
        [gaussian_filter1d(p, sigma, mode="nearest") if len(p) > 1 else p for p in pieces]
    )


def crop_lefts(path, frame_count: int, sample_frames: list[int], width: int, crop_width: int):
    """Crop x for every frame (sample path interpolated, clamped, even)."""
    import numpy as np

    centers = np.interp(np.arange(frame_count), sample_frames, path)
    lefts = np.clip(centers - crop_width / 2, 0, width - crop_width)
    return (lefts // 2 * 2).astype(int)


def analyze(source: str, fallback: str):
    """Sample frames, detect faces (and motion), return everything the crop path needs."""
    import cv2
    import numpy as np

    capture = cv2.VideoCapture(source)
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width, height = (
        int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
        int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)),
    )
    step = max(1, round(fps / SAMPLES_PER_SECOND))
    scale = width / DETECT_WIDTH
    small_size = (DETECT_WIDTH, round(height / scale))
    detector = cv2.FaceDetectorYN.create(str(MODELS / "yunet.onnx"), "", small_size, 0.6, 0.3, 5000)
    sample_frames, centers, boxes, motion = [], [], [], []
    previous_gray, previous_x, index = None, None, 0
    while capture.grab():
        if index % step == 0:
            ok, frame = capture.retrieve()
            if not ok:
                break
            small = cv2.resize(frame, small_size, interpolation=cv2.INTER_AREA)
            _, faces = detector.detect(small)
            face = pick_face(faces, previous_x, scale)
            center = face[0] + face[2] / 2 if face else None
            previous_x = center if center is not None else previous_x
            moving = None
            if fallback == "subject":
                gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (9, 9), 0)
                if previous_gray is not None:
                    columns = cv2.absdiff(gray, previous_gray).astype(np.float32).sum(axis=0)
                    if columns.sum() > 2.0 * gray.size:  # enough movement to follow
                        moving = (
                            float((columns * np.arange(len(columns))).sum() / columns.sum()) * scale
                        )
                previous_gray = gray
            sample_frames.append(index)
            centers.append(center)
            boxes.append(face)
            motion.append(moving)
        index += 1
    capture.release()
    return {
        "fps": fps,
        "width": width,
        "height": height,
        "frames": index,
        "sample_frames": sample_frames,
        "centers": centers,
        "boxes": boxes,
        "motion": motion,
    }


def face_in_frame(boxes, sample_frames, lefts, crop_width: int, width: int) -> float | None:
    """Share of detected faces whose visible part is at least 90% inside the crop window."""
    inside = total = 0
    for box, frame in zip(boxes, sample_frames, strict=True):
        if box is None:
            continue
        x0, x1 = max(0.0, box[0]), min(float(width), box[0] + box[2])  # the part in the source
        if x1 <= x0:
            continue
        total += 1
        left = lefts[min(frame, len(lefts) - 1)]
        overlap = min(x1, left + crop_width) - max(x0, left)
        inside += overlap >= 0.9 * (x1 - x0)
    return round(inside / total, 3) if total else None


def add_parser(sub) -> None:
    p = sub.add_parser("reframe", help="16:9 to 9:16 crop that follows the face")
    p.add_argument("input")
    p.add_argument("-o", "--output", help="default <input>.9x16.mp4")
    p.add_argument(
        "--aspect", default="9:16", help="target aspect, narrower than the source (9:16, 4:5, 1:1)"
    )
    p.add_argument("--size", help="output size (default 1080 wide at --aspect)")
    p.add_argument(
        "--fallback",
        choices=("center", "subject"),
        default="center",
        help="where to look when no face is visible (subject = follow motion)",
    )
    p.set_defaults(func=main)


def main(args) -> None:
    timer = Timer()
    source = Path(args.input)
    out = Path(args.output or source.with_name(source.stem + ".9x16.mp4"))
    out.parent.mkdir(parents=True, exist_ok=True)
    info = probe(source)
    a, _, b = args.aspect.partition(":")
    out_w, out_h = (
        parse_size(args.size) if args.size else (1080, round(1080 * float(b) / float(a)) // 2 * 2)
    )
    crop_width = int(info.height * float(a) / float(b)) // 2 * 2
    if crop_width >= info.width:
        raise SystemExit(f"source {info.width}x{info.height} is not wider than {args.aspect}")
    scan = analyze(str(source), args.fallback)
    detect_s = timer.seconds()
    targets = fill_targets(scan["centers"], scan["motion"], scan["width"], args.fallback)
    path = smooth_path(targets, scan["width"])
    lefts = crop_lefts(path, scan["frames"], scan["sample_frames"], scan["width"], crop_width)
    fps = scan["fps"]
    with tempfile.NamedTemporaryFile("w", suffix=".cmd", delete=False) as commands:
        previous = None
        for frame, left in enumerate(lefts):
            if left != previous:
                commands.write(f"{max(0.0, (frame - 0.5) / fps):.4f} crop x {left};\n")
                previous = left
    vf = (
        f"setpts=PTS-STARTPTS,sendcmd=f={commands.name},crop={crop_width}:{info.height}:{lefts[0]}:0,"
        f"scale={out_w}:{out_h}:flags=lanczos,setsar=1"
    )
    audio = ["-map", "0:a:0?", "-af", "asetpts=PTS-STARTPTS", *AAC] if info.has_audio else []
    ffmpeg("-i", str(source), "-map", "0:v:0", "-vf", vf, *X264, *audio, *FASTSTART, str(out))
    Path(commands.name).unlink()
    hits = sum(c is not None for c in scan["centers"])
    samples = len(scan["centers"])
    in_frame = face_in_frame(scan["boxes"], scan["sample_frames"], lefts, crop_width, scan["width"])
    if hits == 0:
        log("no face found; used the fallback for the whole clip")
    emit(
        {
            "output": str(out),
            "crop": f"{crop_width}x{info.height}",
            "face_seen_pct": round(100 * hits / max(1, samples), 1),
            "face_in_frame_pct": None if in_frame is None else round(100 * in_frame, 1),
            "detect_s": detect_s,
            "seconds": timer.seconds(),
        }
    )
