/*!
 * mahjong-tile-reader v0.5.0
 * 機械学習を使わずに、並んだ麻雀牌（手牌）の画像から牌を読み取るライブラリ。
 * 依存なし・ブラウザのみで動作（Node でも ImageData 互換オブジェクトを渡せば動きます）。
 *
 * しくみ
 *   0. 写真の傾きと遠近（上が狭い台形）を直す（直した方と直さない方の両方で読み、自信のある方を採る）
 *   1. 牌の表面（白っぽい部分）を探し、表面が並ぶ帯を見つける（明るさのしきい値は列ごとに写真に合わせる）
 *   2. 横幅と牌のすき間から 1 枚ずつに切り分ける
 *   3. 1 枚ごとに表面を格子（既定 16×20）に分け、各マスの「暗さ・赤み・緑み・青み」を特徴にする
 *      （しきい値で色分けせず足し算で測るので、JPEG やぼかしで赤・緑が黒に化けない）
 *   4. 事前に登録した基準牌の特徴と比べ、いちばん近い牌を答えにする（テンプレート照合）
 *   5. 萬子と判定したら、上半分の黒い数字だけで比べ直す
 *   6. 並行して「規則」でも読む（基準なし）: 筒子・索子は粒の数・形・並び・赤の位置・中心線の余白、
 *      一〜三萬は横線の本数。見比べと食い違えば自信なしにする
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

/** ["1m","2m","5p"] → "12m5p"（並び順は保ったまま、同じ種類が続く所をまとめる。null は "?"） */
export function formatCodes(codes) {
  let out = '';
  let run = '';
  let suit = '';
  for (const c of codes) {
    if (!c) {
      // 読めなかった牌は "?" にする
      if (run) out += run + suit;
      run = '';
      suit = '';
      out += '?';
      continue;
    }
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

// 特徴の 4 成分: 暗さ・赤み・緑み・青み
const N_INK = 4;

export const DEFAULT_THRESHOLDS = Object.freeze({
  faceV: 0.6, // 牌の表面とみなす最低の明るさ（切り出しにだけ使う）
  faceSat: 0.25, // 牌の表面とみなす最大の彩度（切り出しにだけ使う）
  // adaptive: false にすると、明るさを列ごとに合わせず faceV で固定する（v0.3 と同じ）
});

/**
 * 画像の前処理。結果は readHand などに使い回せます。
 *   lum: 明るさ, face: 牌の表面らしい画素か（切り出し用）, data: 元の RGBA
 * 色の判定にはしきい値を使いません（extractFeatures 参照）。
 * @param {ImageData|{width:number,height:number,data:Uint8ClampedArray}} img
 */
export function analyzeImage(img, thresholds = {}) {
  if (img && img.__mtr) return img;
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const { width: W, height: H, data } = img;
  const face = new Uint8Array(W * H);
  const lum = new Uint8Array(W * H);
  const val = new Uint8Array(W * H);
  const sat = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    lum[i] = (r * 299 + g * 587 + b * 114) / 1000;
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    val[i] = max;
    sat[i] = max ? ((max - min) * 255) / max : 0;
  }
  const satCut = th.faceSat * 255;
  const vCut = th.faceV * 255;
  if (th.adaptive === false) {
    for (let i = 0; i < W * H; i++) face[i] = val[i] >= vCut && sat[i] <= satCut ? 1 : 0;
    return { __mtr: true, W, H, face, lum, data };
  }
  // 写真向け（v0.4）: 明るさのしきい値を列ごとに画像に合わせる
  //   列の「白さ」（明るい方 3%）と「机の明るさ」（上下のふちの明るい方）の間、4 割の所で切る。
  //   影や照明のむらは机も牌も同じように暗くするので、列ごとに比べれば打ち消される。
  //   明るい色の机でも、同じ列の牌の表面より暗ければ表面にならない。
  //   差がほとんどない列（牌のない左右の余白）は表面にしない。
  //   どの列にも差がない（牌ぎりぎりで切り取った）ときは、固定のしきい値に戻す。
  const colWhite = new Float32Array(W);
  const colLow = new Float32Array(W);
  const hist = new Uint32Array(256);
  const k97 = Math.max(1, Math.round(H * 0.03));
  const strip = Math.max(1, Math.round(H * 0.05));
  const tmp = new Uint8Array(strip);
  const med = (y0) => {
    for (let k = 0; k < strip; k++) tmp[k] = val[(y0 + k) * W + curX];
    tmp.sort();
    return tmp[strip >> 1];
  };
  let curX = 0;
  for (let x = 0; x < W; x++) {
    hist.fill(0);
    for (let y = 0, i = x; y < H; y++, i += W) hist[val[i]]++;
    let acc = 0;
    let v = 255;
    for (; v > 0; v--) if ((acc += hist[v]) >= k97) break;
    colWhite[x] = v;
    curX = x;
    colLow[x] = Math.max(med(0), med(H - strip));
  }
  const rad = Math.max(1, Math.round(H * 0.15));
  const smooth = (arr) => {
    const pre = new Float64Array(W + 1);
    for (let x = 0; x < W; x++) pre[x + 1] = pre[x] + arr[x];
    return Float32Array.from(arr, (_, x) => {
      const a = Math.max(0, x - rad);
      const b = Math.min(W, x + rad + 1);
      return (pre[b] - pre[a]) / (b - a);
    });
  };
  const cw = smooth(colWhite);
  const cl = smooth(colLow);
  const white = Float32Array.from(cw).sort()[Math.floor(W * 0.9)];
  // 白さと机の明るさの差が小さい列は牌のない列（左右の余白）なので、表面にしない
  const cut = new Float32Array(W).fill(256);
  let found = false;
  for (let x = 0; x < W; x++) {
    if (cw[x] - cl[x] >= white * 0.1) {
      cut[x] = cl[x] + (cw[x] - cl[x]) * 0.4;
      found = true;
    }
  }
  const fixed = !found;
  for (let i = 0, x = 0; i < W * H; i++, x = x + 1 === W ? 0 : x + 1) {
    face[i] = val[i] >= (fixed ? vCut : cut[x]) && sat[i] <= satCut ? 1 : 0;
  }
  return { __mtr: true, W, H, face, lum, data };
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
  // 余りは「切り捨て後（最低 1 に繰り上げた後）の値」から測る。
  // 切り捨て前の値で測ると、0.99 → 1 に繰り上げた区切りがさらに 1 枚もらってしまう
  const order = raw.map((x, i) => [x - out[i], i]).sort((a, b) => b[0] - a[0]);
  if (diff < 0) order.reverse(); // 配りすぎたら、余りの小さい区切りから 1 枚ずつ戻す
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
    segments: segs.map(([a, b], i) => ({ x: a, w: b - a, tiles: per[i] })),
    tileWidth: usedW / target,
    aspect: usedW / target / bh,
    method: segs.length === target ? 'gaps' : segs.length === 1 ? 'width' : 'gaps+width',
  };
}

// ---------------------------------------------------------------------------
// 傾き・遠近の補正（v0.4）
// ---------------------------------------------------------------------------

/** 出力の (x, y) ごとに map(x, y) → [元の x, 元の y] で画素を取ってくる（双線形補間。はみ出しは黒） */
function warpImage(img, map) {
  const { width: W, height: H, data } = img;
  const out = new Uint8ClampedArray(W * H * 4);
  const p = [0, 0];
  for (let y = 0, o = 0; y < H; y++) {
    for (let x = 0; x < W; x++, o += 4) {
      map(x, y, p);
      const sx = p[0];
      const sy = p[1];
      out[o + 3] = 255;
      if (sx < 0 || sy < 0 || sx > W - 1 || sy > H - 1) continue;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 + 1 < W ? x0 + 1 : x0;
      const y1 = y0 + 1 < H ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const a = (y0 * W + x0) * 4;
      const b = (y0 * W + x1) * 4;
      const c = (y1 * W + x0) * 4;
      const d = (y1 * W + x1) * 4;
      for (let k = 0; k < 3; k++) {
        const top = data[a + k] + (data[b + k] - data[a + k]) * fx;
        const bot = data[c + k] + (data[d + k] - data[c + k]) * fx;
        out[o + k] = top + (bot - top) * fy;
      }
    }
  }
  return { width: W, height: H, data: out };
}

/** 表面の画素が多い行の重心（y0〜y1 の行、x0〜x1 の列で数える） */
function faceCentroidY(A, x0, x1, y0, y1) {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = x0, i = y * A.W + x0; x < x1; x++, i++) c += A.face[i];
    sum += c * y;
    n += c;
  }
  return n ? sum / n : null;
}

/** y0〜y1 の行で、表面が続く横の範囲 [左, 右] */
function faceExtentX(A, y0, y1, tol) {
  const { W, face } = A;
  const col = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = y0, i = y0 * W + x; y < y1; y++, i += W) n += face[i];
    col[x] = n / Math.max(1, y1 - y0);
  }
  return longestRun(col, 0.5, tol);
}

/**
 * 写真の傾きと遠近（上が狭い台形）を直した画像を返す。
 *   1) 牌の並びの左端と右端で、表面の高さの中心がずれていれば回す
 *   2) 牌の帯の上の方と下の方で横幅が違えば、行ごとに横に伸ばして長方形に戻す
 * どちらも小さいずれ（0.4° 未満・幅の差 1% 未満）は直さない。直せなかったときは元の画像を返す。
 * @returns {{ image: ImageData, angle: number, keystone: number }} angle は度、keystone は上の幅/下の幅 − 1
 */
