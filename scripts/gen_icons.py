#!/usr/bin/env python3
"""生成多款 BiliMusic 图标供挑选"""
import struct, zlib, os, sys

OUTPUT = os.path.join(os.path.dirname(__file__), '..', 'build')

def make_png(w, h, pixels):
    raw = b''
    for y in range(h):
        raw += b'\x00'
        for x in range(w):
            raw += bytes(pixels[y * w + x])
    return (b'\x89PNG\r\n\x1a\n' +
            struct.pack('>I', 13) + b'IHDR' + struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0) +
            struct.pack('>I', zlib.crc32(b'IHDR' + struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) & 0xffffffff) +
            struct.pack('>I', zlib.compress(raw).__len__()) + b'IDAT' + zlib.compress(raw) +
            struct.pack('>I', zlib.crc32(b'IDAT' + zlib.compress(raw)) & 0xffffffff) +
            b'\x00\x00\x00\x00IEND\xae\x42\x60\x82')

def make_ico(pngs):
    sizes = [(256,256),(128,128),(64,64),(48,48),(32,32),(24,24),(16,16)]
    header = struct.pack('<HHH', 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = b''
    data = b''
    for i, (w, h) in enumerate(sizes):
        png = pngs[i]
        entries += struct.pack('<BBBBHHII', w if w<256 else 0, h if h<256 else 0, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
        data += png
    return header + entries + data

def save_ico(name, make_pixel_fn):
    sizes = [256,128,64,48,32,24,16]
    pngs = []
    for size in sizes:
        pixels = []
        for y in range(size):
            for x in range(size):
                pixels.append(make_pixel_fn(x, y, size))
        pngs.append(make_png(size, size, pixels))
    ico = make_ico(pngs)
    path = os.path.join(OUTPUT, name)
    with open(path, 'wb') as f:
        f.write(ico)
    print(f'  ✅ {name}  ({len(ico):,} bytes)')

os.makedirs(OUTPUT, exist_ok=True)

def lerp(a, b, t):
    return tuple(int(ac + (bc - ac) * t) for ac, bc in zip(a, b))

# ====== 1. 粉蓝渐变 + 音符 (B站风格) ======
def style1(x, y, s):
    nx, ny = (x+0.5)/s*2-1, (y+0.5)/s*2-1
    rx, ry = abs(nx), abs(ny)
    cr = 0.18
    d1 = max(rx-(1-cr), ry-(1-cr), 0)
    d2 = max(((rx-(1-cr))**2+(ry-(1-cr))**2)**0.5 if rx>1-cr and ry>1-cr else 0, 0)
    od = max(d1, d2)
    edge = 0.03
    alpha = 0 if od > edge else max(0, min(1, 1 - od/edge))
    pink, blue = (0xFB,0x72,0x99), (0x00,0xA1,0xD6)
    grad = (ny*0.5+0.5)*0.7 + (nx*0.3+0.3)*0.3
    bg = lerp(pink, blue, grad)
    cx, cy = -0.05, -0.1
    dx, dy = nx-cx, ny-cy
    rx2, ry2 = dx*0.94+dy*0.34, -dx*0.34+dy*0.94
    head = (rx2/0.22)**2 + (ry2/0.16)**2 < 1
    stem = abs(nx-(cx+0.18)) < 0.04 and 0 < ny-(cy-0.45) < 0.7
    note = head or stem
    if alpha <= 0: return (0,0,0,0)
    if note:
        cd = (nx**2+(ny+0.05)**2)**0.5
        wa = 0.85 + max(0, 1-cd*0.7)*0.15
        return (255, 255, 255, int(alpha * wa * 255))
    return (bg[0], bg[1], bg[2], int(alpha * 255))

# ====== 2. 纯黑底 + 金色音符 ======
def style2(x, y, s):
    nx, ny = (x+0.5)/s*2-1, (y+0.5)/s*2-1
    r = (nx*nx + ny*ny)**0.5
    if r > 1: return (0,0,0,0)
    # 圆
    aa = max(0, min(1, (1 - r) / 0.02))
    bg = (18, 18, 26)
    # 金色音符
    cx, cy = -0.05, -0.1
    head = ((nx-cx)/0.2)**2 + ((ny-cy)/0.15)**2 < 1
    stem = abs(nx-(cx+0.17)) < 0.035 and -0.4 < ny-(cy-0.4) < 0.4
    gold = (0xFF, 0xD7, 0x00)
    if head or stem:
        return (gold[0], gold[1], gold[2], int(aa * 230))
    # 外圈
    ring = abs(r - 0.85) < 0.04
    if ring:
        return (0xFB, 0x72, 0x99, int(aa * 200))
    return (bg[0], bg[1], bg[2], int(aa * 200))

# ====== 3. 白底 + 粉色音符 (简洁) ======
def style3(x, y, s):
    nx, ny = (x+0.5)/s*2-1, (y+0.5)/s*2-1
    r = (nx*nx + ny*ny)**0.5
    if r > 1: return (0,0,0,0)
    aa = max(0, min(1, (1 - r) / 0.03))
    # 白底
    bg = (245, 245, 250)
    # 音符
    cx, cy = -0.05, -0.12
    head = ((nx-cx)/0.22)**2 + ((ny-cy)/0.16)**2 < 1
    stem = abs(nx-(cx+0.19)) < 0.04 and 0 < ny-(cy-0.45) < 0.7
    tail_dx, tail_dy = nx-(cx+0.22), ny-(cy-0.45)
    tail = abs(tail_dx*0.8+tail_dy*0.6) < 0.05 and 0 < tail_dy < 0.3 and tail_dx > -0.03
    note = head or stem or tail
    if note:
        return (0xFB, 0x72, 0x99, int(aa * 255))
    return (bg[0], bg[1], bg[2], int(aa * 255))

# ====== 4. 黑胶唱片风格 ======
def style4(x, y, s):
    nx, ny = (x+0.5)/s*2-1, (y+0.5)/s*2-1
    r = (nx*nx + ny*ny)**0.5
    if r > 1: return (0,0,0,0)
    aa = max(0, min(1, (1 - r) / 0.02))
    # 唱片盘
    disc = abs(r - 0.65) < 0.3 or abs(r - 0.35) < 0.02 or abs(r - 0.15) < 0.015 or abs(r - 0.02) < 0.01
    # 唱片刻纹
    grooves = any(abs(r - g) < 0.008 for g in [0.55, 0.50, 0.45, 0.40, 0.30, 0.25, 0.20])
    if grooves:
        return (0x88, 0x88, 0x99, int(aa * 180))
    if disc:
        return (0x1A, 0x1A, 0x26, int(aa * 255))
    return (0xFB, 0x72, 0x99, int(aa * 200))

# ====== 5. 蓝色渐变 + 白色播放键 ======
def style5(x, y, s):
    nx, ny = (x+0.5)/s*2-1, (y+0.5)/s*2-1
    r = (nx*nx + ny*ny)**0.5
    if r > 1: return (0,0,0,0)
    aa = max(0, min(1, (1 - r) / 0.03))
    # 渐变
    grad = ny * 0.4 + 0.5
    bg = lerp((0x00,0xA1,0xD6), (0x00,0x6B,0x9E), grad)
    # 播放三角
    tri = (nx+0.05)*1.5 - abs(ny)*0.8 > 0 and abs(ny) < 0.3 and nx > -0.4 and nx < 0.4
    if tri:
        return (255, 255, 255, int(aa * 255))
    return (bg[0], bg[1], bg[2], int(aa * 240))

# ====== 6. 圆角方形 粉红背景 + 白色音符 ======
def style6(x, y, s):
    nx, ny = (x+0.5)/s*2-1, (y+0.5)/s*2-1
    rx, ry = abs(nx), abs(ny)
    cr = 0.20
    d1 = max(rx-(1-cr), ry-(1-cr), 0)
    d2 = ((rx-(1-cr))**2+(ry-(1-cr))**2)**0.5 if rx>1-cr and ry>1-cr else 0
    od = max(d1, d2)
    if od > 0.04: return (0,0,0,0)
    aa = max(0, min(1, 1 - od/0.04))
    bg = (0xFB, 0x72, 0x99)
    # 大音符
    cx, cy = -0.02, -0.08
    head = ((nx-cx)/0.24)**2 + ((ny-cy)/0.18)**2 < 1
    stem = abs(nx-(cx+0.20)) < 0.04 and -0.5 < ny-(cy-0.4) < 0.5
    if head or stem:
        return (255, 255, 255, int(aa * 255))
    return (bg[0], bg[1], bg[2], int(aa * 255))

# ====== 7. 复古磁带风格 ======
def style7(x, y, s):
    nx, ny = (x+0.5)/s*2-1, (y+0.5)/s*2-1
    ix, iy = int(nx*s/2), int(ny*s/2)
    rx, ry = abs(nx), abs(ny)
    cr = 0.15
    d1 = max(rx-(1-cr), ry-(1-cr), 0)
    d2 = ((rx-(1-cr))**2+(ry-(1-cr))**2)**0.5 if rx>1-cr and ry>1-cr else 0
    od = max(d1, d2)
    if od > 0.03: return (0,0,0,0)
    aa = max(0, min(1, 1 - od/0.03))
    # 磁带
    tape_in = abs(nx) < 0.7 and abs(ny) < 0.4
    gear_l = (nx+0.4)**2 + ny**2 < 0.12**2
    gear_r = (nx-0.4)**2 + ny**2 < 0.12**2
    window_l = abs(nx+0.2) < 0.1 and abs(ny) < 0.12
    window_r = abs(nx-0.2) < 0.1 and abs(ny) < 0.12
    if gear_l or gear_r:
        return (0x44, 0x44, 0x55, int(aa * 255))
    if window_l or window_r:
        return (0x2A, 0x2A, 0x3A, int(aa * 255))
    if tape_in:
        return (0x1A, 0x1A, 0x26, int(aa * 255))
    # 外壳
    label = abs(ny) < 0.15
    if label:
        return (0xFB, 0x72, 0x99, int(aa * 255))
    return (0x12, 0x12, 0x1A, int(aa * 255))

# ====== 生成全部 ======
print('生成图标中...')
save_ico('icon-bilibili-pink.ico', style1)
save_ico('icon-dark-gold.ico', style2)
save_ico('icon-white-pink.ico', style3)
save_ico('icon-vinyl.ico', style4)
save_ico('icon-blue-play.ico', style5)
save_ico('icon-pink-note.ico', style6)
save_ico('icon-cassette.ico', style7)
print('\n全部生成完毕！在 build/ 目录下选择你喜欢的：')
for f in sorted(os.listdir(OUTPUT)):
    if f.endswith('.ico'):
        print(f'  {f}')
