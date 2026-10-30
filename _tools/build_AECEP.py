# -*- coding: utf-8 -*-
"""
把 CEP 扩展（HTML 面板 + 宿主脚本）组装好并安装到 AE。

跟 ScriptUI 版（build_AEJSX.py）的区别：
  · 逻辑层一模一样：AE/src/ 里的 00/01~06/08 原样拼进去，一行不改
  · 界面层换掉：不拼 07_ui.jsx（那是 ScriptUI），改拼 CEP/host/09_bridge.jsx
    —— 它把逻辑层包成「动作名 + JSON 参数 → JSON 结果」，给 HTML 面板调用
  · 产物是一整个 CEP 扩展目录（CSXS/manifest.xml + client/ + host/）

用法：
  python _tools/build_AECEP.py            # 只构建到 CEP/dist/
  python _tools/build_AECEP.py install    # 构建 + 装进 CEP 扩展目录（Windows 是 %APPDATA%，macOS 是 ~/Library）
  python _tools/build_AECEP.py install --no-reg   # 装但不改注册表
"""

import datetime
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _platform import cep_extensions_dir, enable_cep_debug  # noqa: E402

AE_SRC = os.path.join(ROOT, "AE_JSX", "src")
CEP_DIR = os.path.join(ROOT, "AE_CEP")
CLIENT_SRC = os.path.join(CEP_DIR, "client")
HOST_SRC = os.path.join(CEP_DIR, "host")

# 产物目录名 / 安装目录名 / 窗口菜单里显示的名字，三处都从这一组常量来
DIST_NAME = "LyricSubtitleTool_AE"
# ⚠ 这个名字**没法跟着面板语言切换**，别想着接 i18n：
#   「窗口 > 扩展 >」里的那一行来自 manifest 的 ExtensionBundleName / <Menu>，
#   宿主在**进程启动时**读它，那时面板的 JS 还没跑，SB.M() 根本不存在。
#   CEP 的 manifest 也没有按语言分名字的语法（<LocaleList> 只是声明支持哪些语言）。
#   所以只能选一个「对谁都成立」的名字 —— 用英文，和仓库名 / 文件夹名 / README 标题一致。
#   面板**内部**的标题是另一回事，那里走 data-i18n，会正常跟随语言。
BUNDLE_NAME = "LyricSubtitleTool"
# 改名前的目录名，装的时候顺手清掉，免得 AE 的「扩展」菜单里新旧两个都在
LEGACY_DIR_NAMES = ["SubtitleTool"]

DIST = os.path.join(CEP_DIR, "dist", DIST_NAME)

# 注意：没有 07_ui.jsx —— 那是 ScriptUI 的界面，CEP 版用 HTML 写。
# 02b_i18n.jsx 是查表核心（SB.M / SB.T / setLang），必须排在所有
# 调用 SB.M() 的模块（02~06、08）前面，否则桥接层一跑就是「SB.M is not a function」。
# 02c/02d/02e 是三张语言表，各 60KB 上下：必须**各自成文件**，
# 四张表塞进 02b 会有 ~180KB，顶穿 ExtendScript 单编译单元 ~107KB 的上限，
# 表现是「语法错误」且报错行号指到别处（详见 MEMORY.md）。
ORDER = [
    "00_header.jsx",
    "01_json.jsx",
    "02_util.jsx",
    "02b_i18n.jsx",
    "02c_i18n_en_a.jsx",
    "02c_i18n_en_b.jsx",
    "02d_i18n_zht_a.jsx",
    "02d_i18n_zht_b.jsx",
    "02e_i18n_ja_a.jsx",
    "02e_i18n_ja_b.jsx",
    "03_lrc.jsx",
    "03b_sub.jsx",   # SRT / ASS(SSA) / WebVTT 解析，被 03_lrc 的 parseAuto 调用
    "04_layers.jsx",
    "05_style.jsx",
    "06_online.jsx",
    "08_preset.jsx",
]