export function rectifyImage(source, opts = {}) {
  let img = toImageData(source);
  let angle = 0;
  let keystone = 0;
  try {
    let A = analyzeImage(img, opts.thresholds);
    let lay = locateHand(A, { aspect: opts.aspect || 0.8, thresholds: opts.thresholds, allowedCounts: null });
    let [y0, y1] = lay.band;
    let bh = y1 - y0;
    const [ex0, ex1] = lay.extent;
    const span = ex1 - ex0;
    // 1) 傾き: 左端と右端の 2 割ずつで、表面の高さの中心を比べる
    const q = Math.max(1, Math.round(span * 0.2));
    const ys0 = Math.max(0, Math.round(y0 - bh * 0.6));
    const ys1 = Math.min(A.H, Math.round(y1 + bh * 0.6));
    const yl = faceCentroidY(A, ex0, ex0 + q, ys0, ys1);
    const yr = faceCentroidY(A, ex1 - q, ex1, ys0, ys1);
    if (yl != null && yr != null) {
      const rad = Math.atan2(yr - yl, span - q);
      if (Math.abs(rad) > (0.4 * Math.PI) / 180 && Math.abs(rad) < (15 * Math.PI) / 180) {
        const cx = (img.width - 1) / 2;
        const cy = (img.height - 1) / 2;
        const cs = Math.cos(rad);
        const sn = Math.sin(rad);
        img = warpImage(img, (x, y, p) => {
          const dx = x - cx;
          const dy = y - cy;
          p[0] = cx + dx * cs - dy * sn;
          p[1] = cy + dx * sn + dy * cs;
        });
        angle = (rad * 180) / Math.PI;
        A = analyzeImage(img, opts.thresholds);
        lay = locateHand(A, { aspect: opts.aspect || 0.8, thresholds: opts.thresholds, allowedCounts: null });
        [y0, y1] = lay.band;
        bh = y1 - y0;
      }
    }
    // 2) 遠近: 帯の上 15〜35% と下 15〜35% の行で、牌の並びの左右の端を測る
    const tol = Math.round(bh * 0.8);
    const yt = y0 + bh * 0.25;
    const yb = y1 - bh * 0.25;
    const top = faceExtentX(A, Math.round(y0 + bh * 0.15), Math.round(y0 + bh * 0.35), tol);
    const bot = faceExtentX(A, Math.round(y1 - bh * 0.35), Math.round(y1 - bh * 0.15), tol);
    if (top && bot) {
      const wt = top[1] - top[0];
      const wb = bot[1] - bot[0];
      const k = wt / wb - 1;
      if (Math.abs(k) > 0.01 && Math.abs(k) < 0.25) {
        // 行 y の左右の端（上下の測った所から直線で延ばす）を、下と上の平均の幅に合わせる
        const L0 = (top[0] + bot[0]) / 2;
        const W0 = (wt + wb) / 2;
        img = warpImage(img, (x, y, p) => {
          const f = (y - yt) / (yb - yt);
          const l = top[0] + (bot[0] - top[0]) * f;
          const w = wt + (wb - wt) * f;
          p[0] = l + ((x - L0) * w) / W0;
          p[1] = y;
        });
        keystone = k;
      }
    }
  } catch (e) {
    // 牌が見つからなければ、そのまま返す（読むときに改めてエラーになる）
  }
  return { image: img, angle, keystone };
}

// ---------------------------------------------------------------------------
// 特徴の抽出
// ---------------------------------------------------------------------------

/**
 * 牌 1 枚の表面の範囲と、表面の色・明るさの基準を測る（特徴の抽出と規則の判定で共通）。
 */
function measureFace(A, box, inset) {
  const { W, H, face } = A;
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
  const { lum, data } = A;
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
  // 表面の色 = 明るい方 40% の画素の、色ごとの中央値。照明の色かぶりはここで打ち消される。
  // （平均や「一番明るい画素」だと、JPEG で表面ににじんだ緑や赤に引っぱられる）
  let lumCut = 255;
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= fw * fh * 0.4) {
      lumCut = v;
      break;
    }
  }
  const hr = new Uint32Array(256);
  const hg = new Uint32Array(256);
  const hb = new Uint32Array(256);
  let nFace = 0;
  for (let yy = 0; yy < fh; yy++) {
    for (let xx = 0, i = (fy + yy) * W + fx; xx < fw; xx++, i++) {
      if (lum[i] < lumCut) continue;
      hr[data[i * 4]]++;
      hg[data[i * 4 + 1]]++;
      hb[data[i * 4 + 2]]++;
      nFace++;
    }
  }
  const median = (h) => {
    let a = 0;
    for (let v = 0; v < 256; v++) if ((a += h[v]) * 2 >= nFace) return v;
    return 255;
  };
  const fr = median(hr);
  const fg = median(hg);
  const fb = median(hb);
  const unit = Math.max(30, faceLum * 0.55);
  return { fx, fy, fw, fh, fr, fg, fb, unit };
}

/**
 * 1 枚の牌（box の範囲）から特徴ベクトルを作る。
 * 返り値は 格子数×4（暗さ・赤み・緑み・青み）の Float32Array。
 */
export function extractFeatures(image, box, opts = {}) {
  const A = analyzeImage(image, opts.thresholds);
  const [GX, GY] = opts.grid || [16, 20];
  const { W, data } = A;
  const { fx, fy, fw, fh, fr, fg, fb, unit } = measureFace(A, box, opts.inset ?? 0.06);

  // 各画素で「表面の色からどれだけ光が減ったか」(dr, dg, db) を出し、4 成分に分ける。
  //   暗さ = 3 色の平均の減り
  //   赤み = 緑と青は減ったのに赤は減っていない分（赤インクはここが大きい。黒インクは 0）
  //   緑み・青み も同様
  // どれもしきい値なしの足し算なので、ぼかし・縮小・JPEG（色を 2×2 画素でならす）で
  // 赤い線の色が薄く広がっても、マスの合計はほとんど変わらない。
  // ＝ 赤が黒に化けない。
  const cells = GX * GY;
  const counts = new Float32Array(cells * N_INK);
  const totals = new Float32Array(cells);
  // ドット判定モード用: マスごとの「赤・緑・青のドット」の数
  const dotMode = opts.mode === 'dots';
  const dots = dotMode ? new Uint16Array(cells * 3) : null;
  const dotCut = (opts.dotLevel ?? 0.2) * unit;
  for (let yy = 0; yy < fh; yy++) {
    const gy = Math.min(GY - 1, Math.floor((yy * GY) / fh));
    const row = (fy + yy) * W + fx;
    for (let xx = 0; xx < fw; xx++) {
      const cell = gy * GX + Math.min(GX - 1, Math.floor((xx * GX) / fw));
      totals[cell]++;
      const p = (row + xx) * 4;
      const dr = fr - data[p];
      const dg = fg - data[p + 1];
      const db = fb - data[p + 2];
      const o = cell * N_INK;
      const red = (dg + db) / 2 - dr;
      const green = (dr + db) / 2 - dg;
      const blue = (dr + dg) / 2 - db;
      counts[o] += (dr + dg + db) / 3;
      counts[o + 1] += red;
      counts[o + 2] += green;
      counts[o + 3] += blue;
      if (dotMode) {
        if (red > dotCut) dots[cell * 3]++;
        if (green > dotCut) dots[cell * 3 + 1]++;
        if (blue > dotCut) dots[cell * 3 + 2]++;
      }
    }
  }
  for (let c = 0; c < cells; c++) {
    const t = (totals[c] || 1) * unit;
    for (let k = 0; k < N_INK; k++) counts[c * N_INK + k] /= t;
  }

  // ドット判定モード: 色のドットが minDots 個以上あるマスはその色（色を優先するハンデ）、
  // なければ白黒で判定する。マスごとに「赤・緑・(青)・黒の濃さ」のどれか 1 つになる。
  // 白黒は既定では濃さを残す（bwBinary: true で 黒/白 の 2 択。細い線の情報が減り精度は下がる）
  if (dotMode) {
    const colors = opts.dotColors ?? 'rg';
    const use = [colors.includes('r'), colors.includes('g'), colors.includes('b')];
    const minDots = opts.minDots ?? 1;
    const bwLevel = opts.bwLevel ?? 0.2;
    for (let c = 0; c < cells; c++) {
      const o = c * N_INK;
      let best = -1;
      let bestN = minDots - 1;
      for (let k = 0; k < 3; k++) {
        if (use[k] && dots[c * 3 + k] > bestN) {
          best = k;
          bestN = dots[c * 3 + k];
        }
      }
      const darkness = counts[o];
      counts[o] = counts[o + 1] = counts[o + 2] = counts[o + 3] = 0;
      if (best >= 0) counts[o + 1 + best] = 1;
      else if (opts.bwBinary) counts[o] = darkness > bwLevel ? 1 : 0;
      else counts[o] = darkness > 0 ? darkness : 0;
    }
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

/** 特徴どうしの差（L1）。weights で成分ごとの重み（暗さ・赤み・緑み・青み）を付けられる */
function distance(a, b, w = [1, 1, 1, 1]) {
  let d = 0;
  for (let i = 0; i < a.length; i += 4) {
    d += w[0] * Math.abs(a[i] - b[i]) + w[1] * Math.abs(a[i + 1] - b[i + 1]);
    d += w[2] * Math.abs(a[i + 2] - b[i + 2]) + w[3] * Math.abs(a[i + 3] - b[i + 3]);
  }
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

// ---------------------------------------------------------------------------
// 規則で読む（基準の登録なしで、牌の「決まりごと」から判定する）
// ---------------------------------------------------------------------------
//
// 対象: 筒子・索子（二〜九、一筒）、一〜三萬、白。
// それ以外（四〜九萬・東南西北・發・中・一索）は規則では決めず、見比べに任せる。
//
// 筒子・索子の判定
//   1. インクのある画素をつなげて「粒」にする（丸の中の白い輪、棒の節の白線はつないでから数える）
//   2. 粒の形で種類を決める: 丸くて詰まっていれば筒子、縦に細長ければ索子
//   3. 粒の数を数え、並び方が標準の配置と合うか確かめる（位置は粒全体の広がりを 0〜1 にして比べる）
//   4. 赤い粒の位置が決まりと合うか確かめる（五の中央、六・七筒の下 4 つ、七索の頂上 など）
//   5. 余白を確かめる（四・八は縦横の中央が空く、二は横の中央が空いて縦は塞がる など）
// どれか 1 つでも合わなければ「規則では決められない」とする。

// 粒の並び（粒全体の広がりを 0〜1 にしたときの中心の位置）
const RULE_LAYOUT = {
  p: {
    2: [[0.5, 0], [0.5, 1]],
    3: [[0, 0], [0.5, 0.5], [1, 1]],
    4: [[0, 0], [1, 0], [0, 1], [1, 1]],
    5: [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]],
    6: [[0, 0], [1, 0], [0, 0.6], [1, 0.6], [0, 1], [1, 1]],
    7: [[0, 0], [0.5, 0.15], [1, 0.3], [0.17, 0.7], [0.83, 0.7], [0.17, 1], [0.83, 1]],
    8: [[0, 0], [1, 0], [0, 1 / 3], [1, 1 / 3], [0, 2 / 3], [1, 2 / 3], [0, 1], [1, 1]],
    9: [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]],
  },
  s: {
    2: [[0.5, 0], [0.5, 1]],
    3: [[0.5, 0], [0, 1], [1, 1]],
    4: [[0, 0], [1, 0], [0, 1], [1, 1]],
    5: [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]],
    6: [[0, 0], [0.5, 0], [1, 0], [0, 1], [0.5, 1], [1, 1]],
    7: [[0.5, 0], [0, 0.55], [0.5, 0.55], [1, 0.55], [0, 1], [0.5, 1], [1, 1]],
    8: [[0, 0], [1 / 3, 0], [2 / 3, 0], [1, 0], [0, 1], [1 / 3, 1], [2 / 3, 1], [1, 1]],
    9: [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]],
  },
};

