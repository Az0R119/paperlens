#!/usr/bin/env python3
"""paperlens 桌面版的本地工具接口 —— 网页里点按钮，Python 这里干活。

★ 为什么要有这一层
  浏览器/WebView 干不了的活：读整个文件夹、调用本机 OCR、写文件到任意位置。
  这些能力网页版永远做不了，也是 exe 真正的价值。

★ 和网页怎么通信
  pywebview 的 JS API：页面里 window.pywebview.api.xxx(...)
  返回 Promise，结果直接回给 JS。不需要 HTTP、不需要端口。

★ 原则
  · 每个方法都必须能"失败得很清楚"：返回 {'ok': False, 'error': '人话'}
  · 不做静默降级 —— 没装 OCR 就明说没装
"""
import os
import sys
import traceback

BASE = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))


def _ok(**kw):
    d = {'ok': True}
    d.update(kw)
    return d


def _err(msg, **kw):
    d = {'ok': False, 'error': str(msg)}
    d.update(kw)
    return d


class Api:
    """暴露给网页的所有本地能力。方法名会在 JS 里变成 pywebview.api.<name>。"""

    # ---------- 一键装 Ollama ----------
    def install_ollama(self, model='qwen2.5:3b'):
        """装 Ollama + 拉模型。桌面版有 Python，能真装东西。

        ★ 为什么要这个
          翻译板块原来让用户「双击 install-model.bat」，但 exe 里没那个文件
          （只打包了网页）。用户找一圈找不到就放弃了。
        ★ 步骤
          ① 检测是否已装 → 已装就跳过下载
          ② 下载官方安装包（OllamaSetup.exe）
          ③ 静默安装（/S）
          ④ 拉起服务并 pull 模型
          每一步都返回进度，前端可以显示到哪一步了。
        """
        import os
        import subprocess
        import tempfile
        import urllib.request

        log = []

        def done(msg, **kw):
            d = {'ok': True, 'log': '\n'.join(log), 'step': msg}
            d.update(kw)
            return d

        try:
            # ① 已装？
            exe = os.path.join(os.environ.get('LOCALAPPDATA', ''),
                               'Programs', 'Ollama', 'ollama.exe')
            if not os.path.isfile(exe):
                log.append('[1/3] 没检测到 Ollama，开始下载安装包…')
                url = 'https://ollama.com/download/OllamaSetup.exe'
                tmp = os.path.join(tempfile.gettempdir(), 'OllamaSetup.exe')
                urllib.request.urlretrieve(url, tmp)
                size_mb = os.path.getsize(tmp) / 1048576
                log.append('      下载完成 %.0f MB' % size_mb)

                log.append('[2/3] 静默安装（约 1-3 分钟，别关窗口）…')
                # /S = 静默；Ollama 的安装器是 Inno Setup
                r = subprocess.run([tmp, '/S'], capture_output=True, timeout=600)
                log.append('      安装器退出码 %d' % r.returncode)
                # 安装完通常就在这个路径
                if not os.path.isfile(exe):
                    log.append('      ⚠ 安装后仍找不到 ollama.exe，重启程序后再试')
                    return done('安装完成但没找到可执行文件',
                                need_restart=True)
            else:
                log.append('[1/2] Ollama 已装好，跳过下载')

            # ③ 拉模型
            log.append('[3/3] 下载模型 %s（约 1.9 GB，看网速）…' % model)
            r = subprocess.run([exe, 'pull', model],
                               capture_output=True, timeout=3600)
            tail = (r.stdout or b'')[-400:].decode('utf-8', 'ignore')
            log.append('      pull 退出码 %d' % r.returncode)
            if tail.strip():
                log.append('      ' + tail.strip().replace('\n', ' | ')[:300])

            if r.returncode != 0:
                return done('模型没拉下来', failed=True)

            log.append('✓ 全部完成，刷新页面就能用翻译了')
            return done('done', need_refresh=True)

        except Exception as e:
            log.append('✗ 出错：%s' % e)
            return {'ok': False, 'error': str(e), 'log': '\n'.join(log)}

    # ---------- 环境探测 ----------
    def env(self):
        """报告本机有什么能力 —— 网页据此决定显示/隐藏按钮，不猜。"""
        info = {
            'desktop': True,
            'has_ocr': False,
            'has_pymupdf': False,
            'has_ollama': False,
            'ollama_models': [],
            'python': sys.version.split()[0],
        }
        try:
            import pymupdf  # noqa: F401
            info['has_pymupdf'] = True
        except Exception:
            pass
        try:
            from paperlens_ocr import ocr_pdf  # noqa: F401
            info['has_ocr'] = True
        except Exception:
            pass
        try:
            import json
            import urllib.request
            with urllib.request.urlopen(
                    'http://127.0.0.1:11434/api/tags', timeout=3) as r:
                d = json.load(r)
                info['has_ollama'] = True
                info['ollama_models'] = [m['name'] for m in d.get('models', [])]
        except Exception:
            pass
        return _ok(**info)

    # ---------- 单文件：抽文字 ----------
    def extract_text(self, path, max_pages=12):
        """把一份 PDF 的全部文字抽出来。返回 text。"""
        try:
            if not path or not os.path.isfile(path):
                return _err('文件不存在：%s' % path)
            from pdf2txt import extract
            text, info = extract(path, max_pages=int(max_pages), verbose=False)
            return _ok(text=text, chars=len(text),
                       method=info.get('method'), pages=info.get('pages'))
        except Exception as e:
            return _err('抽取失败：%s' % e, trace=traceback.format_exc()[-800:])

    # ---------- 单文件：存成 txt ----------
    def save_text(self, text, suggested_name='output.txt'):
        """弹保存框，把文字写到用户选的位置。"""
        try:
            import webview
            win = webview.windows[0] if webview.windows else None
            if win is None:
                return _err('窗口不可用')
            target = win.create_file_dialog(
                webview.SAVE_DIALOG, save_filename=suggested_name,
                file_types=('文本文件 (*.txt)', '所有文件 (*.*)'))
            if not target:
                return _err('用户取消')
            p = target if isinstance(target, str) else target[0]
            with open(p, 'w', encoding='utf-8') as f:
                f.write(text or '')
            return _ok(path=p, chars=len(text or ''))
        except Exception as e:
            return _err('保存失败：%s' % e)

    # ---------- 批量：整个文件夹 ----------
    def batch_extract(self, folder, out_dir=None, max_pages=12):
        """把一个文件夹里的所有 PDF 转成 txt（视频/图片忽略）。"""
        try:
            if not folder or not os.path.isdir(folder):
                return _err('文件夹不存在：%s' % folder)
            pdfs = [f for f in sorted(os.listdir(folder))
                    if f.lower().endswith('.pdf')]
            if not pdfs:
                return _err('这个文件夹里没有 PDF')
            from pdf2txt import extract
            out_dir = out_dir or folder
            done, failed = [], []
            for name in pdfs:
                src = os.path.join(folder, name)
                try:
                    text, info = extract(src, max_pages=int(max_pages), verbose=False)
                    dst = os.path.join(out_dir, os.path.splitext(name)[0] + '.txt')
                    with open(dst, 'w', encoding='utf-8') as f:
                        f.write(text)
                    done.append({'name': name, 'chars': len(text),
                                 'method': info.get('method')})
                except Exception as e:
                    failed.append({'name': name, 'error': str(e)[:200]})
            return _ok(total=len(pdfs), done=done, failed=failed, out_dir=out_dir)
        except Exception as e:
            return _err('批量处理失败：%s' % e)

    # ---------- 选文件 / 选文件夹（HTML 里也能选，但拿到的是浏览器沙箱路径）----------
    def pick_pdf(self):
        """弹选择框选 PDF，返回真实路径（网页做不到这个）。"""
        try:
            import webview
            win = webview.windows[0] if webview.windows else None
            if win is None:
                return _err('窗口不可用')
            r = win.create_file_dialog(
                webview.OPEN_DIALOG, allow_multiple=False,
                file_types=('PDF 文件 (*.pdf)', '所有文件 (*.*)'))
            if not r:
                return _err('用户取消')
            p = r if isinstance(r, str) else r[0]
            return _ok(path=p, name=os.path.basename(p),
                       size=os.path.getsize(p))
        except Exception as e:
            return _err('选择失败：%s' % e)

    def pick_folder(self):
        """弹选择框选文件夹（批量处理用）。"""
        try:
            import webview
            win = webview.windows[0] if webview.windows else None
            if win is None:
                return _err('窗口不可用')
            r = win.create_file_dialog(webview.FOLDER_DIALOG)
            if not r:
                return _err('用户取消')
            p = r if isinstance(r, str) else r[0]
            n = len([f for f in os.listdir(p) if f.lower().endswith('.pdf')])
            return _ok(path=p, pdf_count=n)
        except Exception as e:
            return _err('选择失败：%s' % e)
