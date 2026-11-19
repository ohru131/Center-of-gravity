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

  /* 線画むけ。gray: Uint8Array(w*h) の明るさ。opt.t: 二値化の強さ(0〜1)、opt.gap: つなぐ幅(px, 省略で自動)
     戻り値 { contours: [[{x,y}…]…], gap, fill } */
  function detect(gray, w, h, opt) {
    opt = opt || {};
    return shapesFromInk(adaptiveInk(gray, w, h, opt.t == null ? 0.15 : opt.t), w, h, opt);
  }

  /* ---------- カラー写真の物体（背景とちがう色のかたまり）---------- */

  // 色の特徴量（明るさ L と色み 2 成分）を 3x3 でならして返す。かげに強くするため L は軽くあつかう
  const L_WEIGHT = 0.6;
  function colorFeatures(rgba, w, h) {
    const n = w * h, raw = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      raw[0][i] = L_WEIGHT * (r + g + b) / 3; raw[1][i] = r - g; raw[2][i] = (r + g) / 2 - b;
    }
    return raw.map(src => {
      const tmp = new Float32Array(n), out = new Float32Array(n);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        tmp[i] = (src[x > 0 ? i - 1 : i] + src[i] + src[x < w - 1 ? i + 1 : i]) / 3;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        out[i] = (tmp[y > 0 ? i - w : i] + tmp[i] + tmp[y < h - 1 ? i + w : i]) / 3;
      }
      return out;
    });
  }

  // 画像のふちの帯から背景の代表色を k 個もとめる（k-means）
  function borderColors(f, w, h, k) {
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.03)), samples = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= band && x < w - band && y >= band && y < h - band) { x = w - band - 1; continue; }
      if ((x + y) % 2 === 0) samples.push(y * w + x);
    }
    let centers = [];
    for (let j = 0; j < k; j++) { const i = samples[Math.floor((j + 0.5) * samples.length / k)]; centers.push([f[0][i], f[1][i], f[2][i]]); }
    for (let iter = 0; iter < 8; iter++) {
      const sum = centers.map(() => [0, 0, 0, 0]);
      for (const i of samples) {
        let best = 0, bd = Infinity;
        for (let j = 0; j < centers.length; j++) {
          const c = centers[j], d = (f[0][i] - c[0]) ** 2 + (f[1][i] - c[1]) ** 2 + (f[2][i] - c[2]) ** 2;
          if (d < bd) { bd = d; best = j; }
        }
        const s = sum[best]; s[0] += f[0][i]; s[1] += f[1][i]; s[2] += f[2][i]; s[3]++;
      }
      centers = sum.filter(s => s[3] > 0).map(s => [s[0] / s[3], s[1] / s[3], s[2] / s[3]]);
    }
    return centers;
  }

  /* 物体むけ。rgba: 画素データ(w*h*4)。opt.sens: 感度の倍率(1 = 自動、大きいほど背景に近い色もひろう)
     1) 画像のふちの色を「背景」としておぼえる
     2) 各画素の背景からの色のへだたりを出す。背景より暗いだけの所（かげ）は、へだたりを小さめに見る
     3) しきい値 = ふちの画素じしんのばらつき（木目・ざらつき）の数倍。それをこえたら物体
     4) 背景に近い色の画素から広げる。なだらかに変わる所（照明むら・うすいかげ）は少しゆるく通す
     5) とどかなかった所 = 物体（物体の中の背景色の部分は、後段のぬりつぶしでうまる） */
  const SHADOW = 0.3;    // 背景より暗い方向（明るさ半分まで）の明るさの差にかける重み
  function objectInk(rgba, w, h, sens) {
    const f = colorFeatures(rgba, w, h), centers = borderColors(f, w, h, 4), n = w * h;
    const dist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let bd = Infinity;
      for (const c of centers) {
        let dl = f[0][i] - c[0], k = 1;
        // かげ = 背景と同じ色みのまま暗くなった所。暗さの比 k を色みにもかけてくらべる
        if (dl < 0 && c[0] > 0) { k = f[0][i] / c[0]; if (k > 0.5) dl *= SHADOW; }
        const d = dl * dl + (f[1][i] - k * c[1]) ** 2 + (f[2][i] - k * c[2]) ** 2;
        if (d < bd) bd = d;
      }
      dist[i] = Math.sqrt(bd);
    }
    // ふちの帯でのへだたりの 95% 点 = 背景のばらつきの大きさ
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.03)), hist = new Int32Array(256);
    let count = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= band && x < w - band && y >= band && y < h - band) { x = w - band - 1; continue; }
      hist[Math.min(255, Math.round(dist[y * w + x]))]++; count++;
    }
    let acc = 0, p95 = 0;
    while (p95 < 255 && (acc += hist[p95]) < count * 0.95) p95++;
    const T = Math.min(45, Math.max(9, 3 * p95)) / (sens || 1);
    const loose = 2 * T, step2 = (0.15 * T) ** 2;
    const seen = new Uint8Array(n), stack = [];
    for (let p = 0; p < n; p++) if (dist[p] < T) { seen[p] = 1; stack.push(p); }
    const visit = (p, q) => {
      if (seen[q] || dist[q] >= loose) return;
      const d = (f[0][p] - f[0][q]) ** 2 + (f[1][p] - f[1][q]) ** 2 + (f[2][p] - f[2][q]) ** 2;
      if (d >= step2) return;
      seen[q] = 1; stack.push(q);
    };
    while (stack.length) {
      const p = stack.pop(), x = p % w;
      if (x > 0) visit(p, p - 1);
      if (x < w - 1) visit(p, p + 1);
      if (p >= w) visit(p, p - w);
      if (p < n - w) visit(p, p + w);
    }
    const ink = new Uint8Array(n);
    for (let i = 0; i < n; i++) ink[i] = seen[i] ? 0 : 1;
    return ink;
  }

  function detectObject(rgba, w, h, opt) {
    opt = opt || {};
    return shapesFromInk(objectInk(rgba, w, h, opt.sens), w, h, opt);
  }

  /* 共通の後段：線・物体の画素(ink0) → とぎれをつなぐ → 内側をぬる → 輪郭。
     fill = 取れた形のうち ink0 がしめる割合（線画は小さく、中まで色のある物体は 1 に近い） */
  function shapesFromInk(ink0, w, h, opt) {
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
    let inked = 0, total = 0;
    for (const { res, id } of picked) {
      total += res.stats[id].area;
      for (let i = 0; i < W * H; i++) if (ink[i] && res.labels[i] === id) inked++;
    }
    return { contours, gap, area: total, fill: total ? inked / total : 0 };
  }

  const Trace = { adaptiveInk, suggestThreshold, detect, detectObject };
  if (typeof module !== 'undefined' && module.exports) module.exports = Trace;
  else root.Trace = Trace;
})(typeof globalThis !== 'undefined' ? globalThis : this);
