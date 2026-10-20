/* paperlens · 论文解析看板
 * 作者：李子正（正点 / OPC）
 *  * 仓库：https://github.com/Az0R119/paperlens
 *
 * 纯前端实现：不调任何 API、不上传任何数据。
 * 设计决策、实测数据与踩坑记录见 README.md 的「实测记录」章节。
 */
/* ============================================================================
   paperlens · 核心算法（浏览器版，纯 JS，零依赖）
   ============================================================================

   这是 Python 版 paperlens.py + textrank.py + local_sections.py 的**逐行翻译**。
   目标：浏览器里跑完全程，不上传、不需要后端。

   翻译原则（照抄 Python 的逻辑，不"改进"）：
     · 正则原样搬（Python 的 re 和 JS 的 RegExp 语义基本一致）
     · Python 的 re.search / re.findall / re.sub / re.split → JS 同名方法
     · 保留每个函数上方那段"为什么这么写"的注释 —— 那些是踩坑记录，
       删了下次改的人（包括我自己）会重踩
     · 不用任何 npm 包

   ★ 与 Python 版的唯一差异：PDF 文本提取。
     Python 用 PyMuPDF；浏览器用 pdf.js（见 extract.js）。
     两者抽出来的文本可能有微小差异（换行位置），因此下游所有
     "按行/按位置"的判断都做了容错。
   ========================================================================== */

'use strict';

// 最近一次清理时的文本层质量（null = 正常）。由 cleanPdfNoise 写入，UI 读取后提示用户。
// 为什么要这个：有些老 PDF 的数字用了没写 ToUnicode 的字体，抽出来全是 \x01，
// 清掉之后句子会缺数字（"从 年到 年"），不告诉用户会以为是程序 bug。
let PL_TEXT_QUALITY = null;

/* ---------- 全角归一化 ---------- */
// 中文期刊 PDF 常整篇全角排版（实测 U+FF0E 出现 646 次、一个半角句号都没有）
const _FULLWIDTH_MAP = (() => {
  const m = {};
  const chars = '０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ' +
                'ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ' +
                '：；，．！？（）％＃＠＆＊＋－／＝＜＞［］｛｝｜～＾｀';
  for (const c of chars) m[c] = String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  m['\u3000'] = ' ';
  return m;
})();

function normFullwidth(t) {
  let out = '';
  for (const c of (t || '')) out += (c in _FULLWIDTH_MAP) ? _FULLWIDTH_MAP[c] : c;
  return out;
}

const CJK_RE = /[\u4e00-\u9fff]/;
const hasCJK = (s) => CJK_RE.test(s || '');

/* ---------- 参考文献区起点 ---------- */
// 两步（翻译自 local_sections.py:find_refs_start）：
//   ① 有标题词（参/考/文/献 之间可有空白）→ 用它
//   ② 没有 → 找 [N] 编号**连续递增**且相邻间隔不大的最长段
// ② 是为中文期刊写的：实测《知识图谱》那篇"参考文献"四个字竖排（参\n考\n文\n献），
//   全文 find 返回 -1，标题路线完全失效。
const _REFS_TITLE = /参\s*考\s*文\s*献|References/;
const _CITE_NUM = /\[(\d{1,3})\]/g;

function findRefsStart(text) {
  const m = _REFS_TITLE.exec(text);
  if (m) return m.index;

  const marks = [];
  const re = new RegExp(_CITE_NUM.source, 'g');
  let x;
  while ((x = re.exec(text)) !== null) marks.push([x.index, parseInt(x[1], 10)]);
  if (marks.length < 6) return text.length;

  let bestI = 0, bestLen = 0, i = 0;
  while (i < marks.length) {
    let j = i;
    while (j + 1 < marks.length
           && marks[j + 1][0] - marks[j][0] < 3000      // 相邻不远（排除散落正文的 [12]）
           && marks[j + 1][1] - marks[j][1] >= 0
           && marks[j + 1][1] - marks[j][1] <= 3) {     // 编号基本递增
      j++;
    }
    if (j - i > bestLen) { bestI = i; bestLen = j - i; }
    i = j > i ? j + 1 : i + 1;
  }
  // 至少连续 6 条才算（太少可能是正文零散引用）
  return (bestLen + 1 >= 6) ? marks[bestI][0] : text.length;
}

/* ---------- 切句前处理（PDF 噪声清理） ---------- */
// ★ 这一整段都是**踩坑踩出来的**，别删别简化 —— Python 版删任何一条都会让
//   切句数从 67 掉到 5、或者让核心句质量崩。逐条翻译自 textrank.py。

// 剥掉参考文献之后的内容（致谢/作者简介/附录），只留正文
function stripBackMatter(text) {
  // ★ 只剥参考文献和附录 —— **不剥致谢**：致谢句（"We are grateful to X for..."）
  //   在 Python 版里是被保留的有效内容（实测 JS 多剥这一项就少 1 句、索引全偏）
  const re = /(?:^|\n)\s*(参\s*考\s*文\s*献|References|REFERENCES|Bibliography)\s*$/m;
  const m = re.exec(text);
  return m ? text.slice(0, m.index) : text;
}

