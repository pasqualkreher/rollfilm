// Kelvin <-> the editor's relative Temperature value.
//
// The render's white balance is relative: `temperature` (t = value / 100)
// scales red by 1 + 0.3t and blue by 1 - 0.3t on top of the camera's own
// white balance. The slider is labelled in Kelvin by asking which colour
// temperature that red/blue tilt stands for, measured from the temperature
// the photo was shot at (`asShot`, from the RAW's metadata):
//
//   a grey lit by K, in a picture balanced for asShot, has the red/blue ratio
//   rb(K) / rb(asShot); setting the white balance to K undoes exactly that,
//   so the tilt it applies is rho = rb(asShot) / rb(K).
//
// Higher Kelvin = warmer picture, as on the camera.

// Red/blue ratio of the black-body white at `kelvin`, in linear sRGB.
// Planckian locus after Kim et al. (valid 1667..25000 K).
function redBlueRatio(kelvin: number): number {
  const t = Math.min(25000, Math.max(1667, kelvin));
  const x =
    t <= 4000
      ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y =
    t <= 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  const X = x / y;
  const Z = (1 - x - y) / y;
  const red = 3.2406 * X - 1.5372 - 0.4986 * Z;
  // Below ~1900 K the white leaves the sRGB gamut on the blue side.
  const blue = Math.max(1e-4, 0.0557 * X - 0.204 + 1.057 * Z);
  return red / blue;
}

// The camera's own calibration, where the RAW carries one (see the backend's
// services/white_balance.py): [kelvin, red gain, blue gain] rows, green = 1,
// relative to the as-shot balance. With it the slider reproduces what the
// camera itself does at each Kelvin setting instead of the black-body
// estimate below.
export type KelvinGains = [number, number, number][];

// Stored to two decimals: fine enough that a 10 K step is its own value.
const hundredths = (v: number) => Math.round(v * 100) / 100;

function gainsAt(kelvin: number, gains: KelvinGains): [number, number] {
  let i = 1;
  while (i < gains.length - 1 && gains[i][0] < kelvin) i++;
  const [k0, r0, b0] = gains[i - 1];
  const [k1, r1, b1] = gains[i];
  const f = Math.min(1, Math.max(0, (kelvin - k0) / (k1 - k0)));
  return [r0 + f * (r1 - r0), b0 + f * (b1 - b0)];
}

// The white balance a Kelvin setting stands for, as the two values the render
// stores. With red/green = (1 + 0.3t) / (1 - 0.3n) and blue/green =
// (1 - 0.3t) / (1 - 0.3n), any pair of red and blue gains has exactly one
// (temperature, tint) - so the camera's gains go in without loss.
export function whiteBalanceFromKelvin(
  kelvin: number,
  asShot: number,
  gains: KelvinGains | null
): { temperature: number; tint: number } {
  if (!gains || gains.length < 2) {
    const rho = redBlueRatio(asShot) / redBlueRatio(kelvin);
    return { temperature: hundredths(((rho - 1) / (0.3 * (rho + 1))) * 100), tint: 0 };
  }
  const [red, blue] = gainsAt(kelvin, gains);
  const green = 2 / (red + blue);
  const clamp = (v: number, reach: number) => Math.max(-reach, Math.min(reach, hundredths(v)));
  return {
    temperature: clamp(((red * green - 1) / 0.3) * 100, 300),
    tint: clamp(((1 - green) / 0.3) * 100, 250),
  };
}

export function kelvinFromTemperature(
  temperature: number,
  asShot: number,
  gains: KelvinGains | null
): number {
  if (temperature === 0) return asShot;
  const t = temperature / 100;
  const tilt = (1 + 0.3 * t) / (1 - 0.3 * t);
  if (gains && gains.length >= 2) {
    // red/blue rises with Kelvin along the table: find where the tilt sits.
    const ratio = (row: [number, number, number]) => row[1] / row[2];
    if (tilt <= ratio(gains[0])) return gains[0][0];
    for (let i = 1; i < gains.length; i++) {
      if (tilt <= ratio(gains[i])) {
        const lo = ratio(gains[i - 1]);
        const f = (tilt - lo) / (ratio(gains[i]) - lo);
        return gains[i - 1][0] + f * (gains[i][0] - gains[i - 1][0]);
      }
    }
    return gains[gains.length - 1][0];
  }
  const target = redBlueRatio(asShot) / tilt;
  // redBlueRatio falls as Kelvin rises: bisect for the Kelvin that gives it.
  let lo = 1667;
  let hi = 25000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (redBlueRatio(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// The (temperature, tint) that makes a colour neutral. `lin` is that colour
// as rendered, in linear light, with the current white balance already in it.
// The tone curve scales the three channels of a pixel alike, so the ratios
// read off the screen are the ratios the white balance has to undo. The shift
// cross multiplies red and blue before and after alike, so it drops out and
// stays as it is.
function neutralise(
  lin: [number, number, number],
  current: { temperature: number; tint: number }
): { temperature: number; tint: number } {
  const t = current.temperature / 100;
  const n = current.tint / 100;
  // The gains in force now, each divided by what its channel shows.
  const red = (1 + 0.3 * t) / lin[0];
  const green = (1 - 0.3 * n) / lin[1];
  const blue = (1 - 0.3 * t) / lin[2];
  const scale = 2 / (red + blue);
  const clamp = (v: number, reach: number) => Math.max(-reach, Math.min(reach, hundredths(v)));
  return {
    temperature: clamp(((red * scale - 1) / 0.3) * 100, 300),
    tint: clamp(((1 - green * scale) / 0.3) * 100, 250),
  };
}

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

// White balance from an area that should be white (the editor's eyedropper).
// `rgb` is the rendered colour there, 0..255 sRGB. A white surface is bright,
// so anything short of actually clipped is taken; null only when a channel
// sits at the ceiling (a blown-out white has lost its colour cast, there is
// nothing left to measure) or the spot is too dark.
export function whiteBalanceFromNeutral(
  rgb: [number, number, number],
  current: { temperature: number; tint: number }
): { temperature: number; tint: number } | null {
  if (Math.max(...rgb) >= 254 || Math.min(...rgb) < 6) return null;
  return neutralise([toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])], current);
}
