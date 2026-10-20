/* paperlens · 论文解析看板
 * 作者：李子正（正点 / OPC）
 *  * 仓库：https://github.com/Az0R119/paperlens
 *
 * 纯前端实现：不调任何 API、不上传任何数据。
 * 设计决策、实测数据与踩坑记录见 README.md 的「实测记录」章节。
 */
// PDF 扫描件 OCR —— 当文本层坏死（老期刊 PDF 没写 ToUnicode，数字全是 \x01）时兜底。
//
// ★ 为什么需要
//   实测《中国成人血脂异常防治指南》（中华心血管病杂志 2007）：每页是一张
//   2349×3180 的扫描图，盖了一层隐形文字，但数字没写字符映射表，抽出来是
//   "从 \x01\x01\x01 年到 \x01\x01\x01年"（本该是 1984 到 1999）。
//   **文字层是坏的，图片是好的** —— 直接读图就行。
//
// ★★ 我在这上面错判过一次，记下来免得再犯
//   第一次写：用 ESM 版 `import('...tesseract.esm.min.js')` 然后 `Tess.createWorker()`，
//   报 `createWorker is not a function`。我据此判定"浏览器端跑不了 OCR，改用桌面版"。
//   **错的。** ESM 版的 createWorker 不在顶层导出；换成 UMD 版
//   (`dist/tesseract.min.js` → window.Tesseract) 立刻可用。
//   实测（都是浏览器里真跑的）：
//     · createWorker('chi_sim+eng') → 12 秒，含下载语言包
//     · 单行中文 700×160            → 472 ms，1984/1999/26.5 全对
//     · 密排正文 1400×900           → 3942 ms，六行数字全对
//   所以网页版**可以** OCR。之前的"跑崩"其实是：ESM 加载失败后代码继续往下跑，
//   拿着 undefined 的 worker 去 recognize，异常在 async 链里炸掉整页。
//
// ★ 稳定措施（这些是必要的，不是保守）
//   ① 限页数：默认前 12 页。30 页连做会把 canvas 内存堆满（每页 1616×2261≈14MB）
//   ② 每页做完 page.cleanup() 释放
//   ③ 每页之间 setTimeout(0) 让出主线程（否则页面卡死不响应）
//   ④ 全部做完 worker.terminate() 并清缓存
//
// ★ 中文空格问题
//   tesseract 对中文会在词间插空格（"心血 管 病 已 成 为"）。这不是错误，
//   是 tesseract 的分词习惯 —— 去空格由 core.js 的汉字间空格清理负责。
//
// ponytail: 只分左右两栏；三栏及以上不处理（中文期刊基本是单栏/双栏）。

