/* paperlens · 论文解析看板
 * 作者：李子正（正点 / OPC）
 *  * 仓库：https://github.com/Az0R119/paperlens
 *
 * 纯前端实现：不调任何 API、不上传任何数据。
 * 设计决策、实测数据与踩坑记录见 README.md 的「实测记录」章节。
 */
// 本地模型翻译 —— 把英文论文的句子翻成中文。
//
// ★ 用户的要求（原话）：
//   "外文要翻成中文"
//   "模型可以用本地模型 就是用户下桌面端就给他搞好"
//   "反正不能有 AI 就是了" → 后来澄清：比赛是人工智能院办的，AI 该用就用，
//     但**必须显式告知，不能静默降级**。
//
// ★ 设计原则（照抄 wx-mindmap 那套踩过的坑）：
//   ① 默认关闭 —— 不主动连任何服务
//   ② 检测到本地 Ollama → 显示可用的模型，让用户点"开始翻译"
//   ③ 没有 Ollama / 连不上 → **明确显示"未检测到本地模型"**，
//      绝不假装成功、绝不把英文当翻译结果显示
//   ④ 全部本地：数据不出机器（Ollama 跑在 127.0.0.1:11434）
//
// ★ 为什么选 qwen2.5:3b：体积 1.9 GB，中英互译够用；
//   7b 是 4.7 GB（用户机器 15.8 GB 内存焊死、可用仅 4.8 GB，会挤爆）。
//   产品是"用户自己装"，机器好的话换 7b/14b 也只是改 MODEL 常量。
//
// ★ 浏览器跨域：Ollama 默认只允许同源，需要在启动时设
//   OLLAMA_ORIGINS=* （桌面端安装包会自动设）。检测不到时提示用户。

