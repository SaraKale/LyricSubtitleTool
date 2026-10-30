# -*- coding: utf-8 -*-
"""
把 Premiere Pro 版 CEP 扩展（HTML 面板 + 宿主脚本）组装好并安装到 PR。

跟 build_AECEP.py（AE 版）的关系：
  · **逻辑层完全共用** —— AE_JSX/src 里的 00/01/02/02b~02e/03/03b/06 原样搬过去，
    一行不改（歌词解析、编码识别、在线搜索、i18n 全在那边）。
  · AE 专属的 04_layers / 05_style / 08_preset **不带**：
    那是「合成 / 图层 / .ffx 预设」，PR 里没有对应概念。
  · 换成 PR 专属的三个模块（PR_CEP/host/）：
        10_pr_seq.jsx      序列 / 轨道 / ticks 时间换算 / API 能力探测
        11_pr_caption.jsx  生成 SRT → 导入 → Sequence.createCaptionTrack（字幕轨通道）
        12_pr_graphics.jsx 母版复制 + MGT 参数注入（图形剪辑通道，＝批量造文字图层）
  · 桥接层是 PR 版自己的 PR_CEP/host/09_bridge.jsx（动作名和 AE 版不一样）。

用法：
  python _tools/build_PRCEP.py            # 只构建到 PR_CEP/dist/
  python _tools/build_PRCEP.py install    # 构建 + 装进 CEP 扩展目录（Windows 是 %APPDATA%，macOS 是 ~/Library）
  python _tools/build_PRCEP.py install --no-reg   # 装但不改注册表
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

# 共用的逻辑层（跟 AE 版同一份源码）
SHARED_SRC = os.path.join(ROOT, "AE_JSX", "src")
# PR 专属的宿主模块
PR_DIR = os.path.join(ROOT, "PR_CEP")
PR_HOST_SRC = os.path.join(PR_DIR, "host")
CLIENT_SRC = os.path.join(PR_DIR, "client")

DIST_NAME = "LyricSubtitleTool_PR"
# 菜单名固定英文，不跟面板语言切换 —— 原因见 build_AECEP.py 里 BUNDLE_NAME 上面那段注释
# （宿主启动时读 manifest，那时面板代码还没跑）。PR 版加 PR 后缀和 AE 版区分开。
BUNDLE_NAME = "LyricSubtitleTool PR"
LEGACY_DIR_NAMES = []

DIST = os.path.join(PR_DIR, "dist", DIST_NAME)

# 共享逻辑模块（顺序有讲究，见下）
SHARED_ORDER = [
    "00_header.jsx",
    "01_json.jsx",
    "02_util.jsx",
    # 02b 是查表核心（SB.M / SB.T / setLang），必须排在所有调用 SB.M() 的模块前面，
    # 否则桥接层一跑就是「SB.M is not a function」。
    # 02c/02d/02e 是三张语言表，各 60KB 上下：必须**各自成文件**，
    # 四张表塞进 02b 会有 ~180KB，顶穿 ExtendScript 单编译单元 ~107KB 的上限，
    # 表现是「语法错误」且报错行号指到别处（详见 MEMORY.md）。
    "02b_i18n.jsx",
    "02c_i18n_en_a.jsx",
    "02c_i18n_en_b.jsx",
    "02d_i18n_zht_a.jsx",
    "02d_i18n_zht_b.jsx",
    "02e_i18n_ja_a.jsx",
    "02e_i18n_ja_b.jsx",
    "03_lrc.jsx",
    "03b_sub.jsx",   # SRT / ASS(SSA) / WebVTT 解析，被 03_lrc 的 parseAuto 调用
    "06_online.jsx",  # 在线歌词（网易云 / QQ 音乐）
]

# PR 专属宿主模块
PR_ORDER = [
    "10_pr_seq.jsx",
    "11_pr_caption.jsx",
    "12_pr_graphics.jsx",
]

# 桥接层最后加载（它引用上面所有模块）
BRIDGE = "09_bridge.jsx"

# bootstrap 里的加载顺序必须跟这个一致 —— app.js 的 HOST_MODULES 也是。
ORDER = SHARED_ORDER + PR_ORDER + [BRIDGE]

EXT_ID = "com.sarakale.lyricsubtitle.pr.panel"
BUNDLE_ID = "com.sarakale.lyricsubtitle.pr"

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
      <!-- PPRO = Premiere Pro。15.0 = 2019，往上全兼容；
           但字幕轨 API（createCaptionTrack）是 2021(15.x) 才有的，
           老版本里插件会自动降级到「图形剪辑」和「导出 SRT」两条路。 -->
      <Host Name="PPRO" Version="[15.0,99.9]"/>
    </HostList>
    <LocaleList>
      <Locale Code="All"/>
    </LocaleList>
    <RequiredRuntimeList>
      <RequiredRuntime Name="CSXS" Version="[11.0,99.0]"/>
    </RequiredRuntimeList>
  </ExecutionEnvironment>
  <DispatchInfoList>
    <Extension Id="{ext}">
      <DispatchInfo>
        <Resources>
          <MainPath>./client/index.html</MainPath>
          <ScriptPath>./host/index.jsx</ScriptPath>
          <!-- 为什么必须开 Node（参数名见下面两行 Parameter）：
               ① PR 的 ExtendScript 没有 system 对象（那是 AE 独有的），
                  所以 AE 版靠 system.callSystem 调 curl 取歌词那条路在 PR 里
                  一调用就报「ReferenceError: system is undefined」；
               ② ExtendScript 自己也做不了 HTTPS（Socket 只有裸 TCP，没有 TLS）；
               ③ 那让面板的 Chromium 去取？CEP 11 起严格执行 CORS，
                  而网易云 / QQ 音乐的接口都不返回 Access-Control-Allow-Origin，
                  普通 fetch/XHR 会被直接拦掉（CEP 11 Cookbook 的
                  「Migration from CEP 10 to CEP 11 / CORS checks」一节明确写了）；
               ④ CEP 默认关闭 Node.js API（自 CEP 6.1 起），必须在这里显式打开。

               于是：面板侧用 Node 的 https 模块发请求（Node 不受 CORS 约束），
               取到内容再喂回宿主缓存。第二个参数是必需的：没有它，
               require 只在另一个 JS 上下文里存在，页面里拿不到。

               ⚠ 本注释里绝对不能出现两个连续的减号 —— XML 规定注释内容
               不得包含它，一旦写了整个 manifest 就是非法 XML，
               CEP 直接解析失败，表现是「PR 的扩展菜单里根本没有这个插件」，
               而且没有任何报错。build_PRCEP.py 的 check_xml() 会兜住这个坑。 -->
          <CEFCommandLine>
            <Parameter>--enable-nodejs</Parameter>
            <Parameter>--mixed-context</Parameter>
          </CEFCommandLine>
        </Resources>
        <Lifecycle>
          <AutoVisible>true</AutoVisible>
        </Lifecycle>
        <UI>
          <Type>Panel</Type>
          <Menu>{name}</Menu>
          <Geometry>
            <Size>
              <Width>460</Width>
              <Height>700</Height>
            </Size>
            <MinSize>
              <Width>340</Width>
              <Height>280</Height>
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

# 端口跟 AE 版错开（AE 用 8088），两个宿主同时开也能各调各的
DEBUG_FILE = """<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="{ext}">
    <HostList>
      <!-- 有这个文件就能用 Chrome DevTools 连 http://localhost:8090 调试面板 -->
      <Host Name="PPRO" Port="8090"/>
    </HostList>
  </Extension>