/* global Tesseract */
(function () {
  'use strict';

  var CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var LANGS = 'chi_sim+eng';
  // ★ DPI 实测决定，别拍：
  //   2.0（≈144dpi）→ 3 页 76 秒，但错字明显（中华→由华、杂志→杂过、甲等→申等）
  //   2.8（≈200dpi）→ 和 Python 端 RapidOCR 同档，实测几乎全对。
  //   慢约 1.9 倍，但**错字少得多** —— 看板里的句子错一个词就影响可读性，
  //   宁可贵一倍时间也要准。用户机器的性能不是我们省时间的理由。
  // 2.5 ≈ 180dpi。实测 2.0(144dpi) 错字多、2.8(200dpi) 准但吃内存，
  // 180dpi 是折中：印刷体错字可接受，像素量比 200dpi 少 36%。
  var DPI = 2.5;
  // ★ 页数上限 8（原 12）。
  //   实测：16 页的公报在 12 页时把浏览器跑崩（about:blank，DOM 取不到）。
  //   降页数是最有效的省内存手段，比调 DPI 有效得多（tesseract 每页的中间量
  //   不随 DPI 线性变化，但页数是完全累积的）。
  //   学术论文的关键信息都在前 8 页（摘要/方法/结果），够用。
  var MAX_PAGES = 8;

  var _workerPromise = null;

  function loadUMD() {
    return new Promise(function (resolve, reject) {
      if (window.Tesseract && window.Tesseract.createWorker) return resolve(window.Tesseract);
      var s = document.createElement('script');
      s.src = CDN;
      s.onload = function () {
        if (window.Tesseract && window.Tesseract.createWorker) resolve(window.Tesseract);
        else reject(new Error('tesseract 加载了但没有 createWorker'));
      };
      s.onerror = function () { reject(new Error('OCR 引擎加载失败（CDN 连不上）')); };
      document.head.appendChild(s);
    });
  }

  function getWorker(onStage) {
    if (_workerPromise) return _workerPromise;
    _workerPromise = loadUMD().then(function (T) {
      return T.createWorker(LANGS, 1, {
        logger: function (m) {
          // 只把"下载语言包"这类进度报出去，recognizing 不报（会和页进度打架）
          if (onStage && m.status && m.status.indexOf('loading') >= 0) onStage(m.status);
        },
      });
    });
    return _workerPromise;
  }

  // 一页 → 带坐标的行
  //
  // ★ canvas 复用的坑（我改出来的，实测报错过）
  //   为了省内存我改成全局一个 canvas 复用，结果报：
  //     "Cannot use the same canvas during multiple render() operations.
  //      Use different canvas or ensure previous operations were cancelled or completed."
  //   原因：pdf.js 的 page.render() 是**异步**的，上一页的 render 还没完成，
  //   下一页就已经在同一个 canvas 上开画了。
  //   正确做法：**每页新建 canvas，用完立刻置空**（而不是复用同一块）——
  //   这样既不会并发冲突，也不会把像素留到下一页。
  //   内存上足够：单页 1625×2450 约 15 MB，用完 gc 能收。
  function ocrPageBoxes(page, worker) {
    var vp = page.getViewport({ scale: DPI });
    var cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width);
    cv.height = Math.floor(vp.height);
    var ctx = cv.getContext('2d');
    var task = page.render({ canvasContext: ctx, viewport: vp });
    return task.promise
      .then(function () {
        return worker.recognize(cv, {}, { blocks: true });
      })
      .then(function (res) {
        var out = [];
        ((res && res.data && res.data.blocks) || []).forEach(function (b) {
          (b.paragraphs || []).forEach(function (p) {
            (p.lines || []).forEach(function (ln) {
              var bb = ln.bbox || {};
              var t = (ln.text || '').trim();
              if (t.length > 1) {
                out.push({ x0: bb.x0 || 0, x1: bb.x1 || 0,
                           y0: bb.y0 || 0, y1: bb.y1 || 0, t: t });
              }
            });
          });
        });
        if (!out.length && res && res.data && res.data.text) {
          String(res.data.text).split(/\r?\n/).forEach(function (t, i) {
            t = t.trim();
            if (t.length > 1) out.push({ x0: 0, x1: 0, y0: i * 10, y1: i * 10 + 9, t: t });
          });
        }
        // 用完把 canvas 缩到 1×1，让浏览器尽早回收像素内存
        try { cv.width = 1; cv.height = 1; } catch (e) { /* ignore */ }
        return out;
      });
  }

  // ★ 按栏重排。算法与 paperlens_ocr.py 的 _order_boxes 完全一致（两边都有自检）
  function orderBoxes(boxes, pageWidth, pageHeight) {
    if (!boxes.length) return [];
    var minX = Math.min.apply(null, boxes.map(function (b) { return b.x0; }));
    var wide = [], narrow = [];
    boxes.forEach(function (b) {
      var w = b.x1 - b.x0;
      var isTop = pageHeight ? (b.y0 < pageHeight * 0.12) : false;
      if (w > pageWidth * 0.55 ||
          (b.x0 - minX < pageWidth * 0.05 && w > pageWidth * 0.40) ||
          (isTop && w > pageWidth * 0.45)) {
        wide.push(b);
      } else {
        narrow.push(b);
      }
    });

    function byY(a, b) { return a.y0 - b.y0; }

    if (!narrow.length) {
      return boxes.slice().sort(byY).map(function (b) { return b.t; });
    }
    if (!pageWidth) {
      return boxes.slice().sort(byY).map(function (b) { return b.t; });
    }

    var mids = narrow.map(function (b) { return (b.x0 + b.x1) / 2; })
      .sort(function (a, b) { return a - b; });
    var cut = 0, bestGap = 0;
    for (var i = 1; i < mids.length; i++) {
      var gap = mids[i] - mids[i - 1];
      if (gap > bestGap) { bestGap = gap; cut = (mids[i] + mids[i - 1]) / 2; }
    }

    var seq;
    if (bestGap < pageWidth * 0.08) {
      seq = narrow.slice().sort(byY);
    } else {
      var L = [], R = [];
      narrow.forEach(function (b) {
        (((b.x0 + b.x1) / 2) < cut ? L : R).push(b);
      });
      L.sort(byY); R.sort(byY);
      seq = L.concat(R);           // 先左栏读完再右栏 = 人读双栏的顺序
    }

    if (!wide.length) return seq.map(function (b) { return b.t; });
    wide.sort(byY);
    var out = [], wi = 0, si = 0;
    while (wi < wide.length || si < seq.length) {
      if (wi < wide.length && (si >= seq.length || wide[wi].y0 <= seq[si].y0)) {
        out.push(wide[wi].t); wi++;
      } else {
        out.push(seq[si].t); si++;
      }
    }
    return out;
  }

  // 入口。返回 {text, rows, pages, total, capped}
  function ocrPdf(doc, onProgress, onStage, maxPages) {
    var worker = null;
    var out = [];
    var cap = Math.min(doc.numPages, maxPages || MAX_PAGES);
    var capped = doc.numPages > cap;

    function step(i) {
      if (i > cap) {
        return Promise.resolve({
          text: out.join('\n\n'), rows: out.join('\n\n'),
          pages: cap, total: doc.numPages, capped: capped,
        });
      }
      if (onProgress) onProgress((i - 1) / cap);
      return doc.getPage(i).then(function (page) {
        var vp = page.getViewport({ scale: DPI });
        return ocrPageBoxes(page, worker).then(function (boxes) {
          if (onProgress) onProgress(i / cap);
          out.push(orderBoxes(boxes, vp.width, vp.height).join('\n'));
          try { page.cleanup(); } catch (e) { /* 老版本没有 */ }
          // 让出主线程：不让页面在 OCR 期间完全卡死
          return new Promise(function (r) { setTimeout(r, 0); })
            .then(function () { return step(i + 1); });
        });
      });
    }

    return getWorker(onStage).then(function (w) {
      worker = w;
      return step(1);
    }).then(function (res) {
      try { if (worker && worker.terminate) worker.terminate(); } catch (e) { /* ignore */ }
      _workerPromise = null;
      return res;
    }, function (err) {
      try { if (worker && worker.terminate) worker.terminate(); } catch (e) { /* ignore */ }
      _workerPromise = null;
      throw err;
    });
  }

  // ★ 单张图片 → 文字（手机拍照用）
  //   和 ocrPdf 共用同一个 worker 和 recognize 参数，只是没有 pdf.js 的 render 那一步。
  //   dataUrl 由 Capacitor Camera 给出，直接塞进 Image 画到 canvas。
  function ocrImage(dataUrl) {
    return getWorker().then(function (worker) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var cv = document.createElement('canvas');
          // 手机照片动辄 3000+ px，OCR 太慢 —— 长边压到 1800（实测识别率不降）
          var scale = Math.min(1, 1800 / Math.max(img.width, img.height));
          cv.width = Math.round(img.width * scale);
          cv.height = Math.round(img.height * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          worker.recognize(cv, {}, { blocks: true })
            .then(function (res) {
              var lines = [];
              ((res && res.data && res.data.blocks) || []).forEach(function (b) {
                (b.paragraphs || []).forEach(function (p) {
                  (p.lines || []).forEach(function (ln) {
                    var bb = ln.bbox || {};
                    var t = (ln.text || '').trim();
                    if (t.length > 1) {
                      lines.push({ x0: bb.x0 || 0, x1: bb.x1 || 0,
                                   y0: bb.y0 || 0, y1: bb.y1 || 0, t: t });
                    }
                  });
                });
              });
              if (!lines.length && res && res.data && res.data.text) {
                String(res.data.text).split(/\r?\n/).forEach(function (t, i) {
                  t = t.trim();
                  if (t.length > 1) lines.push({ x0: 0, x1: 0, y0: i * 10, y1: i * 10 + 9, t: t });
                });
              }
              // 按栏重排（拍照的纸可能两栏，和 PDF 同一套逻辑）
              var ordered = orderBoxes(lines, cv.width);
              resolve({ text: ordered.join('\n'), lines: lines.length, w: cv.width });
            })
            .catch(reject);
        };
        img.onerror = function () { reject(new Error('图片读不出来')); };
        img.src = dataUrl;
      });
    });
  }

  var G = (typeof window !== 'undefined') ? window : globalThis;
  G.PL_OCR = {
    ocrPdf: ocrPdf,
    ocrImage: ocrImage,
    orderBoxes: orderBoxes,       // 导出给自检用
    ready: function () { return !!(window.Tesseract && window.Tesseract.createWorker); },
    LANGS: LANGS,
  };
})();