// 赤い粒になる位置（上の並びの番号）。書いていない牌は赤い粒がない
const RULE_RED = {
  '3p': [1],
  '5p': [4],
  '6p': [2, 3, 4, 5],
  '7p': [3, 4, 5, 6],
  '9p': [3, 4, 5],
  '5s': [4],
  '7s': [0],
  '9s': [1, 4, 7],
};

// 余白の決まり（v: 縦の中央線, vt/vb: その上半分/下半分, h: 横の中央線。true = 空いている）
const RULE_SPACE = {
  '2p': { v: false, h: true },
  '3p': { v: false, h: false },
  '4p': { v: true, h: true },
  '5p': { v: false, h: false },
  '6p': { v: true },
  '7p': { vt: false, vb: true },
  '8p': { v: true, h: true },
  '9p': { v: false, h: false },
  '2s': { v: false, h: true },
  '3s': { vt: false, vb: true, h: true },
  '4s': { v: true, h: true },
  '5s': { v: false, h: false },
  '6s': { v: false, h: true },
  '7s': { v: false, h: false },
  '8s': { h: true },
  '9s': { v: false, h: false },
};

/** 表面のインクを画素ごとに測る（暗さと赤み・緑み・青み。v0.2 の特徴と同じ測り方） */
function inkMap(A, g, level = 0.3) {
  const { W, data } = A;
  const { fx, fy, fw, fh, fr, fg, fb, unit } = g;
  const n = fw * fh;
  const D = new Float32Array(n);
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const ink = new Uint8Array(n);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const p = ((fy + y) * W + fx + x) * 4;
      const dr = fr - data[p];
      const dg = fg - data[p + 1];
      const db = fb - data[p + 2];
      const i = y * fw + x;
      D[i] = (dr + dg + db) / 3 / unit;
      R[i] = ((dg + db) / 2 - dr) / unit;
      G[i] = ((dr + db) / 2 - dg) / unit;
      B[i] = ((dr + dg) / 2 - db) / unit;
      ink[i] = D[i] > level || R[i] > level || G[i] > level || B[i] > level ? 1 : 0;
    }
  }
  return { D, R, G, B, ink, fw, fh };
}

/** 粒の形の数値を計算する */
function shapeOf(b, fw, fh) {
  b.w = b.x1 - b.x0 + 1;
  b.h = b.y1 - b.y0 + 1;
  b.cx = (b.x0 + b.x1) / 2 / fw;
  b.cy = (b.y0 + b.y1) / 2 / fh;
  b.fill = b.area / (b.w * b.h);
  b.aspect = b.h / b.w;
  const c = Math.max(b.r, b.g, b.bl);
  b.color = c < b.d * 0.25 ? 'k' : c === b.r ? 'r' : c === b.g ? 'g' : 'b';
  b.shape = b.aspect >= 0.7 && b.aspect <= 1.45 && b.fill >= 0.55 ? 'circle' : b.aspect >= 1.7 && b.fill >= 0.45 ? 'stick' : 'other';
  return b;
}

function mergeInto(a, b) {
  for (const key of ['area', 'sx', 'sy', 'r', 'g', 'bl', 'd']) a[key] += b[key];
  a.x0 = Math.min(a.x0, b.x0);
  a.x1 = Math.max(a.x1, b.x1);
  a.y0 = Math.min(a.y0, b.y0);
  a.y1 = Math.max(a.y1, b.y1);
}

/**
 * インクの粒を取り出す。
 *   - 内側に入れ子の粒（丸の中の点）は外側の粒に合わせる
 *   - 上下に並んだ「ずんぐりした切れ端」2 つが、合わせると細長い棒になるなら 1 本の棒にする
 *     （白い節で上下に切れた棒。最初から細長い棒どうしは、別の段の棒なので合わせない）
 */
function findBlobs(m) {
  const { ink, fw, fh, R, G, B, D } = m;
  const label = new Int32Array(fw * fh).fill(-1);
  const stack = new Int32Array(fw * fh);
  const blobs = [];
  for (let start = 0; start < fw * fh; start++) {
    if (!ink[start] || label[start] >= 0) continue;
    const b = { x0: fw, y0: fh, x1: -1, y1: -1, area: 0, sx: 0, sy: 0, r: 0, g: 0, bl: 0, d: 0 };
    const id = blobs.length;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    while (sp) {
      const i = stack[--sp];
      const x = i % fw;
      const y = (i - x) / fw;
      b.area++;
      b.sx += x;
      b.sy += y;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      if (R[i] > 0) b.r += R[i];
      if (G[i] > 0) b.g += G[i];
      if (B[i] > 0) b.bl += B[i];
      if (D[i] > 0) b.d += D[i];
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= fh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= fw) continue;
          const j = ny * fw + nx;
          if (ink[j] && label[j] < 0) {
            label[j] = id;
            stack[sp++] = j;
          }
        }
      }
    }
    blobs.push(b);
  }
  const minArea = Math.max(4, fw * fh * 0.003);
  // 表面のふちに触れる細い塊は、牌のすき間の影・隣の牌・表面のふちの段差（v0.5）。
  // 牌の図柄は表面のふちから離して描かれているので、ふちに触れて、ふちと直角の向きに短いものは捨てる
  const atEdge = (b) =>
    (b.x0 <= 1 && b.x1 < fw * 0.15) ||
    (b.x1 >= fw - 2 && b.x0 > fw * 0.85) ||
    (b.y0 <= 1 && b.y1 < fh * 0.12) ||
    (b.y1 >= fh - 2 && b.y0 > fh * 0.88);
  // 捨てた塊の画素はインクの地図からも消す（一〜三萬の横線の数え方などが、消した影を拾わないように）
  const drop = new Uint8Array(blobs.length);
  blobs.forEach((b, id) => {
    if (b.area < minArea || atEdge(b)) drop[id] = 1;
  });
  for (let i = 0; i < fw * fh; i++) {
    if (label[i] >= 0 && drop[label[i]]) {
      ink[i] = 0;
      D[i] = 0;
      R[i] = 0;
      G[i] = 0;
      B[i] = 0;
    }
  }
  const list = blobs.filter((b, id) => !drop[id]).sort((a, b) => b.area - a.area);

  // 入れ子の粒は外側に合わせる
  let merged = [];
  for (const b of list) {
    const host = merged.find((a) => b.x0 >= a.x0 - 1 && b.x1 <= a.x1 + 1 && b.y0 >= a.y0 - 1 && b.y1 <= a.y1 + 1);
    if (host) mergeInto(host, b);
    else merged.push({ ...b });
  }
  merged.forEach((b) => shapeOf(b, fw, fh));

  // 節で切れた棒をつなぐ
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < merged.length && !changed; i++) {
      for (let j = 0; j < merged.length && !changed; j++) {
        const a = merged[i];
        const b = merged[j];
        if (i === j || b.y0 <= a.y1) continue; // a が上、b が下
        const gap = b.y0 - a.y1 - 1;
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
        if (gap > fh * 0.05 || overlap < Math.min(a.w, b.w) * 0.7) continue;
        if (Math.max(a.w, b.w) > Math.min(a.w, b.w) * 1.4) continue;
        if (a.shape === 'stick' || b.shape === 'stick') continue;
        if (a.aspect < 1.2 || b.aspect < 1.2) continue; // 丸（縦横同じ）はつながない。棒の切れ端は縦長
        // 切れ目がまっすぐか（棒の節で切れた切れ端は、切れ目の行がほぼ全幅インク。丸の下端・上端は細い）
        const cutFill = (y, o) => {
          let n = 0;
          for (let x = o.x0; x <= o.x1; x++) n += ink[y * fw + x];
          return n / o.w;
        };
        if (cutFill(a.y1, a) < 0.6 || cutFill(b.y0, b) < 0.6) continue;
        const h = b.y1 - a.y0 + 1;
        const w = Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0) + 1;
        if (h / w < 1.7) continue;
        mergeInto(a, b);
        shapeOf(a, fw, fh);
        merged = merged.filter((x) => x !== b);
        changed = true;
      }
    }
  }
  return merged;
}

