#!/usr/bin/env python3
"""paperlens 桌面版 —— 双击打开一个窗口，里面就是网页版看板。

★ 为什么有这个
  之前那个 exe（把PDF转成文字）是命令行工具，双击会弹出黑框 ——
  因为它本来就是「拖个 PDF 进去、吐出一堆文字」的工具，不是看板。
  用户要的是「跟网页一样」，所以这里用 WebView2 起一个真窗口。

★ 怎么做的（最省事的路）
  ① 用 Python 标准库 http.server 在 127.0.0.1 起个静态服务
     —— 必须走 http，不能 file://（file:// 下 Ollama 会被 CORS 拒）
  ② pywebview 用系统自带的 WebView2 显示它
  ③ 关窗口时把服务停掉，不留后台进程

★ 不做什么
  · 不做菜单栏、不做托盘 —— 打开就是看板，关掉就没了
  · 不打包 exe（打包在 build_gui.spec）
"""
import os
import socket
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

APP_NAME = 'paperlens'


def _pick_port(start=8765):
    """找一个空闲端口。被占就往上试，最多试 40 个。"""
    for p in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(('127.0.0.1', p))
                return p
            except OSError:
                continue
    return 0


def _serve(root, port):
    """在后台线程里起静态服务 + Ollama 代理。只绑 127.0.0.1，外部访问不到。

    ★ 为什么要代理 Ollama（这是 exe 比网页版强的地方）
      网页版直接 fetch('http://127.0.0.1:11434')。这在两种情况下被浏览器拦：
        · file:// 打开  → Origin=null，Ollama 直接 403
        · https:// 打开 → 混合内容，浏览器拦
      但在 WebView 壳里，页面来源是 http://127.0.0.1:<port>，
      而 Ollama 也是 http，同源策略上没问题 —— 但为了彻底保险
      （也为了以后换成 https 域名的情况），这里做一个同源代理：
        页面请求 /ollama/*  →  本服务转发到 127.0.0.1:11434/*
      页面就不需要知道 Ollama 在哪，也不会触发任何跨源检查。
    """
    import json as _json
    import urllib.request as _req
    import urllib.error as _uerr

    OLLAMA = 'http://127.0.0.1:11434'

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def log_message(self, *a):
            pass          # 别往控制台刷日志

        def _proxy(self, method):
            """把 /ollama/xxx 转发到 Ollama 的 /api/xxx 等。"""
            path = self.path[len('/ollama'):]           # 保留前导 /
            url = OLLAMA + path
            body = None
            if method == 'POST':
                n = int(self.headers.get('Content-Length') or 0)
                body = self.rfile.read(n) if n else b''
            req = _req.Request(url, data=body, method=method,
                               headers={'Content-Type': 'application/json'})
            try:
                with _req.urlopen(req, timeout=180) as r:
                    data = r.read()
                    self.send_response(200)
                    self.send_header('Content-Type',
                                     r.headers.get('Content-Type', 'application/json'))
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
            except _uerr.HTTPError as e:
                data = e.read()
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                msg = _json.dumps({'error': 'proxy: %s' % e}).encode()
                self.send_response(502)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)

        # ★ 云端翻译代理
        #   为什么必须有这一层（实测结论）：
        #     腾讯云 / 百度 / DeepL 的 API 全都不返回 Access-Control-Allow-Origin，
        #     浏览器里直接用 fetch 一律 "Failed to fetch"（CORS 预检过不去）。
        #     只有本机后端能绕过同源限制，所以桌面版的翻译走这里。
        #   设计：前端只发 {provider, text[], from, to, creds}，
        #         后端按各家协议签名并请求，前端拿回纯译文。
        #         好处是 key 不必放进 URL、签名不必在 JS 里算（省掉手写 MD5 的风险）。
        def _translate(self):
            try:
                n = int(self.headers.get('Content-Length') or 0)
                req_data = _json.loads(self.rfile.read(n) or b'{}')
            except Exception as e:
                return self._json_out(400, {'error': '请求体不是合法 JSON：%s' % e})

            provider = (req_data.get('provider') or '').strip()
            texts = req_data.get('texts') or []
            src = req_data.get('from') or 'en'
            dst = req_data.get('to') or 'zh'
            creds = req_data.get('creds') or {}

            if not isinstance(texts, list) or not texts:
                return self._json_out(400, {'error': 'texts 是空数组'})
            if len(texts) > 200:
                return self._json_out(400, {'error': '一次最多 200 句'})

            try:
                from translate_providers import translate
                out = translate(provider, texts, src, dst, creds)
                return self._json_out(200, {'texts': out, 'provider': provider})
            except Exception as e:
                # ★ 失败必须带原因回去，不能返回空数组让前端猜
                return self._json_out(200, {'texts': [], 'provider': provider,
                                            'error': str(e)})

        def _json_out(self, code, obj):
            data = _json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.startswith('/ollama/'):
                return self._proxy('GET')
            return super().do_GET()

        def do_POST(self):
            if self.path.startswith('/ollama/'):
                return self._proxy('POST')
            if self.path.startswith('/translate'):
                return self._translate()
            self.send_error(404)

    httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def main():
    # 资源目录：打包后是 _MEIPASS，开发时是脚本旁边
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    site = os.path.join(base, 'site')
    if not os.path.isdir(site):
        site = os.path.join(base, 'dist-部署')
    if not os.path.isdir(site):
        site = os.path.join(base, 'dist-site')
    if not os.path.isdir(site):
        # 兜底：直接找 index.html
        for cand in ('.', '..'):
            p = os.path.abspath(os.path.join(base, cand))
            if os.path.exists(os.path.join(p, 'index.html')):
                site = p
                break

    index = os.path.join(site, 'index.html')
    if not os.path.exists(index):
        print('找不到 index.html，资源目录：%s' % site)
        input('按回车关闭…')
        return 1

    port = _pick_port(8765)
    if not port:
        print('没有空闲端口可用了')
        input('按回车关闭…')
        return 1

    httpd = _serve(site, port)
    url = 'http://127.0.0.1:%d/index.html' % port

    # 等服务真的能访问再开窗口，避免白屏
    for _ in range(50):
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.3):
                break
        except OSError:
            time.sleep(0.1)

    import webview
    # ★ 把本地能力挂上去：页面里用 window.pywebview.api.xxx() 调
    from paperlens_api import Api
    win = webview.create_window(
        APP_NAME,
        url,
        js_api=Api(),
        width=1280, height=900,
        min_size=(900, 600),
        text_select=True,          # 允许选文字（看板要能复制）
        confirm_close=False,
    )

    # ★ 注入桌面版标记 —— 让 local_ai.js 知道该走 /ollama 代理而不是直连 11434。
    #   用 pywebview 的 evaluate_js 在页面加载后执行；加个重试，
    #   因为窗口创建和页面 DOM 就绪之间有时序差。
    DESKTOP_FLAG = 'window.__PL_DESKTOP = true;'

    def _inject():
        for _ in range(60):        # 最多等 30 秒
            try:
                win.evaluate_js(DESKTOP_FLAG)
                return
            except Exception:
                time.sleep(0.5)

    threading.Thread(target=_inject, daemon=True).start()

    try:
        webview.start()            # 阻塞，直到窗口关闭
    finally:
        httpd.shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())
