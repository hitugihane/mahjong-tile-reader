/*!
 * mahjong-tile-reader v0.1.0
 * 機械学習を使わずに、並んだ麻雀牌（手牌）の画像から牌を読み取るライブラリ。
 * 依存なし・ブラウザのみで動作（Node でも ImageData 互換オブジェクトを渡せば動きます）。
 *
 * しくみ
 *   1. 画素を「黒・赤・緑・青・明るい」の5色に分類し、牌の表面（白っぽい部分）を探す
 *   2. 牌の表面が並ぶ帯を見つけ、横幅と牌のすき間から 1 枚ずつに切り分ける
 *   3. 1 枚ごとに表面を格子（既定 16×20）に分け、各マスの「黒・赤・緑・青」の割合を特徴にする
 *   4. 事前に登録した基準牌の特徴と比べ、いちばん近い牌を答えにする（テンプレート照合）
 *
 * 牌の表記は "123m456p789s1234567z"（1z〜7z = 東南西北白發中）。赤ドラ・花牌などは対象外。
 * MIT License
 */

const KANJI_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const HONORS = ['東', '南', '西', '北', '白', '發', '中'];

/** 対応している 34 種の牌コード */
export const TILE_CODES = Object.freeze([
  ...['m', 'p', 's'].flatMap((s) => KANJI_NUM.map((_, i) => `${i + 1}${s}`)),
  ...HONORS.map((_, i) => `${i + 1}z`),
]);

/** 牌コード → 表示名（例: "1m" → "一萬", "6z" → "發"） */
export function tileName(code) {
  const n = Number(code[0]);
  const s = code[1];
  if (s === 'z') return HONORS[n - 1];
  return KANJI_NUM[n - 1] + { m: '萬', p: '筒', s: '索' }[s];
}

/** "123m456p11z" → ["1m","2m","3m","4p","5p","6p","1z","1z"] */
export function parseCodes(text) {
  const out = [];
  let digits = [];
  for (const ch of String(text).replace(/\s+/g, '')) {
    if (ch >= '0' && ch <= '9') digits.push(ch === '0' ? '5' : ch); // 赤5(0)は通常の5として扱う
    else if ('mpsz'.includes(ch)) {
      if (!digits.length) throw new Error(`"${ch}" の前に数字がありません`);
      for (const d of digits) {
        const code = d + ch;
        if (!TILE_CODES.includes(code)) throw new Error(`存在しない牌です: ${code}`);
        out.push(code);
      }
      digits = [];
    } else throw new Error(`使えない文字です: "${ch}"`);
  }
  if (digits.length) throw new Error('最後の数字のあとに m / p / s / z がありません');
  return out;
}

/** ["1m","2m","5p"] → "12m5p"（並び順は保ったまま、同じ種類が続く所をまとめる） */
export function formatCodes(codes) {
  let out = '';
  let run = '';
  let suit = '';
  for (const c of codes) {
    if (c[1] !== suit && run) {
      out += run + suit;
      run = '';
    }
    suit = c[1];
    run += c[0];
  }
  return run ? out + run + suit : out;
}

// ---------------------------------------------------------------------------
// 画素の分類
// ---------------------------------------------------------------------------

const LIGHT = 0;
const DARK = 1;
const RED = 2;
const GREEN = 3;
const BLUE = 4;
const N_INK = 4; // DARK, RED, GREEN, BLUE

const DEFAULT_THRESHOLDS = Object.freeze({
  minSat: 0.33, // これ以上の彩度で「色付き」とみなす
  minChromaV: 0.22, // 色付きとみなす最低の明るさ
  darkV: 0.45, // これ未満の明るさは「黒」
  faceV: 0.6, // 牌の表面とみなす最低の明るさ
  faceSat: 0.25, // 牌の表面とみなす最大の彩度
});

/**
 * 画像の全画素を分類する。結果は readHand などに使い回せます。
 * @param {ImageData|{width:number,height:number,data:Uint8ClampedArray}} img
 */
export function analyzeImage(img, thresholds = {}) {
  if (img && img.__mtr) return img;
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const { width: W, height: H, data } = img;
  const cls = new Uint8Array(W * H);
  const face = new Uint8Array(W * H);
  const lum = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    lum[i] = (r * 299 + g * 587 + b * 114) / 1000;
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const d = max - min;
    const v = max / 255;
    const s = max ? d / max : 0;
    let c = LIGHT;
    if (s >= th.minSat && v >= th.minChromaV) {
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      c = h < 40 || h >= 300 ? RED : h < 160 ? GREEN : BLUE;
    } else if (v < th.darkV) c = DARK;
    cls[i] = c;
    face[i] = v >= th.faceV && s <= th.faceSat ? 1 : 0;
  }
  return { __mtr: true, W, H, cls, face, lum };
}