/**
 * 余白: 図柄の中心線に「白線が引けるか」。
 * 中心は表面の中心ではなく、粒全体の広がりの中心（切り出しの左右のずれに影響されない）。
 * 縦は中心線 ±2%、横は ±5% の範囲に、ほぼインクのない列・行が 1 本でもあれば「引ける」。
 */
function centerSpace(m, blobs) {
  const { ink, fw, fh } = m;
  const cx = Math.round((Math.min(...blobs.map((b) => b.x0)) + Math.max(...blobs.map((b) => b.x1))) / 2);
  const cy = Math.round((Math.min(...blobs.map((b) => b.y0)) + Math.max(...blobs.map((b) => b.y1))) / 2);
  const dx = Math.max(1, Math.round(fw * 0.02));
  const dy = Math.max(1, Math.round(fh * 0.05));
  const colEmpty = (x, y0, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y++) n += ink[y * fw + x];
    return n <= (y1 - y0) * 0.03;
  };
  const rowEmpty = (y) => {
    let n = 0;
    for (let x = 0; x < fw; x++) n += ink[y * fw + x];
    return n <= fw * 0.03;
  };
  const anyCol = (y0, y1) => {
    for (let x = Math.max(0, cx - dx); x <= Math.min(fw - 1, cx + dx); x++) if (colEmpty(x, y0, y1)) return true;
    return false;
  };
  let h = false;
  for (let y = Math.max(0, cy - dy); y <= Math.min(fh - 1, cy + dy); y++) if (rowEmpty(y)) h = true;
  return { v: anyCol(0, fh), vt: anyCol(0, cy), vb: anyCol(cy, fh), h };
}

/** 粒の並びを標準の配置に当てはめる（近いもの同士から順に組にする）。合えば各粒が何番目かを返す */
function matchLayout(blobs, layout, tol = 0.2) {
  const xs = blobs.map((b) => b.cx);
  const ys = blobs.map((b) => b.cy);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const sx = Math.max(...xs) - x0;
  const sy = Math.max(...ys) - y0;
  const pts = blobs.map((b) => [sx < 0.08 ? 0.5 : (b.cx - x0) / sx, sy < 0.08 ? 0.5 : (b.cy - y0) / sy]);
  const pairs = [];
  pts.forEach((p, i) => layout.forEach((q, j) => pairs.push([Math.hypot(p[0] - q[0], p[1] - q[1]), i, j])));
  pairs.sort((a, b) => a[0] - b[0]);
  const slotOf = new Array(pts.length).fill(-1);
  const used = new Set();
  let worst = 0;
  for (const [d, i, j] of pairs) {
    if (slotOf[i] >= 0 || used.has(j)) continue;
    slotOf[i] = j;
    used.add(j);
    worst = Math.max(worst, d);
  }
  return worst <= tol ? slotOf : null;
}

/**
 * 萬子の数字（表面の上 47%）の形を測る（v0.5）。
 *   comps: 黒い画の塊（小さすぎるものは除く）、holes: 画に囲まれた白、
 *   corners: 数字の外枠の四隅の三角形（角から 35%）の墨の割合、
 *   leftCol / rightCol: 外枠の左端・右端 15% の列で、縦に墨が通る割合、topBar: 上 20% の行でいちばん長い横の墨の長さ
 * 位置・大きさは数字の外枠を 0〜1 にした値。
 */
function numeralStats(m) {
  const { D, R, G, B, fw, fh } = m;
  const half = Math.floor(fh * 0.47);
  const dark = new Uint8Array(fw * half);
  let tintSum = 0;
  let darkSum = 0;
  for (let i = 0; i < fw * half; i++) {
    dark[i] = D[i] > 0.3 && Math.max(R[i], G[i], B[i]) < D[i] * 0.5 ? 1 : 0;
    if (dark[i]) {
      tintSum += Math.max(R[i], G[i], B[i], 0);
      darkSum += D[i];
    }
  }
  // 塊
  const label = new Int32Array(fw * half).fill(-1);
  const stack = new Int32Array(fw * half);
  let comps = [];
  for (let s0 = 0; s0 < fw * half; s0++) {
    if (!dark[s0] || label[s0] >= 0) continue;
    const c = { x0: fw, x1: -1, y0: half, y1: -1, area: 0 };
    let sp = 0;
    stack[sp++] = s0;
    label[s0] = comps.length;
    while (sp) {
      const i = stack[--sp];
      const x = i % fw;
      const y = (i - x) / fw;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= fw || ny >= half) continue;
          const j = ny * fw + nx;
          if (dark[j] && label[j] < 0) {
            label[j] = comps.length;
            stack[sp++] = j;
          }
        }
    }
    comps.push(c);
  }
  const total = comps.reduce((a, c) => a + c.area, 0);
  if (!total) return null;
  comps = comps.filter((c) => c.area >= total * 0.04);
  if (!comps.length) return null;
  const gx0 = Math.min(...comps.map((c) => c.x0));
  const gx1 = Math.max(...comps.map((c) => c.x1));
  const gy0 = Math.min(...comps.map((c) => c.y0));
  const gy1 = Math.max(...comps.map((c) => c.y1));
  const gw = gx1 - gx0 + 1;
  const gh = gy1 - gy0 + 1;
  // 囲まれた白
  const seen = new Uint8Array(gw * gh);
  const holes = [];
  for (let s0 = 0; s0 < gw * gh; s0++) {
    const sx = s0 % gw;
    const sy = (s0 - sx) / gw;
    if (seen[s0] || dark[(gy0 + sy) * fw + gx0 + sx]) continue;
    let sp = 0;
    let area = 0;
    let mx = 0;
    let my = 0;
    let edge = false;
    stack[sp++] = s0;
    seen[s0] = 1;
    while (sp) {
      const i = stack[--sp];
      const x = i % gw;
      const y = (i - x) / gw;
      area++;
      mx += x;
      my += y;
      if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) edge = true;
      for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ddx;
        const ny = y + ddy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const j = ny * gw + nx;
        if (!seen[j] && !dark[(gy0 + ny) * fw + gx0 + nx]) {
          seen[j] = 1;
          stack[sp++] = j;
        }
      }
    }
    if (!edge && area >= gw * gh * 0.01) holes.push({ x: mx / area / gw, y: my / area / gh, a: area / (gw * gh) });
  }
  const tri = (f) => {
    let n = 0;
    let t = 0;
    for (let y = gy0; y <= gy1; y++)
      for (let x = gx0; x <= gx1; x++) {
        if (!f((x - gx0) / gw, (y - gy0) / gh)) continue;
        t++;
        n += dark[y * fw + x];
      }
    return t ? n / t : 0;
  };
  const corners = {
    tl: tri((u, v) => u + v < 0.35),
    tr: tri((u, v) => 1 - u + v < 0.35),
    bl: tri((u, v) => u + 1 - v < 0.35),
    br: tri((u, v) => 2 - u - v < 0.35),
  };
  const colRun = (from, to) => {
    let best = 0;
    for (let x = Math.round(gx0 + gw * from); x <= Math.round(gx0 + gw * to); x++) {
      let n = 0;
      for (let y = gy0; y <= gy1; y++) n += dark[y * fw + x];
      best = Math.max(best, n / gh);
    }
    return best;
  };
  let topBar = 0;
  for (let y = gy0; y <= gy0 + Math.floor(gh * 0.2); y++) {
    let n = 0;
    for (let x = gx0; x <= gx1; x++) n += dark[y * fw + x];
    topBar = Math.max(topBar, n / gw);
  }
  const list = comps
    .map((c) => ({ x0: (c.x0 - gx0) / gw, x1: (c.x1 - gx0) / gw, y0: (c.y0 - gy0) / gh, y1: (c.y1 - gy0) / gh, a: c.area / total }))
    .sort((a, b) => b.a - a.a);
  // 上の中央（横 40〜60%・縦 0〜45%）の墨の割合。八は 2 本の画の頭の間が空く
  let mt = 0;
  let mtn = 0;
  for (let y = gy0; y <= gy0 + Math.floor(gh * 0.45); y++)
    for (let x = Math.round(gx0 + gw * 0.4); x <= Math.round(gx0 + gw * 0.6); x++) {
      mt += dark[y * fw + x];
      mtn++;
    }
  // 中ほど（縦 20〜60%）でいちばん長い横の墨。七は横棒が字の幅いっぱいに通る
  let midRow = 0;
  for (let y = gy0 + Math.floor(gh * 0.2); y <= gy0 + Math.floor(gh * 0.6); y++) {
    let n = 0;
    for (let x = gx0; x <= gx1; x++) n += dark[y * fw + x];
    midRow = Math.max(midRow, n / gw);
  }
  // 上の点（六）: 上 35% に収まる、幅の狭い小さな塊
  const dot = list.some((k) => k.y1 <= 0.38 && k.x1 - k.x0 <= 0.35 && k.a <= 0.2 && Math.abs((k.x0 + k.x1) / 2 - 0.5) <= 0.2);
  return { comps: list, holes, corners, leftCol: colRun(0, 0.15), rightCol: colRun(0.85, 1), topBar, midTop: mtn ? mt / mtn : 0, midRow, dot, tint: darkSum ? tintSum / darkSum : 0, aspect: gh / gw, gw: gw / fw, gh: gh / fh };
}

