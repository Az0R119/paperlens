# -*- mode: python ; coding: utf-8 -*-
"""paperlens 桌面版看板 —— 单文件 exe，双击出窗口，没有黑框。

★ 这个包里有什么（相对网页版多出来的）
  · WebView2 窗口（网页内容本地打包，不联网也能开）
  · Ollama 同源代理 → 翻译在 exe 里可靠（网页版公网会混合内容被拦）
  · 本地 OCR（RapidOCR + cv2 + onnxruntime）→ 扫描件能读
  · PyMuPDF → 坐标重排、版式判定
  · pywebview js_api → 选文件/选文件夹/批量处理/保存（浏览器沙箱做不到）

★ 为什么体积回到 100+ MB
  OCR 的依赖躲不掉：cv2 82 MB（RapidOCR 用它做透视变换和轮廓检测，
  实测用了 20+ 个 cv2 函数，换不成 PIL）、onnxruntime 42 MB、numpy 24 MB。
  这是「能读扫描件」的硬成本。砍掉它们就回到 13 MB 空壳。
  取舍：宁可大，也要真的能干网页干不了的活。
"""
import os
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

ROOT = os.path.abspath(SPECPATH)  # noqa: F821

datas = []
binaries = []

# 网页资源（本地打包，离线可用）
SITE_SRC = os.path.join(ROOT, 'dist-部署')
if os.path.isdir(SITE_SRC):
    for f in os.listdir(SITE_SRC):
        p = os.path.join(SITE_SRC, f)
        if os.path.isfile(p):
            datas.append((p, 'site'))

# OCR 模型和配置
datas += collect_data_files('rapidocr_onnxruntime')

# ★ wordninja 的英文词频表（538 KB）—— 必须手动指定，自动收集抓不到
#   布局是个坑：site-packages 里是「wordninja.py 单文件」+「wordninja/ 文件夹」
#   并列，代码用 dirname(abspath(__file__)) + '/wordninja/wordninja_words.txt.gz'
#   去找。collect_data_files('wordninja') 认的是「包」，对单文件模块返回空，
#   所以第一次打包时词频表没进去（实测 exe 里搜不到 wordninja_words.txt.gz，
#   这会让人一跑 OCR 就崩）。这里直接按物理路径塞到对应位置。
_WN_WORDS = os.path.join(
    ROOT, '.buildenv', 'Lib', 'site-packages', 'wordninja', 'wordninja_words.txt.gz')
if os.path.isfile(_WN_WORDS):
    # 目标目录必须是 wordninja/，和 dirname(wordninja.py) 拼起来才等于原路径
    datas.append((_WN_WORDS, 'wordninja'))
else:
    print('!! 警告：wordninja 词频表没找到，OCR 英文空格修复会失效')
    print('   预期路径:', _WN_WORDS)
binaries += collect_dynamic_libs('onnxruntime')

# 砍掉运行不需要的重货（但保留 OCR 本体）
CHOP = ('opencv_videoio_ffmpeg', 'mupdf-devel')
datas = [(s, d) for (s, d) in datas
         if not any(n in s or n in d for n in CHOP)]
binaries = [(s, d) for (s, d) in binaries
            if not any(n in s or n in d for n in CHOP)]

a = Analysis(
    ['paperlens_gui.py'],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=[
        'webview',
        'webview.platforms.edgechromium',
        'clr_loader',
        'pythonnet',
        # 本地能力
        'paperlens_api',
        'paperlens_ocr',
        'en_segment',          # 英文空格补救（OCR 出来的英文词间空格会丢）
        'translate_providers', # 云端翻译（腾讯云/百度/DeepL 的签名与请求）
        'wordninja',           # 它自带约 500 KB 英文词频表，必须打进包
        'pdf2txt',
        'rapidocr_onnxruntime',
        'onnxruntime',
        'pymupdf',
        'numpy',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'matplotlib', 'scipy', 'pandas', 'pytest', 'IPython',
        'notebook', 'jupyter', 'torch', 'tensorflow', 'sklearn',
        # ★ cv2 不能排除 —— OCR 要用
    ],
    noarchive=False,
)

# 再兜一次底：视频解码 dll 和开发头文件别打进来
a.binaries = [b for b in a.binaries
              if not any(n in b[0] for n in CHOP)]
a.datas = [d for d in a.datas
           if not any(n in d[0] for n in CHOP)]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='paperlens',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,        # ★ 没有黑框
    icon=None,
)
