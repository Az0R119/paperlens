#!/usr/bin/env python3
#!/usr/bin/env python3
"""paperlens · 论文解析看板
作者：李子正（正点 / OPC）
仓库：https://github.com/Az0R119/paperlens
设计决策、实测数据与踩坑记录见 README.md 的「实测记录」章节。
"""
"""生成 Netlify 部署包 dist-site/，并给 CSS/JS 打上内容指纹。

    python build_site.py

为什么需要它：index.html 引用 p3r.css / core.js 时如果不带变化的查询串，
浏览器会一直用缓存里的旧版本 —— 改了 CSS 但页面没变，会浪费半小时查
"为什么样式不生效"（真踩过）。

指纹 = 文件内容的 md5 前 8 位：内容一变指纹就变，不用手工维护版本号。
"""
import hashlib
import os
import re
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'web')
OUT = os.path.join(ROOT, 'dist-site')
# ★ domain.js 必须跟着拷：index.html 引它做领域判定。
# ★ binary_bridge.js 也要拷（18 KB）—— 这是我们自己训的医学二元模型。
#   原来没拷，注释理由是"比赛演示的 5 篇全是 tech/unknown，没篇会走模型分支"。
#   **这个判断已经过期**：用户明确要求"医学论文就用我们自己的模型"。
#   不拷的后果不是"省 18 KB"，而是 index.html 里 PL_BINARY 永远 undefined,
#   医学论文整条模型路径实际不工作（代码写了却永远进不去）—— 已实测确认。
# local_ai.js：本地模型翻译（用户装了 Ollama 才生效，没装则显式提示）
FILES = ['index.html', 'core.js', 'p3r.css', 'domain.js',
         'binary_bridge.js', 'local_ai.js', 'ocr.js']


def main():
    os.makedirs(OUT, exist_ok=True)
    for f in FILES:
        shutil.copy2(os.path.join(SRC, f), os.path.join(OUT, f))

    stamp = {f: hashlib.md5(open(os.path.join(OUT, f), 'rb').read()).hexdigest()[:8]
             for f in ('p3r.css', 'core.js', 'domain.js',
                       'binary_bridge.js', 'local_ai.js', 'ocr.js')}

    p = os.path.join(OUT, 'index.html')
    html = open(p, encoding='utf-8').read()
    html = re.sub(r'href="p3r\.css(\?v=[0-9a-f]+)?"',
                  'href="p3r.css?v=%s"' % stamp['p3r.css'], html)
    html = re.sub(r'src="core\.js(\?v=[0-9a-f]+)?"',
                  'src="core.js?v=%s"' % stamp['core.js'], html)
    html = re.sub(r'src="domain\.js(\?v=[0-9a-f]+|\?v=\d+)?"',
                  'src="domain.js?v=%s"' % stamp['domain.js'], html)
    # ★ local_ai.js 同理打指纹。踩过的坑：只在 index.html 里加了 <script src="local_ai.js?v=1">，
    #   但 build_site.py 不处理它 → 部署后浏览器拿到的可能是旧缓存，PL_LOCAL_AI 是 undefined，
    #   翻译板块就报"模块没加载"。
    html = re.sub(r'src="local_ai\.js(\?v=[0-9a-f]+|\?v=\d+)?"',
                  'src="local_ai.js?v=%s"' % stamp['local_ai.js'], html)
    # ★ binary_bridge.js（我们自己的医学二元模型）同样要打指纹，
    #   否则部署后可能拿旧缓存 → PL_BINARY undefined → 医学模型分支永不进入。
    html = re.sub(r'src="binary_bridge\.js(\?v=[0-9a-f]+|\?v=\d+)?"',
                  'src="binary_bridge.js?v=%s"' % stamp['binary_bridge.js'], html)
    # ★ ocr.js（扫描件 OCR）同样打指纹 —— 这个坑已经踩过三次，别再漏
    html = re.sub(r'src="ocr\.js(\?v=[0-9a-f]+|\?v=\d+)?"',
                  'src="ocr.js?v=%s"' % stamp['ocr.js'], html)
    open(p, 'w', encoding='utf-8', newline='\n').write(html)

    # netlify.toml 和 README.md 是手写的部署配置/说明，不由 web/ 复制，这里只确认它们在
    keep = [f for f in ('netlify.toml', 'README.md') if os.path.exists(os.path.join(OUT, f))]
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in FILES + keep)
    print('dist-site/ 已生成  %d 个文件  %.0f KB' % (len(FILES) + len(keep), total / 1024))
    if len(keep) < 2:
        print('  ⚠ 缺少:', [f for f in ('netlify.toml', 'README.md') if f not in keep])
    print('  p3r.css?v=%s' % stamp['p3r.css'])
    print('  core.js?v=%s' % stamp['core.js'])
    print()
    print('部署：浏览器打开 https://app.netlify.com/drop ，把整个 dist-site 文件夹拖进去')


if __name__ == '__main__':
    main()