</ExtensionList>
"""

BOOTSTRAP_TEMPLATE = os.path.join(PR_DIR, "_bootstrap.jsx")

CLIENT_FILES = ["index.html", "style.css", "net.js", "app.js",
                "i18n_en.js", "i18n_zht.js", "i18n_ja.js", "CSInterface.js"]

# dist 里**只放扩展本身**：client/ CSXS/ host/ .debug，别的都不放。
# 说明文档（README_*.html + image/）和 Add Keys.reg 归发版目录管，
# 由 _tools/package_release.py 组装到 release/LyricSubtitleTool_v<版本>/ 根目录。


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def read_version():
    """版本号从 AE_JSX/src/00_header.jsx 里读 —— 那边是唯一来源（两边共用）。"""
    m = re.search(r'SB\.VERSION\s*=\s*"([^"]+)"',
                  read(os.path.join(SHARED_SRC, "00_header.jsx")))
    return m.group(1) if m else "0.0.0"


def src_of(name):
    """模块文件的来源目录：共享的看 AE_JSX/src，PR 专属的看 PR_CEP/host。"""
    if name in SHARED_ORDER:
        return os.path.join(SHARED_SRC, name)
    return os.path.join(PR_HOST_SRC, name)


def check_es3(code, label):
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


SYNTAX_TMP = os.path.join(ROOT, "_tools", "_pr_syntax.js")


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

    漏一个就会出大事：$("xxx") 返回 null，紧接着给它赋 onclick 直接抛 TypeError，
    而 bind() 是自上而下执行的 —— 抛在哪一行，那一行**之后**的所有按钮就全没绑上。
    症状是「面板能用，一半按钮点不动」，而且没有任何报错提示。
    """
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


