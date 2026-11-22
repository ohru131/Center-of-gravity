/* A4への敷きつめ（ネスティング）とPDF出力。ブラウザ/Node 共用。 */
(function (root) {
  'use strict';

  const A4 = { w: 210, h: 297 };   // mm
  const MARGIN = 5;                // 用紙のふちの余白 mm
  const FOOTER = 8;                // 下の余白のうち、枚数表示に使う高さ mm

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
      const p = r[i], q = r[(i + 1) % n], steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / (cell * 0.5)));
      for (let t = 0; t <= steps; t++) {
        const x = Math.floor((p.x + (q.x - p.x) * t / steps) / cell) - gx, y = Math.floor((p.y + (q.y - p.y) * t / steps) / cell) - gy;
        if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1;
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

  /* 図形（外形の点列, mm）を W×H mm の中に、重ならないよう回転させながらできるだけ多くならべる。
     左上から順に「入る最初の場所」をさがし、回転のうち いちばん上につめられるものを採用（貪欲法）。
     複数の図形は順番にくりかえす。戻り値 [{ shape, angle, tx, ty }]：点を angle 回して (tx,ty) 動かす。 */
  function pack(outlines, opt) {
    opt = opt || {};
    const W = opt.width, H = opt.height, gap = opt.gap == null ? 2 : opt.gap;
    const cell = opt.cell || 0.5, nRot = opt.rotations || 24, limit = opt.limit || 1000;
    const d = Math.ceil(gap / 2 / cell) + 1;
    // マス目は用紙より d マスずつ広くとる（太らせた分は用紙の外にはみ出してよい）
    const GW = Math.floor(W / cell) + 2 * d, GH = Math.floor(H / cell) + 2 * d, PW = GW + 1;
    const occ = new Uint8Array(GW * GH), pref = new Int32Array(PW * GH);

    const variants = outlines.map(pts => {
      const list = [];
      for (let k = 0; k < nRot; k++) {
        const m = rasterize(pts, k * 2 * Math.PI / nRot, cell, d);
        if (m.w <= GW && m.h <= GH) list.push(Object.assign(m, { next: 0 }));   // next = 次にさがしはじめる位置
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

    const placements = [];
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
          let acc = 0;
          for (let i = 0; i < GW; i++) { acc += occ[y * GW + i]; pref[y * PW + i + 1] = acc; }
        }
        placements.push({ shape: s, angle: m.angle, tx: (px - d - m.gx) * cell, ty: (py - d - m.gy) * cell });
        still.push(s);
        if (placements.length >= limit) break;
      }
      active = still;
    }
    return placements;
  }

  // 回転のきざみ・つめ方の方針をいくつか試して、いちばん多く入ったものを返す
  function packBest(outlines, opt) {
    let best = [];
    for (const rotations of [24, 4, 8, 2]) for (const order of ['bottom', 'top']) {
      const r = pack(outlines, Object.assign({}, opt, { rotations, order }));
      if (r.length > best.length) best = r;
    }
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

  const Nest = { A4, MARGIN, FOOTER, pack, packBest, buildPDF };
  if (typeof module !== 'undefined' && module.exports) module.exports = Nest;
  else root.Nest = Nest;
})(typeof globalThis !== 'undefined' ? globalThis : this);
