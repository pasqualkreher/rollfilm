// Converting between the two tone-curve representations when the user flips
// the Point/Parametric toggle, so the look carries over instead of resetting.
//
// Both directions mirror the backend's math (develop_color.py):
// - parametric -> point: sample the parametric formula (region tents + level
//   ramps on the identity line) and drop control points on the samples.
// - point -> parametric: the parametric model is LINEAR in its six sliders,
//   so a least-squares fit of the point curve's deviation from identity gives
//   the closest parametric equivalent (wiggly hand-drawn curves flatten to
//   the nearest smooth shape - the representation simply can't hold more).

import type { Curve, ParamCurveChannel, ParametricCurve, PointCurves } from "./adjustments";

const CHANNELS = ["luma", "red", "green", "blue"] as const;

const IDENTITY: Curve = [
  [0, 0],
  [255, 255],
];

function tent(x: number, centre: number, width: number): number {
  return Math.max(0, Math.min(1, 1 - Math.abs(x - centre) / width));
}

// The six basis functions of the parametric curve, in backend order and
// scaling (develop_color._param_lut); x is 0..1, the value is the y-offset in
// 0..255 units per full slider deflection (slider/100 = coefficient 1).
const PARAM_KEYS = ["shadows", "darks", "lights", "highlights", "black_level", "white_level"] as const;
const BASES: ((x: number) => number)[] = [
  (x) => 55 * tent(x, 0.08, 0.34),
  (x) => 55 * tent(x, 0.35, 0.34),
  (x) => 55 * tent(x, 0.65, 0.34),
  (x) => 55 * tent(x, 0.92, 0.34),
  (x) => 40 * (1 - x),
  (x) => 40 * x,
];

function paramNeutral(p: ParamCurveChannel): boolean {
  return PARAM_KEYS.every((k) => !p[k]);
}

function paramValue(p: ParamCurveChannel, x255: number): number {
  const x = x255 / 255;
  let y = x255;
  PARAM_KEYS.forEach((k, i) => {
    y += (p[k] / 100) * BASES[i](x);
  });
  return Math.max(0, Math.min(255, y));
}

// Monotone cubic (Fritsch-Carlson) evaluation of a point curve, the same
// interpolation the backend renders with (develop_color._pchip_lut).
function pchipSample(points: Curve, xq: number[]): number[] {
  const pts = [...points]
    .filter((p) => p.length >= 2)
    .sort((a, b) => a[0] - b[0]);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of pts) {
    if (xs.length && Math.abs(x - xs[xs.length - 1]) < 1e-6) ys[ys.length - 1] = y;
    else {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < 2) return xq.map((x) => x);
  const n = xs.length;
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    delta.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const d = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) d[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  d[0] = delta[0];
  d[n - 1] = delta[n - 2];
  return xq.map((x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let seg = xs.findIndex((xv, i) => i < n - 1 && x >= xv && x < xs[i + 1]);
    if (seg < 0) seg = n - 2;
    const t = (x - xs[seg]) / h[seg];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[seg] +
      (t3 - 2 * t2 + t) * h[seg] * d[seg] +
      (-2 * t3 + 3 * t2) * ys[seg + 1] +
      (t3 - t2) * h[seg] * d[seg + 1]
    );
  });
}

function isIdentity(points: Curve): boolean {
  return (
    points.length === 2 &&
    points[0][0] === 0 && points[0][1] === 0 &&
    points[1][0] === 255 && points[1][1] === 255
  );
}

// Where the sampled control points sit: aligned with the tent kinks of the
// parametric bases (centres 20/89/166/235 plus their edges), so PCHIP through
// them reproduces the parametric shape to within ~2/255 - while staying
// sparse enough to remain editable by hand (backend cap is 16 points).
const SAMPLE_XS = [0, 20, 42, 64, 89, 107, 128, 148, 166, 192, 214, 235, 255];

function paramChannelToPoints(p: ParamCurveChannel): Curve {
  if (paramNeutral(p)) return IDENTITY.map((pt) => [...pt]) as Curve;
  return SAMPLE_XS.map((x) => [x, Math.round(paramValue(p, x))]) as Curve;
}

function pointsToParamChannel(points: Curve): ParamCurveChannel {
  const out: ParamCurveChannel = {
    highlights: 0, lights: 0, darks: 0, shadows: 0,
    white_level: 0, black_level: 0, split1: 25, split2: 50, split3: 75,
  };
  if (isIdentity(points)) return out;

  // Least squares over the full 0..255 grid: minimise ||B c - target||, where
  // target is the curve's deviation from identity and B holds the six bases.
  const xs = Array.from({ length: 256 }, (_, i) => i);
  const curve = pchipSample(points, xs);
  const A: number[][] = Array.from({ length: 6 }, () => new Array(7).fill(0));
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const b = BASES.map((f) => f(x));
    const t = curve[i] - i;
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) A[r][c] += b[r] * b[c];
      A[r][6] += b[r] * t;
    }
  }
  // Gaussian elimination with partial pivoting on the 6x7 augmented matrix.
  for (let col = 0; col < 6; col++) {
    let piv = col;
    for (let r = col + 1; r < 6; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    if (Math.abs(A[col][col]) < 1e-9) continue;
    for (let r = 0; r < 6; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < 7; c++) A[r][c] -= f * A[col][c];
    }
  }
  PARAM_KEYS.forEach((k, i) => {
    const coef = Math.abs(A[i][i]) < 1e-9 ? 0 : A[i][6] / A[i][i];
    out[k] = Math.max(-100, Math.min(100, Math.round(coef * 100)));
  });
  return out;
}

export function parametricToPoints(pc: ParametricCurve): PointCurves {
  return Object.fromEntries(
    CHANNELS.map((ch) => [ch, paramChannelToPoints(pc[ch])])
  ) as unknown as PointCurves;
}

export function pointsToParametric(p: PointCurves): ParametricCurve {
  return Object.fromEntries(
    CHANNELS.map((ch) => [ch, pointsToParamChannel(p[ch])])
  ) as unknown as ParametricCurve;
}
