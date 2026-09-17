"""Build the deployable animation assets from the high-resolution sources.

Run from the repo root after changing any frame artwork:

    python tools/encode-frames.py

Sources live in anim-src/ and are NOT deployed (see .vercelignore):

    anim-src/home/      73 frames, 3840x2160 RGBA WebP  (index.html hero)
    anim-src/gallery/   89 frames, 1920x1080 RGBA WebP  (gallery.html hero)
    anim-src/loading/   42 frames,  191x280  RGBA WebP  (loader fox)

The original PNG frame folders were deleted upstream, so these are now the only
high-resolution copies. Never regenerate them from the anim/ outputs.

Outputs in anim/ (all names are 5-digit, zero-indexed: 00000.webp ...):

    anim/<seq>-960/  960x540, quality 90  - dense screens (>1.25x) wider than 480px
    anim/<seq>-640/  640x360, quality 88  - phones and ~1x screens
    anim/<seq>-still.png                  - finished mark for browsers without WebP
    anim/loader.webp                      - the loader fox as ONE animated WebP,
                                            fetched only when a load is slow
    anim/loader-first.webp                - its first frame: shown instantly, and
                                            all that reduced motion ever gets

Why these sizes: the hero rig is at most 640 CSS px wide and the player caps the
canvas at 1.5x device pixels, so 960 px is the most it can ever use. The 4K
sources were 16x the pixels and ~100 MB for the home sequence alone, and the
"small" tier was a byte-identical copy of the large one.

Why these qualities, measured on 8 frames spread across each sequence, decoded
and composited over BOTH page backgrounds (#FFFFFF and #0b1724), comparing with
the source downscaled to the same size. Worst case of the two backgrounds:

                    q84       q88       q92
    home  960x540   47.8 dB   49.3 dB   51.2 dB
    home  640x360   46.7 dB   48.2 dB   50.2 dB
    gall. 960x540   45.4 dB   46.9 dB   48.9 dB
    gall. 640x360   44.2 dB   45.6 dB   47.4 dB

Alpha is stored losslessly at every quality so the cut-out edges stay clean.

If a frame count changes, update `count` in the initFoxSequence() call of the
page that uses it.

Requires Pillow:  pip install Pillow
"""
import glob
import multiprocessing as mp
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "anim-src")
OUT = os.path.join(ROOT, "anim")

SEQUENCES = ["home", "gallery"]

# (folder suffix, width, height, quality)
# The folder carries the width, so a re-encode at a different size gets new URLs
# automatically. anim/ is served with a 7-day Cache-Control: reusing a URL for
# different bytes leaves returning visitors on the old frames for a week - which
# is exactly what happened when the 4K frames were replaced in place. If you
# re-encode at the SAME size with different artwork, bump the folder name.
TIERS = [
    ("-960", 960, 540, 90),
    ("-640", 640, 360, 88),
]

LOADER_FPS = 15
METHOD = 6  # slowest, smallest


def encode_frame(job):
    src_path, dst_path, size, quality = job
    im = Image.open(src_path).convert("RGBA")
    if im.size != size:
        im = im.resize(size, Image.LANCZOS)
    im.save(dst_path, "WEBP", quality=quality, alpha_quality=100, method=METHOD)
    return os.path.getsize(dst_path)


def main():
    jobs = []
    plan = []
    for seq in SEQUENCES:
        frames = sorted(glob.glob(os.path.join(SRC, seq, "*.webp")))
        if not frames:
            sys.exit("no source frames in anim-src/" + seq)
        src_total = sum(os.path.getsize(f) for f in frames)
        for suffix, w, h, q in TIERS:
            out_dir = os.path.join(OUT, seq + suffix)
            os.makedirs(out_dir, exist_ok=True)
            for old in glob.glob(os.path.join(out_dir, "*.webp")):
                os.remove(old)
            start = len(jobs)
            for i, f in enumerate(frames):
                jobs.append((f, os.path.join(out_dir, "%05d.webp" % i), (w, h), q))
            plan.append((seq, suffix, w, h, q, len(frames), src_total, start, len(jobs)))

    workers = max(2, (os.cpu_count() or 4) - 2)
    with mp.Pool(workers) as pool:
        sizes = pool.map(encode_frame, jobs, chunksize=2)

    for seq, suffix, w, h, q, n, src_total, a, b in plan:
        out_total = sum(sizes[a:b])
        print("%-8s %2d frames  %4dx%-4d q%-2d  %6.1f MB -> %5.2f MB  anim/%s"
              % (seq, n, w, h, q, src_total / 1048576, out_total / 1048576, seq + suffix),
              flush=True)

    # Still of the finished mark for browsers without WebP. PNG, palette-reduced.
    for seq in SEQUENCES:
        last = sorted(glob.glob(os.path.join(SRC, seq, "*.webp")))[-1]
        still = Image.open(last).convert("RGBA").resize((640, 360), Image.LANCZOS)
        still = still.quantize(colors=256, method=Image.Quantize.FASTOCTREE)
        path = os.path.join(OUT, seq + "-still.png")
        still.save(path, "PNG", optimize=True)
        print("%-8s still        %5.0f KB  anim/%s-still.png"
              % (seq, os.path.getsize(path) / 1024, seq))

    # Loader: one animated WebP instead of 42 separate requests.
    lframes = sorted(glob.glob(os.path.join(SRC, "loading", "*.webp")))
    imgs = [Image.open(f).convert("RGBA") for f in lframes]
    anim_path = os.path.join(OUT, "loader.webp")
    # Quality 75 / alpha 80: the source frames are already lossy, and at 90/100
    # re-encoding them produced a file LARGER than the 42 separate frames
    # (792 KB vs 658 KB). The fox moves across the frame, so frames share little
    # and one file saves few bytes anyway - which is why the pages fetch this
    # only when a load is actually slow (see the loader script in each page).
    imgs[0].save(anim_path, "WEBP", save_all=True, append_images=imgs[1:],
                 duration=round(1000 / LOADER_FPS), loop=0, quality=75,
                 alpha_quality=80, method=METHOD, minimize_size=True)
    first_path = os.path.join(OUT, "loader-first.webp")
    imgs[0].save(first_path, "WEBP", quality=90, alpha_quality=100, method=METHOD)
    src_bytes = sum(os.path.getsize(f) for f in lframes)
    print("loader   %2d frames -> 1 file  %5.0f KB (was %d requests, %.0f KB)  anim/loader.webp"
          % (len(imgs), os.path.getsize(anim_path) / 1024, len(lframes), src_bytes / 1024))
    print("loader   first frame          %5.0f KB  anim/loader-first.webp"
          % (os.path.getsize(first_path) / 1024))


if __name__ == "__main__":
    main()