// ---------------------------------------------------------------------------
// 切り出し
// ---------------------------------------------------------------------------

/** prof[i] >= thr が続く区間（tol 以下のくぼみは無視してつなぐ）をすべて返す */
function runs(prof, thr, tol = 0) {
  const out = [];
  let start = -1;
  let last = -1;
  for (let i = 0; i <= prof.length; i++) {
    const on = i < prof.length && prof[i] >= thr;
    if (on) {
      if (start < 0) start = i;
      last = i;
    } else if (start >= 0 && (i - last > tol || i === prof.length)) {
      out.push([start, last + 1]);
      start = -1;
    }
  }
  return out;
}

function longestRun(prof, thr, tol) {
  let best = null;
  for (const r of runs(prof, thr, tol)) if (!best || r[1] - r[0] > best[1] - best[0]) best = r;
  return best;
}

/** 合計 total を重み weights の比でできるだけ公平に整数へ配分（最大剰余法） */
function apportion(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map((x) => Math.max(1, Math.floor(x)));
  let diff = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; diff !== 0 && k < order.length * 4; k++) {
    const i = order[k % order.length][1];
    if (diff > 0) {
      out[i]++;
      diff--;
    } else if (out[i] > 1) {
      out[i]--;
      diff++;
    }
  }
  return out;
}

/**
 * 画像の中から牌の並びを探し、1 枚ずつの範囲（box）に切り分ける。
 * @param {object} [opts]
 * @param {number|'auto'} [opts.count='auto'] 牌の枚数。分かっているなら指定すると確実
 * @param {number[]} [opts.allowedCounts=[13,14]] auto のときに寄せる枚数の候補（null で無制限）
 * @param {number} [opts.aspect=0.8] 牌の表面の 横/縦 比。基準を登録すると自動で学習されます
 */
export function locateHand(image, opts = {}) {
  const A = analyzeImage(image, opts.thresholds);
  const { W, H, face } = A;
  const aspect = opts.aspect || 0.8;
  const count = opts.count ?? 'auto';
  const allowed = opts.allowedCounts === undefined ? [13, 14] : opts.allowedCounts;

  // 1) 牌の表面が並ぶ横帯を探す
  const rowFrac = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0, i = y * W; x < W; x++, i++) n += face[i];
    rowFrac[y] = n / W;
  }
  const maxRow = Math.max(...rowFrac);
  if (maxRow < 0.03) throw new Error('牌の表面（白っぽい部分）が見つかりませんでした');
  const band = longestRun(rowFrac, maxRow * 0.4, Math.round(H * 0.03) + 1);
  const [y0, y1] = band;
  const bh = y1 - y0;

  // 2) 帯の中で、列ごとの「表面らしさ」を出す
  const colFrac = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = y0, i = y0 * W + x; y < y1; y++, i += W) n += face[i];
    colFrac[x] = n / bh;
  }
  const extent = longestRun(colFrac, 0.3, Math.round(bh * 0.8));
  if (!extent) throw new Error('牌の並びが見つかりませんでした');

  // 3) すき間（表面がほぼない列）で区切る。1 区切りに何枚入っているかは横幅から割り出す
  let segs = runs(colFrac.subarray(extent[0], extent[1]), 0.12).map(([a, b]) => [a + extent[0], b + extent[0]]);
  const estW = bh * aspect;
  segs = segs.filter(([a, b]) => b - a >= estW * 0.25);
  if (!segs.length) segs = [extent];
  const widths = segs.map(([a, b]) => b - a);
  const totalW = widths.reduce((a, b) => a + b, 0);

  let target;
  if (typeof count === 'number') target = count;
  else {
    const est = widths.reduce((n, w) => n + Math.max(1, Math.round(w / estW)), 0);
    target = est;
    if (allowed && allowed.length && !allowed.includes(est)) {
      const guess = totalW / estW;
      target = allowed.reduce((a, b) => (Math.abs(b - guess) < Math.abs(a - guess) ? b : a));
    }
  }
  if (target < segs.length) {
    // 区切りが多すぎる → 細いものから捨てる
    segs = segs
      .map((s, i) => [s, i])
      .sort((a, b) => b[0][1] - b[0][0] - (a[0][1] - a[0][0]))
      .slice(0, target)
      .sort((a, b) => a[1] - b[1])
      .map((x) => x[0]);
  }
  const per = apportion(segs.map(([a, b]) => b - a), target);

  const boxes = [];
  segs.forEach(([a, b], si) => {
    const n = per[si];
    const w = (b - a) / n;
    for (let k = 0; k < n; k++) {
      const x = Math.round(a + w * k);
      boxes.push({ x, y: y0, w: Math.round(a + w * (k + 1)) - x, h: bh });
    }
  });
  const usedW = segs.reduce((s, [a, b]) => s + (b - a), 0);
  return {
    boxes,
    band: [y0, y1],
    extent,
    tileWidth: usedW / target,
    aspect: usedW / target / bh,
    method: segs.length === target ? 'gaps' : segs.length === 1 ? 'width' : 'gaps+width',
  };
}

