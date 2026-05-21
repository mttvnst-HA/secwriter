"""Rasterize SecWriter SVG brand assets into PNGs and a multi-res favicon.ico.

Reads SVG masters from docs/brand/source/. Writes outputs to their canonical
repo locations:
  - public/             runtime favicons, manifest icons, og-image, favicon.svg
  - src/assets/brand/   logos imported by React components
  - docs/brand/         intermediate icon sizes, github-social-preview
"""
from pathlib import Path
import shutil
import subprocess
import sys

import cairosvg
from PIL import Image

ROOT = Path(__file__).parent
SRC = ROOT / "source"
REPO = ROOT.parent.parent
PUBLIC = REPO / "public"
ASSETS = REPO / "src" / "assets" / "brand"


def svg_to_png(svg_path: Path, png_path: Path, size: int) -> None:
    """Render an SVG to a square PNG of the given pixel size."""
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(png_path),
        output_width=size,
        output_height=size,
    )
    print(f"  {png_path.relative_to(REPO)}  ({size}x{size})")


def svg_to_png_wh(svg_path: Path, png_path: Path, w: int, h: int) -> None:
    """Render an SVG to a PNG of explicit width and height."""
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(png_path),
        output_width=w,
        output_height=h,
    )
    print(f"  {png_path.relative_to(REPO)}  ({w}x{h})")


print("Rendering square icon family from icon-mark.svg ...")
icon_svg = SRC / "icon-mark.svg"
# Runtime favicons (16, 32) go to public/; reference sizes stay in docs/brand/.
for size in (16, 32):
    svg_to_png(icon_svg, PUBLIC / f"icon-{size}.png", size)
for size in (48, 64, 128, 180, 192, 256, 512, 1024):
    svg_to_png(icon_svg, ROOT / f"icon-{size}.png", size)

print("\nMobile / PWA install icons ...")
shutil.copy(ROOT / "icon-180.png", PUBLIC / "apple-touch-icon.png")
shutil.copy(ROOT / "icon-192.png", PUBLIC / "android-chrome-192x192.png")
shutil.copy(ROOT / "icon-512.png", PUBLIC / "android-chrome-512x512.png")
print(f"  {(PUBLIC / 'apple-touch-icon.png').relative_to(REPO)}")
print(f"  {(PUBLIC / 'android-chrome-192x192.png').relative_to(REPO)}")
print(f"  {(PUBLIC / 'android-chrome-512x512.png').relative_to(REPO)}")

print("\nBuilding favicon.ico ...")
icons = [
    Image.open(PUBLIC / "icon-16.png"),
    Image.open(PUBLIC / "icon-32.png"),
    Image.open(ROOT / "icon-48.png"),
]
icons[0].save(
    PUBLIC / "favicon.ico",
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48)],
    append_images=icons[1:],
)
print(f"  {(PUBLIC / 'favicon.ico').relative_to(REPO)}  (16, 32, 48 multi-res)")

print("\nRendering logo lockups ...")
svg_to_png_wh(SRC / "logo-full-light.svg", ASSETS / "logo-full-light.png", 1200, 320)
svg_to_png_wh(SRC / "logo-full-dark.svg", ASSETS / "logo-full-dark.png", 1200, 320)

print("\nRendering social cards ...")
svg_to_png_wh(SRC / "og-image.svg", PUBLIC / "og-image.png", 1200, 630)
svg_to_png_wh(SRC / "github-social-preview.svg", ROOT / "github-social-preview.png", 1280, 640)

print("\nPropagating SVG masters to runtime locations ...")
shutil.copy(SRC / "favicon.svg", PUBLIC / "favicon.svg")
shutil.copy(SRC / "icon-mark.svg", ASSETS / "icon-mark.svg")
shutil.copy(SRC / "logo-full-light.svg", ASSETS / "logo-full-light.svg")
shutil.copy(SRC / "logo-full-dark.svg", ASSETS / "logo-full-dark.svg")
print(f"  {(PUBLIC / 'favicon.svg').relative_to(REPO)}")
print(f"  {(ASSETS / 'icon-mark.svg').relative_to(REPO)}")
print(f"  {(ASSETS / 'logo-full-light.svg').relative_to(REPO)}")
print(f"  {(ASSETS / 'logo-full-dark.svg').relative_to(REPO)}")

print("\nOverriding 16x16 with hand-tuned pixel art ...")
subprocess.run([sys.executable, str(ROOT / "_handtune_16.py")], check=True)

print("\nDone.")
