"""Generate icon F (Bili TV) ICO file using PIL only."""
import math
from PIL import Image, ImageDraw

BASE = 256
ICO_PATH = r'C:\Users\陈\Documents\bilibili-music-app\build\icon.ico'
SIZES = [256, 128, 64, 48, 32, 24, 16]

def rounded_rect(draw, xy, r, fill=None):
    x0, y0, x1, y1 = xy
    if r <= 0:
        draw.rectangle((x0, y0, x1, y1), fill=fill)
        return
    draw.pieslice((x0, y0, x0 + r*2, y0 + r*2), 180, 270, fill=fill)
    draw.pieslice((x1 - r*2, y0, x1, y0 + r*2), 270, 360, fill=fill)
    draw.pieslice((x0, y1 - r*2, x0 + r*2, y1), 90, 180, fill=fill)
    draw.pieslice((x1 - r*2, y1 - r*2, x1, y1), 0, 90, fill=fill)
    draw.rectangle((x0 + r, y0, x1 - r, y1), fill=fill)
    draw.rectangle((x0, y0 + r, x1, y1 - r), fill=fill)

def create_gradient(w, h, c1, c2):
    img = Image.new('RGBA', (w, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        r = int(c1[0] * (1 - t) + c2[0] * t)
        g = int(c1[1] * (1 - t) + c2[1] * t)
        b = int(c1[2] * (1 - t) + c2[2] * t)
        for x in range(w):
            img.putpixel((x, y), (r, g, b, 255))
    return img

def draw_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    s = size / BASE
    S = lambda *a: tuple(int(v * s) for v in a)

    # Background rounded rect with gradient
    bg = create_gradient(size, size, (251, 114, 153), (255, 77, 106))
    mask = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    md = ImageDraw.Draw(mask)
    cr = int(48 * s)
    rounded_rect(md, (0, 0, size, size), max(cr, 1), fill=(255, 255, 255, 255))
    bg = Image.composite(bg, Image.new('RGBA', (size, size), (0, 0, 0, 0)), mask)
    img.paste(bg, (0, 0), bg)

    # Antennas (drawn first so they appear behind TV)
    ant_w = max(1, int(5 * s))
    ant_a = 127  # alpha
    # Left antenna rod - slope
    ax1, ay1 = S(45, 52)
    ax0, ay0 = S(45, 70)
    draw.line((ax0, ay0, ax1, ay1), fill=(255, 255, 255, ant_a), width=ant_w)
    # Right antenna rod
    bx1, by1 = S(211, 52)
    bx0, by0 = S(211, 70)
    draw.line((bx0, by0, bx1, by1), fill=(255, 255, 255, ant_a), width=ant_w)
    # Antenna tips
    tr = max(2, int(5 * s))
    draw.ellipse((ax1 - tr, ay1 - tr, ax1 + tr, ay1 + tr), fill=(255, 255, 255, ant_a))
    draw.ellipse((bx1 - tr, by1 - tr, bx1 + tr, by1 + tr), fill=(255, 255, 255, ant_a))

    # TV body
    tv_r = max(1, int(20 * s))
    tv_x0, tv_y0, tv_x1, tv_y1 = S(44, 74, 212, 186)
    rounded_rect(draw, (tv_x0, tv_y0, tv_x1, tv_y1), tv_r,
                 fill=(255, 255, 255, 20))
    # TV outline (draw as stroke using 4 rounded rects offset)
    sw = max(2, int(6 * s))
    # Simple approach: draw a slightly larger rect behind
    rounded_rect(draw, (tv_x0 - sw, tv_y0 - sw, tv_x1 + sw, tv_y1 + sw), tv_r + sw,
                 fill=(255, 255, 255, 0))
    # Better: use rectangle approximation for outline
    draw.rounded_rectangle((tv_x0, tv_y0, tv_x1, tv_y1), radius=tv_r,
                           fill=(255, 255, 255, 20), outline=(255, 255, 255, 255), width=sw)

    # Screen inner area
    scr_r = max(1, int(12 * s))
    draw.rounded_rectangle(
        (S(52, 82, 204, 178)), radius=scr_r,
        fill=(255, 255, 255, 8), outline=None
    )

    # Play triangle
    tri = [S(110, 106), S(146, 130), S(110, 154)]
    draw.polygon(tri, fill=(255, 255, 255, 255))

    # TV stand
    stand_r = max(1, int(5 * s))
    draw.rounded_rectangle(
        (S(100, 186, 156, 194)), radius=stand_r,
        fill=(255, 255, 255, 127)
    )

    return img

def main():
    print(f"Generating icon F → {ICO_PATH}")
    images = []
    for sz in SIZES:
        print(f"  Drawing {sz}x{sz}...")
        img = draw_icon(sz)
        images.append(img)
    images[0].save(
        ICO_PATH, format='ICO',
        sizes=[(s, s) for s in SIZES],
        append_images=images[1:],
    )
    print("Done!")

if __name__ == '__main__':
    main()