// ---------------------------------------------------------------------------
// 特徴の抽出
// ---------------------------------------------------------------------------

/**
 * 1 枚の牌（box の範囲）から特徴ベクトルを作る。
 * 返り値は 格子数×4（黒・赤・緑・青の割合）の Float32Array。
 */
export function extractFeatures(image, box, opts = {}) {
  const A = analyzeImage(image, opts.thresholds);
  const [GX, GY] = opts.grid || [16, 20];
  const inset = opts.inset ?? 0.06;
  const { W, H, cls, face } = A;
  let { x, y, w, h } = box || { x: 0, y: 0, w: W, h: H };

  // 表面の範囲を詰める（左右は箱の中だけ、上下は少し広めに探す）
  const sy0 = Math.max(0, Math.round(y - h * 0.15));
  const sy1 = Math.min(H, Math.round(y + h * 1.15));
  const colF = new Float32Array(w);
  for (let i = 0; i < w; i++) {
    let n = 0;
    for (let yy = y; yy < y + h; yy++) n += face[yy * W + x + i];
    colF[i] = n / h;
  }
  const cr = longestRun(colF, 0.3, Math.round(w * 0.08));
  if (cr && cr[1] - cr[0] >= w * 0.6) {
    x += cr[0];
    w = cr[1] - cr[0];
  }
  const rowF = new Float32Array(sy1 - sy0);
  for (let yy = sy0; yy < sy1; yy++) {
    let n = 0;
    for (let xx = x; xx < x + w; xx++) n += face[yy * W + xx];
    rowF[yy - sy0] = n / w;
  }
  const rr = longestRun(rowF, 0.3, Math.round(h * 0.08));
  if (rr && rr[1] - rr[0] >= h * 0.6) {
    y = sy0 + rr[0];
    h = rr[1] - rr[0];
  }

  const ix = Math.round(w * inset);
  const iy = Math.round(h * inset);
  const fx = x + ix;
  const fy = y + iy;
  const fw = Math.max(1, w - ix * 2);
  const fh = Math.max(1, h - iy * 2);

  // この牌の表面の明るさ（明るい方から 10% の位置）を基準に「黒さ」を測る。
  // 小さい画像やぼやけた画像でも細い線が消えないよう、黒さは 0〜1 の連続値にする。
  const { lum } = A;
  const hist = new Uint32Array(256);
  for (let yy = 0; yy < fh; yy++) for (let xx = 0, i = (fy + yy) * W + fx; xx < fw; xx++, i++) hist[lum[i]]++;
  let acc = 0;
  let faceLum = 255;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= fw * fh * 0.1) {
      faceLum = v;
      break;
    }
  }
  const darkSpan = Math.max(30, faceLum * 0.55);

  const cells = GX * GY;
  const counts = new Float32Array(cells * N_INK);
  const totals = new Float32Array(cells);
  for (let yy = 0; yy < fh; yy++) {
    const gy = Math.min(GY - 1, Math.floor((yy * GY) / fh));
    const row = (fy + yy) * W + fx;
    for (let xx = 0; xx < fw; xx++) {
      const cell = gy * GX + Math.min(GX - 1, Math.floor((xx * GX) / fw));
      totals[cell]++;
      const c = cls[row + xx];
      if (c === LIGHT || c === DARK) {
        const k = (faceLum - lum[row + xx]) / darkSpan;
        if (k > 0) counts[cell * N_INK] += k > 1 ? 1 : k;
      } else counts[cell * N_INK + c - 1]++;
    }
  }
  for (let c = 0; c < cells; c++) {
    const t = totals[c] || 1;
    for (let k = 0; k < N_INK; k++) counts[c * N_INK + k] /= t;
  }

  // 隣のマスと少しなじませて、わずかな位置ずれに強くする
  const smooth = opts.smooth ?? 0.5;
  let out = counts;
  if (smooth > 0) {
    out = new Float32Array(counts.length);
    for (let gy = 0; gy < GY; gy++) {
      for (let gx = 0; gx < GX; gx++) {
        for (let k = 0; k < N_INK; k++) {
          let s = 0;
          let n = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = gx + dx;
            const ny = gy + dy;
            if (nx < 0 || ny < 0 || nx >= GX || ny >= GY) continue;
            s += counts[(ny * GX + nx) * N_INK + k];
            n++;
          }
          const self = counts[(gy * GX + gx) * N_INK + k];
          out[(gy * GX + gx) * N_INK + k] = self * (1 - smooth) + (s / n) * smooth;
        }
      }
    }
  }
  out.faceBox = { x: fx, y: fy, w: fw, h: fh };
  return out;
}