function cleanPdfNoise(text) {
  // ★★ 第一步：清掉 PDF 文本层里的控制字符 —— 必须在一切处理之前。
  //   实测（《中国成人血脂异常防治指南》1990 年代期刊扫描件，老方正字体）：
  //     "从 \x01\x01\x01 年到 \x01\x01\x01年"        ← 本该是 "1984年到1999年"
  //     "血清总胆固醇 \x01\x01\x01 \x01\x01\x01\x01"  ← 本该是 "<5.18 mmol/L"
  //   根因：那些 PDF 的数字用了自定义字形，但**没写 ToUnicode 映射表**，
  //   所以抽出来一律是 \x01（U+0001）。这是 PDF 生成方的问题，
  //   任何抽取工具（pdf.js / pymupdf / pdfplumber）都会得到 \x01，不是我们代码的错。
  //   但**绝不能把 \x01 显示给用户** —— 那看起来像程序坏了。
  //   → 这里统一清成空格，并在下面统计"数字位缺失"的严重程度，必要时要明说。
  const ctrlBefore = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  let t = (text || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');

  return cleanPdfNoiseRest(t, ctrlBefore);
}

// 原始入口保持不变（下面这行是内部实现，改了签名旧调用会静默传错参数）
function cleanPdfNoiseRest(text, ctrlBefore) {
  let t = normFullwidth(stripBackMatter(text || ''));

  // ★★ 页眉整行删除 —— **必须在任何"拼行"之前**（这是追了六轮才定下的位置）。
  //   实测（CNN 那篇，计算机学报双栏排版）原文长这样：
  //     "用中,设计了 不 同 参 数 及 不 同 深 度 的 CNN 网 络 结\n
  //      机 学 报 2017年\n                                    ← 页眉**独占一行**
  //      构,并 将 不 同 网 络 结 构 的 CNN 模 型…"
  //   ★ 为什么必须在拼行之前：
  //     ① 行级判据干净（整行就是页眉，长度短、无句末标点）
  //     ② 一旦先拼行，"网 络 结" + "机 学 报 2017年" + "构" 被空格连成一行，
  //        最后再跑"去掉汉字间空格" → 焊成 "网络结机学报 2017年构"（页眉进了词里）
  //     ③ 那时再删就得用"句中正则"，而句中的汉字**夹着空格**，
  //        我前三轮全写成 `机学报`（无空格）+ 前视要求紧邻汉字 → 一次都没匹配上
  //   ★ 判据（整行三选一即删）：
  //     ① 期号开头："6期" / "第 6 期" / "第 40 卷"（可带空格）
  //     ② 刊名 + 年份："计算机学报 2017年" / "机 学 报 2017年"（刊名允许内部空格）
  //     ③ 期刊名单独成行（"计算机学报" / "软件学报"…）
  //   三条都要求**整行长度 < 34 字**且**不含句末标点**（正文行不会这么短就断）。
  const HDR = [
    /^[\s　]*[０-９\d]{1,3}\s*[期卷][\s　]*[\s\S]{0,30}$/,                       // "6期 周飞燕等 卷积神经网络研究综述"
    /^[\s　]*[^\n]{0,3}学\s*报[\s　]*[（(]?[１２\d]{4}[)）]?\s*年?[\s\S]{0,16}$/,  // "机 学 报 2017年"
    /^[\s　]*(?:第\s*)?[０-９\d]{1,3}\s*[卷期]\s*[^\n]{0,20}$/,                   // "第 40 卷 第 6 期"
    /^[\s　]*[^\n]{0,6}(?:学\s*报|杂\s*志|期\s*刊)[\s　]*$/,                       // "计算机学报"
  ];
  t = t.split('\n').filter(line => {
    const s = line.trim();
    if (!s || s.length > 34) return true;              // 空行 / 长行 → 保留
    if (/[。．.！？?；;，,、]$/.test(s)) return true;    // 有句末标点 → 是正文
    return !HDR.some(re => re.test(s));                // 命中页眉 → 删
  }).join('\n');

  // ★ 英文连字符断词续行处理**必须放在"换行→空格"之前**。
  //   踩过的坑：先执行 `\n → 空格` 后，"English-\nto-German" 变成 "English- to-German"，
  //   连字符规则再也看不到 \n（实测 Attention 的 "28.4 BLEU on the WMT 2014
  //   English-to-German translation task" 因此变形）。
  //   ★ 但**不能简单拼接** —— 直接把 "-\n" 去掉会得到 "Englishto-German"（错词！）。
  //     正确做法：连字符 + 换行 → **保留连字符、去掉换行**。真的跨行断词
  //     （"persua-\nsion"）由下面那条 // 连字符还原（(\w)-\s+(?=[a-z]) → $1）处理。
  t = t.replace(/-\n(?=[a-z])/g, '-');
  // 行尾没有句末标点 → 是同一句被硬换行，接上
  // ★ 必须同时覆盖中文：原正则只认"下一行以小写字母开头"，中文行（下一行是汉字）
  //   接不上，切句时就把**跨行的半句**当成独立句 → 核心句出现
  //   "…比较式层存 / 储的是…" 这种被换行劈开的文本（实测《知识图谱》那篇）
  t = t.replace(/(?<![.:;!?。！？；])\n(?=[a-z(\u4e00-\u9fff])/g, ' ');
  // 数字被换行拆开（"350\n109"）：去掉断口但**不加空格**（加了会拼出假数字）
  t = t.replace(/(?<=\d)\n(?=\d)/g, '');
  // 页码清理：只认"汉字 + 单个数字 + 汉字"的极窄形态，
  // 避免误伤 "110 109" 这种真数字串
  t = t.replace(/(?<=[\u4e00-\u9fff]) \d{1,3} (?=[\u4e00-\u9fff])/g, ' ');
  t = t.replace(/(?<=[\u4e00-\u9fff])\s+\d{1,2}\s+(?=[A-Z][a-z])/g, ' ');
  t = t.replace(/\b(Figure|Fig\.|Table|Algorithm)\s*\d+[:.]?\s*/g, ' ');
  // ★ 删"页码/行号残留"（形如 "12 introduction to the ..."）。
  //   实测 bug：原规则 `\b\d{1,3}\s+(?=[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,})` 把正文里
  //   的数字也吃了 —— "BLEU score of 41.0 after training for 3.5 days" 中
  //   41.0 后面跟着 "after training for" 三个小写词 → 整个 41.0 被删
  //   → 看板上出现 "BLEU score of outperforming"（数字没了，句子读不通）。
  //   收紧：① 只吃**整数**（页码没有小数）② 必须在**句首或行首**（页码总在行首）
  //         ③ 后面跟的词里不能有数字（"3.5 days" 这种量词会带数字）
  t = t.replace(/(^|[.!?。！？]\s+|\n)\d{1,3}\s+(?=[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,})/g,
                (m, pre) => pre);
  // 连字符断词还原（"persua- sion" → "persuasion"）
  t = t.replace(/(\w)-\s+(?=[a-z])/g, '$1');
  // 中文汉字之间夹的空格（两栏排版换行留下的）去掉
  // ★ 页眉插进句子中间（实测 bug，CNN 那篇）：
  //   "本文就CNN在…设计了不同参数及不同深度的 CNN 网络结**机学报 2017年**构,并将…"
  //   —— 原文页眉是 "计算机学报 2017年 第40卷 第6期"。PDF 双栏排版时页眉行
  //   夹在正文两行之间，按 y 坐标排序抽取后**插进了 "结构" 这个词中间**。
  //   全角/半角混排，词被切断，任何"整行判断"的规则都抓不到。
  //   判据（三选一即删，删掉后不再补空格，让 "结"+"构" 自动接回）：
  //     ① 期刊名特征词 + 卷期/年份混在一起
  //     ② "第N卷" / "Vol.N" 前后不是标点也不是行首行尾
  //     ③ 纯年份夹在两个汉字之间
  //   ponytail: 这是"事后补丁"。GROBID 的做法是先做文档分区（cover/header/body/
  //   footnotes/biblio），页眉在分区阶段就分离了。要做到那步需要保留每个 item 的
  //   y 坐标和字号 —— pdf.js 给得到，但 index.html 现在只取 str 不取 y。
  //   日程允许时改成"按 y 分带"，那时这组规则可以全删。
  //   ★ 第三次的错：回调里"还回去一个汉字"是多余且错的 ——
  //     `[\u4e00-\u9fff]?学报` 的**前视不吃正文汉字**，匹配到的 "机学报" 本身
  //     就是刊名残片，再还一个 "机" 字反倒拼出 "网络结机构"。
  //     修：直接全删。缺字由 pdf 抽取负责，不是这里该补的。
  t = t.replace(/(?<=[\u4e00-\u9fff])(计算\s*机\s*学\s*报|软件\s*学\s*报|电子\s*学\s*报|通信\s*学\s*报|中国\s*科\s*学|[\u4e00-\u9fff]?学\s*报)\s*\d{4}\s*年?(?=[\u4e00-\u9fff])/g, '');
  // ★ 偶数页页眉（CNN 那篇的真正根因，追了 5 轮才定位）：
  //   实测正文里出现 "…它在模式识别与人工智能等领域\n\n：\n６期 周飞燕等 卷积神经网络研究综述\n中的发展与应用…"
  //   —— 期刊偶数页页眉印的是 "６期 作者名 论文标题"（**全角数字**的期号），
  //   它夹在正文两行之间，按 y 坐标抽取后就**插进了句子中间**，
  //   把 "结构"、"网络结" 这类词切断 → 重拼后出现 "CNN 网络结机学报 2017年构"。
  //   判据：全角/半角"数字+期" 开头，且**整段像"期号+人名+标题"**（不含标点、≤30 字）。
  t = t.replace(/[０-９\d]{1,3}\s*期[\s　]+[^\n。．,，;；]{0,34}?(?=\n|$)/g, ' ');
  t = t.replace(/(?:^|\n)\s*[^\n]{0,4}等\s+[^\n。．]{4,30}?(?:综述|研究|分析|方法|技术|进展|学报)\s*(?=\n|$)/g, '\n');
  t = t.replace(/(?<=[\u4e00-\u9fff])\s*(?:第\s*\d+\s*[卷期]|Vol\.?\s*\d+|No\.?\s*\d+)\s*(?=[\u4e00-\u9fff])/gi, '');
  t = t.replace(/(?<=[\u4e00-\u9fff])(19|20)\d{2}\s*年?(?=[\u4e00-\u9fff])/g, '');
  // ★ 跨栏连字符残留（实测知识图谱那篇）：
  //   PDF 双栏排版，行尾断字会留一个连字符，抽取后形态是
  //   "以- -及"（原意 "以及"）、"相互联-结"（原意 "相联/联结"）。
  //   这是**排版假象**：连字符两侧其实是被硬拆开的同一个词。
  //   处理：汉字之间的 "- " / "- " / "－" 一律删掉（中文本不缺连字符，
  //   真需要连字符的场合（如"中-美"）在学术论文正文里极罕见，误伤可接受）。
  t = t.replace(/(?<=[\u4e00-\u9fff])[-－]\s*(?=[\u4e00-\u9fff])/g, '');
  t = t.replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '');
  t = t.replace(/\s+/g, ' ');
  // ★ 把"这份 PDF 的文本层缺字"的程度带出去，让 UI 能明说。
  //   判据：控制字符占比。这份 1990 年代期刊扫描件实测大量 \x01（约每页几十个），
  //   正常的新 PDF 是 0。阈值 0.2% 是实测定的：
  //     正常论文（5 篇样例）≈ 0；这份指南 ≈ 3%。
  //   ★ 字符串是原始类型，挂属性无效（会被静默丢掉）—— 用模块级变量传出。
  const ratio = ctrlBefore / Math.max(1, t.length + ctrlBefore);
  // ★ 私有区字符（排版软件的版式符号）也算"文本层不可信"。
  //   实测《"健康中国2030"规划纲要》pua 占 6.69%（1782 个），
  //   这类 PDF 字有但位置错乱，句子会被切断 —— 提示条也要说清。
  const pua = (t.match(/[\uE000-\uF8FF]/g) || []).length;
  const puaR = pua / Math.max(1, t.length);
  PL_TEXT_QUALITY = (ratio > 0.002 || puaR > 0.005)
    ? { ctrl: ctrlBefore, ratio: ratio, pua: pua, puaRatio: puaR } : null;
  return t;
}

// 切句后的尾巴清理（每条都对应一类实测残留）
function trimSentenceTail(s) {
  s = (s || '').trim();
  // 尾巴挂着下一节的标题（"…提供了新的思路. 2.3.3 质量评估"）
  s = s.replace(/\s+\d+(?:\.\d+){1,3}\s+[\u4e00-\u9fffA-Za-z][^.]{0,14}$/g, '').trim();
  s = s.replace(/\s+[一二三四五六七八九十]+[、.]\s*[\u4e00-\u9fff]{2,10}$/g, '').trim();
  // 尾巴挂"图2 xxx"（跨栏图注被切进句尾）
  s = s.replace(/\s+[图表]\s*\d+\s+[\u4e00-\u9fff]{2,12}.*$/g, '').trim();
  // 句中夹带小节标题："...distributions. 3.2 EICS Metric We introduce..."
  s = s.replace(/(?<=[.!?])\s+\d+(?:\.\d+){1,3}\s+(?:[A-Z][A-Za-z\-]{1,12}\s+){1,4}(?=[A-Z(])/g, ' ').trim();
  // 句尾脚注标记（"∗Equal contribution." 实测挂在 Attention 第一篇核心句后面）
  s = s.replace(/\s*[\u2217\u2020\u2021\u00a7*\u2691]+\s*(Equal contribution|Corresponding author|These authors|Work done|Now at|Currently at|Code available|致谢|诚致谢).*$/gi, '').trim();
  // 句末孤立小节号（"…新的思路. 2.3."，标题被排版切走只剩编号）
  s = s.replace(/\s+\d+(?:\.\d+){1,3}\.?\s*$/g, '').trim();
  // 中文小节标题黏在句中且叠字（"…思路. 2.3.3 质量评估质量评估也是…"）
  s = s.replace(/(?<=[.!?])\s+\d+(?:\.\d+){1,3}\s+([\u4e00-\u9fff]{2,12})\1/g, ' ').trim();
  s = s.replace(/(?<=[.!?])\s+\d+(?:\.\d+){1,3}\s+[\u4e00-\u9fff]{2,12}(?=[\u4e00-\u9fff]{2,})/g, ' ').trim();
  // ★ 行首的关键词行：双栏拼接常把 "Keywords xxx;yyy;zzz 摘要正文…" 拼成一行
  //   （实测《知识图谱》的"为什么做"变成 "Keywords knowledgegraph;semanticWeb;… 摘要谷歌知识图谱技术…"）。
  //   判据：行首是 Keywords/关键词/Key words，且后面跟着分号串 —— 剥到分号串结束为止。
  {
    const m = /^\s*(?:Key\s*words?|关\s*键\s*词|キーワード)\s*[:：]?\s*[^\u4e00-\u9fff]*(?:;[^;\u4e00-\u9fff]*)*;?\s*/.exec(s);
    if (m && m[0].length > 8) s = s.slice(m[0].length).trim();
  }
  // 句尾圈码小标题（"…如短文本分析. ②语义模型."）
  s = s.replace(/\s+[\u2460-\u2473\u3251-\u32bf]\s*[\u4e00-\u9fff]{2,10}[.。]?\s*$/g, '').trim();
  s = s.replace(/\s+[（(][\u4e00-\u9fff]{1,3}[)）]\s*[\u4e00-\u9fff]{2,10}[.。]?\s*$/g, '').trim();
  return s;
}

/* ---------- 切句 ---------- */
// 三种边界都要认：
//   ① 英文：. ! ? + 空格 + 大写开头
//   ② 中文：。！？；后直接切
//   ③ 全角归一后的"．"变成 "." 后面紧跟汉字（中文期刊全角排版）——
//      只认 ①② 会让 46,865 字整篇只切出 5 段（实测）
function splitSentences(text) {
  const t = cleanPdfNoise(text);
  if (!t) return [];
  // 四种边界：
  //   ① 英文 .!? + 空白 + 大写/左括号
  //   ② 句末标点后直接跟汉字（中文无空格）
  //   ③ 中文句末标点
  //   ④ ★ 句末标点 + 换行 + **数字编号**（小节标题编号）
  //      实测漏了这条：pdf.js 抽出的英文论文里小节标题和正文挤在一条逻辑行上，
  //      "We used warmup_steps = 4000.\n5.4 Regularization We employ three types of…"
  //      会被拼成一句 307 字符的怪句（全篇 10/68 句超 230 字符，平均句长 153 而非正常的 ~100）。
  //      加上这条后小节编号处能切开。
  // ★ 第 ② 条 `(?<=[.!?])\s+(?=\d+(?:\.\d+)+\s)` 本意是"句末标点 + 小节编号"处切句
  //   （"…warmup_steps = 4000. 5.4 Regularization We employ…"）。
  //   实测 bug：`BLEU score of 41.8 after training for 3.5 days` 里的 41.8 也匹配
  //   `\d+(\.\d+)+` → 句子被从 "41." 和 "8" 之间切开，后半句 "8 after training…"
  //   开头是裸数字 → 被"数字占比/无意义开头"规则丢掉 →
  //   看板上出现 "BLEU score of outperforming"（后面的 41.8 整段消失）。
  //   凑巧 "41.8" 后面正好接 "outperforming"（前句尾部），拼成了读不通的句子。
  //   收紧：小节编号后必须跟**大写字母**（"5.4 Regularization"），
  //        而小数后跟的是小写/单位（"41.8 after"）→ 不再误切。
  const raw = t.split(/(?<=[.!?])\s+(?=[A-Z(])|(?<=[.!?])\s+(?=\d+(?:\.\d+)+\s+[A-Z])|(?<=[.!?])(?=[\u4e00-\u9fff])|(?<=[。！？；])/);
  const out = [];
  for (let s of raw) {
    s = trimSentenceTail(s);
    if (!s) continue;

    // ─── 独立成条的小节标题（无正文跟随）───
    if (/^\d+(?:\.\d+){1,3}\s+(?:[A-Z][A-Za-z\-]{1,12}\s*){1,5}$/.test(s)) continue;
    if (/^\d+(?:\.\d+){1,3}\s+[\u4e00-\u9fff]{2,14}$/.test(s)) continue;

    // ─── 作者简介（中文期刊页脚）───
    if (/born in \d{4}|associate professor|Ph\.?D\.?,|received (his|her|the)/i.test(s)) continue;

    // ─── 页脚元信息：单位/基金/简介/版权 ───
    // 实测这些是"烂句"主要来源：讲**人/钱/机构**，不讲论文内容
    if (/基金项目|资助项目|教改项目|项目编号|No\.?\s*\d{6,}|[（(]\s*\d{6,}\s*[)）]|(research interests?|main interests?|works? (on|in)|is (a|an) (professor|lecturer|student)|received (the )?(B\.?S|M\.?S|Ph)|硕士|博士研究生|教授|副教授|讲师|通信作者|收稿日期|修回日期|作者简介|E-?mail|电子邮件|@[\w.]+\.[a-z]{2,})/i.test(s)) continue;

    // ─── 学位论文前置页与致谢 ───
    // 不加这两条，"开头"会选到版权声明、"结尾"会选到致谢，位置规则全失效
    if (/学位论文(作者签名|版权使用授权书|原创性声明)|除文中已经标明引用的内容外|本声明的法律结果由本人承担|作者签名\s*[:：]|指导教师签名|保密□|经(作者|学位论文作者)授权|编入有关数据库进行检索|衷心感谢|特别感谢我的(家人|父母|导师)|在.{0,6}的悉心指导下|感谢.{0,8}(评审|答辩)委员会/.test(s)) continue;

    // ★ 首页元信息**大块**（实测 CNN 那篇）：pdf.js 把首页的
    //   "第40卷计算机学报 Vol.40 No.6 2017年6月 CHINESEJOURNALOFCOMPUTERS June2017
    //    卷积神经网络研究综述 1),2) 1),2) 1) 周飞燕金林鹏董军
    //    (中国科学院苏州纳米技术与纳米仿生研究所江苏苏州 215123) 2) (中国科学院大学北京 100049)
    //    摘要作为一个十余年来快速发展的崭新领域,深度学习受到了越来越多研究者的关注…"
    //   全挤进**一句**（首页没有句末标点，一直拼到"摘要"后的第一个逗号才断）。
    //   ★ 第一次的错：想整句丢掉，判据用"汉字密度<0.45" → 实测密度 0.543
    //     （因为尾巴拖进了摘要正文），判据没命中，页眉照样出现在看板上。
    //   真修法：**剥头留尾** —— 元信息在句首，摘要正文在句尾，切掉头部、保留正文。
    {
      // 定位"摘要/Abstract"起点（它标志正文真正开始）
      const mk = /(?:^|\s)(摘\s*要|Abstract|ABSTRACT)\s*/.exec(s);
      // ★ 门槛 0.6 实测不够：CNN 那篇的"摘要"出现在 156/220 = 70.9% 处
      //   （首页元信息特别长，把摘要挤到后面）→ 判据没命中，页眉留在看板上。
      //   放宽到 0.75：仍然能排除"摘要"出现在句子后半段的正常正文。
      if (mk && mk.index <= s.length * 0.75) {         // 摘要必须在前 75% 内才算"首页头部"
        const head = s.slice(0, mk.index);
        const metaN = (head.match(/第\s*\d+\s*卷|Vol\.?\s*\d+|No\.?\s*\d+|ISSN|CN\s*\d|JOURNAL|纳米|研究所|大学|学院|实验室|邮编|\d+\s*\)\s*\d+\s*\)|@[\w.]+|基金|资助/g) || []).length;
        if (metaN >= 3) s = s.slice(mk.index + mk[0].length);   // 剥掉头部，留下正文
      }
    }
    if (!s || s.length < 8) continue;

    // ─── 噪声：数字占比 / 引用 / 网址 ───
    // 注意：这里**不做长度过滤** —— 那是"选句"的事，不是"切句"的
    const nCjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    if ((s.match(/\d/g) || []).length > s.length * 0.25) continue;
    if (/\[\d+\]|et al\.|arXiv:|doi:|http/i.test(s)) continue;

    // ─── 参考文献条目 ───
    if (/\[(J|D|M|C|N|R|S|P|EB\/OL|Z|A)\][\.。]?\s*$|\[(期刊|会议|学位论文|专著|博士学位论文|硕士学位论文)\]/.test(s)) continue;
    if (/(大学|学院|研究所|出版社)[,，]?\s*\d{4}|[Jj]ournal|[Pp]roceedings of|\b(19|20)\d{2}\s*[,，]\s*\d{1,4}[-–]\d{1,4}\s*[\.。]?$/.test(s)) continue;

    // ─── 公式符号堆 ───
    // ★ 只对"不含中日韩字符"的句子生效 —— 中文句的拉丁字母占比本来就 ~0，
    //   不加这个条件会把**每一条中文句**都误杀（实测中文核心句全空）
    if (nCjk < 5 && (s.match(/[a-zA-Z]/g) || []).length < s.length * 0.5) continue;

    // ─── 表格行：数字/百分号密集 ───
    if ((s.match(/\d+\.\d+|\d+%/g) || []).length >= 3) continue;

    // ─── 「短行多数字」——只对英文生效 ───
    // 中文没空格，split() 恒为 1，条件永远成立 → 含 4+ 数字的中文句全被杀，
    // 而带数字的恰恰是最有价值的结果句（"准确率达到87.3%"）
    if (nCjk < 5 && s.split(/\s+/).length < 10 && (s.match(/\d/g) || []).length > 3) continue;

    // ─── 文献条目：作者逗号年份 ───
    if (/^[A-Z][a-z]+,?\s+[A-Z]\./.test(s)) continue;

    // ─── 文献标题式 ───
    // ★ 必须带「无动词」这一条：只排除 we/our/results/method 会把
    //   "Sentence 0 describes the experimental setup in detail." 这种正常句丢掉
    //   （实测整篇英文测试文本被切成 0 句）
    if (/^[A-Z][^.]{10,80}\.\s*$/.test(s) &&
        !/\b(we|our|this paper|results|method|model|is|are|was|were|be|been|has|have|had|do|does|did|can|could|shows?|suggests?|indicates?|describes?|presents?|proposes?|means?|finds?|uses?|gives?|makes?|takes?)\b/i.test(s)) continue;

    // ─── 图标签串：多个大写短词、无动词 ───
    const caps = (s.match(/\b[A-Z][a-z]{0,3}\b/g) || []).length;
    if (caps >= 4 && !/\b(is|are|was|were|has|have|can|shows?|means?|suggests?|we|our|this|these|that)\b/i.test(s)) continue;

    // ─── 表头串：短词占比 > 50%（只对英文）───
    // 中文没空格，整句 1 个"词"、字母数 0 → 0/1 > 0.5 → 每条中文句都被误杀
    // ★ 必须同时"没有动词/功能词" —— 真正的表头是无动词的碎词堆，
    //   而正常英文句子里短词本来就多（the / by / over / BLEU / WMT / 2014）。
    //   实测误杀："Our model achieves 28.4 BLEU on the WMT 2014 English-to-German
    //   translation task, improving over the existing best results…"
    //   短词占 0.63 > 0.5 → 被当表头丢掉 → Attention 的「关键数字」板块整个空掉。
    if (nCjk < 5) {
      const words = s.split(/\s+/).filter(Boolean);
      const shortRatio = words.filter(w => w.replace(/[^A-Za-z]/g, '').length <= 4).length / words.length;
      const hasVerb = /\b(is|are|was|were|be|been|has|have|had|can|could|may|might|will|would|do|does|did|achieves?|attains?|reaches?|shows?|uses?|proposes?|presents?|introduces?|improves?|reduces?|increases?|obtains?|yields?|performs?|outperforms?|reports?|finds?|found|observed?|demonstrates?|we|our|this|these|its|their)\b/i.test(s);
      if (words.length && shortRatio > 0.5 && !hasVerb) continue;
    }

    // ─── 尾巴是数字串（≥5 个连续数字才判）───
    if (/(\s[\d,]{1,6}){5,}\s*$/.test(s)) continue;

    // ─── 被表格物理截断的半句 ───
    // "…特征面数目设计了350" 后面直接跟"表5 xxx" —— 判据：裸数字结尾且无句末标点
    if (/\d\s*$/.test(s) && !/[.!?。！？；;]\s*$/.test(s)) continue;

    // ─── 正文夹着图表标题 ───
    if (/\s+[图表]\s*\d+\s*[\u4e00-\u9fffA-Za-z]/.test(s)) continue;

    // ─── 空括号结尾才算残片 ───
    if (/\(\s*\)\s*$/.test(s)) continue;

    out.push(s);
  }
  return out;
}

/* ---------- 分词（英文按词、中文按相邻两字 bigram） ---------- */
// STOP 表逐词照搬 Python 版 textrank.py（111 个）—— 少一个词就会让
// 相似度算错，进而选句不同（实测漏了 "each" 就导致核心句从第 1 句起分叉）。
const STOP_EN = new Set(`a an the and or but if while of to in on at by for with from as is are was were
be been being this that these those it its their there here we our you your they them he she
his her not no nor so than then thus therefore however also such can could may might must
shall should will would do does did done have has had more most much many some any each
other another into over under between during within without about above below up down out
off again further once only own same too very s t just don now i me my myself`.split(/\s+/).filter(Boolean));

// 中文停用字：的/了/是 这类高频道词会让所有句子都"相似"
const CN_STOP = '的了是在和与及或对为以其之也都很会能被把从而且但若则这那有些个中上下不无';

function tokens(s) {
  const low = (s || '').toLowerCase();
  const out = new Set();
  // 英文词：>2 字母且不在停用表
  for (const w of (low.match(/[a-z]+/g) || [])) {
    if (w.length > 2 && !STOP_EN.has(w)) out.add(w);
  }
  // 中文：去掉所有非汉字后再取 bigram
  // （"知识图谱" → {知识, 识图, 图谱}；TextRank 只要"两句有多少共同内容"，
  //   不需要真词边界，bigram 够用且零依赖）
  const cjk = (low.match(/[\u4e00-\u9fff]/g) || []).join('');
  for (let i = 0; i + 1 < cjk.length; i++) {
    const bg = cjk.slice(i, i + 2);
    if (CN_STOP.includes(bg[0]) || CN_STOP.includes(bg[1])) continue;
    out.add(bg);
  }
  return out;
}

/* ---------- 相似度 ---------- */
// 注意：这是 TextRank 原论文的近似公式，**值可能 > 1**
// （短句时分母 log(a)+log(b) < 1）。Python 版实测最大 2.346。
// 保留原公式是为了跟 Python 版结果一致；阈值按这个尺度定。
function similarity(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let common = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const w of small) if (big.has(w)) common++;
  if (!common) return 0;
  return common / (Math.log(a.size + 1) + Math.log(b.size + 1));
}

