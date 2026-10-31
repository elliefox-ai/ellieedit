// Filters tier-2 tunes — pure-function tests (node, no DOM).
import { rgbToHsv, hsvToRgb, liftBlacks, tunePixel, applyStrength, tunesAreIdentity }
  from '../../frontend/js/modules/filters-tunes.js';

function assertClose(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) throw new Error(`${msg}: ${a} != ${b}`);
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: ${a} !== ${b}`);
}

// HSV round-trip on primaries + a midtone.
for (const [r, g, b] of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.2, 0.5, 0.8], [0.5, 0.5, 0.5]]) {
  const [h, s, v] = rgbToHsv(r, g, b);
  const [r2, g2, b2] = hsvToRgb(h, s, v);
  assertClose(r2, r, 1e-6, 'round-trip r');
  assertClose(g2, g, 1e-6, 'round-trip g');
  assertClose(b2, b, 1e-6, 'round-trip b');
}

// Identity tune is a no-op.
{
  const [r, g, b] = tunePixel(0.2, 0.5, 0.8, {});
  assertClose(r, 0.2, 1e-6, 'identity r');
  assertClose(g, 0.5, 1e-6, 'identity g');
  assertClose(b, 0.8, 1e-6, 'identity b');
  assertEq(tunesAreIdentity({}), true, 'identity check');
  assertEq(tunesAreIdentity({ satMul: 1.5 }), false, 'non-identity check');
}

// Saturation 0 desaturates to grey (value preserved).
{
  const [r, g, b] = tunePixel(1, 0, 0, { satMul: 0 });
  assertClose(r, 1, 1e-6, 'desat r');
  assertClose(g, 1, 1e-6, 'desat g');
  assertClose(b, 1, 1e-6, 'desat b');
}

// Lift-blacks curve: identity above the edge, quadratic ease-in below,
// black itself lifts to `lift`.
assertClose(liftBlacks(0.5, 0.1, 0.2), 0.5, 1e-9, 'above edge identity');
assertClose(liftBlacks(0, 0.1, 0.2), 0.1, 1e-9, 'black lifts');
assertClose(liftBlacks(0.2, 0.1, 0.2), 0.2, 1e-9, 'edge meets identity');
assertClose(liftBlacks(0.1, 0.1, 0.2), 0.125, 1e-9, 'midpoint quadratic');
assertClose(liftBlacks(0.3, 0, 0), 0.3, 1e-9, 'curve off');

// Universal strength: lerp, clamped, no extrapolation past 100.
assertClose(applyStrength(0, 1, 0), 0, 1e-9, 'strength 0');
assertClose(applyStrength(0, 1, 50), 0.5, 1e-9, 'strength 50');
assertClose(applyStrength(0, 1, 100), 1, 1e-9, 'strength 100');
assertClose(applyStrength(0, 1, 150), 1, 1e-9, 'strength clamps, no extrapolation');
assertClose(applyStrength(0, 1, -20), 0, 1e-9, 'strength clamps low');

console.log('PASS filters-tunes');
