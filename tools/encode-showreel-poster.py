"""Showreel poster: extract one frame of the brand film and write its web tiers.

Frame 3180 = 106.0 s at 30 fps: the founder card (Haitham Farouk, "Founder & CEO",
white FOX logo) on the film's own FOX-blue set. Usable window is 105.5-106.4 s;
106.6 s is a white flash, so the script refuses a frame that is too bright or soft.
Fallback frame if the founder should not be the cover: 3300 (110.0 s, team circles).

Writes img/showreel/poster-{640,960,1280,1920}.webp and poster-1280.jpg.

Run from the repo root:  python tools/encode-showreel-poster.py
Requires:                pip install opencv-python Pillow
"""
import os
import sys

import cv2
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "Images", "Video", "fox video jan 2021.mp4")
OUT = os.path.join(ROOT, "img", "showreel")
FRAME = 3180                                   # 106.0 s
WEBP = ((640, 80), (960, 80), (1280, 80), (1920, 78))

cap = cv2.VideoCapture(SRC)
cap.set(cv2.CAP_PROP_POS_FRAMES, FRAME)
ok, frame = cap.read()
cap.release()
if not ok or frame.shape[:2] != (1080, 1920):
    sys.exit("could not read a 1920x1080 frame %d from %s" % (FRAME, SRC))

gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
mean, sharp = float(gray.mean()), float(cv2.Laplacian(gray, cv2.CV_64F).var())
# Measured on this file: mean ~118.8, sharpness ~172. The white flash at 106.6 s is ~220 / ~12.
if not (100 <= mean <= 140 and sharp >= 120):
    sys.exit("frame %d looks wrong (mean %.1f, sharpness %.0f) - check the seek" % (FRAME, mean, sharp))

os.makedirs(OUT, exist_ok=True)
master = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
for width, quality in WEBP:
    img = master if width == 1920 else master.resize((width, width * 9 // 16), Image.LANCZOS)
    img.save(os.path.join(OUT, "poster-%d.webp" % width), "WEBP", quality=quality, method=6)
master.resize((1280, 720), Image.LANCZOS).save(
    os.path.join(OUT, "poster-1280.jpg"), "JPEG", quality=82, optimize=True, progressive=True)

for name in sorted(os.listdir(OUT)):
    if name.startswith("poster-"):
        print("%-18s %6.1f KB" % (name, os.path.getsize(os.path.join(OUT, name)) / 1024))
print("frame %d (%.2f s): mean %.1f, sharpness %.0f" % (FRAME, FRAME / 30.0, mean, sharp))