def check_order():
    """bootstrap / app.js / 构建脚本三处的模块清单必须一致。

    这是本类项目最容易静默出错的地方：清单少写一个模块，表现是
    「面板起来了，但某个功能点了没反应」，没有任何报错。
    """
    boot = read(BOOTSTRAP_TEMPLATE)
    m = re.search(r"var MODS = \[(.*?)\];", boot, re.S)
    if not m:
        print("!! 在 _bootstrap.jsx 里找不到 MODS 列表")
        return 1
    boot_mods = re.findall(r'"([^"]+\.jsx)"', m.group(1))

    app = read(os.path.join(CLIENT_SRC, "app.js"))
    m2 = re.search(r"var HOST_MODULES = \[(.*?)\];", app, re.S)
    if not m2:
        print("!! 在 app.js 里找不到 HOST_MODULES 列表")
        return 1
    app_mods = re.findall(r'"([^"]+\.jsx)"', m2.group(1))

    bad = 0
    if boot_mods != ORDER:
        print("!! _bootstrap.jsx 的 MODS 跟构建脚本的 ORDER 不一致：")
        print("     bootstrap: %s" % ", ".join(boot_mods))
        print("     ORDER    : %s" % ", ".join(ORDER))
        bad = 1
    if app_mods != ORDER:
        print("!! app.js 的 HOST_MODULES 跟构建脚本的 ORDER 不一致：")
        print("     app.js   : %s" % ", ".join(app_mods))
        print("     ORDER    : %s" % ", ".join(ORDER))
        bad = 1
    if not bad:
        print("[OK] 三处模块清单一致（%d 个模块）" % len(ORDER))
    return bad


