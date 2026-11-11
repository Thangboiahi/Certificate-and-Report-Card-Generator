"""Draws the placeholder "student photos" and school logo used by the developer playground.

    python3 scripts/make-sample-photos.py        (requires Pillow)

No real people: each photo is a flat-colour avatar. The set is chosen to exercise the engine:

  student-1.jpg   large (1200 x 1500), so the browser has to shrink it before embedding
  student-2.jpg   stored sideways with an EXIF orientation tag, like a phone photo
  student-3.webp  a format pdf-lib cannot embed, so the browser has to convert it
  logo.png        a transparent PNG
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "samples" / "photos"
OUT.mkdir(parents=True, exist_ok=True)


def avatar(width: int, height: int, background, skin, shirt) -> Image.Image:
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    cx = width // 2
    head = int(width * 0.19)
    head_y = int(height * 0.36)
    # shoulders, neck, head, hair
    draw.ellipse([cx - int(width * 0.42), int(height * 0.62), cx + int(width * 0.42), int(height * 1.25)], fill=shirt)
    draw.rectangle([cx - head // 3, head_y + head - 4, cx + head // 3, int(height * 0.66)], fill=skin)
    draw.ellipse([cx - head, head_y - head, cx + head, head_y + head], fill=skin)
    draw.pieslice([cx - head - 6, head_y - head - 10, cx + head + 6, head_y + head], 180, 360, fill=(40, 30, 30))
    # a simple face, so that an upside-down or sideways photo is obvious
    eye = max(3, head // 9)
    for dx in (-head // 2, head // 2):
        draw.ellipse([cx + dx - eye, head_y - eye, cx + dx + eye, head_y + eye], fill=(30, 30, 30))
    draw.arc([cx - head // 2, head_y + head // 6, cx + head // 2, head_y + head // 1.5], 20, 160, fill=(120, 40, 40), width=max(2, eye // 2))
    return image


avatar(1200, 1500, (214, 228, 245), (236, 196, 160), (40, 80, 160)).save(OUT / "student-1.jpg", quality=86)

# Stored rotated; the EXIF tag (6 = "turn a quarter clockwise to view") makes it display upright.
sideways = avatar(480, 600, (232, 220, 244), (222, 178, 140), (150, 60, 120)).transpose(Image.Transpose.ROTATE_90)
exif = Image.Exif()
exif[0x0112] = 6
sideways.save(OUT / "student-2.jpg", quality=86, exif=exif)

avatar(480, 600, (222, 240, 226), (200, 150, 110), (30, 120, 90)).save(OUT / "student-3.webp", quality=82)

logo = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
draw = ImageDraw.Draw(logo)
draw.ellipse([10, 10, 390, 390], fill=(26, 43, 109, 255))
draw.ellipse([34, 34, 366, 366], outline=(184, 143, 51, 255), width=8)
# a rising sun
draw.pieslice([110, 150, 290, 330], 180, 360, fill=(240, 190, 60, 255))
for x in range(80, 340, 40):
    draw.line([200, 240, x, 90], fill=(240, 190, 60, 255), width=6)
draw.rectangle([90, 240, 310, 262], fill=(255, 255, 255, 255))
logo.save(OUT / "logo.png")

for path in sorted(OUT.iterdir()):
    print(f"{path.name:16} {path.stat().st_size:7} bytes")
