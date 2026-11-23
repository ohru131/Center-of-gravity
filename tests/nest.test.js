const test = require('node:test');
const assert = require('node:assert');
const Nest = require('../nest.js');
const Geo = require('../geometry.js');

const place = (pts, pl) => {
  const c = Math.cos(pl.angle), s = Math.sin(pl.angle);
  return pts.map(p => ({ x: p.x * c - p.y * s + pl.tx, y: p.x * s + p.y * c + pl.ty }));
};
// 2つの多角形の最短距離（頂点と辺の距離で近似。交差していれば 0）
function minDist(a, b) {
  if (Geo.contoursIntersect(a, b) || Geo.pointInPolygon(a[0], b) || Geo.pointInPolygon(b[0], a)) return 0;
  let d = Infinity;
  for (const p of a) d = Math.min(d, Geo.distToContour(p, b));
  for (const p of b) d = Math.min(d, Geo.distToContour(p, a));
  return d;
}
function check(outlines, pls, W, H, gap) {
  const placed = pls.map(pl => place(outlines[pl.shape], pl));
  for (const poly of placed) for (const p of poly) {
    assert.ok(p.x >= -1e-6 && p.y >= -1e-6 && p.x <= W + 1e-6 && p.y <= H + 1e-6, `用紙からはみ出し (${p.x}, ${p.y})`);
  }
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const d = minDist(placed[i], placed[j]);
    assert.ok(d >= gap - 1e-6, `図形 ${i} と ${j} のすきま ${d} < ${gap}`);
  }
}
// 重なり = 辺が交わる、または頂点が相手の内がわに 0.02mm より深く入っている（ぴったり接するのは可）
function overlaps(a, b) {
  if (Geo.contoursIntersect(a, b)) return true;
  const deep = (p, poly) => Geo.pointInPolygon(p, poly) && Geo.distToContour(p, poly) > 0.02;
  return a.some(p => deep(p, b)) || b.some(p => deep(p, a));
}
function assertNoOverlap(outlines, pls) {
  const ps = pls.map(pl => place(outlines[pl.shape], pl));
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) assert.ok(!overlaps(ps[i], ps[j]), `図形 ${i} と ${j} が重なり`);
}
const W = 200, H = 279;

test('正方形 40mm：重ならず、すきまを守って A4 にたくさん入る', () => {
  const sq = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }];
  const pls = Nest.packBest([sq], { width: W, height: H, gap: 2 });
  check([sq], pls, W, H, 2);
  assert.ok(pls.length >= 20 && pls.length <= 24, `こ数 ${pls.length}`);   // 理想は 4 x 6 = 24
});

test('L字：回転させてかみ合わせる', () => {
  const L = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 60 }, { x: 0, y: 60 }];
  const pls = Nest.packBest([L], { width: W, height: H, gap: 2 });
  check([L], pls, W, H, 2);
  assert.ok(new Set(pls.map(p => Math.round(p.angle * 100))).size > 1, '複数の角度を使う');
  assert.ok(pls.length >= 16, `こ数 ${pls.length}`);   // 回転なしの格子ならびだと 3 x 4 = 12
});

test('2種類の図形を交互にならべる・大きすぎる図形は 0 こ', () => {
  const a = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 45 }], b = [];
  for (let i = 0; i < 24; i++) b.push({ x: 15 * Math.cos(i / 24 * 2 * Math.PI), y: 15 * Math.sin(i / 24 * 2 * Math.PI) });
  const pls = Nest.pack([a, b], { width: W, height: H, gap: 3 });
  check([a, b], pls, W, H, 3);
  assert.ok(pls.filter(p => p.shape === 0).length >= 8 && pls.filter(p => p.shape === 1).length >= 8);
  const big = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 }];
  assert.strictEqual(Nest.pack([big], { width: W, height: H }).length, 0);
});

test('PDF：A4・赤の切断線・穴・枚数の文字、xref の位置が正しい', () => {
  const r = Geo.analyze([[{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]]);
  const pdf = Nest.buildPDF({
    shapes: r.shapes, placements: [{ shape: 0, angle: 0, tx: 5, ty: 5 }, { shape: 0, angle: Math.PI / 2, tx: 100, ty: 5 }],
    mark: 'hole', holeDiameter: 3, text: 'Copies: 2',
  });
  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /MediaBox \[0 0 595\.276 841\.89\]/);
  assert.match(pdf, /1 0 0 RG/);
  assert.match(pdf, /\(Copies: 2\) Tj/);
  assert.match(pdf, /5 5 m 45 5 l 45 45 l 5 45 l h/);
  assert.match(pdf, /26\.5 25 m/);   // 重心 (25,25) の右に半径 1.5
  const xref = +/startxref\n(\d+)/.exec(pdf)[1];
  assert.strictEqual(pdf.slice(xref, xref + 4), 'xref');
  const offs = [...pdf.matchAll(/(\d{10}) 00000 n/g)].map(m => +m[1]);
  offs.forEach((o, i) => assert.strictEqual(pdf.slice(o, o + 7), `${i + 1} 0 obj`));
  const len = +/\/Length (\d+)/.exec(pdf)[1], s = pdf.indexOf('stream\n') + 7;
  assert.strictEqual(pdf.slice(s + len, s + len + 9), 'endstream');
});

