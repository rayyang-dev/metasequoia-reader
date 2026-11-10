#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按「林间书页」CONCEPT 01 概念稿重绘 Android 启动图标 PNG。

几何唯一来源（不要凭感觉改数字）：D:/work/code/ai-app/sequoia-reading-icons.html
  CONCEPT 01 svg(viewBox 0 0 100 100):
      circle(50,30,r13) / circle(37,36,r9) / circle(63,36,r9)
      rect(46.5,44,7,18)
      path "M16 80 Q50 71 50 80 Q50 71 84 80" stroke-width=5 linecap=round
  展示页 .icon svg{width:64%;height:64%} 且居中，所以图案只占图标 64%：
      P(u) = 0.18 + 0.0064 * u        (u 为 SVG 坐标，返回图标内比例)
  背景 linear-gradient(145deg,#D8412F,#A8281C) + 顶部 14% 白色高光，
  三色标 #D75644 / #C63629 / #B12D1E 为设计稿实测采样（已含高光）。

adaptive 矢量层另按可见区换算（见 drawable/ic_launcher_foreground.xml 注释）：
  c = 18 + 72 * P(u) = 30.96 + 0.4608 * u

用法：python scripts/gen_icons_concept01.py
输出：5 个密度 × (ic_launcher / ic_launcher_round / ic_launcher_foreground)，
     外加 screenshots/icon_concept01_preview.png 与 icon_concept01_compare.png。
"""
from pathlib import Path
from PIL import Image, ImageDraw
import math

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android" / "app" / "src" / "main" / "res"
SHOTS = ROOT / "screenshots"
DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
SS = 4  # 超采样倍数，保证小尺寸下曲线与圆角平滑

TOP = (0xD7, 0x56, 0x44)
MID = (0xC6, 0x36, 0x29)
BOT = (0xB1, 0x2D, 0x1E)
WHITE = (255, 255, 255, 255)


def P(u):
    """SVG 坐标 -> 图标内比例（概念稿 SVG 占 64% 并居中）。"""
    return 0.18 + 0.0064 * u


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))


def ramp(t):
    t = max(0.0, min(1.0, t))
    if t < 0.5:
        return mix(TOP, MID, t / 0.5)
    return mix(MID, BOT, (t - 0.5) / 0.5)


_BG_BASE = None


def background(n):
    """145deg 线性渐变（色标已含概念稿顶部高光），full-bleed 不透明方形。

    渐变是平滑的，只按 768px 算一次再缩放，避免 512px 预览时做百万级逐像素循环。
    """
    global _BG_BASE
    if _BG_BASE is None:
        base = 768
        img = Image.new("RGBA", (base, base))
        px = img.load()
        # CSS 145deg 方向向量 (sin145, -cos145) = (0.574, 0.819)
        dx, dy = 0.5736, 0.8192
        for y in range(base):
            fy = (y + 0.5) / base
            for x in range(base):
                fx = (x + 0.5) / base
                t = (dx * fx + dy * fy) / (dx + dy)
                px[x, y] = ramp(t) + (255,)
        _BG_BASE = img
    return _BG_BASE.resize((n, n), Image.LANCZOS)


def qbez(p0, c, p1, n=64):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
                    u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]))
    return out


def foreground(n):
    """透明底 + 白色树/书页，超采样后 LANCZOS 缩小。"""
    size = n * SS
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    def xy(u, v):
        return (P(u) * size, P(v) * size)

    # 树冠：三个圆（概念稿原样）
    for cx, cy, r in ((50, 30, 13), (37, 36, 9), (63, 36, 9)):
        x0, y0 = xy(cx - r, cy - r)
        x1, y1 = xy(cx + r, cy + r)
        d.ellipse([x0, y0, x1, y1], fill=WHITE)
    # 树干：顶端插进树冠一点点，避免接缝
    x0, y0 = xy(46.5, 43)
    x1, y1 = xy(53.5, 62)
    d.rectangle([x0, y0, x1, y1], fill=WHITE)
    # 书页：双段 Q 浅双峰 + 圆帽。
    # 不用 ImageDraw.line 画折线：相邻线段之间会留下周期性细缝，缩到小尺寸后变成
    # 书页上的密集竖纹。改为沿曲线法线偏移出闭合多边形再填充，线条是实心的。
    w = 5 * 0.0064 * size
    # 两段 Q 在 (50,80) 是 180° 折返尖点：必须分成两个独立多边形，
    # 否则中心差分法线在该点退化，会鼓出一个不属于概念稿的「水滴」。
    segments = (qbez((16, 80), (50, 71), (50, 80), 96),
                qbez((50, 80), (50, 71), (84, 80), 96))
    for seg in segments:
        poly = [xy(u, v) for u, v in seg]
        upper, lower = [], []
        for i, (x, y) in enumerate(poly):
            p0 = poly[max(0, i - 1)]
            p1 = poly[min(len(poly) - 1, i + 1)]
            dx, dy = p1[0] - p0[0], p1[1] - p0[1]
            length = math.hypot(dx, dy) or 1.0
            nx, ny = -dy / length, dx / length
            upper.append((x + nx * w / 2, y + ny * w / 2))
            lower.append((x - nx * w / 2, y - ny * w / 2))
        d.polygon(upper + lower[::-1], fill=WHITE)
    for u in (16, 84):  # 两端 round cap
        px, py = xy(u, 80)
        d.ellipse([px - w / 2, py - w / 2, px + w / 2, py + w / 2], fill=WHITE)
    return layer.resize((n, n), Image.LANCZOS)


def round_mask(n, radius_ratio):
    size = n * SS
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    if radius_ratio >= 0.5:
        d.ellipse([0, 0, size - 1, size - 1], fill=255)  # 正圆
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1],
                            radius=int(size * radius_ratio), fill=255)
    return m.resize((n, n), Image.LANCZOS)


def compose(n):
    bg = background(n)
    fg = foreground(n)
    square = Image.alpha_composite(bg, fg)
    return square, fg


def main():
    SHOTS.mkdir(exist_ok=True)
    square_cache = {}
    for dens, n in DENS.items():
        sq, fg = compose(n)
        square_cache[n] = sq
        folder = RES / f"mipmap-{dens}"
        folder.mkdir(exist_ok=True)
        # 1) 方形：full-bleed 不透明（launcher 自己套圆角遮罩），与 adaptive 策略一致
        sq.save(folder / "ic_launcher.png")
        # 2) 圆形：外接透明
        rd = sq.copy()
        rd.putalpha(round_mask(n, 0.5))
        rd.save(folder / "ic_launcher_round.png")
        # 3) foreground：透明底白图案（尺寸沿用工程既有的 legacy 规格）
        fg.save(folder / "ic_launcher_foreground.png")
        print(f"  {dens:8s} {n:3d}x{n:<3d} ok")

    # 预览：模拟 launcher 的圆角方形遮罩（概念稿 128px/28px ≈ 22%）
    prev_n = 512
    prev = compose(prev_n)[0]
    prev.putalpha(round_mask(prev_n, 22 / 128))
    preview_path = SHOTS / "icon_concept01_preview.png"
    prev.save(preview_path)
    print("preview:", preview_path)

    # 对比图：左 = 用户提供的当前真机图标截图，右 = 新图标
    before_src = Path(r"C:\Users\杨睿\Desktop\01a1bfa26ad777249e6d43470f65023e.png")
    compare_path = SHOTS / "icon_concept01_compare.png"
    if before_src.exists():
        src = Image.open(before_src).convert("RGB")
        crop = src.crop((87, 59, 283, 255)).resize((320, 320), Image.LANCZOS)
        after = prev.resize((320, 320), Image.LANCZOS)
        dark = (14, 14, 17, 255)
        canvas = Image.new("RGBA", (720, 400), dark)
        canvas.paste(crop.convert("RGBA"), (24, 48))
        canvas.paste(after, (376, 48))
        d = ImageDraw.Draw(canvas)
        d.text((24, 20), "BEFORE  v1.4.4 (full-bleed tree)", fill=(200, 200, 208))
        d.text((376, 20), "AFTER   CONCEPT 01 (64% artwork)", fill=(200, 200, 208))
        canvas.convert("RGB").save(compare_path)
        print("compare:", compare_path)
    else:
        print("skip compare (source screenshot not found)")


if __name__ == "__main__":
    main()
