/* paperlens · 论文解析看板
 * 作者：李子正（正点 / OPC）
 *  * 仓库：https://github.com/Az0R119/paperlens
 *
 * 纯前端实现：不调任何 API、不上传任何数据。
 * 设计决策、实测数据与踩坑记录见 README.md 的「实测记录」章节。
 */
// 二元判断模型（缺口 / 方法 / 成效）—— 网页版推理。
//
// ★ 这是"训好的 ML 接进产品"的那一步。之前 ML 一直躺在 research/ 里
//   从没进过产品（core.js 的 roleOf 用手写词表）。本文件补上最后一公里。
//
// ★ 为什么用二元模型而不是 5 分类：
//   5 分类在官方 test 上 0.6809，但 OBJECTIVE 召回只有 0.39 —— 40% 被误判成
//   BACKGROUND。那是**标签本身重叠**（"the aim of this study" 61% 是目的、
//   36% 是背景，人工标注都难分），不是模型不够强：L2 从 1e-4 加到 0.1（1000 倍）
//   TEST 只动 0.015、gap 恒为 13.8 → 加正则治不了，瓶颈在类别定义。
//   改成 3 个独立二元判断后绕开死结，且召回高 3-4 倍：
//
//     实测（官方 test 2500 篇 / 30135 句）：
//       gap    精确 0.570  召回 0.704  F1 0.630   基线 0.198
//       method 精确 0.725  召回 0.791  F1 0.756   基线 0.328
//       effect 精确 0.725  召回 0.832  F1 0.775   基线 0.474
//
//   对照手写词表法（早前 eval_binary.py 实测）：
//       精确 0.912/0.810/0.908 但召回仅 14.7%/22.2%/10.3%
//     → 与 Tkaczyk 2018 (JCDL 十款解析器横评) 的结论一致：
//       "ML 与规则工具精确率相当，但召回差 3 倍（0.66 vs 0.22）"
//
// ★ 只对英文用：16 维里有 10 维是英文词频先验（从 PubMed 医学摘要学出），
//   中文句提取不到英文词 → 那 10 维全 0，判断退化成"只看句长/数字/逗号"。
//   中文继续交给 core.js 的词表 + 位置先验。
(function () {
  'use strict';

  var LEX, BIN, FEAT_LABELS;
  var PAYLOAD = {"binary":{"labels":["gap","method","effect"],"models":{"gap":{"W":[0.599,0.4142,-0.2674,-0.375,-0.0355,0.5995,0.2852,-0.6592,-0.6698,-0.3117,0.2199,0.0,0.0,0.0489,0.1666,-0.2713],"b":-0.8147,"th":0.62,"metrics":{"prec":0.5699,"rec":0.7039,"f1":0.6298,"baseline":0.1976}},"method":{"W":[-0.1337,-0.0971,0.7025,-0.3018,-0.3876,0.006,0.0971,1.1988,-0.2922,-0.2898,-0.5114,0.0,0.0,-0.026,-0.0114,0.2275],"b":-0.4682,"th":0.56,"metrics":{"prec":0.7246,"rec":0.7911,"f1":0.7564,"baseline":0.3284}},"effect":{"W":[-0.3184,-0.3145,-0.3253,0.4753,0.3525,-0.4161,-0.3154,-0.8083,0.5815,0.4628,0.2423,0.0,0.0,-0.0206,-0.106,-0.0128],"b":-0.0452,"th":0.42,"metrics":{"prec":0.7245,"rec":0.8325,"f1":0.7748,"baseline":0.474}}},"mu":[0.0437,0.2418,0.8014,0.6057,0.4109,0.3092,0.2397,0.1901,0.2278,0.2461,0.6063,0.0,0.0,0.0007,0.0765,0.134],"sd":[0.5644,0.5091,0.6965,0.5361,0.4066,0.2395,0.213,0.2221,0.2313,0.2217,0.2591,1.0,1.0,0.0256,0.2658,0.1902],"dim":16,"binary_map":{"gap":["BACKGROUND","OBJECTIVE"],"method":["METHODS"],"effect":["RESULTS","CONCLUSIONS"]},"feat_labels":["BACKGROUND","OBJECTIVE","METHODS","RESULTS","CONCLUSIONS"]},"lex":{"BACKGROUND":{"identifier":3.718,"unknown":2.546,"unclear":2.536,"remains":2.304,"clinicaltrials":2.283,"nct":2.256,"registry":2.232,"little":2.198,"few":2.108,"shown":2.097,"cause":2.097,"often":2.055,"known":2.051,"aimed":1.982,"limited":1.798,"investigated":1.454,"common":1.45,"current":1.422,"people":1.375,"human":1.369,"national":1.361,"registered":1.343,"important":1.274,"purpose":1.267,"role":1.223,"despite":1.196,"reduce":1.193,"whether":1.19,"designed":1.139,"effectiveness":1.131,"available":1.123,"evidence":1.119,"prevention":1.115,"disorder":1.108,"chronic":1.091,"interventions":1.073,"improve":1.026,"increasing":1.008,"because":1.007,"cancer":1.005,"present":0.995,"disease":0.993,"advanced":0.979,"management":0.966,"research":0.966,"development":0.961,"new":0.955,"cardiovascular":0.924,"coronary":0.887,"developed":0.879,"breast":0.844,"previous":0.834,"lung":0.826,"potential":0.815,"health":0.808,"major":0.794,"impact":0.793,"examined":0.752,"approach":0.745,"reducing":0.725,"investigate":0.719,"practice":0.712,"need":0.708,"although":0.703,"factor":0.703,"long-term":0.692,"syndrome":0.678,"efficacy":0.677,"acute":0.662,"stress":0.658,"assess":0.651,"infection":0.651,"cardiac":0.633,"surgical":0.596,"cognitive":0.594,"evaluate":0.593,"due":0.592,"risk":0.59,"effective":0.584,"mortality":0.583,"failure":0.551,"safety":0.529,"diabetes":0.526,"compare":0.515,"determine":0.509,"primary":-0.521,"levels":-0.545,"first":-0.549,"assessed":-0.567,"test":-0.611,"changes":-0.611,"randomized":-0.631,"versus":-0.655,"using":-0.659,"who":-0.67,"outcome":-0.696,"after":-0.781,"adverse":-0.842,"rate":-0.986,"time":-1.042,"two":-1.075,"years":-1.084,"both":-1.12,"control":-1.178},"OBJECTIVE":{"investigate":3.068,"purpose":2.98,"compare":2.977,"sought":2.94,"explore":2.788,"evaluate":2.775,"determine":2.648,"examine":2.603,"whether":2.317,"assess":2.128,"aimed":2.112,"investigated":1.878,"effectiveness":1.764,"efficacy":1.717,"safety":1.51,"impact":1.411,"syndrome":1.41,"examined":1.333,"chronic":1.225,"long-term":1.205,"acute":1.193,"diabetes":1.147,"present":1.136,"coronary":1.105,"type":1.092,"prevention":1.055,"therapy":0.926,"combined":0.886,"undergoing":0.882,"management":0.85,"adults":0.836,"program":0.829,"cancer":0.816,"combination":0.805,"cognitive":0.798,"potential":0.784,"reduce":0.769,"stroke":0.765,"disease":0.759,"oral":0.758,"early":0.75,"factors":0.745,"performance":0.712,"improve":0.663,"different":0.645,"evaluated":0.622,"training":0.595,"alone":0.59,"heart":0.588,"children":0.573,"function":0.561,"exercise":0.56,"clinical":0.554,"quality":0.517,"risk":0.508,"versus":0.501,"two":-0.51,"rate":-0.601,"time":-0.705,"years":-0.805,"control":-0.817},"METHODS":{"divided":3.57,"masked":3.312,"collected":2.875,"randomly":2.839,"blinded":2.737,"parallel-group":2.696,"interviews":2.683,"single-blind":2.67,"consisted":2.536,"randomisation":2.507,"double-blinded":2.501,"receive":2.498,"crossover":2.484,"random":2.475,"scheduled":2.464,"parallel":2.4,"double-blind":2.303,"multicentre":2.283,"consecutive":2.262,"sixty":2.234,"allocated":2.215,"calculated":2.207,"inventory":2.198,"every":2.154,"questionnaires":2.153,"allocation":2.123,"assigned":2.114,"centres":2.11,"aged":2.099,"open-label":2.093,"placebo-controlled":2.066,"january":2.046,"twenty":2.033,"recruited":2.032,"recorded":2.026,"monitored":2.018,"assignment":2.006,"analyzed":1.986,"blind":1.986,"conducted":1.957,"center":1.947,"university":1.947,"stratified":1.936,"clinics":1.926,"december":1.92,"measured":1.898,"assessed":1.893,"twice":1.892,"sessions":1.884,"questionnaire":1.861,"analysed":1.86,"followed":1.855,"cluster":1.828,"multicenter":1.813,"analog":1.802,"analogue":1.795,"centers":1.791,"participated":1.791,"prospective":1.787,"performed":1.783,"randomised":1.745,"randomized":1.742,"carried":1.741,"underwent":1.713,"rating":1.684,"scale":1.676,"included":1.66,"june":1.656,"selected":1.647,"endpoints":1.643,"until":1.64,"eligible":1.636,"weekly":1.631,"defined":1.629,"received":1.628,"samples":1.628,"hospitals":1.61,"undergo":1.604,"survey":1.595,"logistic":1.567,"endpoint":1.555,"cycles":1.517,"determined":1.499,"either":1.498,"session":1.485,"assessments":1.464,"secondary":1.462,"old":1.461,"measure":1.397,"criteria":1.391,"laboratory":1.378,"hundred":1.376,"monthly":1.373,"cox":1.369,"randomization":1.363,"scales":1.345,"taken":1.344,"standardized":1.333,"march":1.314,"clinic":1.314,"primary":1.31,"controlled":1.309,"according":1.308,"applied":1.302,"using":1.301,"telephone":1.294,"intention":1.285,"elective":1.252,"weeks":1.247,"before":1.238,"tests":1.236,"intervals":1.231,"linear":1.22,"volunteers":1.214,"enrolled":1.208,"regression":1.207,"prospectively":1.204,"inclusion":1.193,"saline":1.183,"adult":1.182,"include":1.179,"examination":1.176,"outpatient":1.174,"immediately":1.167,"outcome":1.166,"design":1.162,"evaluated":1.151,"daily":1.136,"administered":1.136,"via":1.131,"end":1.116,"four":1.11,"six":1.097,"review":1.086,"department":1.084,"minute":1.066,"visual":1.065,"mixed":1.064,"repeated":1.037,"made":1.014,"measures":1.012,"visit":1.009,"obtained":1.004,"measurements":1.001,"diagnosed":0.988,"week":0.98,"three":0.98,"eight":0.977,"models":0.972,"participants":0.963,"days":0.948,"later":0.943,"usual":0.94,"day":0.938,"point":0.935,"international":0.929,"hospital":0.926,"hour":0.914,"assessment":0.91,"used":0.897,"sites":0.885,"pre":0.877,"practices":0.87,"minutes":0.866,"units":0.856,"order":0.85,"years":0.848,"american":0.846,"unit":0.838,"last":0.836,"given":0.828,"one":0.825,"five":0.801,"completion":0.799,"completed":0.791,"intention-to-treat":0.791,"main":0.784,"phase":0.772,"times":0.768,"modified":0.759,"experimental":0.758,"visits":0.753,"index":0.752,"healthy":0.75,"estimated":0.747,"least":0.746,"test":0.731,"data":0.723,"continued":0.723,"urine":0.715,"self-reported":0.71,"hours":0.705,"two":0.696,"period":0.693,"postoperatively":0.684,"iii":0.682,"sham":0.676,"min":0.663,"months":0.656,"containing":0.652,"maximum":0.646,"month":0.641,"block":0.641,"variables":0.637,"who":0.634,"measurement":0.629,"analyses":0.625,"second":0.624,"single":0.619,"plus":0.617,"composite":0.616,"evaluation":0.613,"diagnosis":0.605,"post":0.595,"subjects":0.586,"points":0.585,"based":0.581,"medical":0.575,"sample":0.575,"seven":0.567,"imaging":0.562,"testing":0.554,"anesthesia":0.549,"comparing":0.547,"delivered":0.546,"per":0.543,"male":0.536,"general":0.531,"analysis":0.519,"induction":0.517,"examined":0.517,"ultrasound":0.512,"infusion":0.51,"throughout":0.504},"RESULTS":{"iqr":3.923,"interquartile":3.453,"died":2.999,"odds":2.878,"hazard":2.818,"confidence":2.758,"respectively":2.734,"median":2.592,"revealed":2.482,"differ":2.466,"statistically":2.362,"occurred":2.339,"interval":2.302,"between-group":2.235,"remained":2.173,"exhibited":2.041,"mean":2.013,"except":2.003,"correlated":1.993,"showed":1.989,"trend":1.984,"similarly":1.904,"none":1.887,"differences":1.845,"noted":1.834,"deaths":1.826,"adjusted":1.803,"rsb-":1.753,"lsb-":1.752,"seen":1.734,"highest":1.728,"ratio":1.724,"found":1.721,"observed":1.693,"shorter":1.682,"similar":1.644,"percent":1.62,"average":1.617,"auc":1.609,"interaction":1.541,"greater":1.54,"reductions":1.532,"fewer":1.485,"serious":1.475,"adjustment":1.471,"scores":1.453,"experienced":1.43,"whereas":1.41,"mmhg":1.404,"grade":1.395,"values":1.375,"detected":1.359,"aes":1.313,"predicted":1.302,"reported":1.293,"comparable":1.282,"achieved":1.268,"relative":1.243,"versus":1.232,"indicated":1.232,"mmol":1.221,"percentage":1.202,"correlation":1.18,"controls":1.178,"event":1.169,"nausea":1.162,"improvements":1.115,"cumulative":1.114,"multivariate":1.096,"arms":1.092,"events":1.091,"longer":1.088,"overall":1.075,"both":1.072,"range":1.069,"absolute":1.067,"adverse":1.056,"curve":1.049,"decrease":1.038,"statistical":1.021,"peak":1.011,"likely":0.985,"reduced":0.982,"improvement":0.967,"ratios":0.949,"score":0.944,"significance":0.943,"cholesterol":0.938,"arm":0.927,"all":0.892,"rates":0.874,"across":0.869,"il-":0.868,"improved":0.867,"placebo":0.844,"vas":0.839,"less":0.836,"rate":0.82,"whom":0.805,"systolic":0.801,"proportion":0.786,"sex":0.784,"reduction":0.775,"maintained":0.762,"subgroup":0.754,"frequent":0.75,"baseline":0.748,"resulted":0.733,"change":0.731,"final":0.722,"incidence":0.711,"met":0.702,"total":0.683,"seven":0.683,"better":0.666,"hba":0.658,"concentrations":0.652,"levels":0.651,"time":0.642,"stay":0.642,"eyes":0.64,"increase":0.638,"follow-up":0.629,"consistent":0.629,"receiving":0.624,"per":0.611,"pfs":0.606,"concentration":0.604,"bmi":0.593,"intention-to-treat":0.589,"min":0.588,"characteristics":0.559,"value":0.539,"identified":0.536,"demonstrated":0.534,"control":0.522,"cases":0.522,"completed":0.508,"combined":-0.503,"criteria":-0.504,"factors":-0.506,"population":-0.506,"scale":-0.526,"use":-0.531,"usual":-0.546,"injection":-0.549,"stroke":-0.553,"children":-0.558,"models":-0.561,"bone":-0.563,"underwent":-0.58,"physical":-0.581,"conventional":-0.582,"cardiovascular":-0.59,"life":-0.592,"combination":-0.598,"functional":-0.604,"according":-0.608,"sample":-0.62,"individuals":-0.622,"quality":-0.629,"exercise":-0.643,"protocol":-0.646,"early":-0.65,"assessment":-0.663,"surgery":-0.67,"either":-0.682,"recorded":-0.691,"muscle":-0.698,"surgical":-0.74,"data":-0.771,"recruited":-0.772,"older":-0.779,"assigned":-0.793,"general":-0.798,"questionnaire":-0.8,"secondary":-0.804,"outcome":-0.812,"analyzed":-0.827,"therapy":-0.835,"disease":-0.868,"training":-0.883,"new":-0.889,"through":-0.903,"cognitive":-0.907},"CONCLUSIONS":{"appears":4.1,"seems":3.301,"suggest":3.118,"feasible":3.01,"safe":2.829,"future":2.818,"useful":2.776,"effectively":2.766,"findings":2.654,"indicate":2.562,"suggests":2.443,"option":2.379,"provide":2.207,"provides":2.175,"demonstrate":2.042,"help":1.968,"effective":1.926,"tolerated":1.879,"beneficial":1.862,"needed":1.855,"larger":1.847,"benefit":1.808,"improves":1.791,"improving":1.769,"improve":1.712,"alternative":1.71,"even":1.709,"reduces":1.581,"show":1.572,"reducing":1.542,"reduce":1.51,"resulted":1.484,"potential":1.429,"benefits":1.422,"need":1.421,"superior":1.388,"affect":1.373,"support":1.336,"strategy":1.308,"profile":1.289,"better":1.252,"important":1.245,"approach":1.22,"implementation":1.207,"small":1.183,"recommended":1.18,"long-term":1.167,"role":1.164,"evidence":1.146,"although":1.12,"considered":1.111,"good":1.11,"clinically":1.099,"setting":1.078,"improved":1.043,"strategies":1.018,"application":1.003,"research":0.999,"despite":0.984,"practice":0.97,"additional":0.941,"increasing":0.939,"large":0.937,"comparable":0.911,"technique":0.904,"increases":0.9,"early":0.897,"prevention":0.892,"use":0.889,"interventions":0.881,"well":0.879,"when":0.877,"improvements":0.873,"terms":0.871,"population":0.859,"demonstrated":0.855,"longer":0.847,"supplementation":0.841,"provided":0.838,"likely":0.831,"therapeutic":0.782,"administration":0.779,"low":0.748,"combination":0.746,"development":0.741,"addition":0.739,"increase":0.732,"high":0.724,"reduced":0.72,"information":0.706,"management":0.672,"knowledge":0.66,"required":0.644,"exposure":0.63,"because":0.629,"nct":0.617,"clinicaltrials":0.611,"new":0.611,"impact":0.61,"risk":0.601,"people":0.589,"combined":0.585,"function":0.578,"recovery":0.57,"improvement":0.559,"less":0.532,"related":0.508,"due":0.508,"differences":-0.5,"measures":-0.508,"outcome":-0.538,"phase":-0.549,"using":-0.575,"follow-up":-0.579,"subjects":-0.6,"controlled":-0.764,"before":-0.84,"control":-0.846,"primary":-0.906,"age":-0.914,"analysis":-0.924,"weeks":-0.967,"years":-0.979,"placebo":-0.996,"months":-1.01,"all":-1.017,"day":-1.03,"one":-1.158,"participants":-1.298,"total":-1.375,"two":-1.388,"baseline":-1.469,"randomized":-1.539}}};
  BIN = PAYLOAD.binary;
  LEX = PAYLOAD.lex;
  // ★ 特征的 A/A2 组按**5 类原标签**算（BACKGROUND/OBJECTIVE/METHODS/RESULTS/CONCLUSIONS），
  //   不是按二元目标（gap/method/effect）—— 训练时就是这么算的，顺序必须一致。
  //   踩过的坑：曾从 PAYLOAD 顶层读 feat_labels，而 export_binary.py 每次用模板重生成
  //   会把占位符外的改动一起冲掉 → FEAT_LABELS undefined → 特征全 0 → 判不出任何句子。
  //   修：从 BIN.feat_labels 读（随模型文件走，模板不会被覆盖）。
  FEAT_LABELS = BIN.feat_labels || ["BACKGROUND","OBJECTIVE","METHODS","RESULTS","CONCLUSIONS"];
  BIN = PAYLOAD.binary;
  LEX = PAYLOAD.lex;

  var STOP = new Set(('the and for with that this from are was were which their there have has been ' +
    'not but can will our its also such than then thus therefore however more most much many some any ' +
    'each other another into over under between during within without about above below out off ' +
    'used using based shown given these those it is').split(' '));

  function sigmoid(z) {
    if (z < -30) return 0;
    if (z > 30) return 1;
    return 1 / (1 + Math.exp(-z));
  }

  // 复刻 research/train_role_classifier.py 的 featurize 前 16 维
  // （后 10 维是 sequential，二元判断与前后句无关，训练时就切掉了）
  function featurize16(sent) {
    var low = sent.toLowerCase();
    var seen = {}, m = low.match(/[a-z][a-z\-]{2,}/g) || [], k;
    for (k = 0; k < m.length; k++) if (!STOP.has(m[k])) seen[m[k]] = 1;
    if (/\d/.test(sent)) seen['@num'] = 1;
    var wl = Object.keys(seen);
    var f = [], labels = FEAT_LABELS, i, tbl, hits, n;
    for (i = 0; i < labels.length; i++) {            // A. 每类先验平均分
      tbl = LEX[labels[i]] || {};
      hits = [];
      for (k = 0; k < wl.length; k++) if (tbl[wl[k]] !== undefined) hits.push(tbl[wl[k]]);
      f.push(hits.length ? hits.reduce(function (a, b) { return a + b; }, 0) / hits.length : 0);
    }
    var HITMAX = 8;
    for (i = 0; i < labels.length; i++) {            // A2. 命中词数
      tbl = LEX[labels[i]] || {};
      n = 0;
      for (k = 0; k < wl.length; k++) if (tbl[wl[k]] !== undefined) n++;
      f.push(Math.min(1, n / HITMAX));
    }
    f.push(Math.min(1, sent.split(/\s+/).length / 40));   // B. 结构
    f.push(/\d/.test(sent) ? 1 : 0);
    f.push(Math.min(1, (sent.match(/\d/g) || []).length / 10));
    f.push(sent.indexOf('?') >= 0 ? 1 : 0);
    f.push(/^\s*(we|our|this)/.test(low) ? 1 : 0);
    f.push(Math.min(1, (sent.split(',').length - 1) / 8));
    return f;
  }

  function judgeOne(kind, sent) {
    var mdl = BIN.models[kind];
    if (!mdl) return null;
    var f = featurize16(sent), d = BIN.dim, i;
    for (i = 0; i < d; i++) f[i] = (f[i] - BIN.mu[i]) / BIN.sd[i];
    var z = mdl.b;
    for (i = 0; i < d; i++) z += mdl.W[i] * f[i];
    var p = sigmoid(z);
    return { prob: p, yes: p >= mdl.th, th: mdl.th };
  }

  var G = (typeof window !== 'undefined') ? window : globalThis;
  G.PL_BINARY = {
    kinds: BIN.labels,
    judge: judgeOne,
    // 给一串句子 → {gap: [...], method: [...], effect: [...]}，按概率降序
    judgeAll: function (sentences) {
      var out = {};
      for (var t = 0; t < BIN.labels.length; t++) out[BIN.labels[t]] = [];
      for (var i = 0; i < sentences.length; i++) {
        for (var k = 0; k < BIN.labels.length; k++) {
          var kind = BIN.labels[k];
          var r = judgeOne(kind, sentences[i]);
          if (r && r.yes) out[kind].push({ i: i, sent: sentences[i], prob: r.prob });
        }
      }
      for (var kk in out) out[kk].sort(function (a, b) { return b.prob - a.prob; });
      return out;
    },
    // ★ 只对英文用（见文件头）。中文走 core.js 的词表 + 位置先验。
    // ★ 同时挡掉「不该交给模型的句子」—— 这是实测出来的分工：
    //   模型的错集中在三类句子上（21 句真实论文里错的 3-4 条全是这三类）：
    //     ① 图表引用句 "We present these results in In rows (A), we vary…" → 判 method
    //     ② 陈词套话   "To the best of our knowledge, the Transformer is…" → 判 method
    //     ③ 版面残留   参考文献编号、孤立年份
    //   这些**在句子里读不出"这是图表/这是套话"**，模型再大也治不了；
    //   但规则一眼能认。所以规则负责剔噪，模型负责判内容 —— 各管一段。
    //
    //   实测边界（137 句真实论文句）：
    //     拦掉 6 条 = 4.4%，带数字的句子 13 条**一条没误伤**
    //   踩过的两个坑（都是误拦真内容，已修）：
    //     · 只因提到 "table 3" 就拦整句 → 误杀 "step time was 1.0 seconds"
    //       → 改：只有"引用是句子主体"才拦（短句/引用开头/≥2 处/无数字结论）
    //     · 把 "In this work we propose the Transformer…" 当套话 → 那是核心贡献句
    //       → 改：去掉 "in this work we…"，只留纯导航句
    usableFor: function (sent) {
      if (/[\u4e00-\u9fff]/.test(sent)) return false;      // 中文不归它管
      var w = sent.split(/\s+/).length;
      // 陈词/导航套话
      if (w <= 30 && /to the best of our knowledge|rest of (this|the) (paper|article)|(this|the) (paper|article) is organized as follows|as (discussed|described|shown|mentioned) (above|below|earlier)|for (more|further) details|we (refer|point) (the )?reader/i.test(sent)) return false;
      // 版面残留
      if (/^\s*\[\d+\]/.test(sent)) return false;
      // 图表引用为主体
      var refs = sent.match(/\b(Fig(ure)?|Tab(le)?|Eq(uation)?|Sec(tion)?|Alg(orithm)?|rows?|colou?mns?|Appendix)\b\s*\.?\s*[\(\[]?\d/gi) || [];
      if (refs.length >= 2) return false;
      if (refs.length === 1) {
        var hasNum = /\d+(\.\d+)?\s*(%|BLEU|F1|GB|MB|ms|seconds?|days?|GPUs?|layers?|heads?|epochs?|parameters?|tokens?)/i.test(sent);
        if (w < 15) return false;                                        // 短句纯引用
        if (/^\s*(Fig|Tab|Eq|Sec|Alg|rows?|colou?mns?|Appendix)/i.test(sent)) return false;  // 引用开头
        if (!hasNum && /\b(rows?|colou?mns?|table|figure)\b/i.test(sent)) return false;      // 无数字结论
      }
      return true;
    },
    metrics: (function () {
      var o = {};
      for (var k in BIN.models) o[k] = BIN.models[k].metrics;
      return o;
    })(),
    __bin: BIN, __lex: LEX
  };
})();