(function () {
  'use strict';

  var ENDPOINT = 'http://127.0.0.1:11434';
  // ★ 桌面版（exe）里改走同源代理
  //   exe 的 Python 侧起了个 /ollama/* 转发服务，页面请求它就不会有任何跨源问题。
  //   判断方式：页面来源是 http://127.0.0.1:<port> 且存在 window.__PL_DESKTOP
  //   （paperlens_gui.py 注入的脚本会设这个标记；网页部署时没有，走原逻辑）。
  if (typeof window !== 'undefined' && window.__PL_DESKTOP) {
    ENDPOINT = window.location.origin + '/ollama';
  }
  var MODEL = 'qwen2.5:3b';          // 首选
  // ★ 顺序 = 默认优先级。**从最小到最大**，不是从最好到最差。
  //   踩过的坑：原来把 7b 排第一，结果用户机器装了 7b 就默认用它，
  //   第一次点翻译要等 20 秒，用户以为卡死（实测 3b 2-3 秒 / 7b 5-20 秒）。
  //   默认必须保证"点下去马上有反应"，想要更好的译文让用户自己去下拉框选。
  var FALLBACK_MODELS = ['qwen2.5:0.5b', 'qwen2.5:1.5b', 'qwen2.5:3b', 'qwen2.5:7b', 'qwen2.5:14b'];

  var state = {
    checked: false,
    online: false,       // Ollama 服务通不通
    model: null,         // 实际会用的模型
    models: [],          // 服务上已有的模型名
    error: ''            // 人话错误
  };

  function fetchJSON(url, opt, timeoutMs) {
    timeoutMs = timeoutMs || 4000;
    return new Promise(function (resolve, reject) {
      var ctl = ('AbortController' in window) ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctl) ctl.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
      fetch(url, Object.assign({ signal: ctl ? ctl.signal : undefined }, opt || {}))
        .then(function (r) {
          clearTimeout(timer);
          if (!r.ok) return reject(new Error('HTTP ' + r.status));
          return r.json().then(resolve, reject);
        })
        .catch(function (e) { clearTimeout(timer); reject(e); });
    });
  }

  // 检测：服务通不通 + 有没有可用的模型
  function detect() {
    return fetchJSON(ENDPOINT + '/api/tags')
      .then(function (d) {
        state.checked = true;
        state.online = true;
        var raw = d.models || [];
        state.models = raw.map(function (m) { return m.name; });
        // ★ 记下每个模型的体积（字节），给用户看"这个占多少硬盘"。
        //   为什么要显示：实测 3b 1.9 GB 翻一句 2-3 秒、7b 4.7 GB 翻一句 5-20 秒，
        //   质量 7b 更好但慢 2-2.5 倍。**这是用户该自己决定的事，不是我说了算。**
        state.sizes = {};
        raw.forEach(function (m) { state.sizes[m.name] = m.size || 0; });
        // 按偏好顺序挑（默认选最小的能用的，保证"点下去就能跑"）
        for (var i = 0; i < FALLBACK_MODELS.length; i++) {
          if (state.models.indexOf(FALLBACK_MODELS[i]) >= 0) { state.model = FALLBACK_MODELS[i]; break; }
        }
        if (!state.model && state.models.length) {
          // 没有推荐的，就取任意一个 qwen，再退到第一个
          var any = state.models.filter(function (n) { return /qwen/i.test(n); });
          state.model = any[0] || state.models[0];
        }
        if (!state.model) {
          state.error = '本地 Ollama 已运行，但还没有下载翻译模型（推荐 ' + MODEL + '）';
        }
        return state;
      })
      .catch(function (e) {
        state.checked = true;
        state.online = false;
        state.model = null;
        state.error = (e && e.message === 'timeout')
          ? '本地 Ollama 无响应（可能没启动，或被跨域策略拦住）'
          : '没有检测到本地 Ollama（127.0.0.1:11434 连不上）';
        return state;
      });
  }

  // 翻译一句话。返回 Promise<string>
  //
  // ★ prompt 调试过程（三次，都有实测）：
  //   ① 直接下指令「你是学术论文翻译…只输出译文」+ 加 system 提示
  //      → 3b 模型不听话：输出 "您的描述非常专业…以下是重新整理后的版本：" 开场白
  //        + 自己续写了三段解释（14.9 秒，译文埋在废话里）
  //   ② 换 system 强约束 + stop 序列("\n\n")
  //      → 更糟：直接飙英文解释 "The Transformer is indeed a groundbreaking…"（4.3 秒）
  //   ③ ★ few-shot：给一个「英文→中文」的完整示例，再给待翻句子 + "Chinese:"
  //      → 干净的一行中文，50 字、2.8 秒，汉字占比 0.68
  //        译文：我们提出了一种新的简单网络架构——Transformer，完全基于注意力机制，完全摒弃了递归和卷积。
  //   结论：小模型对"角色指令"不敏感，对"格式示范"敏感。给例子比给规矩管用。
  //   示例句特意选了含数字的（3.5 days / 8 GPUs），实测能带出数字保留的习惯。
  var FEWSHOT = 'English: We train the model for 3.5 days on 8 GPUs.\n'
    + 'Chinese: 我们在 8 块 GPU 上训练该模型 3.5 天。\n';

  function translateOne(text, model) {
    var prompt = FEWSHOT
      + 'English: ' + text + '\n'
      + 'Chinese:';
    return fetchJSON(ENDPOINT + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || state.model,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0,        // 翻译要确定性，不要发挥
          num_predict: 220,
          stop: ['English:', '\n\n']   // 防止它接着编下一个例子
        }
      })
    }, 60000).then(function (d) {
      var zh = (d.response || '').trim();
      // 兜底：万一它还是说了英文（实测过这种情况），截掉第一段英文
      if (!/[\u4e00-\u9fff]/.test(zh)) return '';
      // 去掉可能的 "Chinese:" 前缀残留
      zh = zh.replace(/^\s*(Chinese|中文)\s*[:：]\s*/i, '');
      return zh;
    });
  }

  // ★ 带一次重试的翻译
  //   实测（20 句）：模型约有 5% 概率用英文解释原文而不给译文，
  //   这时原来直接返回 ''，页面标红「这句翻译失败」—— 但其实再问一次就好了。
  //   重试仍失败才算失败，仍然标红（不静默）。
  function translateRetry(text, model) {
    return translateOne(text, model).then(function (zh) {
      if (zh) return zh;
      return translateOne(text, model);
    });
  }

  // 批量翻译（串行，避免把用户机器打满；每句之间让出主线程）
  function translateMany(sentences, onProgress) {
    var out = [];
    var i = 0;
    function step() {
      if (i >= sentences.length) return Promise.resolve(out);
      var cur = i++;
      return translateOne(sentences[cur])
        .then(function (zh) {
          out[cur] = zh || '';
          if (onProgress) onProgress(cur + 1, sentences.length);
          return new Promise(function (r) { setTimeout(r, 0); }).then(step);
        })
        .catch(function (e) {
          out[cur] = '';
          if (onProgress) onProgress(cur + 1, sentences.length);
          return new Promise(function (r) { setTimeout(r, 0); }).then(step);
        });
    }
    return step();
  }

  var G = (typeof window !== 'undefined') ? window : globalThis;
  G.PL_LOCAL_AI = {
    ENDPOINT: ENDPOINT,
    MODEL: MODEL,
    detect: detect,
    translateOne: translateOne,
    translateRetry: translateRetry,   // 带一次重试（模型偶尔只用英文回答）
    translateMany: translateMany,
    state: function () { return state; },
    // 让用户在 GUI 里换模型（下拉框）。传空/无效则忽略。
    setModel: function (name) {
      if (name && state.models && state.models.indexOf(name) >= 0) {
        state.model = name;
        return true;
      }
      return false;
    },
    // 人话状态描述（GUI 里直接显示这句，不静默）
    statusText: function () {
      var s = state;
      if (!s.checked) return '未检测';
      if (!s.online) return s.error;
      if (!s.model) return s.error;
      return '本地模型可用：' + s.model + '（数据不出本机）';
    }
  };
})();
