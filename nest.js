/* A4への敷きつめ（ネスティング）とPDF出力。ブラウザ/Node 共用。 */
(function (root) {
  'use strict';

  const Geo = root.Geo || (typeof require === 'function' ? require('./geometry.js') : null);

  const A4 = { w: 210, h: 297 };   // mm
  const MARGIN = 5;                // 用紙のふちの余白 mm
  const FOOTER = 8;                // 下の余白のうち、枚数表示に使う高さ mm

  // 点列を angle 回して (tx,ty) 動かす
  const placePts = (pts, pl) => {
    const c = Math.cos(pl.angle), s = Math.sin(pl.angle);
    return pts.map(p => ({ x: p.x * c - p.y * s + pl.tx, y: p.x * s + p.y * c + pl.ty }));
  };
  const rotatePts = (pts, a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return pts.map(p => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
  };

  /* 外形を角度 a だけ回し、マス目（1マス = cell mm）にぬる。となりとのすきまの半分 + 安全しろとして d マス太らせる。
     戻り値 { w, h, runs: 行ごとの [開始, 終了) の列, gx, gy: マス目の原点（回転後の座標, マス単位） } */
  function rasterize(pts, a, cell, d) {
    const r = rotatePts(pts, a);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of r) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const gx = Math.floor(minX / cell) - d, gy = Math.floor(minY / cell) - d;
    const w = Math.ceil(maxX / cell) - gx + d, h = Math.ceil(maxY / cell) - gy + d;
    const mask = new Uint8Array(w * h);
    // マスの中心で内外判定（偶奇規則）
    for (let j = 0; j < h; j++) {
      const y = (gy + j + 0.5) * cell, xs = [];
      for (let i = 0, n = r.length; i < n; i++) {
        const p = r[i], q = r[(i + 1) % n];
        if ((p.y > y) !== (q.y > y)) xs.push(p.x + (y - p.y) * (q.x - p.x) / (q.y - p.y));
      }
      xs.sort((u, v) => u - v);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] / cell - 0.5) - gx), i1 = Math.min(w - 1, Math.floor(xs[k + 1] / cell - 0.5) - gx);
        for (let i = i0; i <= i1; i++) mask[j * w + i] = 1;
      }
    }
    // 輪郭線の通るマスもぬる（細い所の取りこぼし防止）
    for (let i = 0, n = r.length; i < n; i++) {
      const p = r[i], q = r[(i + 1) % n], steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / (cell * 0.25)));
      for (let t = 0; t <= steps; t++) {
        const px = (p.x + (q.x - p.x) * t / steps) / cell, py = (p.y + (q.y - p.y) * t / steps) / cell;
        // マスのかどをかすめる線も取りこぼさないよう、少しずらした点もぬる
        for (const [ox, oy] of [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) {
          const x = Math.floor(px + ox) - gx, y = Math.floor(py + oy) - gy;
          if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1;
        }
      }
    }
    // d マス太らせる（横 → 縦）
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if (!mask[j * w + i]) continue;
      for (let k = Math.max(0, i - d); k <= Math.min(w - 1, i + d); k++) tmp[j * w + k] = 1;
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if (!tmp[j * w + i]) continue;
      for (let k = Math.max(0, j - d); k <= Math.min(h - 1, j + d); k++) out[k * w + i] = 1;
    }
    const runs = [];
    for (let j = 0; j < h; j++) {
      const row = [];
      for (let i = 0; i < w; i++) {
        if (!out[j * w + i]) continue;
        const s = i;
        while (i < w && out[j * w + i]) i++;
        row.push(s, i);
      }
      runs.push(row);
    }
    return { w, h, runs, gx, gy, angle: a };
  }

  const maskMemo = new WeakMap();   // 外形（点列）ごとの、回転ずみマスクの使いまわし

  /* 図形（外形の点列, mm）を W×H mm の中に、重ならないよう回転させながらできるだけ多くならべる。
     左上から順に「入る最初の場所」をさがし、回転のうち いちばん上につめられるものを採用（貪欲法）。
     複数の図形は順番にくりかえす。戻り値 [{ shape, angle, tx, ty }]：点を angle 回して (tx,ty) 動かす。 */
  function pack(outlines, opt) {
    opt = opt || {};
    const W = opt.width, H = opt.height, gap = opt.gap == null ? 2 : opt.gap;
    const cell = opt.cell || 0.5, nRot = opt.rotations || 24, limit = opt.limit || 1000;
    const d = Math.ceil(gap / 2 / cell);   // マスクは形を必ずおおうので、マスクどうしが重ならなければ すきまは gap 以上
    // マス目は用紙より d マスずつ広くとる（太らせた分は用紙の外にはみ出してよい）
    const GW = Math.floor(W / cell) + 2 * d, GH = Math.floor(H / cell) + 2 * d, PW = GW + 1;
    const occ = new Uint8Array(GW * GH), pref = new Int32Array(PW * GH);

    const variants = outlines.map(pts => {
      const list = [];
      for (let k = 0; k < nRot; k++) {
        const key = [k, nRot, cell, d].join(','), memo = maskMemo.get(pts) || maskMemo.set(pts, new Map()).get(pts);
        const m = memo.get(key) || memo.set(key, rasterize(pts, k * 2 * Math.PI / nRot, cell, d)).get(key);
        if (m.w <= GW && m.h <= GH) list.push(Object.assign({}, m, { next: 0 }));   // next = 次にさがしはじめる位置
      }
      return list;
    });

    const fits = (m, px, py) => {
      for (let j = 0; j < m.h; j++) {
        const row = m.runs[j], base = (py + j) * PW + px;
        for (let k = 0; k < row.length; k += 2) if (pref[base + row[k + 1]] !== pref[base + row[k]]) return false;
      }
      return true;
    };
    // うまっている所はふえるだけなので、前回見つけた位置より手前は二度とさがさなくてよい
    const firstFit = m => {
      const maxX = GW - m.w, maxY = GH - m.h, span = maxX + 1;
      for (let idx = m.next; idx < span * (maxY + 1); idx++) {
        if (fits(m, idx % span, (idx / span) | 0)) { m.next = idx; return idx; }
      }
      m.next = Infinity;
      return -1;
    };

    // 先に置いてある図形（格子ならべの結果）をうめておく
    const rebuildRow = y => {
      let acc = 0;
      for (let i = 0; i < GW; i++) { acc += occ[y * GW + i]; pref[y * PW + i + 1] = acc; }
    };
    const pre = opt.preplaced || [];
    for (const pl of pre) {
      const m = rasterize(placePts(outlines[pl.shape], pl), 0, cell, d);
      for (let j = 0; j < m.h; j++) {
        const y = m.gy + d + j, row = m.runs[j];
        if (y < 0 || y >= GH) continue;
        for (let k = 0; k < row.length; k += 2) {
          const a = Math.max(0, m.gx + d + row[k]), b = Math.min(GW, m.gx + d + row[k + 1]);
          if (a < b) occ.fill(1, y * GW + a, y * GW + b);
        }
      }
    }
    if (pre.length) for (let y = 0; y < GH; y++) rebuildRow(y);

    const placements = pre.slice();
    let active = outlines.map((_, i) => i);
    while (active.length && placements.length < limit) {
      const still = [];
      for (const s of active) {
        let best = null, bestKey = Infinity;
        for (const m of variants[s]) {
          if (m.next === Infinity) continue;
          const idx = firstFit(m);
          if (idx < 0) continue;
          const span = GW - m.w + 1, px = idx % span, py = (idx / span) | 0;
          // つめ方の方針：'bottom' = 下のはしが上にあるものを優先 / 'top' = 上のはしが上にあるものを優先。同じなら左
          const key = (opt.order === 'top' ? py : py + m.h) * GW * 2 + px;
          if (key < bestKey) { bestKey = key; best = { m, px, py }; }
        }
        if (!best) continue;
        const { m, px, py } = best;
        for (let j = 0; j < m.h; j++) {
          const row = m.runs[j], y = py + j;
          for (let k = 0; k < row.length; k += 2) occ.fill(1, y * GW + px + row[k], y * GW + px + row[k + 1]);
          rebuildRow(y);
        }
        placements.push({ shape: s, angle: m.angle, tx: (px - d - m.gx) * cell, ty: (py - d - m.gy) * cell });
        still.push(s);
        if (placements.length >= limit) break;
      }
      active = still;
    }
    return placements;
  }

  /* ---------- 格子ならべ（周期的な敷きつめ）----------
     同じ形をすきまなく並べる問題は、数学では「充填（パッキング）」とよばれる。
     ・格子充填：形を2つのベクトル u, v の整数倍だけずらして並べる。全部が同じ向きで、壁紙のような規則的な模様になる。
     ・二重格子充填（Kuperberg 夫妻, 1990）：形と、その 180° 回転とを1組にして格子状に並べる。
       凸図形なら必ず面積の √3/2 ≒ 86.6% 以上をうめられることが証明されている。へこんだ形でも、かみ合ってよくつまる。
     ここでは「重なるずらし方」の地図（ノーフィット領域）をマス目で作り、単位平行四辺形の面積 |u×v| が最小の格子をさがす。 */

  // マスク M2 を (dx,dy) マスずらしたとき M1 と重なるか、の地図。M1/M2: rasterize の結果
  function forbiddenMap(M1, M2) {
    const P = M1.w + 1, pref = new Int32Array(P * M1.h);
    for (let j = 0; j < M1.h; j++) {
      const row = M1.runs[j], line = new Uint8Array(M1.w);
      for (let k = 0; k < row.length; k += 2) line.fill(1, row[k], row[k + 1]);
      for (let i = 0; i < M1.w; i++) pref[j * P + i + 1] = pref[j * P + i] + line[i];
    }
    const x0 = M1.gx - M2.gx - M2.w + 1, y0 = M1.gy - M2.gy - M2.h + 1;
    const w = M1.w + M2.w - 1, h = M1.h + M2.h - 1, data = new Uint8Array(w * h);
    for (let b = 0; b < h; b++) {
      const offY = M2.gy + y0 + b - M1.gy;
      for (let a = 0; a < w; a++) {
        const offX = M2.gx + x0 + a - M1.gx;
        let hit = 0;
        for (let j = Math.max(0, -offY); j < M2.h && !hit; j++) {
          const jj = j + offY;
          if (jj >= M1.h) break;
          const row = M2.runs[j];
          for (let k = 0; k < row.length; k += 2) {
            const xa = Math.max(0, row[k] + offX), xb = Math.min(M1.w, row[k + 1] + offX);
            if (xa < xb && pref[jj * P + xb] !== pref[jj * P + xa]) { hit = 1; break; }
          }
        }
        data[b * w + a] = hit;
      }
    }
    return (dx, dy) => {
      const a = dx - x0, b = dy - y0;
      return a >= 0 && b >= 0 && a < w && b < h && data[b * w + a] === 1;
    };
  }

  // マスクの 180° 回転
  function flipMask(M) {
    const runs = [];
    for (let j = M.h - 1; j >= 0; j--) {
      const row = M.runs[j], out = [];
      for (let k = row.length - 2; k >= 0; k -= 2) out.push(M.w - row[k + 1], M.w - row[k]);
      runs.push(out);
    }
    return { w: M.w, h: M.h, runs, gx: -M.gx - M.w, gy: -M.gy - M.h };
  }

  /* 面積最小の格子をさがす。valid(dx,dy) = そのずらし方で重ならない。
     u は各方向で「ぎりぎり重ならない」最短のずらし、v は u に沿って位置を変えながら、いちばん低く積める所。 */
  function bestLattice(valid, reach, dirs, bound) {   // bound: この面積以上の格子はさがさない
    const R = 3;
    const ok = (ux, uy, vx, vy) => {
      for (let i = 0; i <= R; i++) for (let j = (i ? -R : 1); j <= R; j++) {
        if (!valid(i * ux + j * vx, i * uy + j * vy)) return false;
      }
      return true;
    };
    let best = null;
    for (let k = 0; k < dirs; k++) {
      const al = Math.PI * k / dirs, cx = Math.cos(al), cy = Math.sin(al);
      let ux = 0, uy = 0, r = 1;
      for (; r <= reach; r++) {
        ux = Math.round(r * cx); uy = Math.round(r * cy);
        if ((ux || uy) && valid(ux, uy) && valid(2 * ux, 2 * uy) && valid(3 * ux, 3 * uy)) break;
      }
      if (r > reach) continue;
      const len = Math.hypot(ux, uy);
      let found = Infinity;
      for (let hgt = 1; hgt <= reach && hgt <= found + 1; hgt++) {
        if (len * (hgt - 1) >= (best ? best.area : bound || Infinity)) break;   // これ以上高くしても今の最良に勝てない
        for (let sft = 0; sft < len; sft++) {
          const vx = Math.round(sft * cx - hgt * cy), vy = Math.round(sft * cy + hgt * cx);
          const area = Math.abs(ux * vy - uy * vx);
          if (!area || area >= (best ? best.area : bound || Infinity)) continue;
          if (valid(vx, vy) && ok(ux, uy, vx, vy)) { best = { ux, uy, vx, vy, area }; found = Math.min(found, hgt); }
        }
      }
    }
    return best;
  }

  /* 山登り法で格子をみがく：u, v（と相方の位置 t）を 1〜2 マスずつ動かし、重ならないまま面積がへる方向へ進む。
     validFor(tx,ty) は、その t のときの判定関数を返す（格子だけのときは t を使わない）。 */
  function refineLattice(lat, t, validFor, tOk) {
    const R = 3, S = [-2, -1, 0, 1, 2];
    const okAll = (valid, ux, uy, vx, vy) => {
      for (let i = 0; i <= R; i++) for (let j = (i ? -R : 1); j <= R; j++) {
        if (!valid(i * ux + j * vx, i * uy + j * vy)) return false;
      }
      return true;
    };
    let cur = Object.assign({}, lat), ct = t && { x: t.x, y: t.y };
    for (let iter = 0; iter < 40; iter++) {
      let best = null;
      const tMoves = ct ? S : [0];
      for (const ex of tMoves) for (const ey of tMoves) {
        const tx = ct ? ct.x + ex : 0, ty = ct ? ct.y + ey : 0;
        if (ct && !tOk(tx, ty)) continue;
        const valid = validFor(tx, ty);
        for (const a of S) for (const b of S) for (const c of S) for (const e of S) {
          const ux = cur.ux + a, uy = cur.uy + b, vx = cur.vx + c, vy = cur.vy + e;
          const area = Math.abs(ux * vy - uy * vx);
          if (!area || area >= (best ? best.area : cur.area)) continue;
          if (okAll(valid, ux, uy, vx, vy)) best = { ux, uy, vx, vy, area, tx, ty };
        }
      }
      if (!best) break;
      cur = best;
      if (ct) ct = { x: best.tx, y: best.ty };
    }
    return { lat: cur, t: ct };
  }

  /* 2つの多角形（a と、b を (bx,by) だけずらしたもの）が limit より近いか（交差・包含もふくむ）。
     相手のわく（limit だけ広げた）にかかる辺だけをくらべるので、接しているだけの組なら速い。 */
  function edgesOf(pts) {
    const n = pts.length, e = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; e[i * 4] = p.x; e[i * 4 + 1] = p.y; e[i * 4 + 2] = q.x; e[i * 4 + 3] = q.y; }
    return e;
  }
  function pointSeg2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - ax - t * dx, ey = py - ay - t * dy;
    return ex * ex + ey * ey;
  }
  function closer(A, B, bx, by, limit) {
    // A, B: { pts, edges, box }
    const a = A.box, b = B.box, l2 = limit * limit;
    const x0 = Math.max(a.minX, b.minX + bx) - limit, x1 = Math.min(a.maxX, b.maxX + bx) + limit;
    const y0 = Math.max(a.minY, b.minY + by) - limit, y1 = Math.min(a.maxY, b.maxY + by) + limit;
    if (x0 > x1 || y0 > y1) return false;
    const pick = (E, ox, oy) => {
      const out = [];
      for (let i = 0; i < E.length; i += 4) {
        const ax = E[i] + ox, ay = E[i + 1] + oy, cx = E[i + 2] + ox, cy = E[i + 3] + oy;
        if (Math.max(ax, cx) < x0 || Math.min(ax, cx) > x1 || Math.max(ay, cy) < y0 || Math.min(ay, cy) > y1) continue;
        out.push(ax, ay, cx, cy);
      }
      return out;
    };
    const ea = pick(A.edges, 0, 0), eb = pick(B.edges, bx, by);
    for (let i = 0; i < ea.length; i += 4) {
      const ax = ea[i], ay = ea[i + 1], cx = ea[i + 2], cy = ea[i + 3];
      for (let j = 0; j < eb.length; j += 4) {
        const px = eb[j], py = eb[j + 1], qx = eb[j + 2], qy = eb[j + 3];
        if (pointSeg2(ax, ay, px, py, qx, qy) < l2 || pointSeg2(cx, cy, px, py, qx, qy) < l2 ||
            pointSeg2(px, py, ax, ay, cx, cy) < l2 || pointSeg2(qx, qy, ax, ay, cx, cy) < l2) return true;
        // 交差（端点どうしが limit 以上はなれたまま交わる場合）
        const d1 = (cx - ax) * (py - ay) - (cy - ay) * (px - ax), d2 = (cx - ax) * (qy - ay) - (cy - ay) * (qx - ax);
        const d3 = (qx - px) * (ay - py) - (qy - py) * (ax - px), d4 = (qx - px) * (cy - py) - (qy - py) * (cx - px);
        if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
      }
    }
    // 一方がもう一方の中にすっぽり入っている場合
    const p = A.pts[0], q = B.pts[0];
    return Geo.pointInPolygon({ x: p.x - bx, y: p.y - by }, B.pts) || Geo.pointInPolygon({ x: q.x + bx, y: q.y + by }, A.pts);
  }
  const solid = pts => ({ pts, edges: edgesOf(pts), box: Geo.bbox([pts]) });

  const boxOf = pts => Geo.bbox([pts]);
  const shift = (pts, x, y) => pts.map(p => ({ x: p.x + x, y: p.y + y }));

  /* マス目で見つけた格子はまるめ誤差をふくむので、正確な多角形どうしの距離を測りながら
     格子全体を少しずつのびちぢみさせて、すきまを指定値ぎりぎりに合わせる。 */
  function tighten(A, lat, gap) {
    gap = Math.max(gap, 0.01);   // 0 のときも交差（距離 0）をはじけるように
    const SA = solid(A), B = lat.t ? solid(A.map(p => ({ x: -p.x, y: -p.y }))) : null;
    // 格子を「u の向きに a 倍、それと直角の向きに b 倍」のびちぢみさせる
    const len = Math.hypot(lat.u.x, lat.u.y), ex = lat.u.x / len, ey = lat.u.y / len;
    const warp = (p, a, b) => {
      const along = p.x * ex + p.y * ey, across = -p.x * ey + p.y * ex;
      return { x: a * along * ex - b * across * ey, y: a * along * ey + b * across * ex };
    };
    const feasible = (a, b) => {
      const R = 3, u = warp(lat.u, a, b), v = warp(lat.v, a, b), t = B && warp(lat.t, a, b);
      for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
        const x = i * u.x + j * v.x, y = i * u.y + j * v.y;
        if ((i > 0 || (i === 0 && j > 0)) && closer(SA, SA, x, y, gap)) return false;
        if (B && closer(SA, B, x + t.x, y + t.y, gap)) return false;
      }
      return true;
    };
    let a = 1, b = 1;
    const STEP = 0.003;
    while (!feasible(a, b)) {            // 足りなければ全体を広げる
      a += STEP; b += STEP;
      if (a > 1.25) return null;
    }
    for (let moved = true; moved;) {     // たて・よこ別々に、つめられるだけつめる
      moved = false;
      if (a > 0.8 && feasible(a - STEP, b)) { a -= STEP; moved = true; }
      if (b > 0.8 && feasible(a, b - STEP)) { b -= STEP; moved = true; }
    }
    // 仕上げ：u, v の先を少しずつ動かし、面積がへって重ならない動きだけ採用（回数に上限）
    let u = warp(lat.u, a, b), v = warp(lat.v, a, b);
    const plain = { u, v, t: B && warp(lat.t, a, b), area: lat.area * a * b };   // 仕上げ前（用紙へのおさまりがよいことがある）
    const t = B && warp(lat.t, a, b), cross = (p, q) => Math.abs(p.x * q.y - p.y * q.x);
    const free = (u2, v2) => {
      const R = 3;
      for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
        const x = i * u2.x + j * v2.x, y = i * u2.y + j * v2.y;
        if ((i > 0 || (i === 0 && j > 0)) && closer(SA, SA, x, y, gap)) return false;
        if (B && closer(SA, B, x + t.x, y + t.y, gap)) return false;
      }
      return true;
    };
    let budget = 120;
    for (const step of [0.4, 0.15, 0.05]) {
      for (let moved = true; moved && budget > 0;) {
        moved = false;
        for (const [du, dv] of [[1, 0], [0, 1]]) for (const [mx, my] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const u2 = { x: u.x + du * mx * step, y: u.y + du * my * step }, v2 = { x: v.x + dv * mx * step, y: v.y + dv * my * step };
          if (cross(u2, v2) >= cross(u, v) - 1e-9 || budget-- <= 0) continue;
          if (free(u2, v2)) { u = u2; v = v2; moved = true; }
        }
      }
    }
    return [{ u, v, t, area: cross(u, v) }, plain];
  }

  // 格子を角度 phi で用紙に置き、ずらし方を変えながら いちばん多く入る配置を返す
  function fitLattice(A, lat, W, H, shape, STEPS, PH) {
    let best = [];
    shape = shape || 0; STEPS = STEPS || 60; PH = PH || 8;
    for (let s = 0; s < STEPS; s++) {
      const phi = Math.PI * s / STEPS, c = Math.cos(phi), sn = Math.sin(phi);
      const rot = p => ({ x: p.x * c - p.y * sn, y: p.x * sn + p.y * c });
      const u = rot(lat.u), v = rot(lat.v), t = lat.t && rot(lat.t);
      const bb = boxOf(A.map(rot)), det = u.x * v.y - u.y * v.x;
      // 用紙の四すみを格子座標になおして、調べる範囲を決める
      let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
      for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) {
        const i = (x * v.y - y * v.x) / det, j = (u.x * y - u.y * x) / det;
        i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      }
      i0 = Math.floor(i0) - 2; i1 = Math.ceil(i1) + 2; j0 = Math.floor(j0) - 2; j1 = Math.ceil(j1) + 2;
      for (let a = 0; a < PH; a++) for (let b = 0; b < PH; b++) {
        const ox = (a * u.x + b * v.x) / PH, oy = (a * u.y + b * v.y) / PH, out = [];
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const x = ox + i * u.x + j * v.x, y = oy + i * u.y + j * v.y;
          if (x + bb.minX >= 0 && x + bb.maxX <= W && y + bb.minY >= 0 && y + bb.maxY <= H) out.push({ shape, angle: phi, tx: x, ty: y });
          if (t) {
            const bx = x + t.x, by = y + t.y;   // 180° 回転した相方
            if (bx - bb.maxX >= 0 && bx - bb.minX <= W && by - bb.maxY >= 0 && by - bb.minY <= H) out.push({ shape, angle: phi + Math.PI, tx: bx, ty: by });
          }
        }
        if (out.length > best.length) best = out;
      }
    }
    return best;
  }

  // 1種類の形について、格子・二重格子の候補（すきま調整ずみ）を密度の高い順に返す
  function latticeCandidates(pts, gap) {
    /* 形をわくの中心が原点にくるよう動かしてから調べる（180° 回転は原点まわりなので、
       形が原点から遠いと相方がはるか遠くへ行き、近くの重なりを見落とす）。center は配置を元の座標にもどすのに使う。 */
    const b0 = boxOf(pts), center = { x: (b0.minX + b0.maxX) / 2, y: (b0.minY + b0.maxY) / 2 };
    const A = Geo.simplifyClosed(shift(pts, -center.x, -center.y), 0.05), bb = boxOf(A);
    const cell = Math.max(0.5, Math.max(bb.w, bb.h) / 110);   // 大きい形ほど粗いマス目（あとで正確につめ直す）
    // 太らせる幅はすきまの半分ちょうど。マス目のまるめで出る誤差は tighten が正確な距離で直す
    const d = Math.max(1, Math.round(gap / 2 / cell));
    const MA = rasterize(A, 0, cell, d), MB = flipMask(MA);
    const fAA = forbiddenMap(MA, MA), fAB = forbiddenMap(MA, MB);
    const reach = MA.w + MA.h, mm = (x, y) => ({ x: x * cell, y: y * cell });
    const cands = [];
    // 格子（全部同じ向き）
    const validSingle = (x, y) => !fAA(x, y);
    let single = bestLattice(validSingle, reach, 60);
    if (single) {
      single = refineLattice(single, null, () => validSingle).lat;
      cands.push({ u: mm(single.ux, single.uy), v: mm(single.vx, single.vy), t: null, area: single.area * cell * cell, per: 1 });
    }
    const validDouble = (tx, ty) => (x, y) => !fAA(x, y) && !fAB(tx + x, ty + y) && !fAB(tx - x, ty - y);
    const raw = [];
    // 二重格子：相方（180° 回転）の置き場所 t を、ぎりぎり重ならない位置からいくつか選んでためす
    const seen = new Set();
    let least = Infinity;   // これまでの最小面積。それより 12% 以上大きい格子は調べない
    for (let k = 0; k < 36; k++) {
      const be = 2 * Math.PI * k / 36, cx = Math.cos(be), cy = Math.sin(be);
      let tx = 0, ty = 0, r = 0;
      for (; r <= reach; r++) { tx = Math.round(r * cx); ty = Math.round(r * cy); if (!fAB(tx, ty)) break; }
      if (r > reach || seen.has(tx + ',' + ty)) continue;
      seen.add(tx + ',' + ty);
      const lat = bestLattice(validDouble(tx, ty), reach, 30, least * 1.12);
      if (lat) { raw.push({ lat, t: { x: tx, y: ty } }); least = Math.min(least, lat.area); }
    }
    // 有望なものだけ、山登り法でみがく
    raw.sort((p, q) => p.lat.area - q.lat.area);
    const done = new Set();
    for (const c of raw.slice(0, 12)) {
      const r = refineLattice(c.lat, c.t, validDouble, (x, y) => !fAB(x, y)), L = r.lat;
      const key = [L.ux, L.uy, L.vx, L.vy, r.t.x, r.t.y].join(',');
      if (done.has(key)) continue;
      done.add(key);
      cands.push({ u: mm(L.ux, L.uy), v: mm(L.vx, L.vy), t: mm(r.t.x, r.t.y), area: L.area * cell * cell, per: 2 });
    }
    // 1こあたりの面積が小さい（= 密な）順に上位をえらび、正確につめ直してから用紙に置く
    cands.sort((p, q) => p.area / p.per - q.area / q.per);
    const picked = cands.filter(c => !c.t).slice(0, 1).concat(cands.filter(c => c.t).slice(0, 8));
    const out = [];
    for (const c of picked) {
      for (const lat of tighten(A, c, gap) || []) {
        out.push({ A, center, lat, double: !!c.t, density: c.per * Math.abs(Geo.signedArea(A)) / lat.area });
      }
    }
    return out.sort((p, q) => q.density - p.density);
  }

  // 候補 c の格子を用紙に置く。中心を原点に動かした分を、配置の平行移動にもどす
  function fitCandidate(c, W, H, shape, steps, ph) {
    return fitLattice(c.A, c.lat, W, H, shape, steps, ph).map(pl => {
      const cs = Math.cos(pl.angle), sn = Math.sin(pl.angle);
      return { shape: pl.shape, angle: pl.angle, tx: pl.tx - (c.center.x * cs - c.center.y * sn), ty: pl.ty - (c.center.x * sn + c.center.y * cs) };
    });
  }

  /* 最終確認：配置どうしが本当に重なっていないか、正確な距離で調べる。
     格子の探索は近くのとなりしか見ないので、見落としがあればその配置はすてる。 */
  function verify(outlines, placements, gap) {
    const polys = placements.map(pl => solid(placePts(outlines[pl.shape], pl))), g = Math.max(gap, 0.01) - 0.005;
    for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) {
      if (closer(polys[i], polys[j], 0, 0, g)) return false;
    }
    return true;
  }

  // 1種類の形を、格子・二重格子で用紙にならべた配置の候補を返す
  function latticeLayouts(pts, opt) {
    const layouts = [];
    for (const c of latticeCandidates(pts, opt.gap == null ? 2 : opt.gap)) {
      const placed = fitCandidate(c, opt.width, opt.height);
      if (placed.length && verify([pts], placed, opt.gap == null ? 2 : opt.gap)) layouts.push({ placements: placed, double: c.double, density: c.density });
    }
    return layouts;
  }

  /* 形が複数種類のとき：用紙を横の帯に分け、帯ごとに1種類を格子でならべる。
     帯の高さは「どの形も同じこ数以上入る」ように、こ数の表（高さ → 入るこ数）から決める。 */
  function bandLayout(outlines, opt) {
    const W = opt.width, H = opt.height, k = outlines.length;
    const gap = Math.max(opt.gap == null ? 2 : opt.gap, 0.02);   // 帯どうしがぴったり重ならないよう、最小でもわずかにあける
    const cands = outlines.map(o => latticeCandidates(o, gap).slice(0, 3));
    if (cands.some(c => !c.length)) return null;
    // 高さ h の帯に入るこ数（粗い探索）
    const STEP = 6, hs = [];
    for (let h = STEP; h < H; h += STEP) hs.push(h);
    hs.push(H);
    const table = cands.map((list, i) => hs.map(h => Math.max(...list.map(c => fitCandidate(c, W, h, i, 30, 4).length))));
    const room = H - (k - 1) * gap;
    let heights = null;
    for (let n = Math.max(...table.map(t => t[t.length - 1])); n >= 1 && !heights; n--) {
      const idx = table.map(t => t.findIndex(c => c >= n));
      if (idx.every(j => j >= 0) && idx.reduce((sum, j) => sum + hs[j], 0) <= room) heights = idx.map(j => hs[j]);
    }
    if (!heights) return null;
    // あまった高さは、こ数がいちばん効率よくふえる帯から順に足していく。最後のあまりは等分
    let left = room - heights.reduce((p, q) => p + q, 0);
    for (;;) {
      let pick = -1, rate = 0, to = 0;
      table.forEach((t, i) => {
        const cur = t[hs.indexOf(heights[i])];
        for (let j = hs.indexOf(heights[i]) + 1; j < hs.length && hs[j] - heights[i] <= left; j++) {
          const r = (t[j] - cur) / (hs[j] - heights[i]);
          if (r > rate) { rate = r; pick = i; to = hs[j]; }
        }
      });
      if (pick < 0) break;
      left -= to - heights[pick];
      heights[pick] = to;
    }
    const spare = left / k;
    const placements = [];
    let y = 0, density = 0;
    cands.forEach((list, i) => {
      const h = heights[i] + spare;
      let best = [], dens = 0;
      for (const c of list) {
        const placed = fitCandidate(c, W, h, i);
        if (placed.length > best.length && verify(outlines, placed, gap)) { best = placed; dens = c.density; }
      }
      for (const pl of best) placements.push(Object.assign(pl, { ty: pl.ty + y }));
      density += dens / k;
      y += h + gap;
    });
    return { placements, density, heights };
  }

  // 全体を用紙のまん中によせる
  function centerOnPage(outlines, placements, W, H) {
    if (!placements.length) return placements;
    const bb = Geo.bbox(placements.map(pl => placePts(outlines[pl.shape], pl)));
    const dx = (W - bb.w) / 2 - bb.minX, dy = (H - bb.h) / 2 - bb.minY;
    return placements.map(pl => Object.assign({}, pl, { tx: pl.tx + dx, ty: pl.ty + dy }));
  }

  /* いちばん多く入るならべ方を返す。
     形が1種類：格子・二重格子でならべ、あまった所を貪欲法でうめる。
     形が複数：用紙を帯に分けて、帯ごとに1種類を格子でならべ、あまった所を貪欲法でうめる。
     貪欲法だけの結果ともくらべる。1種類なら多いほう（同数なら格子）、複数なら貪欲法が 5% より多いときだけ貪欲法。 */
  function packBest(outlines, opt) {
    let best = [], method = 'greedy';
    const multi = outlines.length > 1;   // 複数種類は計算が重いので、ためす通り数をしぼる
    for (const rotations of (multi ? [24, 4] : [24, 4, 8, 2])) for (const order of (multi ? ['bottom'] : ['bottom', 'top'])) {
      const r = pack(outlines, Object.assign({}, opt, { rotations, order }));
      if (r.length > best.length) best = r;
    }
    if (outlines.length === 1 && Geo) {
      let bestLat = null;
      // こ数の多い順に上位3つだけ、あまった所をうめてくらべる（うめる計算が重いため）
      const lays = latticeLayouts(outlines[0], opt).sort((p, q) => q.placements.length - p.placements.length || q.density - p.density).slice(0, 3);
      for (const lay of lays) {
        const filled = pack(outlines, Object.assign({}, opt, { rotations: 24, preplaced: lay.placements }));
        const better = !bestLat || filled.length > bestLat.all.length ||
          (filled.length === bestLat.all.length && lay.placements.length > bestLat.regular);
        if (better) bestLat = { all: filled, regular: lay.placements.length, double: lay.double, density: lay.density };
      }
      if (bestLat && bestLat.all.length >= best.length) {
        best = bestLat.all;
        method = bestLat.double ? 'double-lattice' : 'lattice';
        best.density = bestLat.density;
      }
    } else if (outlines.length > 1 && Geo) {
      // 横の帯と、たての帯（用紙を 90° 回した向きで帯に分け、もどす）の両方をためす
      const W = opt.width, H = opt.height, tries = [bandLayout(outlines, opt)];
      const turned = bandLayout(outlines, Object.assign({}, opt, { width: H, height: W }));
      if (turned) {
        tries.push({ density: turned.density, placements: turned.placements.map(pl =>
          ({ shape: pl.shape, angle: pl.angle + Math.PI / 2, tx: W - pl.ty, ty: pl.tx })) });
      }
      // 格子だけで多く入ったほうをえらび、あまった所をうめる
      const band = tries.filter(Boolean).sort((p, q) => q.placements.length - p.placements.length)[0];
      const bestBand = band && { density: band.density,
        all: pack(outlines, Object.assign({}, opt, { rotations: 24, preplaced: band.placements })) };
      // 規則的なならびを優先：貪欲法が 5% より多く入るときだけ貪欲法にする
      if (bestBand && bestBand.all.length * 1.05 >= best.length) { best = bestBand.all; method = 'bands'; best.density = bestBand.density; }
    }
    best = Object.assign(centerOnPage(outlines, best, opt.width, opt.height), { method, density: best.density });
    return best;
  }

  /* ---------- PDF（A4 たて、ベクター）---------- */

  /* opt: { shapes: [{ contours:[{pts}], centroid, inside }]（mm 座標）,
            placements: [{ shape, angle, tx, ty }]（用紙の左上を原点とした mm）,
            mark: 'hole'|'cross'|'none', holeDiameter, text: 余白に書く文字（半角英数） } */
  function buildPDF(opt) {
    const f = v => (Math.round(v * 1000) / 1000).toString();
    const K = 72 / 25.4;   // mm → pt
    let c = `q ${f(K)} 0 0 ${f(-K)} 0 ${f(A4.h * K)} cm\n0.1 w 1 j 1 J\n`;   // 以後 mm 単位・左上原点
    const cut = [], mark = [];
    for (const pl of opt.placements) {
      const s = opt.shapes[pl.shape], cs = Math.cos(pl.angle), sn = Math.sin(pl.angle);
      const T = p => ({ x: p.x * cs - p.y * sn + pl.tx, y: p.x * sn + p.y * cs + pl.ty });
      for (const u of s.contours) {
        cut.push(u.pts.map((p, i) => { const q = T(p); return `${f(q.x)} ${f(q.y)} ${i ? 'l' : 'm'}`; }).join(' ') + ' h');
      }
      if (!s.inside) continue;
      const g = T(s.centroid);
      if (opt.mark === 'hole') {
        const r = opt.holeDiameter / 2, k = r * 0.5522848;
        cut.push(`${f(g.x + r)} ${f(g.y)} m ${f(g.x + r)} ${f(g.y + k)} ${f(g.x + k)} ${f(g.y + r)} ${f(g.x)} ${f(g.y + r)} c ` +
          `${f(g.x - k)} ${f(g.y + r)} ${f(g.x - r)} ${f(g.y + k)} ${f(g.x - r)} ${f(g.y)} c ` +
          `${f(g.x - r)} ${f(g.y - k)} ${f(g.x - k)} ${f(g.y - r)} ${f(g.x)} ${f(g.y - r)} c ` +
          `${f(g.x + k)} ${f(g.y - r)} ${f(g.x + r)} ${f(g.y - k)} ${f(g.x + r)} ${f(g.y)} c h`);
      } else if (opt.mark === 'cross') {
        mark.push(`${f(g.x - 3)} ${f(g.y)} m ${f(g.x + 3)} ${f(g.y)} l ${f(g.x)} ${f(g.y - 3)} m ${f(g.x)} ${f(g.y + 3)} l`);
      }
    }
    if (cut.length) c += '1 0 0 RG\n' + cut.join('\n') + '\nS\n';     // 赤 = 切断
    if (mark.length) c += '0 0 1 RG\n' + mark.join('\n') + '\nS\n';   // 青 = けがき
    c += 'Q\n';
    if (opt.text) {
      const safe = String(opt.text).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
      c += `BT /F1 10 Tf 0 g ${f(MARGIN * K)} ${f((MARGIN + 1) * K)} Td (${safe}) Tj ET\n`;
    }
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(A4.w * K)} ${f(A4.h * K)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
      `<< /Length ${c.length} >>\nstream\n${c}endstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
      offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
      `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return pdf;   // ASCII のみ（文字数 = バイト数）
  }

  /* ---------- 敷きつめたSVG（A4 たて）。引数は buildPDF と同じ ---------- */
  function buildSVG(opt) {
    const f = v => (Math.round(v * 1000) / 1000).toString();
    const cut = 'fill="none" stroke="#ff0000" stroke-width="0.1"', mark = 'fill="none" stroke="#0000ff" stroke-width="0.1"';
    let body = '';
    opt.placements.forEach((pl, n) => {
      const s = opt.shapes[pl.shape], cs = Math.cos(pl.angle), sn = Math.sin(pl.angle);
      const T = p => ({ x: p.x * cs - p.y * sn + pl.tx, y: p.x * sn + p.y * cs + pl.ty });
      const d = s.contours.map(u => 'M' + u.pts.map(p => { const q = T(p); return f(q.x) + ' ' + f(q.y); }).join(' L') + ' Z').join(' ');
      body += `  <g id="copy-${n + 1}">\n    <path d="${d}" fill-rule="evenodd" ${cut}/>\n`;
      const g = T(s.centroid);
      if (s.inside && opt.mark === 'hole') body += `    <circle cx="${f(g.x)}" cy="${f(g.y)}" r="${f(opt.holeDiameter / 2)}" ${cut}/>\n`;
      else if (s.inside && opt.mark === 'cross') body += `    <path d="M${f(g.x - 3)} ${f(g.y)} H${f(g.x + 3)} M${f(g.x)} ${f(g.y - 3)} V${f(g.y + 3)}" ${mark}/>\n`;
      body += '  </g>\n';
    });
    if (opt.text) {
      const safe = String(opt.text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      body += `  <text id="copies" x="${MARGIN}" y="${f(A4.h - MARGIN - 1)}" font-family="Helvetica, Arial, sans-serif" font-size="3.5" fill="#000000">${safe}</text>\n`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${A4.w}mm" height="${A4.h}mm" viewBox="0 0 ${A4.w} ${A4.h}">\n` +
      `  <!-- 単位: mm / A4 / 赤 = 切断, 青 = けがき(彫刻), 黒 = こ数の表示 -->\n` + body + `</svg>\n`;
  }

  const Nest = { A4, MARGIN, FOOTER, pack, packBest, buildPDF, buildSVG, _bandLayout: bandLayout };
  if (typeof module !== 'undefined' && module.exports) module.exports = Nest;
  else root.Nest = Nest;
})(typeof globalThis !== 'undefined' ? globalThis : this);
