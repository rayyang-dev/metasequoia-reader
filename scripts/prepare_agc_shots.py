"""把真机截图整理成华为 AGC 可提交的 9:16 应用介绍截图。

输入：screenshots/agc/device-original/*.jpg（用户真机原图，原样留档）
输出：
  screenshots/agc/submit-1080x1920/  —— 1080×1920（HarmonyOS 应用 / API 上传口径）
  screenshots/agc/submit-450x800/    —— 450×800（官方《应用素材规范》「APK应用(手机)」口径）

处理原则（对应《应用审核指南》1.9 / 1.16）：
  1. 只做**裁剪**与**等比缩放**，不拉伸、不压缩变形、不修改画面内容（不是 P 图）。
  2. 裁掉系统状态栏 —— 原图状态栏里有其他 App「迷雾」的媒体悬浮通知，
     属于「第三方信息元素 / 无关内容」，是明确的驳回风险。
  3. 裁掉系统手势导航条（系统元素，非应用内容）。
  4. 剩余应用内容等比缩放到高 1920，左右用**取自画面自身的背景色**补到 1080，
     保证「显示完整」——不做 center-crop 切掉底部 tabbar 或页面标题。
  5. 4 张内容互不重复（书架 / 阅读器 / 统计 / 设置），方向一致，均 ≤5MB。

用法：python scripts/prepare_agc_shots.py
"""
from PIL import Image, ImageStat
import os
import hashlib

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'screenshots', 'agc')
SRC = os.path.join(BASE, 'device-original')
OUT_HD = os.path.join(BASE, 'submit-1080x1920')
OUT_SD = os.path.join(BASE, 'submit-450x800')
os.makedirs(OUT_HD, exist_ok=True)
os.makedirs(OUT_SD, exist_ok=True)

# 文件名, 输出名, 顶部裁多少(状态栏), 底部裁多少(手势条)
# 逐行像素实测：其他 App「迷雾」黑色胶囊占 y=21..84，故 top=95 才裁得干净
# （试过 top=80，顶部会残留 5px 黑色圆角下沿）。02-shelf 原图无状态栏，top=0。
JOBS = [
    ('02-shelf.jpg',    '01-shelf.png',    0,  55),
    ('01-reader.jpg',   '02-reader.png',  95,  55),
    ('03-stats.jpg',    '03-stats.png',   95,  55),
    ('04-settings.jpg', '04-settings.png', 95, 55),
]

TARGET_W, TARGET_H = 1080, 1920
SMALL_W, SMALL_H = 450, 800


def extend_canvas(resized, nw):
    """左右补边用「画面最边缘 3px 列的水平延展」而不是单一纯色。

    这样补边颜色随高度跟着内容走（顶部标题栏色 / 中部页面底色 / 底部 tabbar 色
    都能对齐），不会出现一条明显比内容区深或浅的竖带。属于几何延展，
    不新增、不修改任何画面内容，也不做 center-crop 切掉标题或 tabbar。
    """
    pad_l = (TARGET_W - nw) // 2
    pad_r = TARGET_W - nw - pad_l
    canvas = Image.new('RGB', (TARGET_W, TARGET_H))
    if pad_l:
        col = resized.crop((0, 0, 3, TARGET_H)).resize((1, TARGET_H), Image.BOX)
        canvas.paste(col.resize((pad_l, TARGET_H), Image.NEAREST), (0, 0))
    canvas.paste(resized, (pad_l, 0))
    if pad_r:
        col = resized.crop((nw - 3, 0, nw, TARGET_H)).resize((1, TARGET_H), Image.BOX)
        canvas.paste(col.resize((pad_r, TARGET_H), Image.NEAREST), (pad_l + nw, 0))
    return canvas


def process(src_name, out_name, top, bottom):
    im = Image.open(os.path.join(SRC, src_name)).convert('RGB')
    w, h = im.size
    # 1) 裁掉状态栏 / 手势条
    im = im.crop((0, top, w, h - bottom))
    cw, ch = im.size
    # 2) 等比缩放到目标高度（只允许等比，绝不拉伸）
    scale = TARGET_H / ch
    nw = round(cw * scale)
    resized = im.resize((nw, TARGET_H), Image.LANCZOS)
    # 3) 左右用边缘像素延展补到 1080×1920，内容完整不裁切
    if nw > TARGET_W:
        raise RuntimeError(f'{src_name}: 缩放后宽度 {nw} > {TARGET_W}，需重新确认裁剪参数')
    canvas = extend_canvas(resized, nw)

    hd = os.path.join(OUT_HD, out_name)
    canvas.save(hd, 'PNG', optimize=True)
    small = canvas.resize((SMALL_W, SMALL_H), Image.LANCZOS)
    sd = os.path.join(OUT_SD, out_name)
    small.save(sd, 'PNG', optimize=True)

    def info(p):
        b = open(p, 'rb').read()
        return {'size': Image.open(p).size, 'bytes': len(b),
                'md5': hashlib.md5(b).hexdigest()[:8]}
    return {'src': src_name, 'src_size': (w, h), 'crop': (top, bottom),
            'scaled_w': nw, 'hd': info(hd), 'sd': info(sd)}


if __name__ == '__main__':
    import json
    report = [process(*job) for job in JOBS]
    for r in report:
        print(f"{r['src']:<18} {r['src_size']}  crop={r['crop']}  "
              f"HD={r['hd']['size']} {r['hd']['bytes']//1024}KB  "
              f"SD={r['sd']['size']} {r['sd']['bytes']//1024}KB  md5={r['hd']['md5']}")
    hd_md5 = {r['hd']['md5'] for r in report}
    print(f"\nunique_content={len(hd_md5)}/{len(report)}")
    print(f"all_hd_under_5MB={all(r['hd']['bytes'] <= 5*1024*1024 for r in report)}")
    print(f"all_sd_under_2MB={all(r['sd']['bytes'] <= 2*1024*1024 for r in report)}")
    print(f"all_hd_9_16={all(r['hd']['size'] == (1080,1920) for r in report)}")
    print(f"all_sd_9_16={all(r['sd']['size'] == (450,800) for r in report)}")
