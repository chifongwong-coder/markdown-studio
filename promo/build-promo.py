#!/usr/bin/env python3
# Build the Chrome Web Store small promotional tile (440x280).
#
# Run from the repo root:
#   python3 promo/build-promo.py
#
# Output: promo/small-promo-440x280.png
#
# Inputs:
#   icons/image.png  -- the 1254x1254 logo master. Its four corners are
#                       pure black (export artifact); we mask them to
#                       white before resizing so they blend with the tile
#                       background instead of producing visible triangles.

from PIL import Image, ImageDraw, ImageFont
import os

CANVAS_W, CANVAS_H = 440, 280
LOGO_SIZE = 220

HELVETICA = '/System/Library/Fonts/Helvetica.ttc'
DARK = (36, 41, 46)
MUTED = (106, 115, 125)


def font(size, bold=False):
    # On the Helvetica .ttc collection, index 1 is the bold face.
    return ImageFont.truetype(HELVETICA, size, index=1 if bold else 0)


def scrub_near_black(src):
    """Replace near-black pixels in the source logo with white.

    The logo master is white + blue everywhere except the four corners,
    which are pure black -- so a low-brightness threshold cleanly removes
    the export artifact without touching real logo content.
    """
    gray = src.convert('L')
    mask = gray.point(lambda v: 255 if v < 15 else 0)
    white = Image.new('RGB', src.size, 'white')
    src = src.copy()
    src.paste(white, mask=mask)
    return src


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = Image.open(os.path.join(root, 'icons', 'image.png')).convert('RGB')
    src = scrub_near_black(src)
    logo = src.resize((LOGO_SIZE, LOGO_SIZE), Image.LANCZOS)

    tile = Image.new('RGB', (CANVAS_W, CANVAS_H), 'white')
    tile.paste(logo, (10, (CANVAS_H - LOGO_SIZE) // 2))

    draw = ImageDraw.Draw(tile)
    draw.text((242,  70), 'Markdown', fill=DARK, font=font(34, bold=True))
    draw.text((242, 110), 'Studio',   fill=DARK, font=font(34, bold=True))
    draw.text((242, 170), 'All-in-one Markdown toolkit',        fill=MUTED, font=font(13))
    draw.text((242, 192), 'View · Edit · Export to PDF / Word', fill=MUTED, font=font(13))

    out = os.path.join(root, 'promo', 'small-promo-440x280.png')
    tile.save(out, optimize=True)
    print(f'wrote {out} ({os.path.getsize(out)} bytes)')


if __name__ == '__main__':
    main()
