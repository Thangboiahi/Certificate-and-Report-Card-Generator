"""Generates the image fixtures used by the engine tests.

Run from the repository root:  python3 tests/fixtures/make-fixtures.py
Requires Pillow. The outputs are committed, so this only needs re-running to change them.

Every photo is the same "quadrant card": four solid quadrants whose colours identify the corners
(top-left red, top-right green, bottom-left blue, bottom-right yellow) and a white arrow pointing
up. Tests sample pixels of the rendered PDF to prove an image was placed the right way up and
cropped where expected.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "images"
OUT.mkdir(parents=True, exist_ok=True)

RED, GREEN, BLUE, YELLOW = (220, 40, 40), (40, 170, 70), (40, 80, 220), (240, 200, 40)


def quadrant_card(width: int, height: int) -> Image.Image:
    image = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(image)
    half_w, half_h = width // 2, height // 2
    draw.rectangle([0, 0, half_w, half_h], fill=RED)
    draw.rectangle([half_w, 0, width, half_h], fill=GREEN)
    draw.rectangle([0, half_h, half_w, height], fill=BLUE)
    draw.rectangle([half_w, half_h, width, height], fill=YELLOW)
    # An arrow pointing up, so orientation is obvious to a human looking at the output.
    unit = min(width, height) // 6
    cx, cy = half_w, half_h
    draw.polygon([(cx, cy - 2 * unit), (cx - unit, cy), (cx + unit, cy)], fill="white")
    draw.rectangle([cx - unit // 3, cy, cx + unit // 3, cy + 2 * unit], fill="white")
    return image


landscape = quadrant_card(300, 200)
portrait = quadrant_card(200, 300)
landscape.save(OUT / "landscape.jpg", quality=85)
portrait.save(OUT / "portrait.jpg", quality=85)
portrait.save(OUT / "portrait.png")

# The same upright landscape picture stored in each of the eight EXIF orientations. A viewer that
# honours EXIF shows all eight identically. `STORE_AS[k]` undoes what a viewer does for tag k.
T = Image.Transpose
STORE_AS = {
    1: None,
    2: T.FLIP_LEFT_RIGHT,
    3: T.ROTATE_180,
    4: T.FLIP_TOP_BOTTOM,
    5: T.TRANSPOSE,
    6: T.ROTATE_90,
    7: T.TRANSVERSE,
    8: T.ROTATE_270,
}
for orientation, method in STORE_AS.items():
    stored = landscape if method is None else landscape.transpose(method)
    exif = Image.Exif()
    exif[0x0112] = orientation
    stored.save(OUT / f"exif-{orientation}.jpg", quality=85, exif=exif)

# A logo with real transparency: a dark disc on a fully transparent background.
logo = Image.new("RGBA", (200, 100), (0, 0, 0, 0))
ImageDraw.Draw(logo).ellipse([60, 10, 140, 90], fill=(20, 40, 90, 255))
logo.save(OUT / "logo.png")

# Formats pdf-lib cannot embed directly.
landscape.save(OUT / "landscape.webp", quality=80)
landscape.resize((60, 40)).convert("P").save(OUT / "landscape.gif")

# Starts like a JPEG and then stops making sense.
(OUT / "corrupt.jpg").write_bytes(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x00" * 64)

for path in sorted(OUT.iterdir()):
    print(f"{path.name:18} {path.stat().st_size:6} bytes")