/* ---------- TextRank（含四层人工先验） ---------- */
// ★ 这一整段逐行翻译 textrank.py，四层缺一不可 ——
//   纯 TextRank 有个致命偏向：奖励"跟多数句子相似"的句子，
//   于是选出来的是**背景陈述**（大家都在说 RNN），而"我们提出 Transformer"
//   这种引进新词的核心句反而低分（实测 #3 只 0.12）。
//   这四层就是 89% 命中率的来源。

// ① 长度门槛（属于"选句"不是"切句"）
//    中文按汉字数判（12 字才够表达完整意思），英文按字符数判
function lengthGate(sents) {
  return sents.filter(s => {
    const nc = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    if (nc >= 10) return nc >= 12 && s.length <= 400;
    return s.length >= 40 && s.length <= 600;
  });
}

// ② 位置与内容加权
function scoreWeight(s, i, n) {
  let w = 1.0;
  const rel = n > 1 ? i / (n - 1) : 0;
  if (rel < 0.12 || rel > 0.75) w *= 1.5;              // 开头(摘要/引言)与结尾(结论)
  // 新颖性句
  if (/\b(we (propose|present|introduce|show|develop|design)|our (method|approach|model|contribution)|the (key|main) (idea|contribution|insight)|novel|for the first time)\b/i.test(s)) w *= 1.3;
  // 带结果的句子
  if (/\b(outperform|achieve|improv|state-of-the-art)\b|\d+\.?\d*\s*%|(准确率|精度|提升了|达到了)/i.test(s)) w *= 1.2;
  // 中文论文里的**纯英文句**降权：那是英文摘要（同一篇的翻译版），
  // 选它等于把作者的话换成英文版重复一遍（实测微博情感那篇首句就是）。
  // ★ 0.55 压不住 —— 英文摘要自成一个语义簇、TextRank 中心性高，加上"开头结尾 ×1.5"
  //   之后仍然排第 1（实测：中文句 0.2659 vs 英文句 0.0543，乘完权重被反超）。
  //   降到 0.25。只在**这篇有中文正文**时生效（整篇英文的论文不受影响）。
  if ((s.match(/[\u4e00-\u9fff]/g) || []).length === 0 && _CN_DOC) w *= 0.25;
  // 过渡句降权："然后,讨论了…" 是在总结上一段
  if (/^\s*(然后|其次|再次|另外|此外|最后|并且|而且|因此|所以|综上)/.test(s)) w *= 0.8;
  // 实验细节句降权 —— 实测这是 top3-4 位的主要噪音来源
  // （"8 NVIDIA P100 GPUs"、"Each training batch contained 25000 source tokens"）
  if (/\b(GPUs?|TPUs?|batch(es)?|epochs?|learning rate|dropout|hyper-?parameters?|beam size|checkpoint|warmup|we trained|training (set|data) (of|contained|consisted)|source tokens|target tokens|development set|validation set|we (used|use) \d+|took \d+|for \d+ (epochs|steps|hours))\b/i.test(s)) w *= 0.6;
  if (/(实验(设备|环境|平台)|显卡|显存|迭代次数|学习率|批大小|超参|训练集(大小|规模)|测试集(大小|规模)|迭代了|训练了\s*\d+)/.test(s)) w *= 0.6;
  return w;
}

// ③ 新颖句保送：含"我们提出/贡献/首次"的句子直接提前
const MUST = /\b(we (propose|present|introduce|develop|design|show|find|demonstrate|observe|report|argue|hypothesize)|our (main )?(contribution|method|approach|model|framework|finding|result)|(this|the present) (paper|work|study) (presents?|proposes?|shows?|introduces?|investigates?|examines?)|the (key|main|core) (idea|insight|contribution|finding)|(novel|first) (method|approach|architecture|framework)|(these|our) (findings|results|experiments) (show|suggest|indicate|reveal)|we (therefore|thus) )\b|(本文|本研究|我们)(提出|设计|实现|发现|表明|研究|构建|给出|认为)|(实验结果|研究结果)(表明|显示|说明)|(该方法|本文方法|所提方法)/i;

function textrank(sents, top = 5, iters = 30, window = 6) {
  sents = lengthGate(sents);
  const n = sents.length;
  if (!n) return [];
  const tk = sents.map(tokens);

  // 构图：只跟前后 window 句算相似度（全连接是 O(n²)，1000 句就 100 万次）
  const graph = Array.from({ length: n }, () => new Map());
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(n, i + window + 1); j++) {
      if (i === j) continue;
      const w = similarity(tk[i], tk[j]);
      if (w > 0) { graph[i].set(j, w); graph[j].set(i, w); }
    }
  }

  const d = 0.85;
  let score = new Array(n).fill(1.0);
  for (let it = 0; it < iters; it++) {
    const nw = new Array(n).fill((1 - d) / n);
    for (let i = 0; i < n; i++) {
      let total = 0;
      for (const w of graph[i].values()) total += w;
      if (total <= 0) continue;
      for (const [j, w] of graph[i]) {
        let oj = 0;
        for (const w2 of graph[j].values()) oj += w2;
        if (oj > 0) nw[i] += d * score[j] * (w / oj);
      }
    }
    // 防震荡：跟上一轮取平均
    score = score.map((v, i) => 0.5 * (v + nw[i]));
  }
  // 位置先验（第 5 层）：这句话落在"这类内容常见区间"就提权。
  // 与上面四层的区别：那四层看**句子本身**（含什么词），这层只看**它在全文的位置**。
  score = score.map((v, i) => v * scoreWeight(sents[i], i, n) * positionBonus(sents[i], i / Math.max(1, n - 1)));

  // ④ 去重：太像的只留一句（阈值 0.35 —— 实测 0.5 时两句都进 top2，浪费名额）
  const byScore = [...Array(n).keys()].sort((a, b) => score[b] - score[a]);
  const order = byScore.filter(i => MUST.test(sents[i])).concat(byScore.filter(i => !MUST.test(sents[i])));
  const picked = [], used = [];
  for (const i of order) {
    if (used.some(u => similarity(tk[i], u) > 0.35)) continue;
    picked.push([score[i], sents[i], i]);
    used.push(tk[i]);
    if (picked.length >= top) break;
  }
  return picked.sort((a, b) => a[2] - b[2]);     // 按原文顺序返回
}

// 当前处理的文本是否"中文论文"（由 extractKeySentences 设置，供 scoreWeight 读）
let _CN_DOC = false;

function extractKeySentences(text, top = 5) {
  const sents = splitSentences(text);
  // 设好"是否中文论文"标志（供 scoreWeight 里的纯英文句降权用）
  const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  _CN_DOC = text.length > 0 && han / text.length > 0.15;
  return textrank(sents, top).map(x => x[1]);
}

// 章节抽取：**四通道 + 优先级**（逐行翻译 Python 版 paperlens.py:extract_outline）
//
// 为什么不用"全文扫一遍正则"：那样会把正文里所有像标题的都收进来
// （实测 Attention 那篇抽出 53 条，含 "O(n)"、"Pdrop"、"Google Brain"）。
// Python 版的做法是先试**论文自带的目录页**，抓到了就直接用。
function extractOutline(text, limit = 60) {
  const out = [];
  const seen = new Set();
  // 期刊页眉噪声（"计算机"、"软件学报"、"第 N 期"…）
  const NOISE = /^(计\s*算\s*机|软件\s*学报|电子\s*学报|中国\s*科学|第\s*\d+\s*期|第\s*\d+\s*卷|\d{4}\s*年)/;

  const add = (num, title, level, pos) => {
    num = (num || '').trim();
    // ★ pdf.js 抽出的 "1Introduction" 编号与标题之间**没有物理间隙**（两个 item 紧贴），
    //   所以行拼接时补不出空格。这里按"数字后面直接跟字母/汉字"切开补一格。
    if (!num && title) {
      const m0 = /^(\d{1,2}(?:\.\d{1,2}){0,3})(?=[A-Za-z\u4e00-\u9fff])/.exec(title);
      // ★ 只在"首段编号 <= 7"时才切 —— 论文的章节号不会到 18。
      //   不设这个上限，"18Transformer (base model)" / "12Input-Input Layer5"
      //   这类**表格行和图内标签**会被切成假的"编号+标题"（实测目录 20→26）。
      if (m0 && parseInt(m0[1], 10) <= 7) { num = m0[1]; title = title.slice(m0[1].length); }
    }
    title = (title || '').replace(/\s+/g, ' ').replace(/^[ .。:：·…\t]+|[ .。:：·…\t]+$/g, '');
    if (/^\d/.test(title)) return;                       // "1 1 绪论" 这种抓歪了
    if (!title || title.length > 40 || NOISE.test(title)) return;
    if (num && !/^\d{1,2}(\.\d{1,2}){0,3}$/.test(num)) return;   // 编号必须是 1 / 1.1 / 1.1.1
    if (!num) {
      const flat = title.replace(/ /g, '');
      if (['摘要', 'Abstract', '引言', '绪论', '结论', '结束语', '参考文献', '致谢'].includes(flat)) level = 1;
      else if (!level) return;
    }
    if (/[，,。；;：:、]/.test(title)) return;             // 有逗号句号 → 是句子
    if (/\d+(?:\.\d+)?\s*(?:%|ms|s\)|G\)|倍|L\))/.test(title)) return;   // 表格数据
    // ★ 表格行：抽取出的"编号+标题"其实是**表格里的一行**。
    //   实测 Attention p8 的 Table 3 行被拼成 "18Transformer (base model)"
    //   （整行原文是 "Transformer (base model) 27.3 38.1 3.3·10 18"）。
    //   判据：带小数/百分号的值 ≥ 2 个 → 是数据行，不是章节名。
    if ((title.match(/\d+\.\d+|\d+\s*%|·|×/g) || []).length >= 2) return;
    const key = (num || '') + title;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ level: level || (num ? num.split('.').length : 1), num, title, _pos: pos });
  };

  // ── ① 目录页 ──
  const tocM = /(?:^|\n)\s*目\s*录\s*\n/.exec(text);
  if (tocM) {
    let seg = text.slice(tocM.index + tocM[0].length, tocM.index + tocM[0].length + 8000);
    // 目录区到正文为止：正文段落长且有逗号句号，见到就截断
    const pm = /(?:^|\n)([^\n]{45,})/g;
    let m2;
    while ((m2 = pm.exec(seg)) !== null) {
      if (/[，,。；;]/.test(m2[1])) { seg = seg.slice(0, m2.index); break; }
    }
    // 形态 a：带点线的目录行 "1.1 研究背景 ...... 5"
    const reA = /(?:^|\n)\s*(?:(\d{1,2}(?:\.\d{1,2}){0,3})\s+)?([^\n.…·。]{2,40}?)\s*[.…。·]{2,}\s*\(?\s*(?:\d{1,4}|[IVX]{1,5})\s*\)?\s*(?=\n|$)/g;
    let a; while ((a = reA.exec(seg)) !== null) add(a[1], a[2], undefined, a.index);
    // 形态 b：无点线，编号 + 标题 + 换行
    const reB = /(?:^|\n)\s*(\d{1,2}(?:\.\d{1,2}){0,3})\s+([^\n.…·。]{2,40})\s*(?=\n)/g;
    let b; while ((b = reB.exec(seg)) !== null) add(b[1], b[2], undefined, b.index);

    if (out.filter(x => x.num).length >= 4) {
      out.sort((x, y) => x._pos - y._pos);
      out.forEach(x => delete x._pos);
      return out.slice(0, limit);
    }
    out.length = 0; seen.clear();     // 目录页不可靠 → 清空走后面的通道
  }

  // ── ② 正文小标题：编号 + 标题（行尾结束）──
  // ★ `\s+` 换成 `[ \t]+` —— 否则它会**吃掉换行**，把上一行的孤立数字和下一行的
  //   正文拼成假章节："18\nTransformer (base model)" 被匹配成 num=18/title=Transformer (base model)
  //   （实测 Attention p8 的 Table 3 数据行冒充分章节，目录 20→23 条）
  const re2 = /(?:^|\n)[ \t]*(\d{1,2}(?:\.\d{1,2}){0,3})(?:\n)?[ \t]*[、.．]?[ \t]*([\u4e00-\u9fffA-Za-z][^\n，。；,:：]{1,28})[ \t]*(?=\n|$)/g;
  let m; while ((m = re2.exec(text)) !== null) add(m[1], m[2], undefined, m.index);

  // ── ②b 编号脱节清理 ──
  // 表格里的孤立数字会被 ② 抓成"编号+标题"（实测 Attention p8 的 Table 3：
  // "18\nTransformer (base model)"、另外 "19\nTransformer (big)"）。
  // 判据：**只看正文小标题通道的连续编号段**——真章节的一级编号是 1,2,3…连着的；
  // 表格数字是孤立的、且明显超出已有上限。
  // 注意不能简单地"编号 > N 就丢"——附录编号合法到 A.1,而有些论文正文只到 4。
  // 所以用"脱节"判据：取正文通道里最多的一级编号连续段，其上限 +2 之外的丢掉。
  {
    const lv1 = out.filter(x => x.num && !x.num.includes('.'));
    if (lv1.length >= 3) {
      const nums = [...new Set(lv1.map(x => parseInt(x.num, 10)))].sort((a, b) => a - b);
      // 从 1 开始找最长连续段
      let bestEnd = 0, cur = 0;
      for (const n of nums) { if (n === cur + 1) { cur = n; bestEnd = n; } }
      if (bestEnd >= 2) {
        for (let k = out.length - 1; k >= 0; k--) {
          const nm = out[k].num;
          if (nm && !nm.includes('.') && parseInt(nm, 10) > bestEnd + 2) out.splice(k, 1);
        }
      }
    }
  }

  // ── ③ 中文编号：只有两种确定形态，别的都不认（放宽会把正文全抓成标题）──
  const re3 = /(?:^|\n)(?:[（(]\s*([一二三四五六七八九十]+)\s*[）)]|([一二三四五六七八九十]+))\s*\n([^\n]{2,30})\s*(?=\n)/g;
  while ((m = re3.exec(text)) !== null) {
    const t = m[3].trim();
    if (!/[，,。；;：:、]/.test(t)) add('', t, 1, m.index);
  }
  const re3b = /(?:^|\n)\s*([一二三四五六七八九十]+)\s*[、.．]\s*([^\n]{2,30})\s*(?=\n)/g;
  while ((m = re3b.exec(text)) !== null) {
    const t = m[2].trim();
    if (!/[，,。；;：:、]/.test(t)) add('', m[1] + '、' + t, 1, m.index);
  }

  // ── ④ 无编号固定标题 ──
  const re4 = /(?:^|\n)\s*(摘\s*要|Abstract|引\s*言|绪\s*论|结\s*论|结束语|参考文献|致\s*谢)\s*(?=\n|$)/gi;
  while ((m = re4.exec(text)) !== null) add('', m[1].replace(/\s+/g, ''), undefined, m.index);

  out.sort((x, y) => x._pos - y._pos);
  out.forEach(x => delete x._pos);
  return out.slice(0, limit);
}

// 目录清理：丢掉"被夹在兄弟序列中间的外来条目"
// 实测残留垃圾 "9 以提高算法精度" 夹在 2.3.1 与 2.3.2 之间，
// 它 len=7、不以连词开头、编号还递增，词形判据全拦不住；
// 但**前后邻居共享父前缀 2.3、它不属于** → 语义上很明显是外来者。
function dropInterspersed(items) {
  const pfx = (num) => (num || '').includes('.') ? num.replace(/\.[^.]*$/, '') : '';
  const keep = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const num = (it.num || '').trim();
    if (num && i > 0 && i + 1 < items.length) {
      const a = (items[i - 1].num || '').trim();
      const b = (items[i + 1].num || '').trim();
      const pa = pfx(a), pb = pfx(b);
      if (pa && pa === pb && pfx(num) !== pa && !num.includes('.')) continue;
    }
    keep.push(it);
  }
  return keep;
}

