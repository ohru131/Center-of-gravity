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

test('画像のふち近くの形も、とぎれをつないで取れる（形ごとに つなぎ幅を自動選択）', () => {
  const w = 320, h = 200, g = canvas(w, h);
  ring(g, w, 76, 100, 70, 3, 60, a => a > 2 && a < 2.07);   // 左のふちから 4 画素、とぎれあり
  ring(g, w, 240, 100, 40, 3, 60);                          // とぎれなし
  const { contours } = Trace.detect(g, w, h);
  assert.strictEqual(contours.length, 2);
  const areas = contours.map(areaOf).sort((a, b) => a - b);
  near(areas[0], Math.PI * 41.5 ** 2, 400);
  near(areas[1], Math.PI * 71.5 ** 2, 900);
});

test('感度の目安：きれいな背景は高感度、ざらついた写真はひかえめ', () => {
  const w = 200, h = 150, clean = canvas(w, h), noisy = canvas(w, h);
  let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < noisy.length; i++) noisy[i] = Math.max(0, Math.min(255, noisy[i] + Math.round((rnd() - 0.5) * 30)));
  assert.ok(Trace.suggestThreshold(clean, w, h) <= 0.05);
  assert.ok(Trace.suggestThreshold(noisy, w, h) >= 0.1);
});

// カラー写真ふう：むらのある木目調の背景に、色のついた物体
function colorScene(w, h, paint) {
  const d = new Uint8ClampedArray(w * h * 4);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, shade = 1 - 0.3 * (x + y) / (w + h), grain = 6 * Math.sin(y * 0.9) + (rnd() - 0.5) * 14;
    let c = [190 * shade + grain, 150 * shade + grain, 105 * shade + grain];
    c = paint(x, y, c) || c;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  return d;
}

test('カラー写真：背景とちがう色の物体を切り出す（かげ・ハイライト・中の白い部分つき）', () => {
  const w = 320, h = 240;
  const rgba = colorScene(w, h, (x, y, bg) => {
    const dx = x - 100, dy = y - 120;
    if (dx * dx + dy * dy < 55 * 55) {
      if (dx * dx + dy * dy < 15 * 15) return [235, 235, 230];          // 物体の中の白いラベル
      const hl = Math.max(0, 60 - Math.hypot(dx + 20, dy + 20) * 2);    // ハイライト
      return [200 + hl / 2, 40 + hl, 40 + hl];
    }
    if (x >= 200 && x < 280 && y >= 80 && y < 170) return [40, 90, 180]; // 青い四角
    const sx = x - 112, sy = y - 132;                                    // 赤い円のうすいかげ
    if (sx * sx + sy * sy < 55 * 55) return bg.map(v => v * 0.86);
  });
  const { contours, fill } = Trace.detectObject(rgba, w, h);
  assert.strictEqual(contours.length, 2);
  const areas = contours.map(areaOf).sort((a, b) => a - b);
  near(areas[0], 80 * 90, 500);
  near(areas[1], Math.PI * 55 * 55, 900);
  assert.ok(fill > 0.8, '中まで色のある物体は fill が大きい');
});

test('カラー写真：物体なし → 輪郭なし / 線画は fill が小さい', () => {
  const w = 240, h = 180;
  assert.strictEqual(Trace.detectObject(colorScene(w, h, () => null), w, h).contours.length, 0);
  const line = colorScene(w, h, (x, y) => Math.abs(Math.hypot(x - 120, y - 90) - 60) < 2 ? [30, 30, 40] : null);
  const r = Trace.detectObject(line, w, h);
  assert.strictEqual(r.contours.length, 1);
  assert.ok(r.fill < 0.3);
});