EXT_ID = "com.sarakale.lyricsubtitle.panel"
BUNDLE_ID = "com.sarakale.lyricsubtitle"

MANIFEST = """<?xml version="1.0" encoding="UTF-8"?>
<ExtensionManifest Version="11.0"
                   ExtensionBundleId="{bundle}"
                   ExtensionBundleVersion="{ver}"
                   ExtensionBundleName="{name}">
  <ExtensionList>
    <Extension Id="{ext}" Version="{ver}"/>
  </ExtensionList>
  <ExecutionEnvironment>
    <HostList>
      <!-- AEFT = After Effects；13.0 = CC 2014，往上全兼容 -->
      <Host Name="AEFT" Version="[13.0,99.9]"/>
    </HostList>
    <LocaleList>
      <Locale Code="All"/>
    </LocaleList>
    <RequiredRuntimeList>
      <RequiredRuntime Name="CSXS" Version="{csxs}"/>
    </RequiredRuntimeList>
  </ExecutionEnvironment>
  <DispatchInfoList>
    <Extension Id="{ext}">
      <DispatchInfo>
        <Resources>
          <MainPath>./client/index.html</MainPath>
          <ScriptPath>./host/index.jsx</ScriptPath>
        </Resources>
        <Lifecycle>
          <AutoVisible>true</AutoVisible>
        </Lifecycle>
        <UI>
          <Type>Panel</Type>
          <Menu>{name}</Menu>
          <Geometry>
            <Size>
              <Width>430</Width>
              <Height>640</Height>
            </Size>
            <MinSize>
              <Width>320</Width>
              <Height>260</Height>
            </MinSize>
            <MaxSize>
              <Width>900</Width>
              <Height>1600</Height>
            </MaxSize>
          </Geometry>
        </UI>
      </DispatchInfo>
    </Extension>
  </DispatchInfoList>
</ExtensionManifest>
"""

DEBUG_FILE = """<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="{ext}">
    <HostList>
      <!-- 有这个文件就能用 Chrome DevTools 连 http://localhost:8088 调试面板 -->
      <Host Name="AEFT" Port="8088"/>
    </HostList>
  </Extension>
</ExtensionList>
"""


# 宿主入口 bootstrap 是独立模板文件（CEP/_bootstrap.jsx），构建时读它、补 BOM 写出。
# 抽成文件是为了好维护：以前它是个几百行的 Python 字符串常量，改一次对不上字符一次。
BOOTSTRAP_TEMPLATE = os.path.join(CEP_DIR, "_bootstrap.jsx")


CLIENT_FILES = ["index.html", "style.css", "app.js",
                "i18n_en.js", "i18n_zht.js", "i18n_ja.js", "CSInterface.js"]

# dist 里**只放扩展本身**：client/ CSXS/ host/ .debug，别的都不放。
# 说明文档（README_*.html + image/）和 Add Keys.reg 归发版目录管，
# 由 _tools/package_release.py 组装到 release/LyricSubtitleTool_v<版本>/ 根目录 ——
# 那是用户解压后真正会看到的地方，而 extensions 目录他根本不会去翻。


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def read_version():
    """版本号从 00_header.jsx 里读 —— 那里是唯一来源，别的地方不许再写死。

    面板标签栏、关于页、自检报告、manifest 全都用它，发版只改 00_header.jsx 两行。
    """
    m = re.search(r'SB\.VERSION\s*=\s*"([^"]+)"', read(os.path.join(AE_SRC, "00_header.jsx")))
    return m.group(1) if m else "0.0.0"


def check_es3(code, label):
    """复用 build_AEJSX.py 里的 ES3 检查表，避免 CEP 版写出 ExtendScript 跑不动的语法"""
    try:
        import build_AEJSX as build
    except ImportError:
        print("[跳过] 没找到 build_AEJSX.py，跳过 ES3 检查")
        return 0
    checked = build.strip_comments(code)
    bad = 0
    for pattern, msg in build.ES3_FORBIDDEN:
        for m in re.finditer(pattern, checked):
            line = checked[:m.start()].count("\n") + 1
            print("  [%s] 第 %d 行：%s  →  %s" % (label, line, msg, m.group(0)[:60]))
            bad += 1
    return bad


