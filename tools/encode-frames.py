"""Re-encode the fox animation PNG sequences into the WebP sets the site uses.

Run from the repo root after changing any frame artwork:

    python tools/encode-frames.py

Sources are 864x496 RGBA PNGs extracted from Video/*.mp4, which is itself
864x496 - that is the hard ceiling on this animation's resolution.

Two tiers are written per page:

    anim/<page>/      864x496, quality 90  - tablets and desktops
    anim/<page>-sm/   540x310, quality 86  - phones

540x310 is an exact 1.741 aspect match for the source, and lands within 8% of
the device pixels a phone actually shows the rig at. The point of the small tier
is less about bandwidth than about decoded bitmap memory: 80 frames at 864x496
is ~137MB of RGBA, enough that a low-end phone starts discarding and re-decoding
mid-scrub. At 540x310 it is ~54MB.

Quality 90 was picked by measurement, not feel. Compositing each decoded frame
over the page background and comparing against the source PNG:

    q72  45.1 dB    q86  49.0 dB
    q80  46.8 dB    q90  50.9 dB   <- +35% bytes over q72, +5.8 dB
    q94  53.2 dB (+57% bytes)

Alpha is stored losslessly at every quality so the cut-out edges stay clean.

A single still of the finished mark is also written per page. Browsers without
WebP get that instead of the sequence - roughly 3% of traffic, and far better
for them than 19MB of PNGs.

Requires Pillow:  pip install Pillow
"""
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (source dir, first frame number, last frame number, output slug)
# The first/last numbers are the range each page actually animated; the leading
# frames in Home-Frames were never part of the sequence.
JOBS = [
    ("Home-Frames", 3, 82, "home"),     # index.html   - 80 frames
    ("Frames", 2, 67, "gallery"),       # gallery.html - 66 frames
]

# (output suffix, width, height, quality). Sizes keep the source 1.741 aspect
# exactly: 540*496 == 310*864.
TIERS = [
    ("", 864, 496, 90),
    ("-sm", 540, 310, 86),
]

METHOD = 6  # slowest, smallest


def main():
    for src_dir, first, last, slug in JOBS:
        frames = []
        for i in range(first, last + 1):
            src = os.path.join(ROOT, src_dir, "frame_%03d_no_bg.png" % i)
            if not os.path.isfile(src):
                sys.exit("missing source frame: " + src)
            frames.append(src)

        total_in = sum(os.path.getsize(f) for f in frames)

        for suffix, w, h, quality in TIERS:
            out_path = os.path.join(ROOT, "anim", slug + suffix)
            os.makedirs(out_path, exist_ok=True)
            total_out = 0
            for n, src in enumerate(frames, 1):
                im = Image.open(src).convert("RGBA")
                if im.size != (w, h):
                    im = im.resize((w, h), Image.LANCZOS)
                dst = os.path.join(out_path, "%04d.webp" % n)
                im.save(dst, "WEBP", quality=quality, alpha_quality=100,
                        method=METHOD)
                total_out += os.path.getsize(dst)
            print("%-12s %3d frames  %4dx%-4d q%-3d %6.1f MB -> %5.2f MB  anim/%s"
                  % (src_dir, len(frames), w, h, quality,
                     total_in / 1048576, total_out / 1048576, slug + suffix),
                  flush=True)

        # Non-WebP still: the finished mark, palette-reduced to keep it small.
        still = Image.open(frames[-1]).convert("RGBA")
        still = still.quantize(colors=256, method=Image.FASTOCTREE)
        still_path = os.path.join(ROOT, "anim", slug + "-still.png")
        still.save(still_path, "PNG", optimize=True)
        print("%-12s still  %.0f KB  anim/%s-still.png"
              % ("", os.path.getsize(still_path) / 1024, slug))

    print("\nIf the frame count changes, update the `count` passed to "
          "initFoxSequence() in index.html and gallery.html.")


if __name__ == "__main__":
    main()
