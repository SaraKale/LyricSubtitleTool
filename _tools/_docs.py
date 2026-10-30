"""把帮助页（README_*.html + image/）搬进**发版目录**，不是搬进扩展目录。

发版目录由 `package_release.py` 组装，长这样：

    release/LyricSubtitleTool_v1.0.0/
    ├── LyricSubtitleTool_AE/     ← 直接拖进 CEP extensions 的成品
    ├── LyricSubtitleTool_PR/
    ├── Add Keys.reg              ← Windows 开调试模式的快捷方式
    ├── README_SC.html / README_TC.html / README_EN.html / README_JP.html
    └── image/                    ← 帮助页里的截图

**为什么帮助页不放进扩展目录**：CEP 扩展目录里只该有扩展本身
（`client/ CSXS/ host/ .debug`）。多塞 html / 图片进去，一是扩展目录变脏，
二是每装一次就多一份迟早会过期的说明；而扩展目录是用户根本不会去翻的地方。
说明文档放发版目录根，解压后一眼就能看到。

几个刻意的决定：

  * **html 平铺在发版目录根**，图片统一进 `image/`，所以 html 里写
    `<img src="image/foo.png">` 就够了（相对路径，不依赖绝对位置）。
  * **源码位置认两个地方**：仓库根目录、`docs/`。同名以根目录为准 ——
    `README_SC.md` 本来就在根目录，`README_SC.html` 放它旁边最自然；
    现在四份 html 实际在 `docs/` 下，两处都认。
  * **一个 html 都没有不算错误**：先发版、后补网页也能过，只打一行提醒。
"""

import os
import shutil

# 期望的四份，缺哪份会单独提醒（但都不阻塞）
EXPECTED = ("README_SC.html", "README_TC.html", "README_EN.html", "README_JP.html")

HTML_EXTS = (".html", ".htm")
# 帮助页旁边可能带的样式 / 脚本 / 字体（图片不在此列，图片走 image/）
SIDE_EXTS = (".css", ".js", ".woff", ".woff2", ".ttf", ".otf")


def _src_dirs(root):
    """按优先级返回帮助页的源码目录：仓库根目录 → docs/。"""
    return (root, os.path.join(root, "docs"))


def find_pages(root):
    """扫描源码目录，返回 (网页 [(src, name)], 附属文件 [(src, name)], 图片目录或 None)。"""
    pages, side, seen = [], [], set()
    for d in _src_dirs(root):
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            src = os.path.join(d, name)
            if not os.path.isfile(src):
                continue
            ext = os.path.splitext(name)[1].lower()
            if name in seen:
                continue
            if ext in HTML_EXTS:
                seen.add(name)
                pages.append((src, name))
            elif ext in SIDE_EXTS:
                seen.add(name)
                side.append((src, name))

    img = None
    for d in _src_dirs(root):
        cand = os.path.join(d, "image")
        if os.path.isdir(cand):
            img = cand
            break
    return pages, side, img


def _clean(dest):
    """清掉上一轮搬进来的东西，避免源码里删掉的 html 在发版目录里留尸。

    只清 html / 样式 / image/ —— 别碰扩展文件夹，那是 package_release.py 自己管的。
    """
    for name in os.listdir(dest):
        p = os.path.join(dest, name)
        if os.path.isdir(p):
            if name == "image":
                shutil.rmtree(p)
            continue
        if os.path.splitext(name)[1].lower() in HTML_EXTS + SIDE_EXTS:
            os.remove(p)


def copy_help_pages(dest, root):
    """把帮助页 + image/ 复制到 dest（发版目录根）。返回 0 表示成功（缺网页也不算失败）。"""
    if not os.path.isdir(dest):
        print("!! 目标目录不存在：%s" % dest)
        return 1

    _clean(dest)

    pages, side, img = find_pages(root)
    if not pages:
        print("[提醒] 还没有 README_*.html 帮助页，跳过复制"
              "（放仓库根目录或 docs/ 下，下次组装会自动带上）")
        return 0

    for src, name in side + pages:
        shutil.copy2(src, os.path.join(dest, name))

    img_n = 0
    if img:
        dst = os.path.join(dest, "image")
        shutil.copytree(img, dst)
        for _, _, files in os.walk(dst):
            img_n += len(files)

    print("[OK] 帮助页：%d 个网页 + %d 个样式/脚本 + %d 张图 → 发版目录根"
          % (len(pages), len(side), img_n))

    have = set(name for _, name in pages)
    missing = [n for n in EXPECTED if n not in have]
    if missing:
        print("[提醒] 还差这些帮助页：%s" % "、".join(missing))
    return 0