test('敷きつめSVG：A4 サイズ・複製ごとの外形と穴・こ数の文字', () => {
  const r = Geo.analyze([[{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]]);
  const svg = Nest.buildSVG({
    shapes: r.shapes, placements: [{ shape: 0, angle: 0, tx: 5, ty: 5 }, { shape: 0, angle: Math.PI / 2, tx: 100, ty: 5 }],
    mark: 'hole', holeDiameter: 3, text: 'Copies: 2',
  });
  assert.match(svg, /width="210mm" height="297mm" viewBox="0 0 210 297"/);
  assert.match(svg, /<path d="M5 5 L45 5 L45 45 L5 45 Z"/);
  assert.match(svg, /<path d="M100 5 L100 45 L60 45 L60 5 Z"/);   // 90°回転
  assert.match(svg, /<circle cx="25" cy="25" r="1.5"/);
  assert.match(svg, /<circle cx="80" cy="25" r="1.5"/);
  assert.match(svg, />Copies: 2<\/text>/);
});

test('格子ならべ：三角形は 180° 回転の相方と組んで密につまる（二重格子）', () => {
  const tri = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 45 }];
  const pls = Nest.packBest([tri], { width: W, height: H, gap: 2 });
  check([tri], pls, W, H, 2);
  assert.strictEqual(pls.method, 'double-lattice');
  assert.ok(pls.density > 0.84, `密度 ${pls.density}`);   // すきま 2mm での理論値は約 0.877
  assert.ok(pls.length >= 34, `こ数 ${pls.length}`);
});

test('格子ならべ：円は六角形状にならぶ', () => {
  const c = [];
  for (let i = 0; i < 48; i++) c.push({ x: 20 * Math.cos(i / 48 * 2 * Math.PI), y: 20 * Math.sin(i / 48 * 2 * Math.PI) });
  const pls = Nest.packBest([c], { width: W, height: H, gap: 2 });
  check([c], pls, W, H, 2);
  assert.ok(pls.density > 0.79, `密度 ${pls.density}`);   // 六方格子の理論値は約 0.822
  assert.ok(pls.length >= 28, `こ数 ${pls.length}`);
});

test('すきま 0：重ならずに、くっつけてならぶ', () => {
  const sq = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }];
  const pls = Nest.packBest([sq], { width: W, height: H, gap: 0 });
  check([sq], pls, W, H, 0);
  assertNoOverlap([sq], pls);
  assert.strictEqual(pls.length, 30);   // 5 x 6 がすきまなく入る（200 x 279 mm）
  const placed = pls.map(pl => place(sq, pl));
  let closest = Infinity;
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) closest = Math.min(closest, minDist(placed[i], placed[j]));
  assert.ok(closest < 0.2, `となりとのすきま ${closest}`);

  const tri = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 45 }];
  const t = Nest.packBest([tri], { width: W, height: H, gap: 0 });
  check([tri], t, W, H, 0);
  assertNoOverlap([tri], t);
  assert.ok(t.density > 0.97, `密度 ${t.density}`);   // 三角形は 180° 回転と組んで平面をうめつくす
});

test('形が複数種類：帯に分けて格子ならべ、どの形もほぼ同じこ数', () => {
  const tri = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 45 }], c = [];
  for (let i = 0; i < 24; i++) c.push({ x: 15 * Math.cos(i / 24 * 2 * Math.PI), y: 15 * Math.sin(i / 24 * 2 * Math.PI) });
  const L = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 60 }, { x: 0, y: 60 }];
  for (const set of [[tri, c], [tri, c, L]]) {
    const greedy = Nest.pack(set, { width: W, height: H, gap: 2 });
    const pls = Nest.packBest(set, { width: W, height: H, gap: 2 });
    check(set, pls, W, H, 2);
    assert.strictEqual(pls.method, 'bands');
    const counts = set.map((_, i) => pls.filter(p => p.shape === i).length);
    assert.ok(pls.length >= greedy.length, `格子 ${pls.length} こ < 貪欲法 ${greedy.length} こ`);
    assert.ok(Math.min(...counts) >= 0.5 * Math.max(...counts), `こ数のかたより ${counts}`);
  }
});

test('原点から離れた座標の形でも、重ならず同じこ数（180° 回転の相方の見落とし防止）', () => {
  const L = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 60 }, { x: 0, y: 60 }];
  const far = L.map(p => ({ x: p.x + 130, y: p.y + 90 }));
  const tri = [{ x: 300, y: 200 }, { x: 350, y: 200 }, { x: 325, y: 245 }];
  const a = Nest.packBest([L], { width: W, height: H, gap: 2 }), b = Nest.packBest([far], { width: W, height: H, gap: 2 });
  check([far], b, W, H, 2);
  assert.strictEqual(b.length, a.length);
  assert.ok(b.density > 0.8 && b.density < 1, `密度 ${b.density}`);
  const m = Nest.packBest([far, tri], { width: W, height: H, gap: 0 });
  check([far, tri], m, W, H, 0);
  assertNoOverlap([far, tri], m);
});