def build():
    if not os.path.isdir(CLIENT_SRC):
        print("找不到前端目录：%s" % CLIENT_SRC)
        return 1

    missing = []
    for name in ORDER:
        p = src_of(name)
        if not os.path.exists(p):
            missing.append("%s  ←  %s" % (name, p))
    if missing:
        print("!! 缺少模块：")
        for x in missing:
            print("     " + x)
        return 1

    # 拼一份内存副本，只为了跑 ES3 / 语法检查（产物是按模块拆开的）
    parts = []
    for name in ORDER:
        parts.append("/* " + "=" * 70 + "\n * 模块：%s\n * " % name + "=" * 70 + "\n" +
                     read(src_of(name)).rstrip("\n"))
    merged = "\n\n".join(parts) + "\n"

    stamp = datetime.datetime.now().strftime("%m-%d %H:%M")
    placeholder = 'BR.build = "dev";'
    if placeholder not in merged:
        print("!! 找不到构建号占位符 %s" % placeholder)
        return 5
    merged = merged.replace(placeholder, 'BR.build = "%s";' % stamp)
    print("[OK] PR 构建号：%s" % stamp)

    if check_es3(merged, "PR_CEP/host/index.jsx"):
        print("!! ES3 兼容检查未通过")
        return 2
    if syntax_check(merged, "PR_CEP/host/index.jsx"):
        return 3
    if check_order():
        return 6

    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(os.path.join(DIST, "host"))
    os.makedirs(os.path.join(DIST, "client"))
    os.makedirs(os.path.join(DIST, "CSXS"))

    # 宿主按模块拆成独立 .jsx，由 bootstrap 用 $.evalFile 逐个加载，
    # 这样每个编译单元都远小于 ExtendScript 的大小上限（约 107KB）。
    # 每个模块都必须单独带 UTF-8 BOM：模块里有中文，没有 BOM 时 ExtendScript
    # 会按系统 GBK 解码 → 中文乱码 / 字符串吞引号报语法错。
    for name in ORDER:
        with open(src_of(name), "r", encoding="utf-8-sig") as f:
            mod_code = f.read()
        if name == BRIDGE:
            mod_code = mod_code.replace(placeholder, 'BR.build = "%s";' % stamp)
        with open(os.path.join(DIST, "host", name), "w",
                  encoding="utf-8-sig", newline="\n") as f:
            f.write(mod_code)

    with open(BOOTSTRAP_TEMPLATE, "r", encoding="utf-8-sig") as f:
        bootstrap_code = f.read()
    with open(os.path.join(DIST, "host", "index.jsx"), "w",
              encoding="utf-8-sig", newline="\n") as f:
        f.write(bootstrap_code)
    print("[OK] host/ 已拆分：bootstrap(index.jsx) + %d 个模块文件" % len(ORDER))

    # 前端也要查语法：面板是 Chromium 跑的，app.js 里一个多余的大括号
    # 会让整个 IIFE 不执行，表现是「面板出得来，但所有按钮点了没反应」。
    for name in ("app.js", "net.js", "CSInterface.js"):
        with open(os.path.join(CLIENT_SRC, name), "r", encoding="utf-8") as f:
            if syntax_check(f.read(), "PR_CEP/client/" + name):
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
    with open(os.path.join(DIST, "CSXS", "manifest.xml"), "w",
              encoding="utf-8", newline="\n") as f:
        f.write(MANIFEST.format(bundle=BUNDLE_ID, ext=EXT_ID, ver=ver, name=BUNDLE_NAME))
    with open(os.path.join(DIST, ".debug"), "w", encoding="utf-8", newline="\n") as f:
        f.write(DEBUG_FILE.format(ext=EXT_ID))
    print("[OK] CSXS/manifest.xml（v%s，Host=PPRO）+ .debug 已生成" % ver)

    # XML 写坏了 CEP 是**静默拒绝**的（扩展菜单里根本不出现，一句报错都没有，
    # 只能去 %TEMP%\CEP11-PPRO.log 里翻），所以这里必须用真解析器过一遍再往下走。
    # 实现放在 build_AEJSX.py 里，AE 版（build_AECEP.py）共用同一份。
    try:
        import build_AEJSX as bmod
        xbad = bmod.check_xml([os.path.join(DIST, "CSXS", "manifest.xml"),
                               os.path.join(DIST, ".debug")])
    except ImportError:
        print("[跳过] 没找到 build_AEJSX.py，跳过 XML 校验")
        xbad = 0
    if xbad:
        print("!! XML 校验未通过，先别装进 PR")
        return 8

    # 校验**真正写出去的每个编译单元**（BOM / 第 1 行 / 107KB 上限 / 语法）
    try:
        import build_AEJSX as bmod
        host_dir = os.path.join(DIST, "host")
        units = [os.path.join(host_dir, n) for n in sorted(os.listdir(host_dir))
                 if n.endswith(".jsx")]
        print("\n[校验] 逐个编译单元（BOM / 第 1 行 / 107KB 上限 / 语法）：")
        if bmod.verify_units(units, "PR_CEP/host"):
            print("!! 产出文件有问题，先别装进 PR")
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
    """开 PlayerDebugMode：否则 PR 只加载签名过的扩展，自己写的面板根本不出现。

    Windows 写注册表，macOS 写 plist（defaults write），细节在 _platform.py。
    """
    return 0 if enable_cep_debug() else 1


if __name__ == "__main__":
    args = sys.argv[1:]
    try:
        if args and args[0] == "install":
            sys.exit(install(do_reg=("--no-reg" not in args)))
        else:
            sys.exit(build())
    finally:
        clean_syntax_tmp()