function distance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
}

/**
 * 2 段目の比較で見る場所。1 段目で種類（萬・筒・索・字）を決めたあと、
 * その種類の中で「違いが出る場所・色」だけを比べ直す。
 *   萬子: 下の赤い「萬」は全部同じなので、上半分の黒い数字だけを見る
 *   字牌: 東南西北は黒い漢字の形だけが違うので、黒だけを見る
 */
const FOCUS = {
  m: { rows: [0, 0.5], channels: [0] },
  z: { rows: [0, 1], channels: [0, 1, 2, 3] },
};

function focusDistance(a, b, GX, GY, focus) {
  const r0 = Math.floor(focus.rows[0] * GY);
  const r1 = Math.ceil(focus.rows[1] * GY);
  let d = 0;
  for (let gy = r0; gy < r1; gy++) {
    for (let gx = 0; gx < GX; gx++) {
      const base = (gy * GX + gx) * N_INK;
      for (const k of focus.channels) d += Math.abs(a[base + k] - b[base + k]);
    }
  }
  return d;
}

/** ImageData を縮小する（面積平均。canvas 不要） */
export function shrinkImageData(img, scale) {
  const { width: W, height: H, data } = img;
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * H) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * H) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * W) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * W) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        for (let xx = sx0, p = (yy * W + sx0) * 4; xx < sx1; xx++, p += 4) {
          r += data[p];
          g += data[p + 1];
          b += data[p + 2];
          n++;
        }
      }
      const q = (y * w + x) * 4;
      out[q] = r / n;
      out[q + 1] = g / n;
      out[q + 2] = b / n;
      out[q + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// ブラウザ用ヘルパー
// ---------------------------------------------------------------------------

/** <img> / <canvas> / <video> / ImageBitmap / ImageData を ImageData にそろえる */
export function toImageData(source) {
  if (!source) throw new Error('画像がありません');
  if (source.__mtr || (source.data && typeof source.width === 'number')) return source;
  const w = source.naturalWidth || source.videoWidth || source.width;
  const h = source.naturalHeight || source.videoHeight || source.height;
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// ---------------------------------------------------------------------------
// 読み取り器
// ---------------------------------------------------------------------------

/**
 * 読み取り器を作る。
 * @param {object} [options]
 * @param {[number,number]} [options.grid=[16,20]] 牌の表面を何×何のマスに分けるか
 * @param {number} [options.aspect] 牌の表面の 横/縦 比（基準登録で自動学習）
 * @param {object} [options.thresholds] 色の分類しきい値（DEFAULT_THRESHOLDS 参照）
 */
export function createReader(options = {}) {
  const cfg = { grid: [16, 20], inset: 0.06, ...options };
  let refs = []; // { code, f: Float32Array }
  let aspect = options.aspect || null;

  function add(code, f) {
    if (!TILE_CODES.includes(code)) throw new Error(`存在しない牌です: ${code}`);
    refs.push({ code, f });
  }

  function classify(f) {
    if (!refs.length) throw new Error('基準牌が登録されていません。addReferenceRow で登録してください');
    const best = new Map();
    for (const r of refs) {
      const d = distance(f, r.f);
      if (!best.has(r.code) || d < best.get(r.code)) best.set(r.code, d);
    }
    let ranked = [...best.entries()].map(([code, d]) => ({ code, distance: d })).sort((a, b) => a.distance - b.distance);

    // 2 段目: 同じ種類の中だけで、違いが出る場所に絞って比べ直す
    const suit = ranked[0].code[1];
    const focus = cfg.twoStage === false ? null : FOCUS[suit];
    if (focus) {
      const [GX, GY] = cfg.grid;
      const fine = new Map();
      for (const r of refs) {
        if (r.code[1] !== suit) continue;
        const d = focusDistance(f, r.f, GX, GY, focus);
        if (!fine.has(r.code) || d < fine.get(r.code)) fine.set(r.code, d);
      }
      ranked = [...fine.entries()].map(([code, d]) => ({ code, distance: d })).sort((a, b) => a.distance - b.distance);
    }
    const d1 = ranked[0].distance;
    const d2 = ranked[1] ? ranked[1].distance : d1 * 2 + 1;
    const confidence = Math.max(0, Math.min(1, (d2 - d1) / (d2 || 1)));
    return { code: ranked[0].code, confidence, distance: d1, candidates: ranked.slice(0, 3) };
  }

  return {
    get grid() {
      return cfg.grid.slice();
    },
    /** 学習済みの表面の 横/縦 比 */
    get aspect() {
      return aspect;
    },
    /** 登録済みの牌コード（重複なし） */
    get registeredCodes() {
      return [...new Set(refs.map((r) => r.code))];
    },
    get referenceCount() {
      return refs.length;
    },

    /**
     * 並んだ牌の画像と、その並びの牌コードを渡して基準を登録する。
     * 例: reader.addReferenceRow(img, '123456789m123456789p123456789s1234567z')
     */
    addReferenceRow(source, codes, { scales = cfg.referenceScales ?? [0.65, 0.45] } = {}) {
      const list = Array.isArray(codes) ? codes : parseCodes(codes);
      const img = toImageData(source);
      const A = analyzeImage(img, cfg.thresholds);
      const layout = locateHand(A, { count: list.length, aspect: aspect || 0.8, thresholds: cfg.thresholds });
      layout.boxes.forEach((box, i) => add(list[i], extractFeatures(A, box, cfg)));
      aspect = aspect ? (aspect + layout.aspect) / 2 : layout.aspect;
      // 小さく写った牌にも合うよう、縮小した基準も登録しておく（牌の高さが 30px 未満になる縮小は省く）
      for (const s of scales) {
        if ((layout.band[1] - layout.band[0]) * s < 30) continue;
        const As = analyzeImage(shrinkImageData(img, s), cfg.thresholds);
        const ls = locateHand(As, { count: list.length, aspect: layout.aspect, thresholds: cfg.thresholds });
        ls.boxes.forEach((box, i) => add(list[i], extractFeatures(As, box, cfg)));
      }
      return layout;
    },

    /** 牌 1 枚だけの画像（または box で範囲指定）を基準に登録する */
    addReference(source, code, box) {
      const A = analyzeImage(toImageData(source), cfg.thresholds);
      add(code, extractFeatures(A, box, cfg));
    },

    /** 牌 1 枚を読む */
    readTile(source, box) {
      const A = analyzeImage(toImageData(source), cfg.thresholds);
      return classify(extractFeatures(A, box, cfg));
    },

    /**
     * 並んだ手牌を読む。
     * @param {object} [opts] count / allowedCounts（locateHand と同じ）、minConfidence（既定 0.08）
     * @returns {{ codes:string[], text:string, tiles:object[], layout:object, uncertain:number[] }}
     */
    readHand(source, opts = {}) {
      const A = analyzeImage(toImageData(source), cfg.thresholds);
      const layout = locateHand(A, { aspect: aspect || 0.8, thresholds: cfg.thresholds, ...opts });
      const minConf = opts.minConfidence ?? 0.08;
      const tiles = layout.boxes.map((box) => {
        const f = extractFeatures(A, box, cfg);
        return { ...classify(f), box, faceBox: f.faceBox };
      });
      const codes = tiles.map((t) => t.code);
      return {
        codes,
        text: formatCodes(codes),
        tiles,
        layout,
        uncertain: tiles.flatMap((t, i) => (t.confidence < minConf ? [i] : [])),
      };
    },

    /** 基準を JSON にできる形で書き出す（localStorage やファイルに保存して使い回せます） */
    exportReferences() {
      return {
        format: 'mahjong-tile-reader/1',
        grid: cfg.grid,
        aspect,
        refs: refs.map((r) => ({ code: r.code, f: Array.from(r.f, (v) => Math.round(v * 1000) / 1000) })),
      };
    },

    importReferences(data, { append = false } = {}) {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      if (!obj || obj.format !== 'mahjong-tile-reader/1') throw new Error('形式が違います');
      if (obj.grid[0] !== cfg.grid[0] || obj.grid[1] !== cfg.grid[1])
        throw new Error(`格子の大きさが違います（${obj.grid.join('×')}）`);
      if (!append) refs = [];
      for (const r of obj.refs) add(r.code, Float32Array.from(r.f));
      if (obj.aspect) aspect = obj.aspect;
    },

    clear() {
      refs = [];
      aspect = options.aspect || null;
    },
  };
}

export default createReader;
