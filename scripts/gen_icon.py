#!/usr/bin/env python3
"""生成 BiliMusic 应用图标（粉蓝渐变 + 音符）"""
import struct, zlib, os

def make_png(w, h, pixels):
    """生成 PNG 图片字节"""
    def write_chunk(chunk_type, data):
        chunk = chunk_type + data
        return struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk) & 0xffffffff)
    
    raw = b''
    for y in range(h):
        raw += b'\x00'  # filter none
        for x in range(w):
            raw += bytes(pixels[y * w + x])
    
    return (b'\x89PNG\r\n\x1a\n' +
            write_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) +
            write_chunk(b'IDAT', zlib.compress(raw)) +
            write_chunk(b'IEND', b''))

def make_ico(png_data, sizes):
    """把多个 PNG 合成 .ico 文件"""
    # ICO header
    header = struct.pack('<HHH', 0, 1, len(sizes))
    data = header
    offset = 6 + 16 * len(sizes)
    entries = b''
    for i, (w, h) in enumerate(sizes):
        png = png_data[i]
        entries += struct.pack('<BBBBHHII', 
            w if w < 256 else 0, 
            h if h < 256 else 0, 
            0, 0,  # color palette
            1,     # color planes
            32,    # bits per pixel
            len(png),
            offset)
        offset += len(png)
    data = header + entries
    for png in png_data:
        data += png
    return data

def lerp(a, b, t):
    return tuple(int(ac + (bc - ac) * t) for ac, bc in zip(a, b))

def main():
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
    png_list = []
    
    for size_w, size_h in sizes:
        w, h = size_w, size_h
        pixels = []
        
        for y in range(h):
            for x in range(w):
                # 归一化坐标 [-1, 1]
                nx = (x + 0.5) / w * 2 - 1
                ny = (y + 0.5) / h * 2 - 1
                
                # 圆角矩形距离
                rx, ry = abs(nx), abs(ny)
                corner_r = 0.18
                dist = max(rx - (1 - corner_r), ry - (1 - corner_r), 0)
                corner_dist = ((rx - (1 - corner_r)) ** 2 + (ry - (1 - corner_r)) ** 2) ** 0.5 if rx > 1 - corner_r and ry > 1 - corner_r else 0
                outer_dist = max(dist, corner_dist)
                
                # 抗锯齿
                edge = 0.03
                if outer_dist > edge:
                    alpha = 0
                else:
                    alpha = max(0, min(1, 1 - outer_dist / edge))
                
                # 粉蓝渐变
                pink = (0xFB, 0x72, 0x99)  # #FB7299
                blue = (0x00, 0xA1, 0xD6)  # #00a1d6
                grad_t = (ny * 0.5 + 0.5) * 0.7 + (nx * 0.3 + 0.3) * 0.3
                bg = lerp(pink, blue, grad_t)
                
                # 音符 (♪) — 用基础几何绘制
                # 音符头部: 左侧椭圆
                cx, cy = -0.05, -0.1
                
                # 音符头 — 倾斜椭圆
                dx, dy = nx - cx, ny - cy
                # 旋转 -20度
                rx2 = dx * 0.94 + dy * 0.34
                ry2 = -dx * 0.34 + dy * 0.94
                head_rx, head_ry = 0.22, 0.16
                head_dist = (rx2 / head_rx) ** 2 + (ry2 / head_ry) ** 2
                
                # 音符杆 — 竖线
                stem_x = cx + 0.18
                stem_dx = abs(nx - stem_x)
                stem_dy = ny - (cy - 0.45)
                stem_in = stem_dx < 0.04 and 0 < stem_dy < 0.7
                
                # 音符尾巴 — 弧线
                tail_start_y = cy - 0.45
                tail_dx = nx - (stem_x + 0.02)
                tail_dy = ny - tail_start_y
                tail_dist = abs(tail_dx * 0.8 + tail_dy * 0.6) 
                tail_in = tail_dist < 0.06 and 0 < tail_dy < 0.35 and tail_dx > -0.05
                
                is_note = head_dist < 1.0 or stem_in or tail_in
                
                if alpha > 0:
                    if is_note:
                        # 渐变效果: 从音符中心向外白色渐变
                        center_dist = ((nx) ** 2 + (ny + 0.05) ** 2) ** 0.5
                        white_alpha = max(0.0, min(1.0, 1.0 - center_dist * 0.7))
                        r = int(255)
                        g = int(255)
                        b = int(255)
                        a = int(alpha * (0.85 + white_alpha * 0.15) * 255)
                    else:
                        r, g, b = bg
                        a = int(alpha * 255)
                else:
                    r, g, b, a = 0, 0, 0, 0
                
                pixels.append((r, g, b, a))
        
        png_list.append(make_png(w, h, pixels))
    
    ico_data = make_ico(png_list, sizes)
    
    output = os.path.join(os.path.dirname(__file__), '..', 'build', 'icon.ico')
    os.makedirs(os.path.dirname(output), exist_ok=True)
    with open(output, 'wb') as f:
        f.write(ico_data)
    print(f'✅ 图标已生成: {output}')
    print(f'   大小: {len(ico_data):,} 字节, 包含 {len(sizes)} 个尺寸')

if __name__ == '__main__':
    main()
