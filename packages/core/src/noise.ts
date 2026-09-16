/**
 * Deterministic value/simplex-style noise. The server and every client must
 * generate byte-identical terrain from a seed, so this deliberately avoids
 * Math.random and any float ordering that varies between engines.
 */

export function hash2(x: number, y: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1442695040;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function hash3(x: number, y: number, z: number, seed: number): number {
  let h =
    (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647 + (seed | 0) * 1442695040;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smoothed value noise in [0,1]. */
export function valueNoise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);
  const a = n00 + (n10 - n00) * fx;
  const b = n01 + (n11 - n01) * fx;
  return a + (b - a) * fy;
}

export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const fz = smooth(z - z0);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = lerp(hash3(x0, y0, z0, seed), hash3(x0 + 1, y0, z0, seed), fx);
  const c10 = lerp(hash3(x0, y0 + 1, z0, seed), hash3(x0 + 1, y0 + 1, z0, seed), fx);
  const c01 = lerp(hash3(x0, y0, z0 + 1, seed), hash3(x0 + 1, y0, z0 + 1, seed), fx);
  const c11 = lerp(hash3(x0, y0 + 1, z0 + 1, seed), hash3(x0 + 1, y0 + 1, z0 + 1, seed), fx);
  return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz);
}

/** Sums octaves of value noise; returns roughly [0,1]. */
export function fbm2(
  x: number,
  y: number,
  seed: number,
  octaves = 4,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, y * freq, seed + i * 7919) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function fbm3(
  x: number,
  y: number,
  z: number,
  seed: number,
  octaves = 3,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise3(x * freq, y * freq, z * freq, seed + i * 7919) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Small seedable PRNG for gameplay randomness that must be reproducible. */
export class Random {
  private state: number;
  constructor(seed = 0) {
    this.state = (seed | 0) || 0x2545f491;
  }
  nextInt(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return this.state >>> 0;
  }
  nextNumber(min = 0, max = 1): number {
    return min + (this.nextInt() / 4294967296) * (max - min);
  }
  nextInteger(min: number, max: number): number {
    return min + (this.nextInt() % (max - min + 1));
  }
}
