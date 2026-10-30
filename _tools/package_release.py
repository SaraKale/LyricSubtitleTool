"""把两个 dist/ 组装成一个可以直接上传的发版目录（**不产 zip**）。

    python _tools/package_release.py                 # → release/LyricSubtitleTool_v<版本>/
    python _tools/package_release.py --out D:/发布    # 换个地方放

产物结构：

    release/LyricSubtitleTool_v1.0.0/
    ├── LyricSubtitleTool_AE/         拖进 CEP extensions 就能用
    ├── LyricSubtitleTool_PR/
    ├── Add Keys.reg                  Windows 开调试模式（mac 用不上，无害）
    ├── README_SC.html
    ├── README_TC.html
    ├── README_EN.html
    ├── README_JP.html
    └── image/                        帮助页里的截图

**为什么帮助页不放进扩展目录**：CEP 扩展目录里只该有扩展本身
（`client/ CSXS/ host/ .debug`）。用户根本不会去翻 extensions 目录，
而解压出来的版本目录他一眼就看到说明 —— 放这儿才有用。

**为什么要脚本组装、不手动复制**：

  1. **版本号只有一个来源** —— 从 `AE_JSX/src/00_header.jsx` 读，和 manifest 里
     写的是同一个。手动建文件夹很容易写成 `v1.0` / `v1.0.0-beta` 之类对不上的名字。
  2. **每轮先清空版本目录** —— 否则上一版删掉的文件会留在新包里，
     用户拿到的是两代文件的混合体。
  3. **顺手拦住残缺包** —— 扩展必需文件缺一个就直接失败，不产出半成品。
  4. **压缩交给用户** —— 脚本只管目录内容对不对，zip 用他自己惯用的工具打。

压缩方式（两种都行，别只压 `LyricSubtitleTool_AE` 一个文件夹，那会丢掉说明和 reg）：

  * 右键 `LyricSubtitleTool_v1.0.0` 文件夹 → 压缩为 ZIP 文件
    → 解压得到同名文件夹，里面就是上面这个结构。
  * 进到版本目录里全选（AE / PR / reg / 4 个 html / image）→ 压缩
    → 解压后这些直接铺在根上。
"""

import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _docs import copy_help_pages  # noqa: E402

# 两个成品扩展：dist 目录 → 发版目录里的文件夹名（名字必须和 manifest 的安装目录一致）
TARGETS = (
    ("AE", os.path.join(ROOT, "AE_CEP", "dist", "LyricSubtitleTool_AE"),
     "LyricSubtitleTool_AE"),
    ("PR", os.path.join(ROOT, "PR_CEP", "dist", "LyricSubtitleTool_PR"),
     "LyricSubtitleTool_PR"),
)

# 缺了任何一个，用户装完都用不了 —— 直接判失败，别产出半成品
REQUIRED = [
    "CSXS/manifest.xml",
    "client/index.html",
    "client/app.js",
    "host/index.jsx",
]

# 这些文件在 mac 上解压时纯属噪音
JUNK_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
JUNK_DIRS = {"__MACOSX", "__pycache__", ".git"}

REG_FILE = "Add Keys.reg"


def read_version():
    """版本号从 00_header.jsx 里读 —— 和构建脚本、manifest 用同一个来源。"""
    p = os.path.join(ROOT, "AE_JSX", "src", "00_header.jsx")
    if not os.path.exists(p):
        return "0.0.0"
    with open(p, encoding="utf-8-sig") as f:
        m = re.search(r'SB\.VERSION\s*=\s*"([^"]+)"', f.read())
    return m.group(1) if m else "0.0.0"


def safe_ver(ver):
    """版本号要当文件夹名用，掐掉路径分隔符之类的东西。"""
    cleaned = re.sub(r"[^0-9A-Za-z._-]", "_", ver).strip("._")
    return cleaned or "0.0.0"


def ignore_junk(_dir, names):
    return [n for n in names if n in JUNK_NAMES or n in JUNK_DIRS or n.endswith(".pyc")]


def check_dist(tag, dist):
    """动手前先拦住：目录不存在 / 缺关键文件。"""
    if not os.path.isdir(dist):
        print("!! 没有 %s 的产物 —— 先跑一次 python _tools/build_%sCEP.py"
              % (tag, "AE" if tag == "AE" else "PR"))
        return False
    missing = [r for r in REQUIRED if not os.path.exists(os.path.join(dist, r))]
    if missing:
        print("!! %s 缺关键文件：%s" % (tag, "、".join(missing)))
        return False
    return True


def count_files(path):
    n = 0
    for _, _, files in os.walk(path):
        n += len(files)
    return n


def main():
    out_dir = os.path.join(ROOT, "release")
    for i, a in enumerate(sys.argv):
        if a == "--out" and i + 1 < len(sys.argv):
            out_dir = sys.argv[i + 1]

    ver = safe_ver(read_version())

    # 先全部检查完再动手 —— 别删了旧目录才发现新产物是残的
    for tag, dist, _name in TARGETS:
        if not check_dist(tag, dist):
            return 1

    stage = os.path.join(out_dir, "LyricSubtitleTool_v%s" % ver)
    if os.path.isdir(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)
    print("版本 v%s → %s" % (ver, os.path.relpath(stage, ROOT)))

    for tag, dist, name in TARGETS:
        dst = os.path.join(stage, name)
        shutil.copytree(dist, dst, ignore=ignore_junk)
        print("[OK] %-24s %d 个文件（%s）" % (name + "/", count_files(dst), tag))

    reg_src = os.path.join(ROOT, REG_FILE)
    if os.path.exists(reg_src):
        shutil.copy2(reg_src, os.path.join(stage, REG_FILE))
        print("[OK] %-24s Windows 开调试模式用" % REG_FILE)
    else:
        # 不拦：mac / 已开过调试模式的人用不上它
        print("[提醒] 仓库根目录没有 %s —— Windows 用户只能手改注册表" % REG_FILE)

    copy_help_pages(stage, ROOT)

    if not os.path.isdir(os.path.join(stage, "image")):
        print("[提醒] 没有 image/ —— 帮助页里的截图会裂")

    print("\n发版目录：")
    print("  %s" % os.path.relpath(stage, ROOT))
    for name in sorted(os.listdir(stage)):
        p = os.path.join(stage, name)
        if os.path.isdir(p):
            print("    %s/  （%d 个文件）" % (name, count_files(p)))
        else:
            print("    %s" % name)

    print("\n这个目录就是完整的发版内容，直接上传 GitHub Releases 或自己压成 zip：")
    print("  右键 %s 文件夹 → 压缩为 ZIP 文件" % os.path.basename(stage))
    print("别只压 LyricSubtitleTool_AE 一个文件夹 —— 那样说明文档和 reg 会丢掉。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
