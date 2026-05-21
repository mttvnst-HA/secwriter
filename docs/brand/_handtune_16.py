"""Generate the hand-tuned 16x16 favicon.

The 32px+ icons render fine from the typographic SVG (icon-mark.svg / favicon.svg).
The 16x16 needs hand-placement of pixels because there are too few of them for any
auto-downscaling algorithm to keep </> legible.

Run this AFTER _build.py so it overwrites the auto-downscaled icon-16.png, then
rebuild favicon.ico to pick up the hand-tuned 16px layer.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
BG = (14, 165, 233, 255)   # #0ea5e9
T = (0, 0, 0, 0)
W = (255, 255, 255, 255)

img = Image.new("RGBA", (16, 16), BG)
for r, c in [(0, 0), (0, 15), (15, 0), (15, 15)]:
    img.putpixel((c, r), T)

chev_l_outer = [(3, 5), (2, 6), (1, 7), (1, 8), (2, 9), (3, 10)]
chev_l_inner = [(4, 5), (3, 6), (2, 7), (2, 8), (3, 9), (4, 10)]
chev_r_outer = [(12, 5), (13, 6), (14, 7), (14, 8), (13, 9), (12, 10)]
chev_r_inner = [(11, 5), (12, 6), (13, 7), (13, 8), (12, 9), (11, 10)]
slash = [
    (9, 3), (10, 3),
    (8, 4), (9, 4),
    (8, 5), (9, 5),
    (7, 6), (8, 6),
    (7, 7), (8, 7),
    (7, 8), (8, 8),
    (6, 9), (7, 9),
    (6, 10), (7, 10),
    (5, 11), (6, 11),
    (5, 12), (6, 12),
]
for c, r in chev_l_outer + chev_l_inner + chev_r_outer + chev_r_inner + slash:
    img.putpixel((c, r), W)

img.save(ROOT / "icon-16.png")
print("  icon-16.png  hand-tuned 16x16 written")

# Rebuild favicon.ico so its 16x16 layer uses the hand-tuned image
icons = [Image.open(ROOT / f"icon-{s}.png") for s in (16, 32, 48)]
icons[0].save(
    ROOT / "favicon.ico",
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48)],
    append_images=icons[1:],
)
print("  favicon.ico  rebuilt with hand-tuned 16x16 layer")