/**
 * 一〜九萬を数字の形で読む（v0.5。横線の本数で決まらなかったとき）。
 *   四: 囲まれた白があり、外枠の左右の端に縦の墨が通り、上に横棒
 *   五: 囲まれた白が 1 つ、上に横棒、左端は縦に通らない
 *   六: 囲まれた白がなく、2〜3 つの塊（点・横棒・脚）に分かれ、上の中央に墨（点と横棒）、脚が左下・右下に届く
 *   七: 囲まれた白がなく 1 つの塊、左下が空く（縦画が右へ曲がる）、右下に墨
 *   八: 囲まれた白がなく 1 つの塊、右上が空き、左下に墨、中ほどを横に通る墨が短い（2 本の画が離れて下りる）
 *   九: 囲まれた白がなく 1 つの塊、右上がまったく空き、左下に墨（ノの払い）、中ほどを横に通る墨が長い（乙の横画）
 * 七筒（上に 3 つ・下に赤い丸 4 つ）を七萬と取り違えないよう、丸い粒が 3 つ以上ある牌には使わない。
 *   一〜三（横線の本数で決まらなかったもの）: 横に長い薄い塊が 1〜3 個、上下に並ぶ
 * 決め手がそろわなければ null。
 */
function readManzuShape(m, blobs) {
  if (blobs.filter((b) => b.shape === 'circle').length >= 3) return null;
  const st = numeralStats(m);
  // 数字は黒い墨（色み 0.15 未満）。暗い緑の丸がぼやけて黒っぽく見える七筒などは色みが残る（0.2 以上）
  if (!st || st.tint > 0.15) return null;
  const { comps, holes, corners: c, leftCol, rightCol, topBar, midTop, midRow, aspect } = st;
  const info = { comps: comps.length, holes: holes.length, corners: c, leftCol, rightCol, topBar, midTop, midRow, aspect };
  const r2 = (v) => +v.toFixed(2);
  const why = (code, text) => ({ code, reason: text, info: JSON.parse(JSON.stringify(info, (k, v) => (typeof v === 'number' ? r2(v) : v))) });
  // 横線だけの数字（ぼやけて横線の数え方では決まらなかったもの）
  // 位置は数字の外枠に対する割合なので、塊が 1 つなら外枠の縦横比で見る
  const flat = comps.length === 1 ? aspect <= 0.35 : comps.every((k) => k.x1 - k.x0 >= 0.5 && k.y1 - k.y0 <= 0.4);
  if (!holes.length && flat) {
    if (comps.length === 1 && aspect <= 0.35) return why('1m', '数字が横に長い 1 本の線');
    const ys = comps.map((k) => (k.y0 + k.y1) / 2).sort((a, b) => a - b);
    const apart = ys.every((y, i) => i === 0 || y - ys[i - 1] >= 0.25);
    if (apart && comps.length === 2 && aspect >= 0.5) return why('2m', '横に長い線が 2 本、上下に離れて並ぶ');
    if (apart && comps.length === 3 && aspect >= 0.5) return why('3m', '横に長い線が 3 本、上下に離れて並ぶ');
    return null;
  }
  if (holes.length) {
    if (leftCol >= 0.8 && rightCol >= 0.75 && topBar >= 0.85) return why('4m', '囲まれた白があり、左右の端に縦の墨・上に横棒（四）');
    if (holes.length === 1 && topBar >= 0.75 && leftCol < 0.7) return why('5m', '囲まれた白が 1 つ・上に横棒・左端は縦に通らない（五）');
    return null;
  }
  if (aspect < 0.6) return null;
  if (comps.length >= 2) {
    if (midTop >= 0.45 && c.tr >= 0.06 && c.bl >= 0.25 && c.br >= 0.25) return why('6m', '2〜3 つの塊に分かれ、上の中央に点と横棒、脚が左下・右下に届く（六）');
    return null;
  }
  if (c.bl < 0.15 && c.br >= 0.3) return why('7m', '1 つの塊で、左下が空き右下に墨（七）');
  if (c.bl >= 0.25 && c.tr <= 0.05 && midRow <= 0.55) return why('8m', '右上が空き、中ほどを横に通る墨が短い（2 本の画が離れて下りる。八）');
  if (c.bl >= 0.25 && c.tr <= 0.03 && midRow >= 0.67) return why('9m', '右上がまったく空き、中ほどを横棒が通り、左下にノの払い（九）');
  return null;
}

/** 一〜三萬: 上半分が「横線だけ」でできていれば、その本数で決める */
function readManzuStrokes(m) {
  const { D, R, G, B, fw, fh } = m;
  const half = Math.floor(fh * 0.47);
  let dt = 0;
  let ct = 0;
  let db = 0;
  let rb = 0;
  let gbb = 0;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const i = y * fw + x;
      if (!m.ink[i]) continue; // 表面そのもののわずかな色・ノイズは数えない
      const d = D[i] > 0 ? D[i] : 0;
      if (y < half) {
        dt += d;
        ct += Math.max(R[i], G[i], B[i], 0);
      } else if (y > fh * 0.5) {
        db += d;
        if (R[i] > 0) rb += R[i];
        gbb += Math.max(G[i], B[i], 0);
      }
    }
  }
  const area = fw * half;
  const isManzu = dt > area * 0.01 && ct < dt * 0.3 && rb > db * 0.5 && rb > gbb * 2;
  if (!isManzu) return null;
  m.isManzu = true;

  // 上半分の黒い画素の行ごとの割合
  const rows = new Float32Array(half);
  const dark = (i) => D[i] > 0.3 && Math.max(R[i], G[i], B[i]) < D[i] * 0.5;
  let total = 0;
  for (let y = 0; y < half; y++) {
    let n = 0;
    for (let x = 0; x < fw; x++) n += dark(y * fw + x) ? 1 : 0;
    rows[y] = n / fw;
    total += n;
  }
  if (!total) return null;
  // 横線の行を見つけ、すぐ上下のインクのある行（筆の打ち込み・うろこ・にじみ）まで広げる
  const strokes = [];
  for (let [a, b] of runs(rows, 0.12)) {
    while (a > 0 && rows[a - 1] > 0.01) a--;
    while (b < half && rows[b] > 0.01) b++;
    const last = strokes[strokes.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else strokes.push([a, b]);
  }
  if (strokes.length < 1 || strokes.length > 3) return null;
  // 線の太さがそろっているか（2 本の線がぼやけて 1 本に見えると、その線だけ太くなる）
  const thick = strokes.map(([a, b]) => b - a);
  if (strokes.length === 1 ? thick[0] > fh * 0.09 : Math.max(...thick) > Math.min(...thick) * 1.8) return null;
  let inStrokes = 0;
  for (const [a, b] of strokes) {
    if (b - a > fh * 0.12) return null; // 太すぎる = 線がくっついているか、横線ではない
    let x0 = fw;
    let x1 = -1;
    for (let y = a; y < b; y++) {
      for (let x = 0; x < fw; x++) {
        if (!dark(y * fw + x)) continue;
        inStrokes++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
    if (x1 - x0 < fw * 0.2) return null; // 短すぎる = 横線ではない
  }
  if (inStrokes < total * 0.9) return null; // 横線以外の画（縦線・払い）がある
  // 薄いインク（ぼやけて消えかけた線）も、横線の行の外にあってはいけない
  let faintAll = 0;
  let faintIn = 0;
  const inRun = new Uint8Array(half);
  for (const [a, b] of strokes) for (let y = a; y < b; y++) inRun[y] = 1;
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < fw; x++) {
      const i = y * fw + x;
      if (D[i] > 0.12 && Math.max(R[i], G[i], B[i]) < D[i] * 0.5) {
        faintAll++;
        if (inRun[y]) faintIn++;
      }
    }
  }
  if (faintIn < faintAll * 0.85) return null;
  return `${strokes.length}m`;
}

/**
 * 字の形の統計（字牌用）: 3×3 の濃さ、中心の縦の白線、囲まれた白（穴）の位置。
 * 位置はどれも字の外枠を 0〜1 にした値。
 */