SYNTAX_TMP = os.path.join(ROOT, "_tools", "_cep_syntax.js")


def clean_syntax_tmp():
    """临时文件是覆盖写的，构建结束统一删一次。

    别在 syntax_check() 里每次删 —— 一个构建要查二十来个单元，就是二十来次
    删除系统调用，既没用又慢（某些环境对短时间内的大量删除还有保护策略）。
    """
    if os.path.exists(SYNTAX_TMP):
        try:
            os.remove(SYNTAX_TMP)
        except OSError:
            pass


def syntax_check(code, label):
    import build_AEJSX as build
    node = build.find_node()
    tmp = SYNTAX_TMP
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(build.strip_directives(code))
        # 必须显式给 utf-8：Windows 下默认用 gbk 解码 node 的输出，
        # 碰到中文/特殊字符会直接 UnicodeDecodeError，把真正的语法错误吞掉。
        res = subprocess.run([node, "--check", tmp], capture_output=True,
                             text=True, encoding="utf-8", errors="replace")
        if res.returncode != 0:
            print("!! 语法检查未通过（%s）：" % label)
            print(res.stderr or res.stdout)
            return 1
        return 0
    except FileNotFoundError:
        print("[跳过] 没找到 node，跳过语法检查")
        return 0


def check_ids():
    """app.js 里引用的控件 id，是不是真的存在于 index.html。

    漏一个就会出大事：$("xxx") 返回 null，紧接着给它赋 onclick/onchange 直接抛
    TypeError，而 bind() 是自上而下执行的 —— 抛在哪一行，那一行**之后**的所有按钮
    就全都没绑上。症状同样是「面板能用，一半按钮点不动」，而且没有任何报错提示。
    """
    import re
    with open(os.path.join(CLIENT_SRC, "index.html"), "r", encoding="utf-8") as f:
        html = f.read()
    with open(os.path.join(CLIENT_SRC, "app.js"), "r", encoding="utf-8") as f:
        js = f.read()

    ids = set(re.findall(r'id="([A-Za-z0-9_]+)"', html))
    used = set()
    for pat in (r'\$\("([A-Za-z0-9_]+)"\)', r'\bchk\("([A-Za-z0-9_]+)"\)',
                r'\bsel\("([A-Za-z0-9_]+)"\)', r'\bv\("([A-Za-z0-9_]+)"\)',
                r'\bn\("([A-Za-z0-9_]+)"', r'\boptionValue\("([A-Za-z0-9_]+)"'):
        used |= set(re.findall(pat, js))

    missing = sorted(x for x in used if x not in ids)
    if missing:
        print("!! index.html 里缺少这些控件 id（app.js 用了但页面上没有）：")
        for m in missing:
            print("     " + m)
        return 1
    print("[OK] 控件 id 交叉核对通过（引用 %d 个 / 页面定义 %d 个）" % (len(used), len(ids)))
    return 0


