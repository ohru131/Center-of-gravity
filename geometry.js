/* 図形計算（重心・簡略化・DXF読込・SVG出力）。ブラウザ/Node 共用。 */
(function (root) {
  'use strict';

  // 符号付き面積（シューレース公式）
  function signedArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  // 多角形の面積重心
  function polygonCentroid(pts) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      const w = p.x * q.y - q.x * p.y;
      a += w; cx += (p.x + q.x) * w; cy += (p.y + q.y) * w;
    }
    a /= 2;
    return { x: cx / (6 * a), y: cy / (6 * a), area: a };
  }

  function bbox(contours) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of contours) for (const p of c) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function pointInPolygon(p, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > p.y) !== (b.y > p.y) &&
          p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // Ramer–Douglas–Peucker（閉曲線用）
  function simplifyClosed(pts, eps) {
    if (pts.length < 4) return pts.slice();
    const line = pts.concat([pts[0]]);
    const keep = new Uint8Array(line.length);
    keep[0] = keep[line.length - 1] = 1;
    // 始点と終点が同じなので、最遠点で2分割してから開始
    let far = 0, fd = -1;
    for (let i = 1; i < line.length - 1; i++) {
      const d = Math.hypot(line[i].x - line[0].x, line[i].y - line[0].y);
      if (d > fd) { fd = d; far = i; }
    }
    keep[far] = 1;
    const stack = [[0, far], [far, line.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let idx = -1, md = eps;
      for (let i = s + 1; i < e; i++) {
        const d = segDist(line[i], line[s], line[e]);
        if (d > md) { md = d; idx = i; }
      }
      if (idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
    }
    const out = [];
    for (let i = 0; i < line.length - 1; i++) if (keep[i]) out.push(line[i]);
    return out;
  }

  // Chaikin の角丸め（閉曲線）
  function smoothClosed(pts, iterations) {
    let cur = pts;
    for (let k = 0; k < iterations; k++) {
      const next = [];
      for (let i = 0, n = cur.length; i < n; i++) {
        const p = cur[i], q = cur[(i + 1) % n];
        next.push({ x: 0.75 * p.x + 0.25 * q.x, y: 0.75 * p.y + 0.25 * q.y });
        next.push({ x: 0.25 * p.x + 0.75 * q.x, y: 0.25 * p.y + 0.75 * q.y });
      }
      cur = next;
    }
    return cur;
  }

  function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }

  // 線分 ab と cd が交わるか（端点でふれるだけは除外）
  function segCross(a, b, c, d) {
    if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) ||
        Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return false;
    const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && !!(d1 && d2 && d3 && d4);
  }

  // 自己交差の有無（となり合う辺は除外）
  function selfIntersects(pts) {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (segCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
      }
    }
    return false;
  }

  // 2つの輪郭の線が交わるか
  function contoursIntersect(p, q) {
    for (let i = 0; i < p.length; i++) {
      for (let j = 0; j < q.length; j++) {
        if (segCross(p[i], p[(i + 1) % p.length], q[j], q[(j + 1) % q.length])) return true;
      }
    }
    return false;
  }

  function distToContour(p, pts) {
    let d = Infinity;
    for (let i = 0; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i], pts[(i + 1) % pts.length]));
    return d;
  }

  /* 複数輪郭 → 図形ごとに分けて、それぞれの重心を計算。
     入れ子の深さが偶数の輪郭 = 図形の外形、奇数 = すぐ外側の図形の穴（面積を引く）。 */
  function analyze(contours) {
    const cs = contours.filter(c => c.length >= 3 && Math.abs(signedArea(c)) > 1e-9);
    if (!cs.length) return null;
    const within = cs.map((c, i) => cs.map((o, j) => j !== i && pointInPolygon(c[0], o)));
    const depth = within.map(r => r.filter(Boolean).length);
    const shapes = [], owner = [];
    cs.forEach((c, i) => {
      if (depth[i] % 2 === 0) { owner[i] = shapes.length; shapes.push({ contours: [{ pts: c, hole: false }] }); }
    });
    cs.forEach((c, i) => {
      if (depth[i] % 2 === 0) return;
      const parent = cs.findIndex((o, j) => within[i][j] && depth[j] === depth[i] - 1);
      if (parent >= 0) shapes[owner[parent]].contours.push({ pts: c, hole: true });
    });
    for (const s of shapes) {
      let A = 0, sx = 0, sy = 0;
      for (const u of s.contours) {
        const g = polygonCentroid(u.pts);
        const a = Math.abs(g.area) * (u.hole ? -1 : 1);
        A += a; sx += g.x * a; sy += g.y * a;
      }
      const c = s.centroid = { x: sx / A, y: sy / A };
      s.area = A;
      s.bbox = bbox([s.contours[0].pts]);
      // 重心が材料の上にあるか
      s.inside = s.contours.every(u => pointInPolygon(c, u.pts) !== u.hole);
      // 重心からふちまでの最短距離
      s.edgeDist = Math.min(...s.contours.map(u => distToContour(c, u.pts)));
    }
    shapes.sort((p, q) => p.centroid.x - q.centroid.x);
    return { shapes, bbox: bbox(cs) };
  }

  /* ---------- DXF ---------- */

  function arcPoints(cx, cy, r, a0, sweep) {
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + sweep * i / n;
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return out;
  }

  // ふくらみ(bulge)つき頂点列 → 点列
  function tessellate(verts, closed) {
    const out = [];
    const n = verts.length, last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p = verts[i], q = verts[(i + 1) % n];
      out.push({ x: p.x, y: p.y });
      if (p.b) {
        const theta = 4 * Math.atan(p.b);
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
        if (d > 0) {
          const off = (d / 2) / Math.tan(theta / 2);
          const cx = p.x + dx / 2 - dy / d * off, cy = p.y + dy / 2 + dx / d * off;
          const arc = arcPoints(cx, cy, Math.hypot(p.x - cx, p.y - cy), Math.atan2(p.y - cy, p.x - cx), theta);
          for (let k = 1; k < arc.length - 1; k++) out.push(arc[k]);
        }
      }
    }
    if (!closed) out.push({ x: verts[n - 1].x, y: verts[n - 1].y });
    return out;
  }

  // 開いた線分どうしを端点でつないで閉曲線にする
  function chainSegments(segs) {
    if (!segs.length) return [];
    const b = bbox(segs);
    const tol = Math.max(1e-6, Math.hypot(b.w, b.h) * 1e-4);
    const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) <= tol;
    const used = new Array(segs.length).fill(false);
    const loops = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      let chain = segs[i].slice();
      for (;;) {
        if (chain.length > 2 && near(chain[0], chain[chain.length - 1])) {
          chain.pop(); loops.push(chain); break;
        }
        const end = chain[chain.length - 1];
        let found = false;
        for (let j = 0; j < segs.length && !found; j++) {
          if (used[j]) continue;
          const s = segs[j];
          if (near(end, s[0])) { chain = chain.concat(s.slice(1)); used[j] = found = true; }
          else if (near(end, s[s.length - 1])) { chain = chain.concat(s.slice(0, -1).reverse()); used[j] = found = true; }
        }
        if (!found) break; // 閉じない線は捨てる
      }
    }
    return loops;
  }

  function parseDXF(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseInt(lines[i], 10);
      if (isNaN(code)) throw new Error('DXFとして読めませんでした');
      pairs.push([code, lines[i + 1].trim()]);
    }
    let start = 0, end = pairs.length;
    for (let i = 0; i + 1 < pairs.length; i++) {
      if (pairs[i][0] === 0 && pairs[i][1] === 'SECTION' && pairs[i + 1][0] === 2 && pairs[i + 1][1] === 'ENTITIES') {
        start = i + 2;
        for (let j = start; j < pairs.length; j++) if (pairs[j][0] === 0 && pairs[j][1] === 'ENDSEC') { end = j; break; }
        break;
      }
    }
    const ents = [];
    for (let i = start; i < end; i++) {
      if (pairs[i][0] === 0) ents.push({ type: pairs[i][1], data: [] });
      else if (ents.length) ents[ents.length - 1].data.push(pairs[i]);
    }
    const get = (e, code, def) => { const f = e.data.find(d => d[0] === code); return f ? parseFloat(f[1]) : def; };

    const closedLoops = [], segs = [];
    let skipped = 0;
    const addPoly = (verts, closed) => {
      if (verts.length < 2) return;
      const f = verts[0], l = verts[verts.length - 1];
      if (!closed && verts.length > 2 && Math.hypot(f.x - l.x, f.y - l.y) < 1e-9) { verts = verts.slice(0, -1); closed = true; }
      const pts = tessellate(verts, closed);
      (closed ? closedLoops : segs).push(pts);
    };

    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.type === 'LWPOLYLINE') {
        const verts = [];
        for (const [c, v] of e.data) {
          if (c === 10) verts.push({ x: parseFloat(v), y: 0, b: 0 });
          else if (c === 20 && verts.length) verts[verts.length - 1].y = parseFloat(v);
          else if (c === 42 && verts.length) verts[verts.length - 1].b = parseFloat(v);
        }
        addPoly(verts, (get(e, 70, 0) & 1) === 1);
      } else if (e.type === 'POLYLINE') {
        const verts = [];
        let j = i + 1;
        for (; j < ents.length && ents[j].type === 'VERTEX'; j++) {
          verts.push({ x: get(ents[j], 10, 0), y: get(ents[j], 20, 0), b: get(ents[j], 42, 0) });
        }
        addPoly(verts, (get(e, 70, 0) & 1) === 1);
        i = j - 1;
      } else if (e.type === 'CIRCLE') {
        const pts = arcPoints(get(e, 10, 0), get(e, 20, 0), get(e, 40, 0), 0, 2 * Math.PI);
        pts.pop(); closedLoops.push(pts);
      } else if (e.type === 'LINE') {
        segs.push([{ x: get(e, 10, 0), y: get(e, 20, 0) }, { x: get(e, 11, 0), y: get(e, 21, 0) }]);
      } else if (e.type === 'ARC') {
        const a0 = get(e, 50, 0) * Math.PI / 180;
        let sweep = get(e, 51, 0) * Math.PI / 180 - a0;
        while (sweep <= 0) sweep += 2 * Math.PI;
        segs.push(arcPoints(get(e, 10, 0), get(e, 20, 0), get(e, 40, 0), a0, sweep));
      } else if (e.type === 'SPLINE' || e.type === 'ELLIPSE') {
        skipped++;
      }
    }
    const contours = closedLoops.concat(chainSegments(segs))
      .map(c => c.map(p => ({ x: p.x, y: -p.y }))); // DXFはY軸が上向き
    return { contours, skipped };
  }

  /* ---------- レーザ加工機用SVG ---------- */

  // opt: { shapes, bbox, mmPerUnit, mark:'hole'|'cross'|'none', holeDiameter, margin }
  // 重心が材料の外にある図形には しるしを付けない
  function buildSVG(opt) {
    const k = opt.mmPerUnit, m = opt.margin == null ? 5 : opt.margin, b = opt.bbox;
    const f = v => (Math.round(v * 1000) / 1000).toString();
    const X = x => f((x - b.minX) * k + m), Y = y => f((y - b.minY) * k + m);
    const W = f(b.w * k + 2 * m), H = f(b.h * k + 2 * m);
    const cut = 'fill="none" stroke="#ff0000" stroke-width="0.1"';
    const mark = 'fill="none" stroke="#0000ff" stroke-width="0.1"';
    let body = '';
    opt.shapes.forEach((s, i) => {
      const d = s.contours.map(c => 'M' + c.pts.map(p => X(p.x) + ' ' + Y(p.y)).join(' L') + ' Z').join(' ');
      const cx = X(s.centroid.x), cy = Y(s.centroid.y), n = i + 1;
      body += `  <g id="shape-${n}">\n    <!-- 重心 (${cx}, ${cy}) -->\n` +
        `    <path id="outline-${n}" d="${d}" fill-rule="evenodd" ${cut}/>\n`;
      if (s.inside && opt.mark === 'hole') {
        body += `    <circle id="shaft-hole-${n}" cx="${cx}" cy="${cy}" r="${f(opt.holeDiameter / 2)}" ${cut}/>\n`;
      } else if (s.inside && opt.mark === 'cross') {
        const r = 3;
        body += `    <path id="centroid-mark-${n}" d="M${f(+cx - r)} ${cy} H${f(+cx + r)} M${cx} ${f(+cy - r)} V${f(+cy + r)}" ${mark}/>\n`;
      }
      body += '  </g>\n';
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">\n` +
      `  <!-- 単位: mm / 赤 = 切断, 青 = けがき(彫刻) -->\n` + body + `</svg>\n`;
  }

  const Geo = {
    signedArea, polygonCentroid, bbox, pointInPolygon, simplifyClosed, smoothClosed,
    selfIntersects, contoursIntersect, distToContour, analyze, parseDXF, buildSVG,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Geo;
  else root.Geo = Geo;
})(typeof globalThis !== 'undefined' ? globalThis : this);