function glyphStats(m, blobs) {
  const { ink, fw } = m;
  const gx0 = Math.min(...blobs.map((b) => b.x0));
  const gx1 = Math.max(...blobs.map((b) => b.x1));
  const gy0 = Math.min(...blobs.map((b) => b.y0));
  const gy1 = Math.max(...blobs.map((b) => b.y1));
  const gw = gx1 - gx0 + 1;
  const gh = gy1 - gy0 + 1;

  const cells = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      let n = 0;
      let t = 0;
      for (let y = gy0 + Math.floor((r * gh) / 3); y < gy0 + Math.floor(((r + 1) * gh) / 3); y++)
        for (let x = gx0 + Math.floor((c * gw) / 3); x < gx0 + Math.floor(((c + 1) * gw) / 3); x++) {
          n += ink[y * fw + x];
          t++;
        }
      row.push(t ? n / t : 0);
    }
    cells.push(row);
  }

  const cx = Math.round((gx0 + gx1) / 2);
  const dx = Math.max(1, Math.round(gw * 0.08));
  let vLine = false;
  for (let x = cx - dx; x <= cx + dx; x++) {
    let n = 0;
    for (let y = gy0; y <= gy1; y++) n += ink[y * fw + x];
    if (n <= gh * 0.02) vLine = true;
  }

  // 囲まれた白: 字の外枠の中の白い領域のうち、外枠に触れないもの
  const seen = new Uint8Array(gw * gh);
  const stack = new Int32Array(gw * gh);
  const holes = [];
  for (let s = 0; s < gw * gh; s++) {
    const sx = s % gw;
    const sy = (s - sx) / gw;
    if (seen[s] || ink[(gy0 + sy) * fw + gx0 + sx]) continue;
    let sp = 0;
    let area = 0;
    let mx = 0;
    let my = 0;
    let edge = false;
    stack[sp++] = s;
    seen[s] = 1;
    while (sp) {
      const i = stack[--sp];
      const x = i % gw;
      const y = (i - x) / gw;
      area++;
      mx += x;
      my += y;
      if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) edge = true;
      for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ddx;
        const ny = y + ddy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const j = ny * gw + nx;
        if (!seen[j] && !ink[(gy0 + ny) * fw + gx0 + nx]) {
          seen[j] = 1;
          stack[sp++] = j;
        }
      }
    }
    if (!edge && area >= gw * gh * 0.006) holes.push({ x: mx / area / gw, y: my / area / gh });
  }
  // 斜めの特徴: 四隅の三角形（字の枠で角から 35% の斜め線より外側）のインクの割合
  const tri = (f) => {
    let n = 0;
    let t = 0;
    for (let y = gy0; y <= gy1; y++)
      for (let x = gx0; x <= gx1; x++) {
        if (!f((x - gx0) / gw, (y - gy0) / gh)) continue;
        t++;
        n += ink[y * fw + x];
      }
    return t ? n / t : 0;
  };
  const corners = {
    tl: tri((u, v) => u + v < 0.35),
    tr: tri((u, v) => 1 - u + v < 0.35),
    bl: tri((u, v) => u + 1 - v < 0.35),
    br: tri((u, v) => 2 - u - v < 0.35),
  };
  // 上端の平らさ: 字の上 15% の行のうち、いちばん横に長いインクの幅
  let topWidth = 0;
  for (let y = gy0; y <= gy0 + Math.floor(gh * 0.15); y++) {
    let a = -1;
    let b = -1;
    for (let x = gx0; x <= gx1; x++)
      if (ink[y * fw + x]) {
        if (a < 0) a = x;
        b = x;
      }
    if (a >= 0) topWidth = Math.max(topWidth, (b - a + 1) / gw);
  }
  // 中央のくぼみ: 中心の列のインクが、左右（中心から 10〜25%）の最も濃い列の 7 割未満
  const colFrac = (x) => {
    let n = 0;
    for (let y = gy0; y <= gy1; y++) n += ink[y * fw + x];
    return n / gh;
  };
  let center = 0;
  for (let x = cx - dx; x <= cx + dx; x++) center = Math.max(center, colFrac(x));
  const sideMax = (from, to) => {
    let v = 0;
    for (let x = Math.round(gx0 + gw * from); x <= Math.round(gx0 + gw * to); x++) v = Math.max(v, colFrac(x));
    return v;
  };
  const valley = center < 0.7 * Math.min(sideMax(0.25, 0.4), sideMax(0.6, 0.75));
  // 左右 2 つに分かれた字（北）: 大きい塊 2 つが、どちらも字の高さの 75% 以上あり、左右に並んで重ならない
  const big = blobs.filter((b) => b.area >= blobs[0].area * 0.3).sort((a, b) => a.x0 - b.x0);
  const halves =
    big.length === 2 &&
    big.every((b) => b.h >= gh * 0.75) &&
    Math.min(big[0].x1, big[1].x1) - Math.max(big[0].x0, big[1].x0) <= gw * 0.12 &&
    Math.abs((big[0].x1 + big[1].x0) / 2 - (gx0 + gx1) / 2) <= gw * 0.15;
  return { cells, vLine, holes, corners, topWidth, valley, halves };
}

/**
 * 字牌を「白の配置」で読む（遠目でも残る特徴を優先）。
 *   北: 中心に縦の白線が通り、字が左右に分かれる。下段の中央は黒い
 *   西: 下段の中央が白っぽく両端が黒い。近ければ上の中央に穴
 *   南: ど真ん中に穴（上の中央には穴がない）
 *   東: 穴が左右対に並ぶ（「日」を縦線が割る）。中央に穴がない
 *   中: 赤い字で、下段の両端が白く中央だけ黒い
 * 東と南は遠いと穴がつぶれるので、そのときは左下の角（斜めの欠け）で決める。
 *   東: 下の払いで左下の角が斜めに欠ける（菱形）  南: 箱が角まで届いて埋まる（四角）
 */
function readHonor(m, blobs) {
  if (!blobs.length) return null;
  let d = 0;
  let r = 0;
  let g = 0;
  let bl = 0;
  for (const b of blobs) {
    d += b.d;
    r += b.r;
    g += b.g;
    bl += b.bl;
  }
  // 黒ははっきり黒いときだけ（暗い緑・赤が JPEG で色を失ったものを黒と取り違えない）
  const black = r + g + bl < d * 0.15;
  const red = r > (g + bl) * 3 && r > d * 0.4;
  // 發: 緑だけの字（赤も青も混ざらない）。一索の鳥は赤い頭・青い尾があるので外れる
  const green = g > d * 0.3 && r < g * 0.1 && bl < g * 0.2;
  if (!black && !red && !green) return null;
  // 字は 1 文字で表面の中央にあり、高さは表面の半分ほど。
  // 棒や丸の並び（索子・筒子）は表面の上下いっぱいに広がるので、ここで外れる。萬子は上下 2 段なので外れる
  const gy0 = Math.min(...blobs.map((b) => b.y0)) / m.fh;
  const gy1 = Math.max(...blobs.map((b) => b.y1)) / m.fh;
  const gx0 = Math.min(...blobs.map((b) => b.x0)) / m.fw;
  const gx1 = Math.max(...blobs.map((b) => b.x1)) / m.fw;
  // 字は横にも広い（調べた字牌は表面の幅の 0.57〜0.69）。縦に並んだ棒 1 列（二索など）は細いので外れる
  if (gy0 < 0.08 || gy1 > 0.92 || gy1 - gy0 < 0.35 || gy1 - gy0 > 0.8 || gx1 - gx0 < 0.4 || gx1 - gx0 > 0.92) return null;
  // 色の付いた棒が 2 本以上なら索子（北の左右の縦長の画は黒いので数えない）
  if (blobs.filter((b) => b.shape === 'stick' && b.color !== 'k').length >= 2) return null;
  // 字には横の白線が通らない（調べた 72 通りすべてで 0）。索子・筒子は段の間に横の白線が通るので外れる
  {
    const y0 = Math.round(gy0 * m.fh + (gy1 - gy0) * m.fh * 0.1);
    const y1 = Math.round(gy1 * m.fh - (gy1 - gy0) * m.fh * 0.1);
    const x0 = Math.round(gx0 * m.fw);
    const x1 = Math.round(gx1 * m.fw);
    for (let y = y0; y <= y1; y++) {
      let n = 0;
      for (let x = x0; x <= x1; x++) n += m.ink[y * m.fw + x];
      if (n <= (x1 - x0 + 1) * 0.02) return null;
    }
  }

  const s = glyphStats(m, blobs);
  const [bL, bC, bR] = s.cells[2];
  const info = {
    holes: s.holes.map((h) => [+h.x.toFixed(2), +h.y.toFixed(2)]),
    bottom: s.cells[2].map((v) => +v.toFixed(2)),
    vLine: s.vLine,
    corners: Object.fromEntries(Object.entries(s.corners).map(([k, v]) => [k, +v.toFixed(2)])),
    topWidth: +s.topWidth.toFixed(2),
    valley: s.valley,
    halves: s.halves,
  };
  const flatTop = s.topWidth >= 0.85;
  // 「中央」は字の幅の ±7% 以内（東の穴は縦線の左右 0.33 / 0.62 付近にあるので入らない）
  const topHole = s.holes.some((h) => Math.abs(h.x - 0.5) < 0.07 && h.y < 0.35);
  const midHole = s.holes.some((h) => Math.abs(h.x - 0.5) < 0.07 && h.y >= 0.35 && h.y <= 0.65);
  // 東の穴: 中央の縦画のすぐ左右（中心から 0.08〜0.19）に、同じ高さで対になって並ぶ。南の外側の穴はもっと外（0.2 以上）
  const near = s.holes.filter((h) => Math.abs(h.x - 0.5) > 0.08 && Math.abs(h.x - 0.5) < 0.19);
  const pairs = near.filter((a) => a.x < 0.5 && near.some((b) => b.x > 0.5 && Math.abs(a.y - b.y) < 0.08)).length;

  if (green) {
    // 索子（縦長の棒が並ぶ）・筒子（丸）でないこと
    if (blobs.filter((b) => b.shape === 'stick').length >= 2 || blobs.some((b) => b.shape === 'circle' && b.w < m.fw * 0.4)) return null;
    return { code: '6z', reason: '緑だけの字が 1 文字', info: { blobs: blobs.length } };
  }
  if (red) {
    if (bL < 0.2 && bR < 0.2 && bC >= 0.35) return { code: '7z', reason: '赤い字で、下段の両端が白く中央だけ黒い', info };
    return null;
  }
  if (s.vLine && blobs.length >= 2 && bC >= 0.35) return { code: '4z', reason: '中心に縦の白線が通り、字が左右に分かれる', info };
  // v0.5: 白線が 1 画素しかなくても、左右 2 つの塊がどちらも字の高さいっぱいなら北（東・南・西は 1 つにつながる）
  if (s.halves) return { code: '4z', reason: '字の高さいっぱいの塊が左右 2 つに分かれている', info };

  // 北がぼやけて白線が消えても、中央は左右の縦画よりくぼむ。くぼみがあれば東・南の決め手は使わない
  if (s.valley) return { code: null, reason: '中央がくぼんでいる（ぼやけた北かもしれない）', info };
  if (pairs >= 1 && !midHole && !topHole && s.corners.bl < 0.45)
    return { code: '1z', reason: '縦画のすぐ左右に穴が対になって並ぶ', info };
  // v0.5: 東・南・西は上に横棒があり、右上の角まで墨が届く（0.25 以上）。北の右半分「匕」は上が細く、右上が空く
  if (s.corners.tr <= 0.2 && s.corners.tl <= 0.3 && !midHole && !topHole) return { code: '4z', reason: '右上の角が空いている（上に横棒がない）', info };
  if (s.corners.tr < 0.25) return { code: null, reason: '右上の角が薄い（北かもしれない）', info };
  if ((bC < 0.6 * Math.min(bL, bR) && Math.min(bL, bR) >= 0.35) || topHole) {
    const why = [topHole && '上の中央に穴', bC < 0.6 * Math.min(bL, bR) && '下段の中央が白い', flatTop && '上が平ら'].filter(Boolean);
    return { code: '3z', reason: why.join('・'), info };
  }
  if (midHole) return { code: '2z', reason: 'ど真ん中に穴がある', info };
  // 遠くて穴が見えないとき: 左下の角。東は斜めの払いで角が欠け（菱形）、南は箱が角まで届く（四角）
  if (!flatTop && !s.vLine) {
    if (s.corners.bl >= 0.52) return { code: '2z', reason: '左下の角まで埋まっている（四角い）', info };
    // 東: 左下が欠ける。ただし左上までほぼ空っぽなのは、白線がぼやけて消えた北（北の左上は 0.05 前後）
    if (s.corners.bl <= 0.3 && s.corners.tl >= 0.07) return { code: '1z', reason: '左下の角が斜めに欠けている（菱形）', info };
  }
  return { code: null, reason: '字牌（東か南か決めきれない）', info };
}