def build():
    """拼宿主脚本 + 复制前端 → CEP/dist/LyricSubtitleTool/"""
    if not os.path.isdir(CLIENT_SRC):
        print("找不到前端目录：%s" % CLIENT_SRC)
        return 1

    parts = []
    for name in ORDER:
        p = os.path.join(AE_SRC, name)
        if not os.path.exists(p):
            print("!! 缺少模块：%s" % name)
            return 1
        parts.append("/* " + "=" * 70 + "\n * 模块：%s\n * " % name + "=" * 70 + " */\n" + read(p).rstrip("\n"))

    bridge_path = os.path.join(HOST_SRC, "09_bridge.jsx")
    if not os.path.exists(bridge_path):
        print("!! 缺少桥接模块：%s" % bridge_path)
        return 1
    bridge = read(bridge_path).rstrip("\n")
    parts.append("/* " + "=" * 70 + "\n * 模块：CEP/host/09_bridge.jsx\n * " + "=" * 70 + " */\n" + bridge)

    merged = "\n\n".join(parts) + "\n"

    stamp = datetime.datetime.now().strftime("%m-%d %H:%M")
    placeholder = 'BR.build = "dev";'
    if placeholder not in merged:
        print("!! 找不到构建号占位符 %s" % placeholder)
        return 5
    merged = merged.replace(placeholder, 'BR.build = "%s";' % stamp)
    print("[OK] CEP 构建号：%s" % stamp)

    if check_es3(merged, "CEP/host/index.jsx"):
        print("!! ES3 兼容检查未通过")
        return 2
    if syntax_check(merged, "CEP/host/index.jsx"):
        return 3

    # --- 产物目录 ---
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(os.path.join(DIST, "host"))
    os.makedirs(os.path.join(DIST, "client"))
    os.makedirs(os.path.join(DIST, "CSXS"))

    # 宿主不再拼成单文件：按模块拆成独立 .jsx，由 bootstrap 用 $.evalFile 逐个加载，
    # 这样每个编译单元都远小于 ExtendScript 的大小上限（约 107KB）。
    # 1) 逻辑模块写进 host/ —— 每个都必须单独带 UTF-8 BOM！
    #    拆成独立文件后，单文件顶部那个 BOM 不再覆盖它们；模块里有中文，没有 BOM 时
    #    ExtendScript 会按系统 GBK 解码 → 中文乱码 / 字符串吞引号报语法错。
    #    读用 utf-8-sig（顺手吃掉可能已存在的 BOM），写也用 utf-8-sig（保证恰好一个 BOM）。
    for name in ORDER:
        with open(os.path.join(AE_SRC, name), "r", encoding="utf-8-sig") as f:
            mod_code = f.read()
        with open(os.path.join(DIST, "host", name), "w", encoding="utf-8-sig", newline="\n") as f:
            f.write(mod_code)
    # 2) 桥接层：盖上构建号后复制
    bridge_code = read(bridge_path).rstrip("\n").replace(placeholder, 'BR.build = "%s";' % stamp)
    with open(os.path.join(DIST, "host", "09_bridge.jsx"), "w", encoding="utf-8-sig", newline="\n") as f:
        f.write(bridge_code)
    # 3) 入口 bootstrap（$.evalFile 逐个加载上面的模块）
    with open(BOOTSTRAP_TEMPLATE, "r", encoding="utf-8-sig") as f:
        bootstrap_code = f.read()
    with open(os.path.join(DIST, "host", "index.jsx"), "w", encoding="utf-8-sig", newline="\n") as f:
        f.write(bootstrap_code)
    print("[OK] host/ 已拆分：bootstrap(index.jsx) + %d 个模块文件（均 < 107KB）" % (len(ORDER) + 1))

    # 前端也要查语法：面板是 Chromium 跑的，app.js 里一个多余的大括号
    # 会让**整个 IIFE 不执行**，表现是「面板出得来，但所有按钮点了没反应」——
    # 而且控制台之外看不出任何症状。所以这一步必须拦在复制之前。
    for name in ("app.js", "CSInterface.js"):
        with open(os.path.join(CLIENT_SRC, name), "r", encoding="utf-8") as f:
            if syntax_check(f.read(), "CEP/client/" + name):
                return 3
    if check_ids():
        return 3

    for name in CLIENT_FILES:
        src = os.path.join(CLIENT_SRC, name)
        if not os.path.exists(src):
            print("!! 缺少前端文件：%s" % name)
            return 1
        shutil.copy2(src, os.path.join(DIST, "client", name))
    print("[OK] client/ %d 个文件已复制" % len(CLIENT_FILES))

    ver = read_version()
    with open(os.path.join(DIST, "CSXS", "manifest.xml"), "w", encoding="utf-8", newline="\n") as f:
        f.write(MANIFEST.format(bundle=BUNDLE_ID, ext=EXT_ID, ver=ver,
                                name=BUNDLE_NAME, csxs="[11.0,99.0]"))
    with open(os.path.join(DIST, ".debug"), "w", encoding="utf-8", newline="\n") as f:
        f.write(DEBUG_FILE.format(ext=EXT_ID))
    print("[OK] CSXS/manifest.xml（v%s）+ .debug 已生成" % ver)

    # XML 写坏了 CEP 是**静默拒绝**的：扩展菜单里根本不出现，一句报错都没有，
    # 只能去 %TEMP% 下的 CEP 日志里翻。用真解析器过一遍再往下走。
    # （实现放在 build_AEJSX.py 里，PR 版 build_PRCEP.py 共用同一份。）
    try:
        import build_AEJSX as xbmod
        if xbmod.check_xml([os.path.join(DIST, "CSXS", "manifest.xml"),
                            os.path.join(DIST, ".debug")]):
            print("!! XML 校验未通过，先别装进 AE")
            return 8
    except ImportError:
        print("[跳过] 没找到 build_AEJSX.py，跳过 XML 校验")

    # 最后校验**真正写出去的每个编译单元**（bootstrap + 每个模块）。
    # 以前只检查内存里拼出来的 merged 字符串，产出文件本身从没查过 ——
    # 结果「模块缺 BOM」「bootstrap 第 1 行是指令」这类问题都是用户先撞上的。
    try:
        import build_AEJSX as bmod
        host_dir = os.path.join(DIST, "host")
        units = [os.path.join(host_dir, n) for n in sorted(os.listdir(host_dir))
                 if n.endswith(".jsx")]
        print("\n[校验] 逐个编译单元（BOM / 第 1 行 / 107KB 上限 / 语法）：")
        if bmod.verify_units(units, "CEP/host"):
            print("!! 产出文件有问题，先别装进 AE")
            return 7
    except ImportError:
        print("[跳过] 没找到 build_AEJSX.py，跳过产出校验")

    print("\n产物：%s" % DIST)
    return 0


