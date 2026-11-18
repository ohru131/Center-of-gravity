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

  // 線を gap だけ太らせてすきまをつなぎ、内側をぬりつぶしてから同じだけ細らせる
  function shapesAt(ink, w, h, gap, minArea) {
    const filled = spread(fillEnclosed(spread(ink, w, h, gap, 1), w, h), w, h, gap, 0);
    const { labels, stats } = label(filled, w, h);
    const keep = [];
    let area = 0;
    // ふちにかかるもの（机・かげなど）と小さいゴミはすてる
    for (let id = 1; id < stats.length; id++) {
      if (!stats[id].border && stats[id].area >= minArea) { keep.push(id); area += stats[id].area; }
    }
    return { labels, stats, keep, area };
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

  const GAPS = [0, 1, 2, 3, 5, 8, 12];

  /* gray: Uint8Array(w*h) の明るさ。opt.t: 二値化の強さ(0〜1)、opt.gap: つなぐ幅(px, 省略で自動)
     戻り値 { contours: [[{x,y}…]…], gap } */
  function detect(gray, w, h, opt) {
    opt = opt || {};
    const ink = adaptiveInk(gray, w, h, opt.t == null ? 0.15 : opt.t);
    // ぽつんと離れた数画素のノイズを消す。かすれた線のかけらは、近くの線とまとめて数えるので残る
    const near = label(spread(ink, w, h, 1, 1), w, h);
    const count = new Int32Array(near.stats.length);
    for (let i = 0; i < w * h; i++) if (ink[i]) count[near.labels[i]]++;
    for (let i = 0; i < w * h; i++) if (ink[i] && count[near.labels[i]] < 6) ink[i] = 0;

    const minArea = Math.max(30, Math.round(w * h * 0.002));
    let gap = opt.gap, res;
    if (gap == null) {
      // 自動：ぬれた面積がほぼ最大になる、いちばん小さいつなぎ幅
      const tries = GAPS.map(g => shapesAt(ink, w, h, g, minArea));
      const max = Math.max(...tries.map(t => t.area));
      const i = tries.findIndex(t => t.area >= max * 0.85);
      gap = GAPS[i]; res = tries[i];
    } else {
      res = shapesAt(ink, w, h, gap, minArea);
    }
    const contours = res.keep.map(id => traceBoundary(res.labels, w, h, id, res.stats[id].start));
    return { contours, gap };
  }

  const Trace = { adaptiveInk, detect };
  if (typeof module !== 'undefined' && module.exports) module.exports = Trace;
  else root.Trace = Trace;
})(typeof globalThis !== 'undefined' ? globalThis : this);