/**
 * 牌 1 枚を規則で読む。決められないときは code: null と理由を返す。
 * @returns {{ code: string|null, reason: string, detail?: object }}
 */
export const debug = {};
export function readTileByRules(image, box, opts = {}) {
  const A = analyzeImage(image, opts.thresholds);
  const g = measureFace(A, box, opts.inset ?? 0.06);
  const m = inkMap(A, g);
  // 先に塊を取り出す（ふちの影や小さな点はここでインクの地図から消える）
  const blobs = findBlobs(m);
  let inkCount = 0;
  for (let i = 0; i < m.ink.length; i++) inkCount += m.ink[i];
  if (!blobs.length || inkCount < m.ink.length * 0.01) return { code: '5z', reason: '表面に何も描かれていない' };

  const manzu = readManzuStrokes(m);
  if (manzu) return { code: manzu, reason: `上半分が横線${manzu[0]}本だけ` };
  if (opts.debug) debug.num = m.isManzu ? numeralStats(m) : null;
  if (m.isManzu) {
    const shape = readManzuShape(m, blobs);
    if (shape) return { code: shape.code, reason: shape.reason, detail: shape.info };
  }

  if (opts.debug) debug.last = { fw: m.fw, fh: m.fh, blobs: blobs.map((b) => ({ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, area: b.area, color: b.color, shape: b.shape })) };
  let suits = readSuitsByRules(m, blobs);
  if (suits.code) return suits;
  // v0.5: 丸や棒がぼやけてくっついたとき（九筒・八索など）は、濃いインクだけで数え直す。
  // 粒の中心は濃く、粒どうしのすき間はにじんで薄いので、しきい値を上げると離れる
  if (!m.isManzu && /言い切れない|混ざっている|並び方と合わない|数が合わない/.test(suits.reason)) {
    for (const level of [0.5, 0.7]) {
      const m2 = inkMap(A, g, level);
      const b2 = findBlobs(m2);
      if (b2.length < 2) break;
      const s2 = readSuitsByRules(m2, b2);
      if (s2.code && s2.code[1] !== 'z') return { ...s2, reason: `${s2.reason}（濃いインクだけで数え直し）` };
    }
  }
  // 筒子・索子で決まらなければ、字牌（白の配置）として読めるか試す
  const honor = readHonor(m, blobs);
  if (honor) return { code: honor.code, reason: honor.reason, detail: { blobs: blobs.length, ...honor.info } };
  return suits;
}

