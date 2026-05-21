"""Rasterize SecWriter SVG brand assets into PNGs and a multi-res favicon.ico."""
from pathlib import Path
import cairosvg
from PIL import Image

ROOT = Path("/home/claude/secwriter-brand")

def svg_to_png(svg_path: Path, png_path: Path, size: int) -> None:
    """Render an SVG to a square PNG of the given pixel size."""
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(png_path),
        output_width=size,
        output_height=size,
    )
    print(f"  {png_path.name}  ({size}x{size})")

def svg_to_png_wh(svg_path: Path, png_path: Path, w: int, h: int) -> None:
    """Render an SVG to a PNG of explicit width and height."""
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(png_path),
        output_width=w,
        output_height=h,
    )
    print(f"  {png_path.name}  ({w}x{h})")

print("Rendering square icon family from icon-mark.svg ...")
icon_svg = ROOT / "icon-mark.svg"
for size in [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024]:
    svg_to_png(icon_svg, ROOT / f"icon-{size}.png", size)

# Apple touch icon - by convention this is icon-180.png renamed
print("\nRenaming touch icon ...")
import shutil
shutil.copy(ROOT / "icon-180.png", ROOT / "apple-touch-icon.png")
print("  apple-touch-icon.png")

# PWA manifest icons - explicit Android Chrome conventions
shutil.copy(ROOT / "icon-192.png", ROOT / "android-chrome-192x192.png")
shutil.copy(ROOT / "icon-512.png", ROOT / "android-chrome-512x512.png")
print("  android-chrome-192x192.png")
print("  android-chrome-512x512.png")

# Build favicon.ico from 16, 32, 48 PNGs (multi-resolution ICO)
print("\nBuilding favicon.ico ...")
icons = [Image.open(ROOT / f"icon-{s}.png") for s in (16, 32, 48)]
icons[0].save(
    ROOT / "favicon.ico",
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48)],
    append_images=icons[1:],
)
print("  favicon.ico  (16, 32, 48 multi-res)")

# Logo lockups - render at 2x for retina
print("\nRendering logo lockups ...")
svg_to_png_wh(ROOT / "logo-full-light.svg", ROOT / "logo-full-light.png", 1200, 320)
svg_to_png_wh(ROOT / "logo-full-dark.svg", ROOT / "logo-full-dark.png", 1200, 320)

# Open Graph card and GitHub social preview
print("\nRendering social cards ...")
svg_to_png_wh(ROOT / "og-image.svg", ROOT / "og-image.png", 1200, 630)
svg_to_png_wh(ROOT / "github-social-preview.svg", ROOT / "github-social-preview.png", 1280, 640)

print("\nOverriding 16x16 with hand-tuned pixel art ...")
import subprocess, sys
subprocess.run([sys.executable, str(ROOT / "_handtune_16.py")], check=True)

print("\nDone.")