// 判断一个标题串像不像**章节名**（而不是被误抽的正文/表格行/图内标签）
//
// ★ 长度阈值必须**按语言分**。中文一个字符是一个信息单位，英文一个词才是 ——
//   "Scaled Dot-Product Attention" 28 字符、中文"实体抽取"4 字，量纲根本不同。
//   实测教训：拿"中文 16 字"去卡英文，Attention 那篇的 Model Architecture /
//   Why Self-Attention / Machine Translation 全被砍，**目录从 32 条掉到 9 条**。
function looksLikeHeading(t) {
  const nCjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  if (nCjk >= 4) {                                   // 中文标题
    if (nCjk <= 8) return true;                      // "实体抽取" "问题与挑战" "结束语"
    if (/[，。；,;]/.test(t)) return false;            // 带标点 = 句子
    if (nCjk > 16) return false;                     // 超 16 字的中文标题不存在
    // 以助词/介词收尾 = 半句话（"…中抽取实" 的"实"是"实体"被截断）
    if (/(的|了|是|在|和|与|对|从|把|被|为|以|中|上|下)$/.test(t)) return false;
    return true;
  }
  // 英文标题：词数 ≤ 6 且没有整句特征
  if (t.split(/\s+/).length > 6) return false;
  if (/[.;:]\s|\b(is|are|was|were|has|have|we|our|this|that)\b/i.test(t)) return false;
  // ★ 驼峰/连写的产品名不是章节名 —— 实测中文论文的表格里
  //   "WatsonKB TheWorldBook"、"GoogleSeachEngine Wikipedia Freebase"
  //   被当成"3 章"，混进目录（正文是中文，真章节名不会长这样）。
  //   判据：≥2 个词、且**大部分词是驼峰或没有空格分隔的小写连写**。
  //   判据只认**驼峰**（小写紧跟大写）和**超长连写**，不算连字符复合词 ——
  //   实测踩过：把 length >= 9 也算进去后，"Multi-Head Attention"(10+9)、
  //   "Scaled Dot-Product Attention" 这些**真章节名**被误杀，英文目录 20→18。
  //   连字符复合词是学术英文的正常构词法，不能当"产品名"特征。
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const camel = words.filter(w => /[a-z][A-Z]/.test(w)).length;      // WatsonKB / TheWorldBook
    const glued = words.filter(w => w.length >= 12 && !w.includes('-')).length;  // GoogleSeachEngine
    if (camel + glued >= 2) return false;
  }
  return true;
}