def install(do_reg=True):
    rc = build()
    if rc != 0:
        return rc

    ext_root = cep_extensions_dir()
    if not ext_root:
        print("!! 找不到 CEP 扩展目录，不知道该装到哪")
        return 4
    target = os.path.join(ext_root, DIST_NAME)
    if os.path.isdir(target):
        shutil.rmtree(target)
    os.makedirs(ext_root, exist_ok=True)
    shutil.copytree(DIST, target)
    print("[OK] 已安装到 %s" % target)

    # 改名前的旧目录留着的话，AE 的「扩展」菜单里会新旧两个面板并存，
    # 用户点错的那个还是老代码 —— 比不装更糟。这里一并清掉。
    for old in LEGACY_DIR_NAMES:
        stale = os.path.join(ext_root, old)
        if os.path.isdir(stale):
            try:
                shutil.rmtree(stale)
                print("[OK] 已清掉旧名字的扩展目录：%s" % old)
            except Exception as e:
                print("[提醒] 旧目录 %s 删不掉（%s），请手动删除" % (stale, e))

    if do_reg:
        set_reg()
    else:
        print("[跳过] 未改注册表")
    return 0


def set_reg():
    """开 PlayerDebugMode：否则 AE 只加载签名过的扩展，自己写的面板根本不出现。

    Windows 写注册表，macOS 写 plist（defaults write），细节在 _platform.py。
    """
    return 0 if enable_cep_debug() else 1


if __name__ == "__main__":
    args = [a for a in sys.argv[1:]]
    try:
        if args and args[0] == "install":
            sys.exit(install(do_reg=("--no-reg" not in args)))
        else:
            sys.exit(build())
    finally:
        clean_syntax_tmp()
