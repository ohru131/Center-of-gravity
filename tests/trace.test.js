const test = require('node:test');
const assert = require('node:assert');
const Trace = require('../trace.js');
const Geo = require('../geometry.js');

// 白い紙（むらあり）に線をかいた画像をつくる
function canvas(w, h) {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = 200 + Math.round(40 * x / w); // 照明むら
  return g;
}
// 円周の線。skip(角度) が true の所はかかない。dark = 線のこさ
function ring(g, w, cx, cy, R, width, dark, skip) {
  for (let a = 0; a < 2 * Math.PI; a += 0.002) {
    if (skip && skip(a)) continue;
    for (let r = R - width / 2; r <= R + width / 2; r += 0.5) {
      g[Math.round(cy + r * Math.sin(a)) * w + Math.round(cx + r * Math.cos(a))] = dark;
    }
  }
}
const areaOf = c => Math.abs(Geo.signedArea(c));
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b} (±${tol})`);

test('とじた線 → 内側をふくむ1つの輪郭', () => {
  const w = 300, h = 240, g = canvas(w, h);
  ring(g, w, 150, 120, 70, 3, 60);
  const { contours, gap } = Trace.detect(g, w, h);
  assert.strictEqual(contours.length, 1);
  assert.strictEqual(gap, 0);
  near(areaOf(contours[0]), Math.PI * 71.5 ** 2, 600);
  const c = Geo.polygonCentroid(contours[0]);
  near(c.x, 150.5, 1); near(c.y, 120.5, 1);
});

test('とぎれた線・かすれた線でも つないで とじる', () => {
  const w = 300, h = 240, g = canvas(w, h);
  // 5画素ほどのすきま3か所 + 点線状のかすれ + うすい区間
  ring(g, w, 150, 120, 70, 3, 60, a => (a > 1 && a < 1.07) || (a > 3 && a < 3.07) || (a > 5 && a < 5.06));
  ring(g, w, 150, 120, 70, 3, 150, a => !(a > 2 && a < 2.6));            // うすい線で上書き
  ring(g, w, 150, 120, 70, 3, 225, a => !(a > 4 && a < 4.5 && Math.floor(a * 40) % 2)); // 点線状
  const { contours, gap } = Trace.detect(g, w, h);
  assert.strictEqual(contours.length, 1);
  assert.ok(gap > 0, 'すきまをつなぐ幅が自動で選ばれる');
  near(areaOf(contours[0]), Math.PI * 71.5 ** 2, 900);
});

test('ぬりつぶした形・複数の形・ふちにかかるかげ', () => {
  const w = 320, h = 240, g = canvas(w, h);
  for (let y = 60; y < 140; y++) for (let x = 40; x < 120; x++) g[y * w + x] = 40; // 黒い正方形 80x80
  ring(g, w, 230, 120, 50, 3, 60);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 30 - y; x++) g[y * w + x] = 90;  // すみのかげ
  const { contours } = Trace.detect(g, w, h);
  assert.strictEqual(contours.length, 2);
  const areas = contours.map(areaOf).sort((a, b) => a - b);
  near(areas[0], 6400, 200);
  near(areas[1], Math.PI * 51.5 ** 2, 500);
});

test('何もない紙 → 輪郭なし', () => {
  assert.strictEqual(Trace.detect(canvas(200, 150), 200, 150).contours.length, 0);
});

test('とじていない線（半円）は形にしない', () => {
  const w = 300, h = 240, g = canvas(w, h);
  ring(g, w, 150, 120, 70, 4, 60, a => a > Math.PI);
  assert.strictEqual(Trace.detect(g, w, h).contours.length, 0);
  assert.strictEqual(Trace.detect(g, w, h, { gap: 2 }).contours.length, 0);
});
