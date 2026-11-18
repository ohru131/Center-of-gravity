/* 写真・画像 → 閉じた輪郭。二値化 → すきまをつなぐ → ぬりつぶし → 輪郭追跡。ブラウザ/Node 共用。 */
(function (root) {
  'use strict';

  /* 適応的二値化（Bradley法）：まわりの平均より t 以上暗い画素を「線」とする。
     照明むら・かげに強く、うすい線もひろえる。 */
  function adaptiveInk(gray, w, h, t) {
    const W = w + 1, integ = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += gray[y * w + x];
        integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row;
      }
    }
    const half = Math.max(4, Math.round(Math.max(w, h) / 16));
    const ink = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
        const sum = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0];
        if (gray[y * w + x] * (x1 - x0) * (y1 - y0) < sum * (1 - t)) ink[y * w + x] = 1;
      }
    }
    return ink;
  }

  // 4連結でラベルづけ。labels は 1 始まり、stats[id] = { area, border }
  function label(mask, w, h) {
    const labels = new Int32Array(w * h), stats = [null], stack = [];
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || labels[s]) continue;
      const id = stats.length, st = { area: 0, border: false, start: s };
      stats.push(st);
      labels[s] = id; stack.push(s);
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p - x) / w;
        st.area++;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) st.border = true;
        if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = id; stack.push(p - 1); }
        if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = id; stack.push(p + 1); }
        if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = id; stack.push(p - w); }
        if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = id; stack.push(p + w); }
      }
    }
    return { labels, stats };
  }

  // 正方形 (2r+1) での膨張。v = 広げる値（1: 膨張 / 0: 収縮）
  function spread(mask, w, h, r, v) {
    if (r <= 0) return mask;
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    const pass = (src, dst, n, m, step, stride) => {
      for (let j = 0; j < m; j++) {
        const base = j * stride;
        let count = 0;
        for (let i = 0; i < Math.min(r, n); i++) if (src[base + i * step] === v) count++;
        for (let i = 0; i < n; i++) {
          if (i + r < n && src[base + (i + r) * step] === v) count++;
          if (i - r - 1 >= 0 && src[base + (i - r - 1) * step] === v) count--;
          dst[base + i * step] = count > 0 ? v : 1 - v;
        }
      }
    };
    pass(mask, tmp, w, h, 1, w);
    pass(tmp, out, h, w, w, 1);
    return out;
  }

  // 画像のふちから「線でない所」をたどり、とどかなかった所（線 + 線に囲まれた内側）を返す
  function fillEnclosed(ink, w, h) {
    const seen = new Uint8Array(w * h), stack = [];
    const push = p => { if (!ink[p] && !seen[p]) { seen[p] = 1; stack.push(p); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
      const p = stack.pop(), x = p % w;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (p >= w) push(p - w);
      if (p < w * (h - 1)) push(p + w);
    }
    const filled = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) filled[i] = seen[i] ? 0 : 1;
    return filled;
  }

  const GAPS = [0, 1, 2, 3, 5, 8, 12];  // 自動でためす つなぎ幅
  const THIN = 6;                       // はば 13 画素以下のものは「線」とみなす

  /* 線を gap だけ太らせてすきまをつなぎ、内側をぬりつぶしてから同じだけ細らせる。
     m = 画像のまわりに足した余白の幅（余白の内がわの線 = 元の画像のふち） */
  function shapesAt(ink, w, h, gap, minArea, m) {
    const filled = spread(fillEnclosed(spread(ink, w, h, gap, 1), w, h), w, h, gap, 0);
    const { labels, stats } = label(filled, w, h);
    // 細らせても残る = 面としての太さがある。とじていない線の切れはしは消える
    const core = spread(filled, w, h, THIN, 0), solid = new Uint8Array(stats.length);
    for (let i = 0; i < w * h; i++) if (core[i]) solid[labels[i]] = 1;
    // 元の画像のふちにかかるもの（机・かげなど）
    const edge = new Uint8Array(stats.length);
    for (let x = m; x < w - m; x++) { edge[labels[m * w + x]] = 1; edge[labels[(h - 1 - m) * w + x]] = 1; }
    for (let y = m; y < h - m; y++) { edge[labels[y * w + m]] = 1; edge[labels[y * w + w - 1 - m]] = 1; }
    const keep = [];
    let area = 0;
    // ふちにかかるもの、小さいゴミ、ただの線はすてる
    for (let id = 1; id < stats.length; id++) {
      if (!edge[id] && solid[id] && stats[id].area >= minArea) { keep.push(id); area += stats[id].area; }
    }
    return { labels, stats, keep, area, gap };
  }

  /* 領域 id の外周を、画素のさかい目にそってたどる（領域を右手に見て一周）。
     ななめ接触は別の領域あつかい（4連結）。 */
  function traceBoundary(labels, w, h, id, start) {
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === id;
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1]; // 東・南・西・北
    // 進行方向 d のとき、頂点 (x,y) の「前方右」「前方左」の画素
    const RX = [0, -1, -1, 0], RY = [0, 0, -1, -1], LX = [0, 0, -1, -1], LY = [-1, 0, 0, -1];
    const sx = start % w, sy = (start - sx) / w;
    let x = sx, y = sy, d = 0;
    const pts = [];
    const limit = 4 * w * h + 8;
    for (let n = 0; n < limit; n++) {
      let nd;
      if (!at(x + RX[d], y + RY[d])) nd = (d + 1) % 4;        // 右へまがる
      else if (at(x + LX[d], y + LY[d])) nd = (d + 3) % 4;    // 左へまがる
      else nd = d;                                            // 直進
      if (nd !== d || n === 0) pts.push({ x, y });
      d = nd;
      x += DX[d]; y += DY[d];
      if (x === sx && y === sy && n > 0) break;
    }
    return pts;
  }



  /* 二値化の強さの目安。背景のざらつき（ノイズ）が小さい画像ほど、うすい線までひろう。
     きれいな背景の画像 → 0.03 前後、紙を写した写真 → 0.1 前後 */
  function suggestThreshold(gray, w, h) {
    const hist = new Int32Array(256);
    let n = 0;
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        const i = y * w + x;
        const d = Math.abs(4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]) >> 2;
        hist[d]++; n++;
      }
    }
    let acc = 0, med = 0;
    while (med < 255 && (acc += hist[med]) < n / 2) med++;   // となりとの差の中央値
    return Math.min(0.15, 0.03 + med * 0.02);
  }

  /* gray: Uint8Array(w*h) の明るさ。opt.t: 二値化の強さ(0〜1)、opt.gap: つなぐ幅(px, 省略で自動)
     戻り値 { contours: [[{x,y}…]…], gap } */
  function detect(gray, w, h, opt) {
    opt = opt || {};
    const ink0 = adaptiveInk(gray, w, h, opt.t == null ? 0.15 : opt.t);
    // ぽつんと離れた数画素のノイズを消す。かすれた線のかけらは、近くの線とまとめて数えるので残る
    const near = label(spread(ink0, w, h, 1, 1), w, h);
    const count = new Int32Array(near.stats.length);
    for (let i = 0; i < w * h; i++) if (ink0[i]) count[near.labels[i]]++;
    for (let i = 0; i < w * h; i++) if (ink0[i] && count[near.labels[i]] < 6) ink0[i] = 0;

    // 画像のふち近くの形が欠けないよう、まわりに白い余白を足して処理する
    const m = Math.max(opt.gap || 0, GAPS[GAPS.length - 1]) + THIN + 2;
    const W = w + 2 * m, H = h + 2 * m, ink = new Uint8Array(W * H);
    for (let y = 0; y < h; y++) ink.set(ink0.subarray(y * w, (y + 1) * w), (y + m) * W + m);

    const minArea = Math.max(30, Math.round(w * h * 0.002));
    const picked = [];   // { res, id }
    let gap = opt.gap;
    if (gap == null) {
      /* 自動：形ごとに、ほぼ全体がぬれる いちばん小さいつなぎ幅をえらぶ。
         まず面積が最大になる幅での領域を「形の候補」とし、候補ごとに小さい幅から調べる。 */
      const tries = GAPS.map(g => shapesAt(ink, W, H, g, minArea, m));
      const max = Math.max(...tries.map(t => t.area));
      const ref = tries.find(t => t.area >= max * 0.98);
      gap = 0;
      for (const region of ref.keep) {
        for (const t of tries) {
          const ids = t.keep.filter(id => ref.labels[t.stats[id].start] === region);
          const area = ids.reduce((sum, id) => sum + t.stats[id].area, 0);
          if (area >= ref.stats[region].area * 0.85 || t === ref) {
            for (const id of ids) picked.push({ res: t, id });
            gap = Math.max(gap, t.gap);
            break;
          }
        }
      }
    } else {
      const res = shapesAt(ink, W, H, gap, minArea, m);
      for (const id of res.keep) picked.push({ res, id });
    }
    const contours = picked.map(({ res, id }) =>
      traceBoundary(res.labels, W, H, id, res.stats[id].start).map(p => ({ x: p.x - m, y: p.y - m })));
    return { contours, gap };
  }

  const Trace = { adaptiveInk, suggestThreshold, detect };
  if (typeof module !== 'undefined' && module.exports) module.exports = Trace;
  else root.Trace = Trace;
})(typeof globalThis !== 'undefined' ? globalThis : this);