/** 筒子・索子・一筒を規則で読む（readTileByRules の一部） */
function readSuitsByRules(m, blobs) {
  const circles = blobs.filter((b) => b.shape === 'circle').length;
  const sticks = blobs.filter((b) => b.shape === 'stick').length;
  const detail = { blobs: blobs.length, circles, sticks };

  // 一筒: 大きな丸が 1 つで、複数の色（青・緑・赤など）が混ざっている。字牌の大きな 1 文字は単色なので除く
  if (blobs.length === 1 && circles === 1 && blobs[0].w > m.fw * 0.55) {
    const b = blobs[0];
    // 一筒は同心円の飾り: 中心と外周で色が違う。字牌（發・中など）は単色なので中心と外周が同じ色
    const ccx = (b.x0 + b.x1) / 2;
    const ccy = (b.y0 + b.y1) / 2;
    const rad = Math.min(b.w, b.h) / 2;
    const inner = [0, 0, 0];
    const outer = [0, 0, 0];
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const i = y * m.fw + x;
        if (!m.ink[i]) continue;
        const d = Math.hypot(x - ccx, y - ccy) / rad;
        const t = d < 0.3 ? inner : d > 0.65 && d <= 1 ? outer : null;
        if (!t) continue;
        t[0] += Math.max(0, m.R[i]);
        t[1] += Math.max(0, m.G[i]);
        t[2] += Math.max(0, m.B[i]);
      }
    }
    const hue = (t) => t.indexOf(Math.max(...t));
    if (b.color !== 'k' && Math.max(...inner) > 0 && hue(inner) !== hue(outer))
      return { code: '1p', reason: '大きな丸が 1 つ（中心と外周で色が違う）', detail };
    return { code: null, reason: '大きな塊が 1 つ（字牌かもしれない）', detail };
  }

  // 黒い粒が多いなら字（字牌や萬子の数字）なので、筒子・索子の規則は使わない
  if (blobs.filter((b) => b.color === 'k').length > blobs.length * 0.3) return { code: null, reason: '黒い字がある', detail };

  // v0.5 一索: 鳥の絵。黒い墨がなく、緑がいちばん大きい塊で、赤（頭）と青か緑の別の色が混ざる。
  // 棒が 2 本以上並んだり、丸が並んだりしない（棒は 1 本まで、丸の数は全体の半分未満）
  {
    const total = blobs.reduce((a, b) => a + b.area, 0);
    const top = blobs[0];
    const colors = new Set(blobs.filter((b) => b.area >= total * 0.03).map((b) => b.color));
    let r = 0;
    let gr = 0;
    let bl = 0;
    for (const b of blobs) {
      r += b.r;
      gr += b.g;
      bl += b.bl;
    }
    if (
      blobs.length <= 4 &&
      sticks <= 1 &&
      circles < blobs.length * 0.5 &&
      top.color === 'g' &&
      top.area >= total * 0.45 &&
      top.w >= m.fw * 0.3 &&
      r < gr &&
      // 頭の赤・尾の青は、別の塊でも、胴とつながって 1 つの塊でも、色の量で見る
      (colors.has('r') || r >= gr * 0.12) &&
      (colors.has('b') || bl >= gr * 0.12)
    )
      return { code: '1s', reason: '緑の大きな絵に赤（頭）と青（尾）が混ざる鳥の絵', detail };
  }

  let suit = null;
  if (circles >= blobs.length * 0.6 && sticks === 0) suit = 'p';
  else if (sticks >= 2 && circles === 0) suit = 's';
  if (!suit) return { code: null, reason: '丸とも棒とも言い切れない', detail };

  const n = blobs.length;
  if (suit === 's') {
    const odd = blobs.filter((b) => b.shape !== 'stick');
    if (odd.length) {
      // 八索: 中央 2 列の棒が傾いていて、つながると「∧」「∨」の 1 つの塊になる
      const stickW = blobs.filter((b) => b.shape === 'stick').map((b) => b.w).sort((a, c) => a - c);
      const medW = stickW[Math.floor(stickW.length / 2)] || 1;
      const xs = blobs.map((b) => b.cx);
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
      const span = Math.max(...xs) - Math.min(...xs);
      const inner = (b) => Math.abs(b.cx - mid) < span * 0.3;
      const merged8 = n === 6 && odd.length === 2 && odd.every((b) => inner(b) && b.w >= medW * 1.5);
      const loose8 = n === 8 && odd.length <= 4 && odd.every((b) => inner(b));
      if (!merged8 && !loose8) return { code: null, reason: '棒以外の形が混ざっている', detail };
      const space = centerSpace(m, blobs);
      if (!space.h) return { code: null, reason: '8s の余白と合わない（h）', detail };
      return { code: '8s', reason: merged8 ? '外側に棒、中央に「∧」「∨」の形が上下 2 段' : '棒が 8 本（中央の 4 本が傾いている）', detail };
    }
  }
  const code = `${n}${suit}`;
  const layout = RULE_LAYOUT[suit][n];
  if (!layout) return { code: null, reason: `${suit === 'p' ? '丸' : '棒'}が ${n} 個（数が合わない）`, detail };

  const slots = matchLayout(blobs, layout);
  if (!slots) return { code: null, reason: `${code} の並び方と合わない`, detail };

  const reds = RULE_RED[code] || [];
  let redMiss = 0;
  blobs.forEach((b, i) => {
    if ((b.color === 'r') !== reds.includes(slots[i])) redMiss++;
  });
  if (redMiss > (n >= 6 ? 1 : 0)) return { code: null, reason: `${code} の赤の位置と合わない`, detail };

  const space = centerSpace(m, blobs);
  const rule = RULE_SPACE[code] || {};
  const spaceMiss = Object.entries(rule).filter(([k, want]) => space[k] !== want).map(([k]) => k);
  if (spaceMiss.length) return { code: null, reason: `${code} の余白と合わない（${spaceMiss.join(',')}）`, detail: { ...detail, space, blobsAt: blobs.map((b) => [+b.cx.toFixed(2), +b.cy.toFixed(2), b.w, b.h, b.shape]) , fw: m.fw } };

  return { code, reason: `${suit === 'p' ? '丸' : '棒'}が ${n} 個・並び・赤・余白が一致`, detail };
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
 * @param {object} [options.thresholds] 牌の表面を探すしきい値（DEFAULT_THRESHOLDS 参照）
 * @param {number[]} [options.weights=[1,1,1,1]] 比べるときの重み（暗さ・赤み・緑み・青み）。
 *   色の違いしかない絵柄なら赤・緑を重くする（例: [1, 2, 2, 1]）
 * @param {'sum'|'dots'} [options.mode='sum'] マスの測り方
 *   'sum'  … 暗さ・赤み・緑み・青みの量をそのまま持つ（既定。いちばん精度が高い）
 *   'dots' … 色のドットが 1 つでもあればそのマスを色と判定し、なければ白黒で判定する。
 *            マスごとに色のラベルが付くので、判定の理由を説明しやすい
 * @param {number} [options.dotLevel=0.2] dots: ドットとみなす色の強さ（小さいほど敏感。0.12 以下は黒字のふちのにじみも拾う）
 * @param {number} [options.minDots=1] dots: 何ドットあれば色のマスにするか
 * @param {string} [options.dotColors='rg'] dots: 色として扱う色（'rg' = 赤と緑、'rgb' = 青も）
 * @param {boolean} [options.bwBinary=false] dots: 白黒を 黒/白 の 2 択にする
 * @param {boolean} [options.rules=true] 規則での判定も使う（筒子・索子・一〜三萬・白）。基準なしでも読める
 * @param {'auto'|'template'|'rule'} [options.prefer='auto'] 規則と見比べの答えが食い違ったときにどちらを採るか。
 *   'auto' は見比べの確からしさが autoThreshold（既定 0.35）未満なら規則を採る
 * @param {number} [options.bwLevel=0.2] dots: bwBinary のとき、黒とみなす暗さ
 * @param {boolean} [options.rectify=true] 読む前・基準を登録する前に、写真の傾きと遠近（上が狭い台形）を直す
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
      const d = distance(f, r.f, cfg.weights);
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

  /**
   * 牌 1 枚を、見比べ（基準があれば）と規則の両方で読み、組み合わせる。
   *   両方が同じ答え → その答え（確からしさを上げる）
   *   答えが違う     → prefer に従って片方を答えにし、自信なしにする
   *                    （'auto' は見比べの確からしさが autoThreshold 未満なら規則、それ以上なら見比べ）
   *   片方だけ       → その答え（規則だけのときは確からしさ 0.5）
   */
  function readOne(A, box) {
    const f = extractFeatures(A, box, cfg);
    const tpl = refs.length ? classify(f) : null;
    const rule = cfg.rules === false ? null : readTileByRules(A, box, cfg);
    const base = { faceBox: f.faceBox, rule };
    if (tpl && rule && rule.code) {
      if (tpl.code === rule.code) return { ...tpl, ...base, confidence: Math.max(tpl.confidence, 0.5), source: 'both' };
      const prefer = cfg.prefer ?? 'auto';
      const useRule = prefer === 'rule' || (prefer === 'auto' && tpl.confidence < (cfg.autoThreshold ?? 0.35));
      const code = useRule ? rule.code : tpl.code;
      return { ...tpl, ...base, code, confidence: 0, source: 'disagree' };
    }
    if (tpl) return { ...tpl, ...base, source: 'template' };
    if (rule && rule.code) return { code: rule.code, confidence: 0.5, distance: null, candidates: [], ...base, source: 'rule' };
    return { code: null, confidence: 0, distance: null, candidates: [], ...base, source: 'none' };
  }

  return {
    get grid() {
      return cfg.grid.slice();
    },
    /** 測り方（'sum' か 'dots'） */
    get mode() {
      return cfg.mode || 'sum';
    },
    /** この読み取り器の設定（extractFeatures にそのまま渡せる） */
    get options() {
      return { ...cfg };
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
    addReferenceRow(source, codes, { scales = cfg.referenceScales ?? [0.65, 0.45], rectify = cfg.rectify } = {}) {
      const list = Array.isArray(codes) ? codes : parseCodes(codes);
      const img = rectify === false ? toImageData(source) : rectifyImage(source, { aspect, thresholds: cfg.thresholds }).image;
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
      layout.image = img;
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
      return readOne(A, box);
    },

    /**
     * 並んだ手牌を読む。
     * @param {object} [opts] count / allowedCounts（locateHand と同じ）、minConfidence（既定 0.08）、
     *   rectify（既定 true。傾きと遠近を直してから読む）
     * @returns {{ codes:(string|null)[], text:string, tiles:object[], layout:object, uncertain:number[], image:ImageData, rectified:object }}
     *   image … 実際に読んだ（傾き・遠近を直した）画像。tiles[i].box はこの画像の上の位置
     *   tiles[i].source … 'both'（規則と見比べが一致）/ 'template'（見比べだけ）/ 'rule'（規則だけ）
     *   tiles[i].rule   … 規則での判定（code と理由）。決められなかった牌は code: null
     *   基準が未登録で規則でも決められない牌は code: null（text では "?"）
     */
    readHand(source, opts = {}) {
      const img = toImageData(source);
      const read = (image, rectified) => {
        const A = analyzeImage(image, cfg.thresholds);
        const layout = locateHand(A, { aspect: aspect || 0.8, thresholds: cfg.thresholds, ...opts });
        const minConf = opts.minConfidence ?? 0.08;
        const tiles = layout.boxes.map((box) => ({ ...readOne(A, box), box }));
        const codes = tiles.map((t) => t.code);
        return {
          codes,
          text: formatCodes(codes),
          tiles,
          layout,
          uncertain: tiles.flatMap((t, i) => (!t.code || t.confidence < minConf ? [i] : [])),
          image,
          rectified,
        };
      };
      const plain = { angle: 0, keystone: 0 };
      if ((opts.rectify ?? cfg.rectify) === false) return read(img, plain);
      const rect = rectifyImage(img, { aspect, thresholds: cfg.thresholds });
      if (!rect.angle && !rect.keystone) return read(img, plain);
      // 直した方と直さない方の両方で読み、自信のある牌が多い方を採る（直し方を間違えたときの保険）
      const score = (r) => r.tiles.length - r.uncertain.length + r.tiles.reduce((a, t) => a + t.confidence, 0) / (r.tiles.length || 1);
      let a = null;
      let b = null;
      try {
        a = read(rect.image, { angle: rect.angle, keystone: rect.keystone });
      } catch (e) {
        // 直した画像で読めなければ元の画像で
      }
      try {
        b = read(img, plain);
      } catch (e) {
        if (!a) throw e;
      }
      if (!a) return b;
      if (!b) return a;
      return score(a) >= score(b) ? a : b;
    },

    /** 基準を JSON にできる形で書き出す（localStorage やファイルに保存して使い回せます） */
    exportReferences() {
      return {
        format: 'mahjong-tile-reader/2',
        grid: cfg.grid,
        mode: cfg.mode || 'sum',
        aspect,
        refs: refs.map((r) => ({ code: r.code, f: Array.from(r.f, (v) => Math.round(v * 1000) / 1000) })),
      };
    },

    importReferences(data, { append = false } = {}) {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      if (!obj || obj.format !== 'mahjong-tile-reader/2') throw new Error('形式が違います（古い版の基準は登録し直してください）');
      if ((obj.mode || 'sum') !== (cfg.mode || 'sum'))
        throw new Error(`測り方が違います（基準は ${obj.mode}、この読み取り器は ${cfg.mode || 'sum'}）`);
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
