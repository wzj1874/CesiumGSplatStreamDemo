/**
 * Utility functions for GSplatStream
 */

/**
 * Convert float32 to float16 (half precision)
 * @param {number} val Float32 value
 * @returns {number} Float16 value as Uint16
 */
function toHalfFloat(val) {
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);
  
  floatView[0] = val;
  const x = int32View[0];

  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;

  if (e < 103) return bits;

  if (e > 142) {
    bits |= 0x7c00;
    bits |= (e == 255 ? 1 : 0) && x & 0x007fffff;
    return bits;
  }

  if (e < 114) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }

  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

/**
 * Calculate texture size for given splat count
 * @param {number} count Number of splats
 * @returns {{x: number, y: number}} Texture dimensions
 */
function evalTextureSize(count) {
  let w = Math.ceil(Math.sqrt(count));
  const align = 64; // Align to 64 for GPU optimization
  w = Math.ceil(w / align) * align;
  const h = Math.ceil(count / w);
  return { x: w, y: h };
}

export { toHalfFloat, evalTextureSize };