// 目录清理（逐行翻译 paperlens.py:_clean_outline + _drop_interspersed）
//
// ★ 血泪史（别简化）：
//   ① 全局"编号必须递增" → 一个垃圾条目把编号进度推上去，后面 3/4/5/6 四个
//      真章节全判"倒退"丢掉（26 条目录只剩 8 条）
//   ② 改成同前缀比 + 先过滤不像章节名的 → 21 字的垃圾被拦，7 字的又顶上
//   根因：靠"编号必须递增"本身就脆。所以这里只做**弱检查**（同前缀下重复才丢），
//   真兜底交给最后那道语义判据：父节点是否存在。
function cleanOutline(outline) {
  const out = [], seen = new Set(), lastByPrefix = new Map();
  const LEVELS = ['big','small','base','ours','the','a','an','and','or','of','in','on','for','with'];

  for (const raw of outline) {
    let it = raw;
    const t = String(it.title || '').trim();
    if (!t || t.length > 40) continue;
    if (/\[\d+\]|\(\d{4}\)/.test(t)) continue;                     // 引用标记
    if (/^\d+(\.\d+)*$/.test(t)) continue;                         // 纯数字
    if (LEVELS.includes(t.toLowerCase())) continue;
    // 表头残片："Transformer (4 layers)"
    if (/^[A-Za-z\-\s]+\s*\(\s*\d+\s*(layers?|heads?|d_model)?\s*\)$/i.test(t)) continue;

    let num = String(it.num || '').trim();
    // 层级一律按**编号里的点数**算，不信抽取器给的 level ——
    // 实测 "3.3 Scaled..." 被抓成 num="3"/level=1，结果 3.2.1 找不到父节点 3.2
    if (num && /^\d+(\.\d+)*$/.test(num)) it = Object.assign({}, it, { level: num.split('.').length });

    // ★ 不像章节名的项要在**编号判定之前**丢掉，且不参与进度更新 ——
    //   否则垃圾条目的编号会把进度推上去，后面一整支真章节全被误判（实测 26→8）
    if (num && !looksLikeHeading(t)) continue;
    if (num) {
      const pfx = num.includes('.') ? num.slice(0, num.lastIndexOf('.')) : '';
      if (lastByPrefix.get(pfx) === num) continue;   // 同前缀下同编号重复 = 抽取错误
      lastByPrefix.set(pfx, num);
    }
    const key = (num || t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  // ★ 按编号把带编号的条目排回正确顺序 —— 双栏 PDF 里左右栏各自成流，
  //   章节标题在两栏的 y 位置不同，抽出来的顺序会是
  //   "2.2.1 实体链接（左栏）→ 2.2 知识融合（右栏）"、（实测）
  //   "3.2 跨语言知识链接 → 3.1 跨语言知识抽取"。
  //   编号本身就是权威顺序，按数字段逐级比较即可（2.10 > 2.2 也说对了）。
  //   无编号条目（摘要/结论/致谢）不参与排序，保持原相对位置。
  const keyed = [], free = [];
  out.forEach((it, i) => {
    const num = String(it.num || '').trim();
    if (/^\d+(\.\d+)*$/.test(num)) keyed.push({ it, i, parts: num.split('.').map(Number) });
    else free.push({ it, i });
  });
  if (keyed.length >= 4) {
    keyed.sort((a, b) => {
      for (let k = 0; k < Math.max(a.parts.length, b.parts.length); k++) {
        const x = a.parts[k] ?? -1, y = b.parts[k] ?? -1;
        if (x !== y) return x - y;
      }
      return a.i - b.i;                       // 同编号再看原始位置
    });
    // 合并：无编号项按它们的原始下标插回去，尽量不改变相对次序
    const merged = [];
    let ki = 0;
    const freeBefore = (pos) => free.filter(f => f.i < pos);
    let usedFree = new Set();
    for (const k of keyed) {
      for (const f of free) {
        if (!usedFree.has(f.i) && f.i < k.i) { merged.push(f.it); usedFree.add(f.i); }
      }
      merged.push(k.it);
    }
    for (const f of free) if (!usedFree.has(f.i)) merged.push(f.it);
    out.length = 0; merged.forEach(x => out.push(x));
  }
  return dropInterspersed(out);
}

// 丢掉"被夹在兄弟序列中间的外来条目"（如 "9 以提高算法精度"）
// 判据只用一件事：前后邻居有共同父前缀、而它没有 → 外来者
//   2.3.1 / [9] / 2.3.2  → 前后都是 2.3.x → 丢
//   1 / 2 / 3            → 前后无共同父前缀 → 保留
function dropInterspersed(items) {
  const pfx = n => n.includes('.') ? n.slice(0, n.lastIndexOf('.')) : '';
  const keep = [];
  for (let i = 0; i < items.length; i++) {
    const num = String(items[i].num || '').trim();
    if (num && i > 0 && i + 1 < items.length) {
      const a = String(items[i-1].num || '').trim();
      const b = String(items[i+1].num || '').trim();
      const pa = pfx(a), pb = pfx(b);
      if (pa && pa === pb && pfx(num) !== pa && !num.includes('.')) continue;
    }
    keep.push(items[i]);
  }
  return keep;
}

// ★ 四个分区正则，逐行照搬 paperlens.py（每条都对应实测坑）：
//   _ABSTRACT  可带编号、可有冒号
//   _INTRO     **要求标题后跟换行**（说明是独立行）—— 写成行尾匹配会命中正文里
//              随便一个 "Introduction"（实测把 intro 定位到 offset 2700）
//   _INTRO_FALLBACK  中文论文常把首章叫"研究背景/概述/相关工作"而不叫"引言"，
//              没兜底就整篇找不到引言
//   _CONCL     "可选编号 + 章名"一个分支覆盖两种（原正则把"结束语"写成无编号分支，
//              而中文期刊实际是"6 结束语" → 永远匹配不到）
const _ABSTRACT = /(?:^|\n)\s*(?:摘\s*要|内容提要|Abstract)\s*[:：]?\s*\n?/;
// ★ 加"编号 + 空格 + Introduction **同行**"这一支 —— 原来只认 `1\nIntroduction`（分行）
//   和中文的 `1 引言`，而英文论文绝大多数是 "1 Introduction" 同行排版，
//   于是 intro 永远定位失败 → "为什么做"只能从正文乱抓（实测 Attention 那篇）。
const _INTRO = /(?:^|\n)\s*(?:1\s*[\.、]?\s*(?:引\s*言|绪\s*论|\s*Introduction)|一\s*[、.]?\s*(?:引\s*言|绪\s*论)|1\s*\n\s*Introduction)\s*\n/i;
const _INTRO_FALLBACK = /(?:^|\n)\s*(?:1|一)\s*[\.、]?\s*(?:研究背景|背景|概述|引言|绪论|相关工作)\s*\n/;
// ★ 候选词要含"总 结"（汉字被空格拆开的形态）。
//   实测《卷积神经网络研究综述》的结论标题是 "7 总 结" ——
//   旧正则只有"结 论|结束语|结 语|总结与展望|结论与展望"，匹配不到，
//   导致 conclusion 为空 → 「🔚 作者自己怎么收尾」整个板块消失。
//   这是第三次遇到"汉字被字距拆开"（前两次：作者行、中文标题）。
const _CONCL = /(?:^|\n)\s*(?:\d{1,2}\s*[\.、]?\s*)?(?:结\s*论|总\s*结|结\s*束\s*语|结\s*语|总\s*结\s*与\s*展\s*望|结\s*论\s*与\s*展\s*望|Conclusion|Conclusions)\s*[:：]?\s*\n/;

/* ---------- 章节定位（摘要/引言/正文/结论） ---------- */
// 定位不到就返回空串 —— 不崩、不猜。
function locateSections(text) {
  const out = { abstract: '', intro: '', body: '', conclusion: '' };

  const find = (re, from = 0) => {
    const sub = text.slice(from);
    const m = re.exec(sub);
    return m ? [from + m.index, from + m.index + m[0].length] : null;
  };

  const ab = find(_ABSTRACT);
  let intro = find(_INTRO);
  // 没有"引言"标题时退化：从摘要之后找"1 研究背景/概述/相关工作"这类首章标题
  if (!intro && ab) intro = find(_INTRO_FALLBACK, ab[1]);
  const concl = find(_CONCL);
  const refs = findRefsStart(text);

  if (ab) {
    // 摘要右边界：引言之首，否则往后看 2500 字
    let end = (intro && intro[0] > ab[1]) ? intro[0] : Math.min(ab[1] + 2500, text.length);
    let seg = text.slice(ab[1], end);
    // 中文期刊常"英文摘要在前、中文摘要在后"，2500 字窗口把中文那份截掉。
    // 判据不看"中文多少"，看**段首英文、段内有中文** = 双语摘要。
    const head = seg.slice(0, 200).replace(/\s+/g, '');
    if (CJK_RE.test(seg) && !CJK_RE.test(head)) {
      end = (intro && intro[0] > ab[1]) ? intro[0] : Math.min(ab[1] + 8000, text.length);
      seg = text.slice(ab[1], end);
    }
    out.abstract = seg.trim();
  }
  if (intro) {
    const end = (refs > intro[1]) ? refs : text.length;
    out.intro = text.slice(intro[1], end).trim();
  }
  if (concl) {
    const end = (refs > concl[1]) ? refs : text.length;
    out.conclusion = text.slice(concl[1], end).trim();
  }
  // ★ 正文起点：有引言就从引言后算；**没有引言**（英文论文的 "1 Introduction" 常因
  //   版式抽不到、中文期刊引言标题各异）时以前是 0 —— 于是封面/版权声明/作者单位/
  //   基金号全被当成"方法"（实测英文 body 首行是 Google 的版权许可、
  //   中文首行是英文作者单位）。这里改成：退化到"摘要之后"，再兜底跳段首元信息。
  let bStart = intro ? intro[1] : 0;
  if (!intro) {
    if (ab) bStart = ab[1];
    // 再往后跳掉段首那层元信息（刊名/作者/单位/版权），取第一个像正文的行
    const win = text.slice(bStart, bStart + 6000);
    const lines = win.split('\n');
    // 第一层：跳过元信息行
    const tail = skipFrontMeta(win);
    const firstReal = tail.split('\n').findIndex(l => l.trim().length >= 40);
    if (firstReal >= 0) bStart += lines.slice(0, firstReal).join('\n').length;
    // 第二层：中文期刊常"英文摘要在前、中文摘要/正文在后"，落在英文段里要往后跳。
    //   判据：当前行汉字数 < 3（纯英文），且往后 60 行内能找到汉字密集的行。
    const probe = text.slice(bStart, bStart + 6000).split('\n');
    let j = 0;
    while (j < probe.length && (probe[j].match(/[\u4e00-\u9fff]/g) || []).length < 3) j++;
    if (j > 2 && j < probe.length) {
      // 只有"后面确实有中文正文"时才跳（否则英文论文会被跳空）
      const ahead = probe.slice(j).join('').match(/[\u4e00-\u9fff]/g) || [];
      if (ahead.length > 200) bStart += probe.slice(0, j).join('\n').length;
    }
    // ponytail: 不跳"摘要块本身"。试过用"摘要标题 -> 第一个小标题"定位正文起点，
    //   结果英文跳过了整节 Introduction（落到 Background）、中文跳到正文中间。
    //   方法列抓到摘要是可接受的（摘要就是"这篇做了什么"的最好概述）。
    //   要精确到方法段，上 section_role() 的章节角色判定。
  }
  const bEnd = concl ? concl[0] : refs;
  if (bEnd > bStart) out.body = text.slice(bStart, bEnd).trim();
  return out;
}

/* ---------- 图表标题 ---------- */
// 图表清单（图/表标题）
// ★ 双栏 PDF 的图注常被换行拆断（实测 "Fig.1 Technicalarchite"），
//   所以允许标题**跨行续抓**；但遇到下一个"图N/表N"、小节编号、或空行就停 ——
//   不设这个刹车会把整段正文都吞进图注里。
function extractFigures(text, limit = 12) {
  const out = [];
  const re = /(?:^|\n)[ \t]*((?:图|表|Figure|Fig\.?|Table|TABLE)\s*\d{1,2})\s*[:：.]?[ \t]*([^\n]{0,90})/g;
  let m;
  while ((m = re.exec(text)) !== null && out.length < limit) {
    let title = m[2] || '';
    // 跨行续抓：**只处理英文断词**（"Technicalarchite" + "ctureof..."）。
    //   为什么不用"行长度"判据：双栏分流后每行只有半栏宽、普遍 20~40 字，
    //   长度阈值拦不住正文（实测 35 和 60 都试过，照样把"则构成网络中的边…"吞进来）。
    //   断词的判据很硬：当前 title 以字母结尾 + 下一行以小写字母开头 + 拼起来是单词。
    if (/[A-Za-z]$/.test(title)) {
      const tail = text.slice(m.index + m[0].length).replace(/^\n+/, '');
      const first = (tail.split('\n')[0] || '').trim();
      // 只接"纯小写字母/连字符开头且不含 CJK、不含空格"的续行 —— 这是断词后半截的样子
      //   结尾允许一个句点（"ctureofknowledgegraph." 这种断词后半截常带句末标点）
      if (first && /^[a-z][a-z\-]{2,}\.?$/.test(first)) title += first;
    }
    const s = (m[1] + ' ' + title).replace(/\s+/g, ' ').trim();
    // 只保留有实际标题的（"图 3" 光秃秃一条没意义）
    if (s.length > 10 && !out.includes(s)) out.push(s);
  }
  return out;
}


/* ---------- 论证链（背景 → 问题 → 方法 → 结果） ---------- */
// 纯算法做法：**不用理解语义，用位置**。
//   背景 = 引言开头 1-2 句（作者一定先讲领域处境）
//   问题 = 引言末尾（作者在引出自己工作前点明痛点）
//   方法 = 正文最开头（先剥掉刊名/DOI/作者单位那层元信息）
//   结果 = 结论开头
// 这个"位置区间"规则在项目里实测稳定（前 3 句=摘要区、后 3 句=结论区）。
// 收尾句挑选 —— 结论段里挑"作者在总结自己做了什么"的句子。
// 旧做法：结论段原文前 3 句。实测中文那篇第 1 句是
//   "互联网正从…文档万维网转变成…数据万维网"（背景铺垫，不是结论）。
// 新做法：结论段内按"自指 + 总结动词"打分排序。
function pickClosing(sentences, limit, excludeSet) {
  const cand = [];
  for (const s of (sentences || [])) {
    if (!s || s.length < 25 || judge(s).junk) continue;
    let v = 0;
    // 自指（在讲"本文/我们"）—— 结论句一定自指
    if (/(本文|我们|笔者|\bwe\b|\bour\b|\bthis (paper|work)\b)/i.test(s)) v += 3;
    // 总结动词
    if (/(提出|构建|设计|分析|总结|调研|presented|proposed|introduced|shown|demonstrated|developed|conclude|summary)/i.test(s)) v += 2;
    // 未来工作
    if (/(未来|后续|进一步|有待|future|plan to|extend)/i.test(s)) v += 1;
    // "价值/意义"类泛句扣分（不是结论，是感想）
    if (/(具有重要的|具有广阔|意义重大|具有重要价值|promising|important (value|significance))/i.test(s)) v -= 2;
    const len = s.length;
    if (len >= 30 && len <= 240) v += 0.5;
    // ★ 已被别的板块（做出了什么/为什么做）用过的句子 → 重扣（不是硬排除）。
    //   实测踩坑：在 index.html 里"先排序再传进来"没用 —— 本函数内部会重新打分排序，
    //   调用方给的顺序被覆盖干净，所以那句照样被选中
    //   （知识图谱：本文从知识图谱构建的视角…同时进「做出了什么」和「怎么收尾」）。
    //   扣 10 分而非 continue：结论段很短时（实测 3 句）若全被排除会让板块整个空掉，
    //   宁可重复也不能没有内容。
    if (excludeSet && excludeSet.has(s)) v -= 10;
    cand.push([v, s]);
  }
  cand.sort((a, b) => b[0] - a[0]);
  return cand.slice(0, limit).map(x => x[1]);
}

// 论证链 v2 —— 用三个**经检验的判断**取句，不再按位置切片。
//
// 旧版（位置切片）的问题：背景=引言前 2 句、问题=引言末尾、方法=正文开头。
// 实测抓到 "Acknowledgements We are grateful to Nal Kalchbrenner…" 当"问题" ——
// 因为致谢段恰好落在被切的位置上。位置规则在 PDF 抽取有噪声时不可靠。
//
// 新版：四段各用最合适的判据
//   背景 = 位置先验（该走 positionBonus，因为"背景"没有可靠的字面特征）
//   问题 = judge 的 gap 判断（精确 0.912）
//   方法 = judge 的 method 判断（精确 0.810）
//   结果 = judge 的 effect 判断（精确 0.908）
function argumentChain2(sents, sections, keySentences) {
  const rows = [];
  const jc = judgeCounts(sents || []);

  // 背景：没有可靠的字面判据（"背景句"和普通陈述句字面一样），
  // 所以走**位置先验** —— 全文前 15% 里的长句。这是唯一该用位置的栏。
  const n = (sents || []).length;
  // 「背景」= 全文前 15% 里**最像"讲领域"**的那句。
  // ★ 踩的坑：只按"前 15% + 长度 + 非 junk"取，实测抓到的是
  //   CNN综述的期刊页眉（"第40卷第6期计算机学报 Vol.40 No.6…"）和
  //   微博情感那篇的学位论文授权声明（"授权华中科技大学可以将本学位论文…"）。
  //   这两类都在前 15% 里、长度也合适 —— 但都不是背景。
  //   加两条排除：期刊页眉特征词 / 学位论文声明特征词。
  const FRONTJUNK = /(第\s*\d+\s*卷|Vol\.\s*\d+|No\.\s*\d+|ISSN|CN\s*\d|出版日期|收稿日期|授权|学位论文(作者签名|版权)|编入有关数据库|除文中已经标明引用的内容外|本声明的法律结果|指导教师签名|保密□|分类号|密级|学号)/i;
  const head = (sents || []).slice(0, Math.max(1, Math.round(n * 0.15)))
    .filter(s => s.length >= 40 && s.length <= 300 && !judge(s).junk && !FRONTJUNK.test(s));
  if (head.length) rows.push(['背景', head[0]]);

  const pick1 = (which) => {
    const got = pickJudged(sents, which, 1);
    return got.length ? got[0] : null;
  };
  const g = pick1('gap');
  if (g) rows.push(['问题', g]);
  const m = pick1('method');
  if (m) rows.push(['方法', m]);
  const e = pick1('effect');
  if (e) rows.push(['结果', e]);

  return rows;
}

function argumentChain(sections, keySentences) {
  const secs = sections || {};
  const ks = (keySentences || []).filter(Boolean);

  const parts = (seg, nHead = 2, nTail = 1) => {
    if (!seg) return [];
    let p = seg.split(/(?<=[。！？])|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
    p = p.filter(s => s.length >= 20 && s.length <= 400);
    if (!p.length) return [];
    return p.slice(0, nHead).concat(nTail ? p.slice(-nTail) : []);
  };
  const join = (xs, limit = 220) => {
    // ★ 把软换行连成一句：双栏 PDF 的段落被切成多个短行，行尾没有句末标点时
    //   下一行是同一句的延续 —— 直接 join(' ') 会得到
    //   "…引起了广泛关注,由于公 开 披 露 的 技 术 资 料 较 少\n该技术的内涵和价值."
    //   这种带换行的半截句（实测论证链的"方法"栏）。
    //   判据：行尾无 [。.!?！？] → 连上（去掉换行，中文直接拼、英文补空格）。
    let t = '';
    for (let i = 0; i < xs.length; i++) {
      const seg = xs[i].trim();
      if (!seg) continue;
      if (!t) { t = seg; continue; }
      const needsSpace = /[A-Za-z0-9]$/.test(t) && /^[A-Za-z0-9]/.test(seg);
      t += (needsSpace ? ' ' : '') + seg;
    }
    t = t.replace(/\s+/g, ' ').trim();
    return t.length > limit ? t.slice(0, limit) + '…' : t;
  };

  const rows = [];
  const bg = parts(secs.intro, 2, 0);
  if (bg.length) rows.push(['背景', join(bg)]);

  // 问题 = 引言末尾（作者引出自己工作前一定先讲"卡在哪"）
  const intro = secs.intro || '';
  if (intro.length > 1200) {
    const tail = parts(intro.slice(-1200), 0, 1);
    if (tail.length) rows.push(['问题', join(tail, 200)]);
  }

  // 方法 = 正文开头 —— 必须先剥掉刊名/DOI/单位/基金那层元信息，
  // 否则中文期刊会把"计算机研究与发展 DOI:10.7544/… (电子科技大学…)"当方法
  const body = skipFrontMeta(secs.body || '');
  if (body) {
    const head = parts(body.slice(0, 1500), 2, 0);
    if (head.length) rows.push(['方法', join(head)]);
  }

  const concl = secs.conclusion || '';
  if (concl) {
    const head = parts(concl.slice(0, 1200), 2, 0);
    if (head.length) rows.push(['结果', join(head)]);
  }

  // 兜底：上面某一步没拿到，用 TextRank 的核心句补
  if (rows.length < 3 && ks.length) {
    for (let i = 0; i < Math.min(ks.length, 4 - rows.length); i++) {
      rows.push(['要点 ' + (i + 1), ks[i].slice(0, 220)]);
    }
  }
  return rows;
}

// 剥掉段首那层元信息（刊名/DOI/作者/单位/基金/邮箱/版权声明/水印）
// ★ 判据不能只看长度 —— 实测两篇的段首元信息都**很长**：
//   英文 "Provided proper attribution is provided, Google hereby grants permission to"(75)
//   中文 "(Schoolo InormationandSotwareEnineerin ,Universit o Electronic...)"（作者单位，很长）
//   所以长度阈值只当辅助，主力是**特征词**：版权/许可/水印/单位/邮箱/DOI。
function skipFrontMeta(text, maxScan = 40) {
  const lines = (text || '').split('\n');
  const META = /(DOI|doi\.org|arXiv|ISSN|Vol\.|第\s*\d+\s*卷|版权|著作权|©|\(C\)\s*\d{4}|all rights reserved|grants? permission|permission to (reproduce|copy)|provided proper attribution|journalistic or scholarly|@[\w.-]+\.\w{2,}|基金|资助|项目编号|收稿|修回|作者简介|通信作者|\bUniversity\b|\bInstitute\b|\bCollege\b|\bSchool of\b|大学|学院|研究所|实验室|有限公司|\(liu|electron|技术大学|信息与|工程|成都|北京\s*\d{6}|邮编)/i;
  const isMetaLine = (s) => {
    if (META.test(s)) return true;
    if (/^\s*[（(].{0,120}[)）]\s*$/.test(s)) return true;          // 整行被括号包住 = 单位/邮箱
    if (/^[\s∗\*†‡§·、,，.。\-–—0-9]+$/.test(s)) return true;        // 纯符号/数字（脚注标记行）
    if (s.length < 45 && !/[。.．!?！？]\s*[A-Z\u4e00-\u9fff]/.test(s) && s.split(/\s+/).length <= 6) return true;
    return false;
  };
  let i = 0;
  while (i < lines.length && i < maxScan) {
    const s = lines[i].trim();
    if (!s) { i++; continue; }
    if (!isMetaLine(s)) break;
    i++;
  }
  return lines.slice(i).join('\n');
}

/* ---------- 核心句的功能标签（读者按"我要找什么"去读） ---------- */
const PATTERN_HINT = [
  [/\b(we (propose|present|introduce|develop|design))\b/i, '提出型'],
  [/\b(we (show|find|demonstrate|observe|report))\b/i, '发现型'],
  [/\b(outperform|achieve|improve|state-of-the-art)\b/i, '成效型'],
  [/\b(limitation|future work|remain|open problem)\b/i, '局限型'],
  [/\b(because|since|therefore|thus|hence)\b/i, '因果型'],
  [/\b(compared (to|with)|baseline|ablation)\b/i, '对比型'],
  [/本文(提出|采用|设计|构建)/, '提出型'],
  [/(结果表明|实验表明|研究发现|数据显示)/, '发现型'],
  [/(优于|超过|提升了|达到了)/, '成效型'],
  [/(局限|不足|未来工作|有待)/, '局限型'],
  [/(因此|所以|从而|由此可见)/, '因果型'],
  [/(对比|相比|基准|消融)/, '对比型'],
];
function tagSentence(s) {
  for (const [re, name] of PATTERN_HINT) if (re.test(s)) return name;
  return '陈述型';
}



/* ---------- 贡献句词表（从**自己的 3611 篇 arXiv 语料**学的） ----------
   正样本 = 含 "we propose / this paper presents" 等宣称贡献句式（11137 句）
   负样本 = 其余 99373 句；取 log 似然比 llr >= 1.3 的词。

   为什么不用 PubMed 那份：那是**医学摘要**，迁到通用论文实测失效
   （真实论文 6 句只判对 2 句还判错）。数据不对口，调阈值救不了。
   这份从同分布语料学，才是对的 —— "propose" 正 2875 / 负 551（5.2 倍）。

   重跑：python research/build_lexicon_local.py → lexicon_local.json
*/
const ROLE_LEXICON = {
  // 指示"作者在宣称贡献"（正样本倾向）
  CONTRIB: ["hypothesize","propose","argue","introduce","investigates","observe","novel","present","formulate","proposes","find","show","framework","summarized","method","contributions","two-stage","demonstrate","approach","leverages","exploits","develop","construct","inspired","address","combines","outperforms","paper","introduces","outperforming","incorporates","innovative","baselines","report","alleviate","margin","bridge","overcome","called","presents","contribution"],
  // 排斥（在背景铺垫/解释句里更常见）—— 用于反向降分
  ANTI: ["because","often","example","due","researchers","keywords","although","what","people","still","instance","requires","like","since","one","despite","meaning","made","limited","part","rely","focus","especially","known","see"],
};

// 打分：一句里命中的贡献词数 - 0.5 × 命中的背景词数
// （不搞复杂加权，命中数就是最稳的信号）
// ★ 必须用**词边界**匹配，不能用 includes()。
//   实测的坑：`one` 是子串，`dependencies` / `component` / `done` 全都会命中它 ——
//   "relying entirely on an attention mechanism to draw global dependencies"
//   这句命中了 ANTI 的 `one`，把真信号（propose）的分数从 1 压到 0.5，整句判成 null。
//   短词（one/part/like/due/made/what/what/still）在英文里几乎都是子串，必须 \b 包起来。
function hitWord(low, w) {
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z])' + esc + '([^a-z]|$)').test(low);
}
function roleScores(sent) {
  const low = sent.toLowerCase();
  const isCn = /[\u4e00-\u9fff]/.test(sent);
  let pos = 0, neg = 0;
  for (const w of ROLE_LEXICON.CONTRIB) if (hitWord(low, w)) pos++;
  if (!isCn) for (const w of ROLE_LEXICON.ANTI) if (hitWord(low, w)) neg++;
  return { pos, neg, score: pos - 0.5 * neg };
}

// 判定：是不是"作者在说自己做了什么"的句子。
// ★ 阈值**分语言**（实测过，一个阈值管两种语言是错的）：
//   英文词表命中稀疏（"sought to determine"只中 1 个）→ 1 个就认；
//   中文没有受控词表，靠下方的 CN 关键词表，命中密集 → 要 2 个。
const CN_CONTRIB = ["目标","目的","本文","旨在","探讨","研究目的","拟","旨在探讨","分析其","探索"];
const CN_ANTI = ["背景","现状","近年来","随着","尚不","空白","前人","发现","达到","提升","优于","准确率","证明","说明","结果表"];

function roleOf(sent) {
  const low = sent.toLowerCase();
  if (/[\u4e00-\u9fff]/.test(sent)) {
    let p = 0, n = 0;
    for (const w of CN_CONTRIB) if (low.includes(w)) p++;
    for (const w of CN_ANTI) if (low.includes(w)) n++;
    return (p >= 2 && p > n) ? 'CONTRIB' : null;
  }
  const s = roleScores(sent);
  return s.pos >= 1 && s.score >= 1 ? 'CONTRIB' : null;
}

/* ---------- 位置先验（从语料统计出来的，不靠读懂句子） ---------- */
// 思路：论文的结构高度固定 —— 贡献句、转折句、实验细节句、结论句
// **各自出现在全文的哪一段**是可以统计的（arXiv 3611 篇跑出来的分布，见
// research/position_prior.py 与 weights.json 里的 prior 字段）。
//
// 用途：给一句话打分时，看它落在"这类内容常见区间"就提权、落在别处就降权。
// 这不依赖任何语义理解，纯概率 —— 而且比模型稳的地方在于**可解释、可画图**：
// 曲线摆出来，谁都能看出"贡献句为什么该在 0.1-0.4 区间"。
//
// ★ 区间来自**全量**语料：research/position_prior.py 扫 train_v3.jsonl（3611 篇 / 110510 句）。
//   每类给 [q15, q85] 也就是"70% 的这类内容落在哪一段"，以及样本量。
//   小样本会骗人：结论句中位位置在 30 条样本时算出 0.308（看着挺合理），
//   样本涨到 1206 条后变成 0.615 —— 差一倍。贡献句 8159 条 → 0.436，
//   与 120 篇小样本完全一致，说明这个数已经稳了。
//   重跑：python research/position_prior.py --in train_v3.jsonl --out _prior_full.json
const POSITION_PRIOR = {
  // name: [常见区间下限, 上限, 提权倍数]   样本量在注释里
  贡献句:   [0.077, 0.769, 1.25],   // n=8159   中位 0.436
  转折句:   [0.077, 0.795, 1.15],   // n=11607  中位 0.410
  成效句:   [0.077, 0.795, 1.10],   // n=3245   中位 0.333
  实验细节: [0.103, 0.897, 1.00],   // n=807    中位 0.667（中性，只用来识别"这段是实验区"）
  结论句:   [0.154, 0.872, 1.30],   // n=1206   中位 0.615
  未来工作: [0.154, 0.872, 1.25],   // n=338    中位 0.615
  图表标题: [0.256, 0.923, 1.00],   // n=3074   中位 0.641
  引用句:   [0.205, 0.872, 1.00],   // n=5035   中位 0.615
};

// 一句话落在第几类内容的常见区间里（可叠多个 → 取最大倍数）
function positionBonus(s, rel) {
  if (rel == null || !isFinite(rel)) return 1.0;
  let mult = 1.0;
  if (/(we (propose|present|introduce|develop|design)|our (main )?(contribution|method|approach)|(this|the present) (paper|work|study) (presents?|proposes?|introduces?))/i.test(s)) {
    const [lo, hi, m] = POSITION_PRIOR.贡献句;
    if (rel >= lo && rel <= hi) mult = Math.max(mult, m);
  }
  if (/^(however|but|although|despite|while|yet|nevertheless)\b|\b(however|limitation|challeng|remain|difficult)/i.test(s)) {
    const [lo, hi, m] = POSITION_PRIOR.转折句;
    if (rel >= lo && rel <= hi) mult = Math.max(mult, m);
  }
  if (/\b(outperform|achiev|improv|state-of-the-art|better than)\b|\d+\.?\d*\s*(%|bleu|f1|accuracy)/i.test(s)
      && !/\b(gpu|batch|epoch|learning rate|dropout|warmup)\b/i.test(s)) {
    const [lo, hi, m] = POSITION_PRIOR.成效句;
    if (rel >= lo && rel <= hi) mult = Math.max(mult, m);
  }
  if (/\b(in conclusion|to conclude|in summary|we have (shown|presented|proposed)|this paper (has )?(presented|proposed))\b/i.test(s)) {
    const [lo, hi, m] = POSITION_PRIOR.结论句;
    if (rel >= lo && rel <= hi) mult = Math.max(mult, m);
  }
  if (/\b(future work|in the future|we plan to|would be interesting|further (work|research))\b/i.test(s)) {
    const [lo, hi, m] = POSITION_PRIOR.未来工作;
    if (rel >= lo && rel <= hi) mult = Math.max(mult, m);
  }
  return mult;
}

/* ---------- 英中术语对照（零 AI 的"翻译"能做到的上限） ---------- */

// ★ 为什么不做"整句翻译"：那是机器翻译的活，纯算法做不到。
//   逐词查表拼出来的句子不可读，例：
//   "based solely on attention mechanisms, dispensing with recurrence"
//   → "基于 仅仅 在 注意力 机制 免除 与 循环"（语法正确但不成立）
//   用户明确要求过"不能有 AI"、"不要 API"，所以不给假翻译。
//
//   能给的是**术语级对照**：把英文论文里的专业词标出中文对应，
//   读者看英文原句时能对上号。这也是真正有用的部分 ——
//   专业词不认识才读不下去，冠词介词不影响理解。
//
// 词表来源：论文领域通用术语（NLP / 深度学习 / 通用科研），人工整理。
// 只收"一个英文词对应一个稳定中文译法"的，不收多义/语境依赖的。
const TERM_CN = {
  // ── 注意力/Transformer（这篇的主场）
  'attention': '注意力', 'self-attention': '自注意力', 'multi-head': '多头',
  'transformer': 'Transformer（原论文不译）', 'encoder': '编码器', 'decoder': '解码器',
  'embedding': '词嵌入', 'positional encoding': '位置编码', 'softmax': '归一化指数（Softmax）',
  'dot-product': '点积', 'sequence': '序列', 'token': '词元',
  // ── 训练/模型通用
  'recurrence': '循环', 'recurrent': '循环的', 'convolution': '卷积', 'convolutional': '卷积的',
  'layer': '层', 'neural network': '神经网络', 'architecture': '架构', 'model': '模型',
  'training': '训练', 'regularization': '正则化', 'dropout': '随机失活（Dropout）',
  'batch': '批次', 'epoch': '轮次', 'learning rate': '学习率', 'gradient': '梯度',
  'optimizer': '优化器', 'loss': '损失', 'baseline': '基线', 'ablation': '消融实验',
  'state-of-the-art': '当前最优（SOTA）', 'benchmark': '基准', 'dataset': '数据集',
  'corpus': '语料库', 'supervised': '有监督', 'unsupervised': '无监督',
  'fine-tuning': '微调', 'pretraining': '预训练', 'inference': '推理',
  // ── 评测指标
  'bleu': 'BLEU 分数', 'accuracy': '准确率', 'precision': '精确率', 'recall': '召回率',
  'f1': 'F1 分数', 'perplexity': '困惑度', 'latency': '延迟', 'throughput': '吞吐量',
  'complexity': '复杂度', 'parallelization': '并行化', 'dependencies': '依赖关系',
  // ── 论文结构（读论文时最常卡住的词）
  'abstract': '摘要', 'introduction': '引言', 'related work': '相关工作',
  'method': '方法', 'experiments': '实验', 'results': '结果', 'discussion': '讨论',
  'conclusion': '结论', 'future work': '未来工作', 'contribution': '贡献',
  'limitation': '局限', 'evaluation': '评测', 'setup': '实验设置', 'implementation': '实现',
  // ── 常见动词（论文里高频）
  'propose': '提出', 'introduce': '引入', 'present': '呈现', 'demonstrate': '证明',
  'outperform': '优于', 'achieve': '达到', 'improve': '改进', 'reduce': '降低',
  'evaluate': '评测', 'implement': '实现', 'generalize': '泛化',
};

// 从文本里找出出现过的术语，返回 [[英文, 中文, 出现次数], ...]（按次数降序）
// 用途：看板里给英文论文挂一个"术语对照表"，读者对照着读原文。
function termGlossary(text, top) {
  const low = (text || '').toLowerCase();
  const hits = [];
  for (const en in TERM_CN) {
    // 用词边界计数（"attention"不该命中 "attentions" 之外的东西，也不该命中 "self-attention" 两次）
    const esc = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = low.match(new RegExp('(?<![a-z])' + esc + '(?![a-z])', 'g'));
    if (m && m.length >= 2) hits.push([en, TERM_CN[en], m.length]);
  }
  hits.sort((a, b) => b[2] - a[2]);
  return hits.slice(0, top || 24);
}

/* ---------- 每节摘要 + 引文链接 ---------- */

// 给目录的每一条挂上"这节在讲什么"（该节正文首句）。
//
// ★ 定位判据：正文里的节标题形态是「编号 + 空格 + 标题 + 换行」，
//   实测："2.1 信息抽取\n信息抽取(informationextraction)是 知 识 …"
//   只在全文里 indexOf(title) 会命中目录页、摘要引用、图表标题等（实测 20 条只取到 5 条）。
//   加上编号前缀 + 换行边界后能定位到真正的正文节。
function outlineWithSummary(text, outline, bodyEnd) {
  const out = [];
  const limit = bodyEnd > 0 ? bodyEnd : text.length;
  for (let i = 0; i < outline.length; i++) {
    const it = outline[i];
    const titleEsc = it.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 优先「编号 + 标题 + 换行」；退化到「编号(可有空格) + 标题」
    let at = -1;
    if (it.num) {
      const re = new RegExp('\\n\\s*' + it.num.replace(/\./g, '\\.') + '\\s*' + titleEsc + '\\s*\\n');
      const m = re.exec(text.slice(0, limit));
      if (m) at = m.index + m[0].length;
    }
    if (at < 0) at = text.indexOf(it.title);
    if (at < 0) { out.push({ ...it, summary: '', len: 0 }); continue; }

    // 本节终点 = 下一条目录在正文里的位置（找不到就用 bodyEnd）
    let end = limit;
    for (let k = i + 1; k < outline.length; k++) {
      const nx = outline[k];
      const nxEsc = nx.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let nat = -1;
      if (nx.num) {
        const m2 = new RegExp('\\n\\s*' + nx.num.replace(/\./g, '\\.') + '\\s*' + nxEsc + '\\s*\\n').exec(text.slice(0, limit));
        if (m2) nat = m2.index + m2[0].length;
      }
      if (nat < 0) nat = text.indexOf(nx.title, at + 1);
      if (nat > at) { end = nat; break; }
    }
    const seg = text.slice(at, Math.min(end, at + 3000));
    const lines = seg.split('\n').map(x => x.trim()).filter(Boolean);
    // ★ 用「标题后面那段连续文字」当正文，别逐行拼。
    //   踩的坑：把 lines[0]+'\n'+lines[1] 拼起来会得到
    //   "…技术(体系)架构,后" + "构以及构建知识图谱所采用的技术(体系)架构,后" —— 同一句的两个半截。
    //   双栏 PDF 的字距被空格拆开（"架,后" / "构以及"），逐行拼就出现重复。
    //   做法：把标题之后的行**直接连起来**（去掉换行），再切句。
    const joined = seg.replace(/\n+/g, '').replace(/\s{2,}/g, ' ');
    const bare = it.title.replace(/\s/g, '');
    let body = joined;
    // 去掉紧跟标题的那一段重复标题（"2.1.1 实体抽取实体抽取,也称为…"）
    if (body.replace(/\s/g, '').startsWith(bare)) {
      const k = body.indexOf(it.title) >= 0 ? body.indexOf(it.title) + it.title.length : bare.length;
      body = body.slice(k);
    }
    const sents = splitSentences(body).filter(x => x.length >= 24 && !/^[\d\W]{0,6}$/.test(x));
    // ★ 不止一句：给 3 句当摘要（首句常常只是"本节讨论…"这种过渡，第 2、3 句才见内容）。
    //   同时保留整节正文（全文），供看板做"展开看全节"。
    let picked = sents.slice(0, 3);
    // 首句太短（<40 字）说明是过渡句，往后多取一句
    if (picked.length && picked[0].length < 40) picked = sents.slice(0, 4);
    const sum = picked.join(' ');
    out.push({
      ...it,
      summary: sum.slice(0, 420),
      nSent: picked.length,
      full: body.slice(0, 4000).trim(),        // 全节正文（看板折叠用）
      len: Math.max(0, end - at),
    });
  }
  return out;
}

// 文献表前几行的链接：把 [n] 编号 → 文献表第 n 条的 URL（如果那行里有 DOI/arXiv/URL）
// 用途：看板里"最依赖哪几篇"的编号能点开（有地址）或至少看到是哪篇（无地址）
// 返回 { n: {url, title} }
function refLinks(text) {
  const at = findRefsStart(text);
  if (at <= 0) return {};
  const tail = text.slice(at);
  const out = {};
  // 文献条目：以 [n] 或 n. 开头，取到下一个编号为止
  const re = /(?:^|\n)\s*\[?(\d{1,3})\]?[\.、\s]\s*([\s\S]{0,400}?)(?=\n\s*\[?\d{1,3}\]?[\.、\s]|$)/g;
  let m, n = 0;
  while ((m = re.exec(tail)) !== null && n < 120) {
    const num = parseInt(m[1], 10);
    if (out[num]) continue;
    const body = m[2].replace(/\s+/g, ' ');
    let url = '';
    const doi = /(10\.\d{4,9}\/[^\s,;，。]+)/.exec(body);
    const arx = /arXiv[:\s]*(\d{4}\.\d{4,5})/i.exec(body);
    const http = /(https?:\/\/[^\s,;，。)）]+)/.exec(body);
    // ★ 不要求必须有 URL —— 中文期刊的文献表**根本没有 DOI/URL**
    //   （实测《知识图谱构建技术研究》88 条引用，文献区里 0 个 http、0 个 10.xxxx）。
    //   所以两种都收：有地址给链接，没地址给"文献表条目原文"，读者至少能看到是哪篇。
    let title = '';
    if (doi) url = 'https://doi.org/' + doi[1].replace(/[.,;]+$/, '');
    else if (arx) url = 'https://arxiv.org/abs/' + arx[1];
    else if (http) url = http[1].replace(/[.,;]+$/, '');
    // 条目文字：取到第一个 [J]/[C]/[M] 或年份前，当"这是什么文献"
    const cut = body.search(/\[\s*[JjCcMmDdRrNnSsPp]\s*\]|\(\s*(?:19|20)\d{2}\s*\)|,\s*(?:19|20)\d{2}\b/);
    title = (cut > 12 ? body.slice(0, cut) : body.slice(0, 90)).replace(/\s+/g, ' ').trim();
    // ★ 没有 DOI/URL 也生成可点链接 —— 拿文献条目文字去 Google Scholar 搜。
    //   原因：中文期刊的文献表**根本没有 DOI/URL**（实测《知识图谱》88 处引用，
    //   文献区里 0 个 http、0 个 10.xxxx，只有卷期页码）。
    //   旧做法"没地址就不给链接"→ 中文看板 0 个可点，用户点不到任何东西。
    //   改成兜底搜索，中英文评论都能点开查。
    if (!url && title.length >= 10) {
      // ★ 不用 Google Scholar —— 国内访问不了（用户反馈"有人没有魔法"）。
      //   换百度学术：国内直连，中英文文献都能搜到。
      url = 'https://xueshu.baidu.com/s?wd=' + encodeURIComponent(title.slice(0, 90));
      // 备选（保留注释，将来要换只改这一行）：
      //   知网 https://kns.cnki.net/kns8/defaultresult/index?kw=<q>   （要登录）
      //   Semantic Scholar https://www.semanticscholar.org/search?q=<q>（国外）
      //   直接搜 https://www.bing.com/search?q=<q>                    （国内可用）
    }
    if (url) { out[num] = { url, title: title.slice(0, 110), bySearch: !/^https:\/\/(doi\.org|arxiv\.org)/.test(url) }; n++; }
  }
  return out;
}

/* ---------- 出处（DOI / arXiv / 文章编号） ---------- */
function extractSource(text) {
  const head = text.slice(0, 3000);
  let m = /(?:DOI|doi)\s*[:：]?\s*(10\.\d{4,9}[/?][^\s，。;；、]+)/.exec(head);
  if (m) return { url: 'https://doi.org/' + m[1].replace(/\?/g, '/').replace(/[.,;]+$/, ''), note: '' };
  m = /(?:arXiv)\s*[:：]?\s*(\d{4}\.\d{4,5})/i.exec(head);
  if (m) return { url: 'https://arxiv.org/abs/' + m[1], note: '' };
  m = /文章编号\s*[:：]?\s*([\dXx][\d\-Xx()]{7,})/.exec(head);
  if (m) return { url: '', note: '文章编号 ' + m[1].trim() };
  return { url: '', note: '' };
}


/* ---------- 作者与引用（抄 allenai/science-parse 的输出 schema） ---------- */
// Science Parse（AI2，★707）是"AI 元年前"论文解析的标杆，它输出的字段是：
//   Title / Authors / Abstract / Sections(heading+body) / Bibliography / Mentions
// 我原来只有 Title/Abstract/Sections/Bibliography —— 缺 Authors 和 Mentions。
// 这两个都值得补：
//   · Authors —— 读者要知道谁写的（而且能看出是不是同一课题组）
//   · Mentions —— 引用出现在正文哪几个位置，能看出**作者最依赖谁的工作**

// 作者（抄 science-parse 的 Authors 字段）
// ★ 踩的坑：
//   ① 放宽（首字母大写就算人名）→ 标题 "Attention Is All You Need"、单位 "Google Brain" 全被抓进来
//   ② 收紧（要求逗号分隔）→ 英文作者行是**空格分隔**的（"Ashish Vaswani Noam Shazeer …"），
//      一条都抽不到；中文抽到的是标题
//   正解看**整行的词形构成**：人名行里"首字母大写 + 其余小写"的词占绝大多数，
//   而标题含实词（is/of/model/attention）、单位含机构词（university/brain/research）。
function extractAuthors(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 16);
  const INST = /(universit|institut|college|department|school|laborator|academy|\bbrain\b|\bresearch\b|\binc\b|\bltd\b|@|http)/i;
  // 标题/句子里的实词 —— 人名行不会有这些
  const FUNC = /\b(is|are|was|were|the|of|for|with|and|in|on|at|to|from|by|a|an|we|our|this|that|all|you|need|model|network|learning|based|attention|method|approach|study|paper)\b/i;

  const looksLikeName = (w) => /^[A-Z][a-z]{1,}[a-z'’\-]*$/.test(w) || /^[A-Z][a-z]*\.$/.test(w);

  const out = [];
  for (const l of lines) {
    if (l.length < 6 || l.length > 160) continue;
    if (INST.test(l)) continue;
    // 中文作者行有两种常见形态：
    //   ① 单字姓名 + 空格：  "刘 峤 李 杨 段 宏 刘 瑶 秦志光"   （期刊排版把 2 字名拆成单字）
    //   ② 双字姓名 + 空格：  "张三 李四 王五"
    // 判据必须同时覆盖 —— 只认 {2,4} 字会把 ① 全漏掉（实测抽到的是标题）。
    if (/[\u4e00-\u9fff]/.test(l)) {
      // ★ 标题 vs 作者行的分水岭：**有没有空格**。
      //   实测标题 "知识图谱构建技术综述" 也是 han=10 / ratio=1.00 / compactEqHan=true，
      //   前面所有判据都拦不住它 —— 它唯一的破绽是**整行一个连续长词，没有空格**；
      //   而作者行一定是被空格隔开的多组（"刘 峤 李 杨 段 宏 刘 瑶 秦志光"）。
      if (!/\s/.test(l)) continue;
      const han = (l.match(/[\u4e00-\u9fff]/g) || []).length;
      const nospace = l.replace(/\s+/g, '');
      // ★ 占比要**去掉空格再算**。实测 "刘 峤 李 杨 段 宏 刘 瑶 秦志光" 是 19 字符 / 11 汉字，
      //   含空格算是 0.58 < 0.7 被丢掉 —— 而它正是作者行。
      if (han / Math.max(1, nospace.length) < 0.85 || /[，。；：！？]/.test(l)) continue;
      if (han < 6) continue;                                          // 太短
      const compact = l.replace(/\s+/g, '');
      if (compact.length !== han) continue;                            // 夹了非汉字 → 不是纯姓名行
      // ① 单字序列（≥5 个汉字、被空格隔开）：两两合并当成 "刘峤" "李杨"
      //   ★ 光看形态分不开期刊名和作者行 —— 实测 "计 算 机 研 究 与 发 展" 也是 8 个单字、ratio=1.00。
      //     差别在**词义**：期刊名含 学报/杂志/进展/研究…；作者行是**姓氏用字**。
      //     判据：单字里姓氏用字占比 ≥ 一半 → 作者行，否则跳过。
      const groups = l.split(/\s+/);
      const singles = groups.filter(x => /^[\u4e00-\u9fff]$/.test(x));
      // ★ 别要求"全部是单字"：实测 "刘 峤 李 杨 段 宏 刘 瑶 秦志光" 里 8 个单字 + 1 个三字名
      //   （"秦志光"），旧判据 `singles.length === groups.length` 是 8 === 9 → false，
      //   整行掉进 else 分支被当标题丢掉。改成**单字占多数**即可。
      if (singles.length >= 5 && singles.length / groups.length >= 0.6) {
        const SURNAME = new Set('王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'.split(''));
        //   实测 "刘 峤 李 杨 段 宏 刘 瑶 秦志光" 只有 刘/李/段/刘/秦 是姓氏（5/8），
        //   而 "计 算 机 研 究 与 发 展" 里 计/算/机/研/究/与/发/展 全不是 —— 差别极大，
        //   所以判据用**姓氏个数 ≥2** 就够，不必卡比例。
        const sur = singles.filter(c => SURNAME.has(c)).length;
        if (sur < 2) continue;
        for (let k = 0; k + 1 < singles.length; k += 2) out.push(singles[k] + singles[k + 1]);
        if (singles.length % 2) out.push(singles[singles.length - 1]);
        // 混进来的多字组本身就是完整姓名（"秦志光"）
        groups.filter(x => x.length > 1 && /^[\u4e00-\u9fff]+$/.test(x)).forEach(x => out.push(x));
      } else {
        // ② 紧凑的 2-4 字组。同样要排除期刊名／标题。
        if (/(学报|杂志|期刊|通报|进展|研究与发展|科学|评论|综述|导报|学院报)/.test(l)) continue;
        const cn = l.match(/[\u4e00-\u9fff]{2,4}/g) || [];
        // 标题形态：整体是一个长词组（汉字数 ≥8 且无分隔）——大概率是标题不是姓名列表
        if (cn.length < 3) continue;
        cn.forEach(n => out.push(n));
      }
      if (out.length) break;
      continue;
    }
    // 英文：先剔除"标题"（含功能词/实词）
    if (FUNC.test(l)) continue;
    const ws = l.split(/\s+/).map(w => w.replace(/[,&]/g, '')).filter(Boolean);
    if (ws.length < 4) continue;
    const nameLike = ws.filter(looksLikeName).length;
    // 人名行 ≥75% 的词是"首大写+小写"
    if (nameLike / ws.length < 0.75) continue;
    // 按 2~3 个词切成人名（Ashish Vaswani / Noam Shazeer / Niki Parmar …）
    let buf = [];
    const names = [];
    for (const w of ws) {
      buf.push(w);
      if (buf.length === 2) { names.push(buf.join(' ')); buf = []; }
    }
    if (buf.length) names.push(buf.join(' '));
    names.forEach(n => out.push(n));
    if (out.length >= 4) break;
  }
  return [...new Set(out)].slice(0, 16);
}

// 引用提及：正文里 [12] / [3,5] / (Smith et al., 2018) 出现的次数与位置
// 用途：看出**这篇最依赖哪几篇**（被提最多次的那几个编号）
function extractMentions(text) {
  const body = text.slice(0, Math.max(2000, findRefsStart(text)));
  const cnt = new Map();
  const re = /\[(\d{1,3}(?:\s*[,\-–]\s*\d{1,3})*)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    for (const part of m[1].split(',')) {
      const range = part.split(/[-–]/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (range.length === 2 && range[1] - range[0] <= 20) {
        for (let i = range[0]; i <= range[1]; i++) cnt.set(i, (cnt.get(i) || 0) + 1);
      } else if (range.length >= 1) {
        cnt.set(range[0], (cnt.get(range[0]) || 0) + 1);
      }
    }
  }
  const total = [...cnt.values()].reduce((a, b) => a + b, 0);
  const top = [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { total, unique: cnt.size, top };
}

/* ---------- 论文类型猜测 ---------- */
function guessType(text) {
  const head = text.slice(0, 3000);
  if (/(综\s*述|研究进展|review|survey)/i.test(head)) return 'survey';
  if (/(实验|数据集|experiment|dataset|benchmark)/i.test(head)) return 'empirical';
  if (/(学位论文|硕士|博士|thesis|dissertation)/i.test(head)) return 'thesis';
  if (/(教学|课程|教育|teaching|education)/i.test(head)) return 'education';
  if (/(理论|证明|theorem|proof)/i.test(head)) return 'theory';
  return 'empirical';
}

/* ---------- 标题提取 ---------- */
// 标题提取
// ★ 血泪史：
//   ① 早期"取前 8 行里最长的一条" → 作者单位行（4 个单位拼成 52 字符）被选中
//   ② 加了"重复片段"防线（Google Brain ×4）→ 挡不住**不重复的人名列表**
//      （双栏后作者行被拼成 "Ashish Vaswani Noam Shazeer Niki Parmar Jakob Uszkoreit"，
//       61 字符，比标题长，实测又被选中）
//   所以判据要落在"**这是不是人名列表**"上，而不是长度。
function extractTitle(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return '未识别标题';
  const head = lines.slice(0, 10);

  const isPersonList = (l) => {
    // 2~4 个"首字母大写 + 小写"的词，中间无标点、无动词 → 人名串
    const words = l.split(/\s+/).filter(Boolean);
    if (words.length < 3) return false;
    const nameLike = words.filter(w => /^[A-Z][a-z\-]+$/.test(w)).length;
    if (nameLike / words.length < 0.7) return false;
    // 含这些词就不是人名列表（是标题或句子）
    return !/\b(the|of|for|with|and|is|are|we|our|this|model|network|attention|learning|based)\b/i.test(l);
  };
  const bad = (l) =>
    l.length < 6 || l.length > 70 ||
    /(第\s*\d+\s*卷|Vol\.|ISSN|DOI|http|@)/.test(l) ||
    /(.{6,})\1/.test(l) ||                 // 重复片段（作者单位）
    isPersonList(l) ||                     // 人名列表
    /^[A-Z\s]{4,}$/.test(l);               // 全大写（刊名/栏目名）

  // ★ 中文论文：真标题常常**不是最长的行** —— 实测《知识图谱》前 10 行里
  //   刊名+DOI(55) / 英文刊名卷期(58) / 作者(19) / 单位(27) / 邮箱(18) / 英文标题(36)
  //   全比标题 "知识图谱构建技术综述"(10) 长。所以中文走**独立判据**：
  //   汉字 ≥ 6、汉字占多数、无 DOI/邮箱/卷期形态、且汉字之间没被空格拆开
  //   （作者行 "刘 峤 李 杨 段 宏" 就是被 PDF 字距拆开的单字序列）。
  const isCjkTitle = (l) => {
    const cjk = (l.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk < 6 || cjk / l.length < 0.6) return false;
    if (/DOI|doi|issn|ISSN|http|@/.test(l)) return false;
    if (/\d{4}\s*[;:，,]|\d+\s*\(\s*\d+\s*\)/.test(l)) return false;   // 卷期号
    // 汉字被空格拆开：≥4 个"单汉字 + 空格"的片段 → 作者行/被字距拉伸的排版
    const split = (l.match(/[\u4e00-\u9fff]\s+(?=[\u4e00-\u9fff])/g) || []).length;
    if (split >= 4) return false;
    if (/^[\(（]/.test(l)) return false;                                    // 单位行
    return true;
  };
  // ★ 中文标题常常**跨两行**（课本题名排版）—— 实测《微博情感》那篇的
  //   "基于情感词典的中文微博情感倾向分析研究" 被拆成
  //   [2]"词典的中文微博情感" + [3]"倾向分析研究" 两行，
  //   只取一行会得到残缺标题。判据：下一行也是"标题形态"（纯汉字、无标点、短）→ 合并。
  //   ★ 踩的坑：这行判据太松，把**作者行**也当成"标题续行"了 ——
  //     实测第 2 行 "知识图谱构建技术综述"(10) 后面紧跟 "刘 峤 李 杨 段 宏 刘 瑶 秦志光"(19)，
  //     两者相加 29 ≤ 40 → 被合并成 "知识图谱构建技术综述刘 峤 李 杨…"，
  //     合并后 split≥4 又判 false，**真标题就这样丢了**，最后返回了英文刊名行。
  //     所以续行必须**先排除作者行**：汉字被空格拆成 ≥4 段的就是作者行。
  const looksLikeTitleTail = (l) =>
    /^[\u4e00-\u9fff\s]{2,20}$/.test(l) && !/[：:，,。.]/.test(l)
    && (l.match(/[\u4e00-\u9fff]\s+(?=[\u4e00-\u9fff])/g) || []).length < 4
    && !/(学位申请人|学科专业|指导教师|答辩日期|学号|密级|分类号)/.test(l);
  const rawLines = lines.slice(0, 10);
  const merged = [];
  for (let i = 0; i < rawLines.length; i++) {
    const cur = rawLines[i];
    if (isCjkTitle(cur) && i + 1 < rawLines.length && looksLikeTitleTail(rawLines[i + 1])
        && cur.length + rawLines[i + 1].trim().length <= 40) {
      merged.push(cur + rawLines[i + 1].trim());
      i++;
    } else merged.push(cur);
  }
  const cjkCand = merged.filter(isCjkTitle);
  if (cjkCand.length) {
    // 中文标题取"汉字数最多的那条"（最短的是真标题，但同页可能有多个候选；用长度中位更稳）
    return cjkCand.sort((a, b) => b.length - a.length > 20 ? a.length - b.length : 0)[0].slice(0, 120);
  }

  const cand = head.filter(l => !bad(l));
  if (!cand.length) {
    // 兜底：从最前面几行里找一个"不太糟"的（优先不是人名的）
    const fb = head.filter(l => l.length >= 6 && l.length <= 70 && !isPersonList(l));
    return (fb[0] || head[0] || '未识别标题').slice(0, 120);
  }
  // 取最长的一条 —— 作者/单位已被上面的 bad() 排除，剩下的最长的通常是标题
  return cand.reduce((a, b) => (b.length > a.length ? b : a)).slice(0, 120);
}

// 论文句子判断器 —— 三个**经实测验证**的二元判断。
//
// ★ 走到这一版的曲折（每步都有数据，不是拍脑袋）：
//   v1  我写了 60 多条"通用学术句式"正则 → 在 30212 句人工标注上判对率 **1%**，84% 判不出。
//   v2  跑 signal_stats.py 逐条测信号，只留提升 >=1.5 倍的 → 5 分类最好 **20%**。
//   v3（本版）看混淆矩阵发现 v2 的天花板在**目标选错了**：
//       BACKGROUND 和 OBJECTIVE 在真实摘要里高度重叠（"the aim of this study" 61% 问题 / 36% 背景），
//       人工标都难分，我却去追 5 分类的准确率。
//       改成三个**二元判断**（对应三个板块需要的三件事）后：
//         缺口句  精确 0.912（基线 0.192）  提升 4.7×
//         方法句  精确 0.810（基线 0.332）  提升 2.4×
//         成效句  精确 0.908（基线 0.477）  提升 1.9×
//
// 验证脚本：research/eval_binary.py（改这里必须同步改它，然后重跑看数字）
//
// 设计原则（用户原话）：「又不要求我们分析的全对 本质上概率大一点就ok」
//   → 优化**精确率**（判出来的要准），不优化召回（宁可少判，别判错）。
//   → 每条信号的权重 = 它在真实语料上的提升倍数，注释里写着实测值。

/* ---------- 三个判断的判据（权重=提升倍数，阈值=4） ---------- */

// ① 缺口句：在讲"卡在哪 / 空白 / 困境" —— 用于板块「为什么做」
// ★ 判据从**自家 110510 句 arXiv 通用论文**学出（research/learn_en_rules.py）。
//   之前用 PubMed 医学摘要那套（were randomized / dose / mg）在通用论文上判不出
//   （Attention 那篇 68 句，缺口 0 / 成效 0）。换成通用语料学的这套后可用。
//   括号里是实测精确率（命中它的句子里有多少真是这个角色）和命中次数。
const RULES_GAP = [
  [/\bhowever\b/i, 3],                                                // 1.000  命中 4622
  [/\b(suffer|suffers|suffered)\b/i, 3],                              // 0.996  命中 230
  [/\b(remains?|is) (unclear|unknown|an open|difficult|challenging)\b/i, 3],  // 0.992
  [/\b(difficult|hard) to\b/i, 3],                                    // 0.991  命中 213
  [/\b(suffer(s|ed)? from|fails? to|hindered by|limited by)\b/i, 3],  // 0.987  命中 468
  [/\b(expensive|costly|inefficient)\b/i, 3],                         // 0.932  命中 324
  [/\b(limitation|limitations|shortcoming|drawback)\b/i, 2],          // 0.827  命中 502
  [/\b(bottleneck|scalability)\b/i, 1],                               // 提升 1.27（弱）
];

// ② 方法句：作者自己怎么做的 —— 用于板块「做出了什么」
const RULES_METHOD = [
  [/\bwe (propose|present|introduce|introduces)\b/i, 3],              // 0.962  命中 4806
  [/\bwe (develop|design|build|construct|create)\b/i, 3],             // 0.945  命中 715
  [/\bour (method|approach|model|framework|system|architecture|algorithm|network)\b/i, 3],  // 0.902  命中 2553
  [/\bwe describe\b/i, 2],                                            // 0.793  命中 87
  [/\b(architecture|framework|pipeline|module|layer)\b/i, 2],         // 0.773  命中 1941
  [/\b(consists? of|composed of|comprises?)\b/i, 1],                  // 0.637  命中 124
];

// ③ 成效句：做出来什么效果 —— 用于板块「做出了什么」
const RULES_EFFECT = [
  [/\b(accuracy|precision|recall|f1|bleu|rouge|perplexity)\b/i, 3],   // 0.834  命中 1574
  [/\b(state-of-the-art|sota)\b/i, 3],                                // 0.755  命中 722
  [/\b(achieves?|achieved|attains?|reaches?)\b/i, 2],                 // 0.563  命中 758
  [/\b(improves?|improved|improvement)\b/i, 2],                       // 0.556  命中 1129
  [/\b(outperforms?|outperforming|outperformed)\b/i, 2],              // 0.508  命中 506
  [/\b(speedup|speed-up|faster)\b/i, 1],                              // 0.491
  [/\b(matches?|surpasses?|exceeds?|beats?)\b/i, 1],                  // 0.397
  [/\b(state-of-the-art|much|far|significantly) (better|faster|higher|lower)\b/i, 1],
];

/* ---------- 中文判据 ----------
   中文没有现成的人工标注语料，所以这三套是**照英文的结构写的**，没做准确率承诺。
   但结构上是同一件事：缺口=讲困境/空白，方法=讲自己怎么做，成效=讲结果。 */
const RULES_GAP_CN = [
  [/(尚(未|不)|难以|无法|存在.{0,4}(问题|不足|局限|挑战)|瓶颈|难点)/, 7],
  [/(问题|挑战|瓶颈|难点)(是|在于|主要|依然|仍然)/, 6],
  [/(然而|但是|但)[^。]{8,}/, 5],
  [/(亟待|有待|亟需|急需)/, 6],
];
const RULES_METHOD_CN = [
  // ★ 自指词必须在**句首区**（前 24 字）——
  //   实测那条"随着自动知识抽取与加工技术的不断成熟, 目前的知识图谱大多采用自底向上的
  //   方式构建 … 本文主要介绍自底向上的知识图谱构建技术" 是**两句拼接**的，
  //   "本文"在后半段，旧判据 [/(本文|我们).{0,8}(提出|采用…)/] 照样命中 5 分，
  //   于是这条讲"领域现状"的句子被当成"本文的方法"排到第一。
  //   改成锚在句首，讲领域的句子就不会被误收。
  [/^(?:本文|我们|笔者|本\s*文)[^。]{0,24}(?:提出|采用|使用|构建|设计|介绍|开发|给出|实现|研究|分析)/, 5],
  [/(方法|算法|模型|框架|流程|步骤)(是|为|如下|包括|主要)/, 3],
  [/(采用|使用|基于|通过).{0,10}(方法|算法|模型|技术|方式|手段)/, 3],
];
const RULES_EFFECT_CN = [
  [/(结果(表明|显示)|实验(表明|显示|证明)|研究表明)/, 6],
  [/(准确率|精度|召回率|性能|效果).{0,12}(\d|百分|倍|%|优于|高于|达到)/, 5],
  [/(优于|高于|提升|提高|降低|达到|取得).{0,10}(\d|百分|倍|%)/, 4],
];

/* ---------- 判定 ---------- */

function scoreOf(sent, rules) {
  let v = 0;
  for (const [rx, w] of rules) { try { if (rx.test(sent)) v += w; } catch (e) {} }
  return v;
}

// 三个判断一起给（一次遍历，避免重复扫描）
// 阈值 3。
// ★ 为什么不是 4：4 是在**医学摘要**语料上测出的最优（精确 0.912/0.810/0.908），
//   但医学摘要的句式密度高，改到通用论文（Attention 那篇 68 句）上最高分只有 3，
//   阈值 4 会让英文一个字都判不出来（实测全 0）。降到 3 两边都能出结果。
//   也不更低：2 时出现误判（"The third is the path length between…" 被判成成效句）。
//   ponytail: 单一阈值兼顾两种语料是妥协；要更准得按语料分别调，但那需要中文的人工标注数据。
const JUDGE_THRESHOLD = 3;

function judge(sent) {
  const s = (sent || '').trim();
  if (!s || s.length < 20) return { gap: false, method: false, effect: false, junk: true };
  const cn = /[\u4e00-\u9fff]/.test(s);
  const junk = /^\s*(figure|table|fig\.|tab\.|图|表)\s*\d/i.test(s)
    || /^\s*\[\d+\]|^\s*\d+\.\s+[A-Z][a-z]+,\s+[A-Z]\./.test(s)
    || /\b(acknowledg|we thank|grateful|this work was supported)\b/i.test(s)
    || /(致谢|感谢|基金|资助)/.test(s)
    // ★ 页眉标记：实测中文论文的摘要段落开头被拼成 "摘要谷歌知识图谱技术近年来…"，
    //   它命中了 however 的等价词"然而"类判据，混进了"缺口"候选。
    //   这类行首标记词不该参与判断。
    || /^(摘要|关键词|关键字|abstract|keywords|index terms|引言|前言)\s*[:：]?/i.test(s)
    // ★ 小节编号开头的残句："5.4 Regularization We employ three types of…"
    //   原文是 "…warmup_steps = 4000.\n5.4 Regularization\nWe employ three types…"，
    //   pdf.js 把小节标题和正文并进一行，切句切开后仍带着编号标题。
    //   这种句子不该参与任何判断（它是排版残渣，不是完整观点）。
    || /^\d+(?:\.\d+){1,2}\s+[A-Z][A-Za-z\-]{2,20}\s/.test(s);
  if (junk) return { gap: false, method: false, effect: false, junk: true };
  const g = scoreOf(s, cn ? RULES_GAP_CN : RULES_GAP);
  const m = scoreOf(s, cn ? RULES_METHOD_CN : RULES_METHOD);
  const e = scoreOf(s, cn ? RULES_EFFECT_CN : RULES_EFFECT);
  return {
    gap: g >= JUDGE_THRESHOLD,
    method: m >= JUDGE_THRESHOLD,
    effect: e >= JUDGE_THRESHOLD,
    gapScore: g, methodScore: m, effectScore: e,
    junk: false,
  };
}

// ★ 一次取三组句子，**组间排他**（实测 bug 的修复）。
//
// 症状（Attention 那篇，用户实测看到的）：
//   「为什么做」板块里混进了 "We propose a new simple network architecture..."（这是"做了什么"）
//   「做出了什么」板块里前两条又是同样这两句（重复）
//   而真正的成效句（BLEU 41.0 / state-of-the-art）反而没进"做出了什么"
//
// 根因：judge 允许一句同时命中多个判断（`our model achieves 28.4 BLEU` 同时是 method 3 分
//   和 effect 5 分，这是**特性不是 bug** —— 句子的角色本来就有重叠）。
//   但三个板块各自独立调 pickJudged，谁都不知道别人拿了什么 →
//   同一句被三个板块同时展示，用户看到"换汤不换药"。
//
// 修法：**按专一性顺序分配** —— 谁的该句得分占比最高，这句就归谁。
//   一句的分数向量 (gapScore, methodScore, effectScore)，取 argmax 决定归属；
//   argmax 相同时按 effect > method > gap 的优先级（成效/方法比缺口更"硬"，
//   字数证据更具体；缺口句常是铺垫，容易泛滥）。
//
// ponytail: 这是"硬分配"（一句只能进一个板块）。若某板块因此不足 N 条，
//   才允许从"已分配给别的板块、但本板块也有分"的句子里回借 ——
//   否则严格的排他会让「为什么做」这种本来就少的板块空掉。
function pickJudgedExclusive(sents, quotas) {
  // quotas: {gap: 3, method: 2, effect: 2}
  const PRIO = { effect: 3, method: 2, gap: 1, none: 0 };
  const pool = [];
  for (const s of sents) {
    const j = judge(s);
    if (j.junk) continue;
    const sc = { gap: j.gapScore || 0, method: j.methodScore || 0, effect: j.effectScore || 0 };
    const tot = sc.gap + sc.method + sc.effect;
    if (tot <= 0) continue;
    // 归属：得分占比最高者；并列时按 PRIO
    let owner = 'none', best = -1;
    for (const k of ['gap', 'method', 'effect']) {
      if (!j[k]) continue;
      const ratio = sc[k] / tot;
      if (ratio > best + 1e-9 || (Math.abs(ratio - best) < 1e-9 && PRIO[k] > PRIO[owner])) {
        best = ratio; owner = k;
      }
    }
    if (owner === 'none') continue;
    // ★ 补上 pickJudged 里的两段保护（我写新函数时漏抄了 —— 实测后果：
    //   "例如Socher等人将知识库中的实体表达为词向量…" 被选进「做出了什么」，
    //   而它讲的是**别人的工作**，本质就不该在该板块。）
    if (owner !== 'gap') {
      // ① 铺陈开头（"随着…的不断/目前…大多/近年来"）且没有句首自指 → 讲领域，不是讲本文
      if (/^(随着|目前|当前|近年来|一直以来|一般而言|众所周知|总的来说)[^。]{0,40}(不断|大多|普遍|日益|越来越)/.test(s)
          && !/^(本文|我们|笔者)/.test(s)) continue;
      // ② 他人指代 → **硬排除**（不是扣分：实测"例如Socher等人…准确率86.2%"命中两条成效
      //    判据共 9 分，扣 3 分后仍排第一 —— 扣分救不了，必须剔掉）
      if (/(等人|例如|已有研究|现有方法|前人|学者|一些研究|相关工作|\bet al\b|\bprior work\b|\bsome (studies|works)\b)/i.test(s)) continue;
    }
    let v = sc[owner] * best;                       // 同 pickJudged 的打分
    const len = s.length;
    if (len >= 25 && len <= 220) v += 1.0;
    if (len > 320) v -= 1.5;
    if (/\[\d+\]/.test(s)) v -= 0.6;
    if (owner !== 'gap' && /(本文|我们|笔者|\bwe\b|\bour\b|\bthis (paper|work)\b)/i.test(s)) v += 1.2;
    pool.push({ s: s, owner: owner, sc: sc, v: v, tot: tot });
  }
  pool.sort((a, b) => b.v - a.v);

  const out = { gap: [], method: [], effect: [] };
  const used = new Set();
  // 第一轮：按归属取（排他）
  for (const it of pool) {
    const q = quotas[it.owner] || 0;
    if (out[it.owner].length >= q) continue;
    if (used.has(it.s)) continue;
    out[it.owner].push(it.s);
    used.add(it.s);
  }
  // 第二轮：某板块不够 → 从"别家拿了但本家也有分"的回借（保底不让板块空）
  for (const k of ['gap', 'method', 'effect']) {
    const q = quotas[k] || 0;
    if (out[k].length >= q) continue;
    for (const it of pool) {
      if (out[k].length >= q) break;
      if (used.has(it.s) || !it.sc[k]) continue;
      if (it.owner === k) continue;
      out[k].push(it.s);
      used.add(it.s);
    }
  }
  return out;
}

// 取某类判断的代表句：按"该判断得分 ÷ 三个判断得分之和"（纯度）排序。
// ★ 为什么用纯度不用得分和：旧版按得分和排，长句命中多就排前面，
//   实测"成效"第一名是 "We used warmup_steps = 4000. 5.4 Regularization…"（其实是实验细节句）。
function pickJudged(sents, which, n) {
  const cand = [];
  for (const s of sents) {
    const j = judge(s);
    if (!j[which]) continue;
    const tot = (j.gapScore || 0) + (j.methodScore || 0) + (j.effectScore || 0);
    const pure = tot > 0 ? j[which + 'Score'] / tot : 0;
    let v = j[which + 'Score'] * pure;
    const len = s.length;
    if (len >= 25 && len <= 220) v += 1.0;     // 长度温和奖励（太短没说清、太长是拼接）
    if (len > 320) v -= 1.5;
    if (/\[\d+\]/.test(s)) v -= 0.6;           // 含引用标记扣分（讲别人工作易混入）
    // ★ 讲"别人怎么做"的句子不该进"作者自己做了什么"。
    //   实测中文那篇的方法板块第一名是 "随着自动知识抽取与加工技术的不断成熟, 目前的知识图谱
    //   大多采用自底向上的方式构建, 其中最具影响力的例子包括谷歌的 Knowledge Vault…"
    //   —— 它在讲整个领域/别人的做法，不是本文的做法。字面却命中了"采用/构建"。
    //   判据：出现"等人 / 例如 / 已有 / 前人 / et al / [12]"这类**他人指代**就重罚。
    if (which !== 'gap') {
      // ★ 讲"领域现状"的句子不该进"作者自己做了什么"。
      //   判据：句首是"随着…的不断/目前…大多/近年来/一般而言"这类**铺陈**开头，
      //   且全句没有句首自指 → 它在讲这个领域，不是讲本文。
      if (/^(随着|目前|当前|近年来|一直以来|一般而言|众所周知|总的来说)[^。]{0,40}(不断|大多|普遍|日益|越来越)/.test(s)
          && !/^(本文|我们|笔者)/.test(s)) continue;
      // ★ 硬排除，不是扣分。踩过的坑：先写的是"扣 3.0"，但
      //   "例如Socher等人…准确率分别达到86.2%和90.0%" 同时命中两条成效判据（9 分），
      //   扣完还有 6 分照样排第一。这类句子讲的是**别人的成果**，
      //   放在"作者自己做了什么"板块里本质就是错的 —— 扣分救不了，必须直接剔掉。
      if (/(等人|例如|已有研究|现有方法|前人|学者|一些研究|相关工作|\bet al\b|\bprior work\b|\bsome (studies|works)\b)/i.test(s)) continue;
      // "本文/我们/our" 自指 → 加分（这才是作者在说自己）
      if (/(本文|我们|笔者|\bwe\b|\bour\b|\bthis (paper|work)\b)/i.test(s)) v += 1.2;
    }
    cand.push([v, s]);
  }
  cand.sort((a, b) => b[0] - a[0]);
  return cand.slice(0, n).map(x => x[1]);
}

// 统计每一类有多少句（用于板块里的"全篇 N 句里找到 M 句"）
function judgeCounts(sents) {
  const c = { gap: 0, method: 0, effect: 0, junk: 0, none: 0 };
  for (const s of sents) {
    const j = judge(s);
    if (j.junk) { c.junk++; continue; }
    let any = false;
    for (const k of ['gap', 'method', 'effect']) if (j[k]) { c[k]++; any = true; }
    if (!any) c.none++;
  }
  return c;
}

/* 挂载：浏览器挂到 window，Node 挂到 globalThis（方便跑一致性对比） */
(function (root) {
  root.PL = { splitSentences, tokens, similarity, textrank, extractKeySentences,
              extractOutline, cleanOutline, locateSections, findRefsStart, looksLikeHeading,
              extractFigures, extractSource, guessType, extractTitle,
              extractAuthors, extractMentions,
                            roleScores, roleOf, ROLE_LEXICON,
              judge, pickJudged, pickJudgedExclusive, judgeCounts, argumentChain2, pickClosing,
              outlineWithSummary, refLinks, termGlossary, TERM_CN,
              argumentChain, skipFrontMeta, tagSentence, positionBonus, POSITION_PRIOR,
              normFullwidth, hasCJK,
              // ★ 领域判定（web/domain.js）—— 用**函数**包一层，不用 typeof 探测。
              //   踩过的坑：原来写成 `detectDomain: (typeof PL_DOMAIN !== 'undefined') ? ... : null`，
              //   core.js 执行时如果 domain.js 还没加载（script 顺序靠后），
              //   这个值就被定死成 null，之后加载了也不会变 → 领域判定永远不显示。
              //   包成函数后是**调用时**才去取，与加载顺序无关。
              detectDomain: function (text) {
                return (typeof PL_DOMAIN !== 'undefined' && PL_DOMAIN.detect)
                  ? PL_DOMAIN.detect(text) : null;
              },
              // 文本层质量：null = 正常；有值 = 这份 PDF 的数字/字符在文本层就缺了
              // （老期刊 PDF 没写 ToUnicode），已清成空格，UI 要明说而不是装作没事。
              textQuality: function () { return PL_TEXT_QUALITY; }};
})(typeof window !== 'undefined' ? window : globalThis);


/* ---------- 自检（node core.js 就能跑，不依赖网络/PDF） ---------- */
function demo() {
  const t = [
    "1 Introduction",
    "Sequence transduction models have been dominated by recurrent networks for years.",
    "2 Background",
    "Recurrent models process symbols one at a time, which prevents parallel training.",
    "2.1 Prior Work",
    "Attention mechanisms were already used alongside recurrent models before this work.",
    "3 Method",
    "We propose an architecture based solely on attention mechanisms for this task.",
  ].join("\n");
  const s = splitSentences(t);
  if (!s.length) throw new Error("切句返回空");
  const o = cleanOutline(extractOutline(t));
  if (!o.some(x => x.title.includes("Introduction"))) throw new Error("抓不到 1 Introduction");
  // 表格行不该冒充分章节 —— 用例必须**带真章节编号**（1..4），
  // 脱节判据靠"超出已有编号体系"识别表格数字，光有 18/19 是测不出来的
  const bad = cleanOutline(extractOutline([
    "1 Introduction", "This paper studies sequence models in detail.",
    "2 Background", "Recurrent networks are the prior standard here.",
    "3 Method", "We propose an attention only architecture for this task.",
    "4 Results", "The model improves over the previous best baseline by a margin.",
    "18", "Transformer (base model)", "19", "Transformer (big)",
  ].join("\n")));
  if (bad.some(x => /base model|big/.test(x.title)))
    throw new Error("表格行冒充了章节: " + JSON.stringify(bad.map(x=>x.title)));
  // 页码不该混进正文
  const ks = extractKeySentences("We propose a new architecture for sequence modeling that is faster. " +
    "The results show a clear improvement over prior work on this task. " +
    "We conclude that attention alone is sufficient for this problem setting.", 2);
  if (!ks.length) throw new Error("核心句返回空");
  console.log("✓ 自检通过  切句 " + s.length + " / 目录 " + o.length + " / 核心句 " + ks.length);
}
if (typeof require !== 'undefined' && require.main === module) demo();
