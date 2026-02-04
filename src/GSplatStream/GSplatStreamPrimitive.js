import * as Cesium from 'cesium';
import { evalTextureSize, toHalfFloat } from './GSplatStreamUtils';
import GSplatStreamGeometry from './GSplatStreamGeometry';
import GSplatStreamVS from './Shaders/GSplatStreamVS';
import GSplatStreamFS from './Shaders/GSplatStreamFS';

/**
 * A primitive that renders Gaussian splats with streaming support.
 * 
 * @constructor
 * @param {object} options An object with the following properties:
 * @param {number} [options.totalCount=0] Total number of splats that will be streamed
 * @param {number} [options.batchSize=128] Number of splats per batch
 * @param {boolean} [options.debugShowBoundingVolume=false] Whether to show the bounding volume
 * @param {boolean} [options.show=true] Whether to show the primitive
 */
class GSplatStreamPrimitive {
  constructor(options) {
    options = options ?? Cesium.Frozen.EMPTY_OBJECT;

    /**
     * Whether this object was destroyed.
     * @type {boolean}
     * @private
     */
    this._isDestroyed = false;

    /**
     * Whether to show the primitive.
     * @type {boolean}
     */
    this.show = options.show !== undefined ? options.show : true;

    /**
     * Whether to show the bounding volume for debugging.
     * @type {boolean}
     */
    this.debugShowBoundingVolume = options.debugShowBoundingVolume ?? false;

    this.totalCount = 0;
    this.size = { x: 0, y: 0 };
    this.localBoundBox = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };

    this.splatColor = undefined;
    this.transformA = undefined;
    this.transformB = undefined;
    this.texParams = undefined; // [numSplats, texWidth, validCount, visBoost]
    this._texParamDirty = true;
    this.splatOrder = undefined;

    this._geometry = undefined;

    this._colorData = undefined; // RGBA8: count * 4
    this._transformAData = undefined; // RGBA32U: count * 4
    this._transformBData = undefined; // RGBA16F: count * 4 (Float16 format)
    this._orderData = undefined; // R32U: size.x * size.y
    this._positions = undefined; // xyz per splat (local space)

    this._splatSetFlags = undefined; // Track which indices have data
    this._validCount = 0; // Number of splats with valid data

    this._sortWorker = undefined;
    this._lastSentTime = 0;
    this._minIntervalMs = 16;
    this._centersSent = false;
    this._lastViewMatrixHash = 0;
    this._workerHasReturned = false; // Track if worker has returned at least once

    this._lastCameraSpeed = 0;
    this._adaptiveSorting = true;

    this._minPixelCoverage = 4.0;
    this._maxPixelCoverage = 0.0;
    this._maxPixelCullDistance = 0.0;
    this._lastPixelCullParams = '';
    this._texturesInitialized = false;

    this._batchSize = 128;
    this.instanceCount = 0;

    this._pendingUpdates = new Set(); // Indices pending GPU update
    this._autoFlushThreshold = 10000; // Auto-flush when this many updates pending
    this._frameCount = 0;
    this.flushFrameLimit = 10;
    this.flushInterval = 1000;
    this.lastTimeStamp = new Date().getTime();

    this._vertexArray = undefined;
    this._drawCommand = undefined;
    this._shaderProgram = undefined;
    this._uniformMap = undefined;
    this._renderState = undefined;
    this.boundingSphere = undefined;
    this.modelMatrix = Cesium.Matrix4.IDENTITY.clone();
    this._context = undefined;
    this._dirty = true;
    this._prevViewMatrix = new Cesium.Matrix4();
    this._scene = options.scene || undefined;

    if (options.totalCount !== undefined && options.totalCount > 0) {
      this.initCount(options.totalCount, options.batchSize ?? 128);
    }
  }

  /**
   * Initialize renderer with total splat count.
   * Pre-allocates all GPU resources with zero-initialized data.
   * 
   * @param {number} totalCount Total number of splats that will be streamed
   * @param {number} [batchSize=128] Splats per draw call
   */
  initCount(totalCount, batchSize = 128) {
    if (this.isDestroyed()) {
      throw new Cesium.DeveloperError("GSplatStreamPrimitive is destroyed.");
    }

    if (totalCount <= 0) {
      throw new Cesium.DeveloperError("Total count must be greater than 0");
    }

    this.totalCount = totalCount;
    this._batchSize = batchSize;
    this.size = evalTextureSize(totalCount);

    const w = this.size.x | 0;
    const h = this.size.y | 0;
    const total = w * h;

    this._colorData = new Uint8Array(total * 4);
    this._colorData.fill(0);

    this._transformAData = new Uint32Array(total * 4);
    this._transformAData.fill(0);

    this._transformBData = new Uint16Array(total * 4);
    this._transformBData.fill(0);

    this._orderData = new Uint32Array(total);
    for (let i = 0; i < total; i++) {
      this._orderData[i] = i < totalCount ? i : (totalCount > 0 ? totalCount - 1 : 0);
    }

    this._positions = new Float32Array(totalCount * 3);
    this._positions.fill(0);
    this.localBoundBox = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };

    this._splatSetFlags = new Array(totalCount).fill(false);
    this._validCount = 0;

    this.texParams = new Float32Array([this._validCount, this.size.x, 0, 1.0]);

    // Note: Cesium textures are created lazily in _updateTextures when context is available
    // For now, we just mark that textures need to be initialized
    this._geometry = new GSplatStreamGeometry(this._batchSize);

    this.instanceCount = 0;
    this._dirty = true;
  }

  /**
   * Set data for a single splat at the given index.
   * Updates CPU buffers and marks for GPU update.
   * 
   * @param {number} index Splat index (0 to count-1)
   * @param {object} data Splat data
   * @param {number[]} data.position Position [x, y, z] (required)
   * @param {number[]} [data.rotation] Rotation quaternion [x, y, z, w] (optional)
   * @param {number[]} [data.scale] Scale [x, y, z] (optional, anisotropic)
   * @param {number} [data.opacity] Opacity value (optional)
   * @param {object} [data.sh] Spherical harmonics data (optional)
   * @param {number} data.sh.order SH order
   * @param {Float32Array} data.sh.coeffs SH coefficients
   */
  setSplatData(index, data) {
    if (this.isDestroyed()) {
      throw new Cesium.DeveloperError("GSplatStreamPrimitive is destroyed.");
    }

    if (index < 0 || index >= this.totalCount) {
      throw new Cesium.DeveloperError(
        `Index ${index} out of range [0, ${this.totalCount})`
      );
    }

    const wasSet = this._splatSetFlags[index];

    this._positions[index * 3 + 0] = data.position[0];
    this._positions[index * 3 + 1] = data.position[1];
    this._positions[index * 3 + 2] = data.position[2];
    
    this._updateLocalBoundBox(data.position[0], data.position[1], data.position[2]);

    const SH_C0 = 0.28209479177387814;
    let r = 0.5, g = 0.5, b = 0.5;
    if (data.sh && data.sh.coeffs && data.sh.coeffs.length >= 3) {
      r = 0.5 + data.sh.coeffs[0] * SH_C0;
      g = 0.5 + data.sh.coeffs[1] * SH_C0;
      b = 0.5 + data.sh.coeffs[2] * SH_C0;
    }
    const a = data.opacity !== undefined ? 1 / (1 + Math.exp(-data.opacity)) : 1.0;

    const colorIdx = index * 4;
    this._colorData[colorIdx + 0] = Math.max(0, Math.min(255, Math.floor(r * 255)));
    this._colorData[colorIdx + 1] = Math.max(0, Math.min(255, Math.floor(g * 255)));
    this._colorData[colorIdx + 2] = Math.max(0, Math.min(255, Math.floor(b * 255)));
    this._colorData[colorIdx + 3] = Math.max(0, Math.min(255, Math.floor(a * 255)));

    this.updateTransformData(index, data);

    if (!wasSet) {
      this._splatSetFlags[index] = true;
      this._validCount++;
      this._texParamDirty = true;
    }

    this._pendingUpdates.add(index);

    if (Cesium.defined(this._scene)) {
      this._scene.requestRender();
    }
    if (this._pendingUpdates.size >= this._autoFlushThreshold && Cesium.defined(this._context)) {
      this.flushUpdates();
    }
  }

  /**
   * Update local bounding box.
   * @private
   */
  _updateLocalBoundBox(x, y, z) {
    const min = this.localBoundBox.min;
    const max = this.localBoundBox.max;
    min.x = Math.min(min.x, x);
    min.y = Math.min(min.y, y);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x);
    max.y = Math.max(max.y, y);
    max.z = Math.max(max.z, z);
  }

  /**
   * Update transform data for a single splat.
   * @private
   */
  updateTransformData(index, data) {
    const idx = index * 4;

    const fb = new ArrayBuffer(4);
    const f32 = new Float32Array(fb);
    const u32 = new Uint32Array(fb);
    const setFloatBits = (v) => {
      f32[0] = v;
      return u32[0];
    };

    const x = data.position[0];
    const y = data.position[1];
    const z = data.position[2];
    this._transformAData[idx + 0] = setFloatBits(x);
    this._transformAData[idx + 1] = setFloatBits(y);
    this._transformAData[idx + 2] = setFloatBits(z);

    let qx = 0, qy = 0, qz = 0, qw = 1;
    if (data.rotation) {
      qx = data.rotation[0];
      qy = data.rotation[1];
      qz = data.rotation[2];
      qw = data.rotation[3];
      const inv = 1.0 / Math.hypot(qx, qy, qz, qw);
      qx *= inv; qy *= inv; qz *= inv; qw *= inv;
    }

    let sx = 1, sy = 1, sz = 1;
    if (data.scale) {
      sx = Math.exp(data.scale[0]);
      sy = Math.exp(data.scale[1]);
      sz = Math.exp(data.scale[2]);
    }

    const x2 = qx + qx;
    const y2 = qy + qy;
    const z2 = qz + qz;
    const xx = qx * x2;
    const xy = qx * y2;
    const xz = qx * z2;
    const yy = qy * y2;
    const yz = qy * z2;
    const zz = qz * z2;
    const wx = qw * x2;
    const wy = qw * y2;
    const wz = qw * z2;

    const data0 = 1 - (yy + zz);
    const data1 = xy + wz;
    const data2 = xz - wy;
    const data3 = xy - wz;
    const data4 = 1 - (xx + zz);
    const data5 = yz + wx;
    const data6 = xz + wy;
    const data7 = yz - wx;
    const data8 = 1 - (xx + yy);

    const r00 = data0 * sx; const r01 = data1 * sx; const r02 = data2 * sx;
    const r10 = data3 * sy; const r11 = data4 * sy; const r12 = data5 * sy;
    const r20 = data6 * sz; const r21 = data7 * sz; const r22 = data8 * sz;

    const cAx = r00 * r00 + r10 * r10 + r20 * r20;
    const cAy = r00 * r01 + r10 * r11 + r20 * r21;
    const cAz = r00 * r02 + r10 * r12 + r20 * r22;

    const cBx = r01 * r01 + r11 * r11 + r21 * r21;
    const cBy = r01 * r02 + r11 * r12 + r21 * r22;
    const cBz = r02 * r02 + r12 * r12 + r22 * r22;

    const bidx = idx;
    this._transformBData[bidx + 0] = toHalfFloat(cAx) & 0xffff;
    this._transformBData[bidx + 1] = toHalfFloat(cAy) & 0xffff;
    this._transformBData[bidx + 2] = toHalfFloat(cAz) & 0xffff;
    this._transformBData[bidx + 3] = toHalfFloat(cBz) & 0xffff;

    const hx = toHalfFloat(cBx) & 0xffff;
    const hy = toHalfFloat(cBy) & 0xffff;
    this._transformAData[idx + 3] = hx | (hy << 16);
  }

  /**
   * Flush pending updates to GPU.
   * Updates GPU textures with all pending changes.
   * Uses partial updates when possible for better performance.
   */
  flushUpdates() {
    if (this.isDestroyed()) {
      throw new Cesium.DeveloperError("GSplatStreamPrimitive is destroyed.");
    }

    if (this._pendingUpdates.size === 0) return;

    const w = this.size.x | 0;
    const h = this.size.y | 0;

    const pendingIndices = Array.from(this._pendingUpdates);
    if (pendingIndices.length === 0) return;

    let minRow = h;
    let maxRow = 0;
    let minCol = w;
    let maxCol = 0;
    for (const index of pendingIndices) {
      const row = Math.floor(index / w);
      const col = index % w;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
    }

    const rowCount = maxRow - minRow + 1;
    const colCount = maxCol - minCol + 1;
    const updateRatio = (rowCount * colCount) / (h * w);

    this._pendingUpdates.clear();

    if (Cesium.defined(this._context) && w > 0 && h > 0) {
      if (updateRatio < 0.5 && (rowCount < h || colCount < w)) {
        this._updateTexturesPartial(w, h, minRow, rowCount, minCol, colCount, this._context);
      } else {
        this._updateTextures(w, h, this._context);
      }
    }
    this.updatePendingWorldPositions();
    this._dirty = true;
    if (Cesium.defined(this._scene)) {
      this._scene.requestRender();
    }
    
  }

  /**
   * Update world space positions when transform changes.
   * @private
   */
  updatePendingWorldPositions() {
    if (!this._positions || this._validCount === 0) return;
    this._centersSent = false;
  }

  /**
   * Update GPU textures (full update - creates new textures if needed).
   * @private
   */
  _updateTextures(width, height, context) {
    if (!Cesium.defined(context)) {
      context = this._context;
    }
    if (!Cesium.defined(context)) {
      return;
    }
    
    this._context = context;

    if (!Cesium.defined(this.splatColor)) {
    this.splatColor = new Cesium.Texture({
      context: context,
      source: {
        width: width,
        height: height,
        arrayBufferView: this._colorData,
      },
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      skipColorSpaceConversion: true,
      sampler: Cesium.Sampler.NEAREST,
    });
    } else {
      this.splatColor.copyFrom({
        source: {
          width: width,
          height: height,
          arrayBufferView: this._colorData,
        },
        skipColorSpaceConversion: true,
      });
    }

    if (!Cesium.defined(this.transformA)) {
    this.transformA = new Cesium.Texture({
      context: context,
      source: {
        width: width,
        height: height,
        arrayBufferView: this._transformAData,
      },
      pixelFormat: Cesium.PixelFormat.RGBA_INTEGER,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_INT,
      flipY: false,
      skipColorSpaceConversion: true,
      sampler: Cesium.Sampler.NEAREST,
    });
    } else {
      this.transformA.copyFrom({
        source: {
          width: width,
          height: height,
          arrayBufferView: this._transformAData,
        },
        skipColorSpaceConversion: true,
      });
    }

    if (!Cesium.defined(this.transformB)) {
    this.transformB = new Cesium.Texture({
      context: context,
      source: {
        width: width,
        height: height,
        arrayBufferView: this._transformBData,
      },
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.HALF_FLOAT,
      flipY: false,
      skipColorSpaceConversion: true,
      sampler: Cesium.Sampler.NEAREST,
    });
    } else {
      this.transformB.copyFrom({
        source: {
          width: width,
          height: height,
          arrayBufferView: this._transformBData,
        },
        skipColorSpaceConversion: true,
      });
    }

    if (!Cesium.defined(this.splatOrder)) {
    this.splatOrder = new Cesium.Texture({
      context: context,
      source: {
        width: width,
        height: height,
        arrayBufferView: this._orderData,
      },
      pixelFormat: Cesium.PixelFormat.RED_INTEGER,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_INT,
      flipY: false,
      skipColorSpaceConversion: true,
      sampler: Cesium.Sampler.NEAREST,
    });
    } else {
      this.splatOrder.copyFrom({
        source: {
          width: width,
          height: height,
          arrayBufferView: this._orderData,
        },
        skipColorSpaceConversion: true,
      });
    }
  }

  /**
   * Partial update of GPU textures (only update affected region).
   * @private
   * @param {number} width Texture width
   * @param {number} height Texture height
   * @param {number} startRow Starting row index
   * @param {number} rowCount Number of rows to update
   * @param {number} startCol Starting column index
   * @param {number} colCount Number of columns to update
   * @param {Context} context WebGL context
   */
  _updateTexturesPartial(width, height, startRow, rowCount, startCol, colCount, context) {
    if (!Cesium.defined(context)) {
      context = this._context;
    }
    if (!Cesium.defined(context)) {
      return;
    }

    this._context = context;

    if (!Cesium.defined(this.splatColor) || !Cesium.defined(this.transformA) || 
        !Cesium.defined(this.transformB) || !Cesium.defined(this.splatOrder)) {
      this._updateTextures(width, height, context);
      return;
    }

    const bytesPerPixelColor = 4; // RGBA8
    const bytesPerPixelTransformA = 16; // RGBA32U = 4 * 4 bytes
    const bytesPerPixelTransformB = 8; // RGBA16F = 4 * 2 bytes
    const bytesPerPixelOrder = 4; // R32U

    const rowStrideColor = width * bytesPerPixelColor;
    const rowStrideTransformA = width * bytesPerPixelTransformA;
    const rowStrideTransformB = width * bytesPerPixelTransformB;
    const rowStrideOrder = width * bytesPerPixelOrder;

    const partialRowStrideColor = colCount * bytesPerPixelColor;
    const partialRowStrideTransformA = colCount * bytesPerPixelTransformA;
    const partialRowStrideTransformB = colCount * bytesPerPixelTransformB;
    const partialRowStrideOrder = colCount * bytesPerPixelOrder;

    const partialSizeColor = rowCount * partialRowStrideColor;
    const partialSizeTransformA = rowCount * partialRowStrideTransformA;
    const partialSizeTransformB = rowCount * partialRowStrideTransformB;
    const partialSizeOrder = rowCount * partialRowStrideOrder;

    // Create partial views of the data
    // IMPORTANT: We need to create a contiguous copy of the data for WebGL
    // The issue is that when we create a TypedArray view with byteOffset, WebGL's
    // texSubImage2D might not correctly interpret the data alignment.
    // By creating a new contiguous buffer, we ensure proper alignment.
    const partialColorData = new Uint8Array(partialSizeColor);
    const partialTransformAData = new Uint32Array(partialSizeTransformA / 4);
    const partialTransformBData = new Uint16Array(partialSizeTransformB / 2);
    const partialOrderData = new Uint32Array(partialSizeOrder / 4);

    for (let row = 0; row < rowCount; row++) {
      const srcRow = startRow + row;
      const srcRowStartColor = srcRow * rowStrideColor + startCol * bytesPerPixelColor;
      const srcRowStartOrder = srcRow * width + startCol;
      
      const dstRowStartColor = row * partialRowStrideColor;
      const dstRowStartOrder = row * colCount;

      // Copy color data (RGBA8: 4 bytes per pixel)
      partialColorData.set(
        this._colorData.subarray(srcRowStartColor, srcRowStartColor + partialRowStrideColor),
        dstRowStartColor
      );

      // Copy transformA data (RGBA32U: 4 Uint32 elements per pixel)
      const srcTransformAStart = (srcRow * width + startCol) * 4;
      const dstTransformAStart = row * colCount * 4;
      partialTransformAData.set(
        this._transformAData.subarray(srcTransformAStart, srcTransformAStart + colCount * 4),
        dstTransformAStart
      );

      // Copy transformB data (RGBA16F: 4 Uint16 elements per pixel)
      const srcTransformBStart = (srcRow * width + startCol) * 4;
      const dstTransformBStart = row * colCount * 4;
      partialTransformBData.set(
        this._transformBData.subarray(srcTransformBStart, srcTransformBStart + colCount * 4),
        dstTransformBStart
      );

      // Copy order data (R32U: 1 element per pixel)
      partialOrderData.set(
        this._orderData.subarray(srcRowStartOrder, srcRowStartOrder + colCount),
        dstRowStartOrder
      );
    }

    this.splatColor.copyFrom({
      source: {
        width: colCount,
        height: rowCount,
        arrayBufferView: partialColorData,
      },
      xOffset: startCol,
      yOffset: startRow,
      skipColorSpaceConversion: true,
    });

    this.transformA.copyFrom({
      source: {
        width: colCount,
        height: rowCount,
        arrayBufferView: partialTransformAData,
      },
      xOffset: startCol,
      yOffset: startRow,
      skipColorSpaceConversion: true,
    });

    this.transformB.copyFrom({
      source: {
        width: colCount,
        height: rowCount,
        arrayBufferView: partialTransformBData,
      },
      xOffset: startCol,
      yOffset: startRow,
      skipColorSpaceConversion: true,
    });

    this.splatOrder.copyFrom({
      source: {
        width: colCount,
        height: rowCount,
        arrayBufferView: partialOrderData,
      },
      xOffset: startCol,
      yOffset: startRow,
      skipColorSpaceConversion: true,
    });
  }

  /**
   * Set auto-flush threshold.
   * @param {number} threshold Number of pending updates before auto-flush (default: 100)
   */
  setAutoFlushThreshold(threshold) {
    this._autoFlushThreshold = Math.max(1, threshold);
  }

  /**
   * Get current streaming statistics.
   */
  getStreamingStats() {
    return {
      totalCount: this.totalCount,
      validCount: this._validCount,
      pendingUpdates: this._pendingUpdates.size,
      progress: this.totalCount > 0 ? (this._validCount / this.totalCount * 100) : 0
    };
  }

  /**
   * Schedule Web Worker-based sorting task.
   * @param {Cesium.Matrix4} viewMatrix The view matrix
   * @private
   */
  _scheduleOrder(viewMatrix) {
    if (this._validCount === 0) return;

    const transformChanged = false;

    const r = viewMatrix;
    const vx = r[2], vy = r[6], vz = r[10];
    const px = -(r[0] * r[12] + r[1] * r[13] + r[2] * r[14]);
    const py = -(r[4] * r[12] + r[5] * r[13] + r[6] * r[14]);
    const pz = -(r[8] * r[12] + r[9] * r[13] + r[10] * r[14]);

    const now = performance.now();
    const deltaTime = (now - this._lastSentTime) / 1000.0;

    const posHash = Math.floor(px * 1000) ^ Math.floor(py * 1000) ^ Math.floor(pz * 1000);
    const dirHash = Math.floor(vx * 1000) ^ Math.floor(vy * 1000) ^ Math.floor(vz * 1000);
    const hash = posHash ^ dirHash;

    if (hash === this._lastViewMatrixHash && !transformChanged && this._centersSent) {
      return;
    }

    let effectiveThrottle = this._minIntervalMs;
    if (this._adaptiveSorting && this._minIntervalMs > 0) {
      const hashDelta = Math.abs(hash - this._lastViewMatrixHash);
      const speed = hashDelta / Math.max(deltaTime, 0.001);

      if (speed < 1000) {
        effectiveThrottle = this._minIntervalMs;
      } else if (speed < 10000) {
        effectiveThrottle = this._minIntervalMs * 0.5;
      } else {
        effectiveThrottle = this._minIntervalMs * 0.2;
      }

      this._lastCameraSpeed = speed;
    }

    if (now - this._lastSentTime < effectiveThrottle) {
      return;
    }

    this._lastViewMatrixHash = hash;
    this._lastSentTime = now;

    if (!this._sortWorker) {
      this._sortWorker = this._createSortWorker();
      this._sortWorker.onmessage = (ev) => {
        const newOrderBuffer = ev.data.order;
        const total = this.size.x * this.size.y;
        
        const indices = new Uint32Array(newOrderBuffer);
        const validCount = Math.min(this._validCount, indices.length);
        
        let needsUpdate = false;
        if (!this._orderData || this._orderData.length !== total) {
          this._orderData = new Uint32Array(total);
          needsUpdate = true;
        } else if (validCount > 0) {
          const checkPoints = [];
          if (validCount > 0) checkPoints.push(0);
          if (validCount > 1) checkPoints.push(validCount - 1);
          if (validCount > 2) checkPoints.push(Math.floor(validCount / 2));
          if (validCount > 10) {
            checkPoints.push(Math.floor(validCount / 4));
            checkPoints.push(Math.floor(validCount * 3 / 4));
          }
          
          for (const idx of checkPoints) {
            if (this._orderData[idx] !== indices[idx]) {
              needsUpdate = true;
              break;
            }
          }
        } else {
          needsUpdate = true;
        }
        
        if (needsUpdate) {
          if (validCount > 0) {
            this._orderData.set(indices.subarray(0, validCount), 0);
            
            if (validCount < total) {
              const lastIndex = this._validCount > 0 ? this._validCount - 1 : 0;
              const fillSize = total - validCount;
              
              if (fillSize > 100000) {
                let i = validCount;
                const end = total;
                while (i < end - 7) {
                  this._orderData[i++] = lastIndex;
                  this._orderData[i++] = lastIndex;
                  this._orderData[i++] = lastIndex;
                  this._orderData[i++] = lastIndex;
                  this._orderData[i++] = lastIndex;
                  this._orderData[i++] = lastIndex;
                  this._orderData[i++] = lastIndex;
                  this._orderData[i++] = lastIndex;
                }
                while (i < end) {
                  this._orderData[i++] = lastIndex;
                }
              } else {
                this._orderData.fill(lastIndex, validCount, total);
              }
            }
          }
          
          if (Cesium.defined(this.splatOrder) && Cesium.defined(this._context)) {
            this.splatOrder.copyFrom({
              source: {
                width: this.size.x,
                height: this.size.y,
                arrayBufferView: this._orderData,
              },
              skipColorSpaceConversion: true,
            });
          }
        }
        
        const bufferToTransfer = this._orderData.buffer.slice(0);
        this._sortWorker.postMessage({
          order: bufferToTransfer
        }, [bufferToTransfer]);

        const valid = Math.max(0, Math.min(this._validCount, ev.data.count | 0));
        const oldCount = this.texParams ? this.texParams[0] : 0;
        const countChanged = valid !== oldCount;
        
        if (countChanged) {
          this.setCount(valid);
          const newInstanceCount = Math.ceil(valid / this._batchSize);
          if (this.instanceCount !== newInstanceCount) {
            this.instanceCount = newInstanceCount;
            this._dirty = true;
          }
        }
        
        this._workerHasReturned = true;
        this._updateTexParams();
      };

      const centers = new Float32Array(this._validCount * 3);
      let centerIdx = 0;
      const m = this.modelMatrix;
      const localPos = this._positions;
      for (let i = 0; i < this._validCount; i++) {
        if (this._splatSetFlags[i]) {
          const srcIdx = i * 3;
          const x = localPos[srcIdx + 0];
          const y = localPos[srcIdx + 1];
          const z = localPos[srcIdx + 2];
          centers[centerIdx * 3 + 0] = m[0] * x + m[4] * y + m[8] * z + m[12];
          centers[centerIdx * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          centers[centerIdx * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          centerIdx++;
        }
      }

      const actualCenters = centerIdx < this._validCount ? centers.subarray(0, centerIdx * 3) : centers;

      const orderBuffer = new Uint32Array(this.totalCount);
      for (let i = 0; i < this.totalCount; i++) {
        orderBuffer[i] = i < this._validCount ? i : (this._validCount > 0 ? this._validCount - 1 : 0);
      }

      this._sortWorker.postMessage({
          order: orderBuffer.buffer,
        centers: actualCenters.buffer
      }, [orderBuffer.buffer, actualCenters.buffer]);

      this._centersSent = true;
    }

    if (!this._centersSent && this._sortWorker) {
      const centers = new Float32Array(this._validCount * 3);
      let centerIdx = 0;
      const m = this.modelMatrix;
      const localPos = this._positions;
      for (let i = 0; i < this._validCount; i++) {
        if (this._splatSetFlags[i]) {
          const srcIdx = i * 3;
          const x = localPos[srcIdx + 0];
          const y = localPos[srcIdx + 1];
          const z = localPos[srcIdx + 2];
          centers[centerIdx * 3 + 0] = m[0] * x + m[4] * y + m[8] * z + m[12];
          centers[centerIdx * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          centers[centerIdx * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          centerIdx++;
        }
      }
      this._sortWorker.postMessage({
        type: 'centers',
        centers: centers.buffer
      }, [centers.buffer]);
      this._centersSent = true;
    }

    if (Cesium.defined(this._sortWorker)) {
    this._sortWorker.postMessage({
      cameraPosition: { x: px, y: py, z: pz },
        cameraDirection: { x: -vx, y: -vy, z: -vz }
    });
    }
  }

  /**
   * Create Web Worker for sorting.
   * @returns {Worker} The sort worker
   * @private
   */
  _createSortWorker() {
    const workerCode = `
      const compareBits = 16;
      const bucketCount = (2 ** compareBits) + 1;

      let order;
      let centers;
      let cameraPosition;
      let cameraDirection;

      let forceUpdate = false;

      const lastCameraPosition = { x: 0, y: 0, z: 0 };
      const lastCameraDirection = { x: 0, y: 0, z: 0 };

      const boundMin = { x: 0, y: 0, z: 0 };
      const boundMax = { x: 0, y: 0, z: 0 };

      let distances;
      let countBuffer;

      const binarySearch = (m, n, compare_fn) => {
        while (m <= n) {
          const k = (n + m) >> 1;
          const cmp = compare_fn(k);
          if (cmp > 0) {
            m = k + 1;
          } else if (cmp < 0) {
            n = k - 1;
          } else {
            return k;
          }
        }
        return ~m;
      };

      const update = () => {
        if (!order || !centers || !cameraPosition || !cameraDirection) return;

        const px = cameraPosition.x;
        const py = cameraPosition.y;
        const pz = cameraPosition.z;
        const dx = cameraDirection.x;
        const dy = cameraDirection.y;
        const dz = cameraDirection.z;

        const epsilon = 0.001;

        if (!forceUpdate &&
            Math.abs(px - lastCameraPosition.x) < epsilon &&
            Math.abs(py - lastCameraPosition.y) < epsilon &&
            Math.abs(pz - lastCameraPosition.z) < epsilon &&
            Math.abs(dx - lastCameraDirection.x) < epsilon &&
            Math.abs(dy - lastCameraDirection.y) < epsilon &&
            Math.abs(dz - lastCameraDirection.z) < epsilon) {
          return;
        }

        forceUpdate = false;

        lastCameraPosition.x = px;
        lastCameraPosition.y = py;
        lastCameraPosition.z = pz;
        lastCameraDirection.x = dx;
        lastCameraDirection.y = dy;
        lastCameraDirection.z = dz;

        const numVertices = centers.length / 3;
        if (distances?.length !== numVertices) {
          distances = new Uint32Array(numVertices);
        }

        let minDist;
        let maxDist;
        for (let i = 0; i < 8; ++i) {
          const x = (i & 1 ? boundMin.x : boundMax.x) - px;
          const y = (i & 2 ? boundMin.y : boundMax.y) - py;
          const z = (i & 4 ? boundMin.z : boundMax.z) - pz;
          const d = x * dx + y * dy + z * dz;
          if (i === 0) {
            minDist = maxDist = d;
          } else {
            minDist = Math.min(minDist, d);
            maxDist = Math.max(maxDist, d);
          }
        }

        if (!countBuffer) {
          countBuffer = new Uint32Array(bucketCount);
        } else {
          countBuffer.fill(0);
        }

        const range = maxDist - minDist;
        const divider = (range < 1e-6) ? 0 : 1 / range * (2 ** compareBits);
        for (let i = 0; i < numVertices; ++i) {
          const istride = i * 3;
          const x = centers[istride + 0] - px;
          const y = centers[istride + 1] - py;
          const z = centers[istride + 2] - pz;
          const d = x * dx + y * dy + z * dz;
          // Invert sortKey so larger distances (farther) get smaller sortKey values
          // This makes the radix sort produce far-to-near order directly
          const sortKey = bucketCount - 1 - Math.floor((d - minDist) * divider);

          distances[i] = sortKey;
          countBuffer[sortKey]++;
        }

        // Cumulative count: countBuffer[i] = count of elements with sortKey <= i
        for (let i = 1; i < bucketCount; i++) {
          countBuffer[i] += countBuffer[i - 1];
        }

        // Standard radix sort: produces near-to-far order, but since we inverted sortKey,
        // this actually gives us far-to-near order (back-to-front for alpha blending)
        for (let i = 0; i < numVertices; i++) {
          const distance = distances[i];
          const destIndex = --countBuffer[distance];
          order[destIndex] = i;
        }

        // Calculate actual distance from camera (handle divider = 0 case)
        const dist = i => {
          if (divider === 0) {
            // All splats are at same distance, use original distance calculation
            const istride = order[i] * 3;
            const x = centers[istride + 0] - px;
            const y = centers[istride + 1] - py;
            const z = centers[istride + 2] - pz;
            return x * dx + y * dy + z * dz;
          }
          // Recover original sortKey from inverted sortKey, then calculate distance
          const invertedSortKey = distances[order[i]];
          const originalSortKey = bucketCount - 1 - invertedSortKey;
          return originalSortKey / divider + minDist;
        };
        const findZero = () => {
          // Binary search for first index where dist(i) >= 0
          // compare_fn returns: > 0 if dist(i) < 0 (behind camera), < 0 if dist(i) > 0 (in front), = 0 if dist(i) == 0
          const result = binarySearch(0, numVertices - 1, i => -dist(i));
          if (result < 0) {
            // Not found: all splats are in front of camera (result = ~0 = -1) or all behind (result = ~numVertices)
            // Check first splat to determine which case
            if (dist(0) >= 0) {
              // All splats in front, return numVertices
              return numVertices;
            } else {
              // All splats behind, return 0
              return 0;
            }
          }
          return result;
        };
        const count = dist(numVertices - 1) >= 0 ? findZero() : numVertices;

        // Debug: log count calculation if suspicious
        // if (count === 1 && numVertices > 1) {
        //   const lastDist = dist(numVertices - 1);
        //   const firstDist = dist(0);
        //   console.log('[Worker] count=' + count + ', numVertices=' + numVertices + ', divider=' + divider + ', minDist=' + minDist + ', maxDist=' + maxDist + ', firstDist=' + firstDist + ', lastDist=' + lastDist);
        // }

        // Send results
        self.postMessage({
          order: order.buffer,
          count
        }, [order.buffer]);

        order = null;
      };

      self.onmessage = (message) => {
        if (message.data.order) {
          order = new Uint32Array(message.data.order);
        }
        if (message.data.centers) {
          centers = new Float32Array(message.data.centers);

          boundMin.x = boundMax.x = centers[0];
          boundMin.y = boundMax.y = centers[1];
          boundMin.z = boundMax.z = centers[2];

          const numVertices = centers.length / 3;
          for (let i = 1; i < numVertices; ++i) {
            const x = centers[i * 3 + 0];
            const y = centers[i * 3 + 1];
            const z = centers[i * 3 + 2];

            boundMin.x = Math.min(boundMin.x, x);
            boundMin.y = Math.min(boundMin.y, y);
            boundMin.z = Math.min(boundMin.z, z);

            boundMax.x = Math.max(boundMax.x, x);
            boundMax.y = Math.max(boundMax.y, y);
            boundMax.z = Math.max(boundMax.z, z);
          }
          forceUpdate = true;
        }
        if (message.data.cameraPosition) cameraPosition = message.data.cameraPosition;
        if (message.data.cameraDirection) cameraDirection = message.data.cameraDirection;

        update();
      };
    `;

    const blob = new Blob([workerCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    return new Worker(url);
  }

  /**
   * Set visibility boost factor.
   * @param {number} v Visibility boost value
   */
  setVisBoost(v) {
    if (Cesium.defined(this.texParams)) {
      this.texParams[3] = Math.max(0.0, v);
      this._texParamDirty = true;
    }
  }

  /**
   * Set count.
   * Updates texParams[0] with valid count (after camera back culling).
   * @param {number} c Valid count
   */
  setCount(c) {
    if (Cesium.defined(this.texParams)) {
      this.texParams[0] = Math.max(0, c);
      this._texParamDirty = true;
    }
  }

  /**
   * Update texture parameters.
   * @private
   */
  _updateTexParams() {
    if (this._texParamDirty && Cesium.defined(this.texParams)) {
      const oldTexWidth = this.texParams[1];
      this.texParams[1] = this.size.x;
      
      // texParams[0] (numSplats) is updated by setCount() called from worker callback
      // Before worker returns for the first time, texParams[0] should equal _validCount
      // After worker returns, setCount(valid) will update it (valid may be <= _validCount due to back-face culling)
      const oldNumSplats = this.texParams[0];
      if (!this._workerHasReturned) {
        this.texParams[0] = this._validCount;
      }
      // If worker has returned, texParams[0] is managed by setCount() and should not be changed here
      
      // Debug: log when values change
      // if (oldNumSplats !== this.texParams[0] || oldTexWidth !== this.texParams[1]) {
      //   console.log(`[GSplatStream] _updateTexParams: numSplats=${oldNumSplats}->${this.texParams[0]}, texWidth=${oldTexWidth}->${this.texParams[1]}, _validCount=${this._validCount}, _workerHasReturned=${this._workerHasReturned}`);
      // }
      
      // texParams[2] is reserved
      // texParams[3] is visBoost (set during initialization or via setVisBoost)
      this._texParamDirty = false;
    }
  }

  /**
   * Set sort throttle interval (milliseconds).
   * @param {number} ms Throttle interval in milliseconds
   */
  setSortThrottle(ms) {
    this._minIntervalMs = Math.max(0, (ms | 0));
  }

  /**
   * Enable/disable adaptive sorting.
   * @param {boolean} enabled Whether to enable adaptive sorting
   */
  setAdaptiveSorting(enabled) {
    this._adaptiveSorting = enabled;
  }

  /**
   * Set pixel coverage culling thresholds.
   * @param {number} minPixels Minimum pixel coverage
   * @param {number} maxPixels Maximum pixel coverage (0 = disabled)
   * @param {number} maxPixelCullDistance Maximum distance for pixel culling (0 = disabled)
   */
  setPixelCulling(minPixels, maxPixels = 0, maxPixelCullDistance = 0) {
    this._minPixelCoverage = Math.max(0, minPixels);
    this._maxPixelCoverage = Math.max(0, maxPixels);
    this._maxPixelCullDistance = Math.max(0, maxPixelCullDistance);
  }

  /**
   * Get current pixel culling settings.
   */
  getPixelCullingStats() {
    return {
      minPixels: this._minPixelCoverage,
      maxPixels: this._maxPixelCoverage,
      maxPixelCullDistance: this._maxPixelCullDistance,
      maxEnabled: this._maxPixelCoverage > 0,
      distanceEnabled: this._maxPixelCullDistance > 0
    };
  }

  /**
   * Get batching statistics.
   */
  getBatchingStats() {
    return {
      enabled: true,
      batchSize: this._batchSize,
      instanceCount: this.instanceCount,
      splatCount: this._validCount,
      reduction: this._validCount > 0 ? (1 - this.instanceCount / this._validCount) * 100 : 0
    };
  }

  /**
   * Calculate texture size for given splat count.
   * @private
   */
  evalTextureSize(count) {
    let w = Math.ceil(Math.sqrt(count));
    const align = 64;
    w = Math.ceil(w / align) * align;
    const h = Math.ceil(count / w);
    return { x: w, y: h };
  }

  /**
   * Build DrawCommand for rendering.
   * @param {FrameState} frameState The frame state
   * @private
   */
  _buildDrawCommand(frameState) {
    if (this._validCount === 0) {
      this._drawCommand = undefined;
      return;
    }

    if (!Cesium.defined(this.splatColor) || !Cesium.defined(this.transformA) || 
        !Cesium.defined(this.transformB) || !Cesium.defined(this.splatOrder)) {
      this._drawCommand = undefined;
      return;
    }

    const context = frameState.context;
    this._context = context;

    const shaderBuilder = new Cesium.ShaderBuilder();

    shaderBuilder.addAttribute("vec2", "a_screenQuadPosition");
    shaderBuilder.addAttribute("float", "a_localSplatIndex");

    shaderBuilder.addVarying("vec4", "v_splatColor");
    shaderBuilder.addVarying("vec2", "v_vertPos");

    shaderBuilder.addUniform(
      "sampler2D",
      "u_splatColor",
      Cesium.ShaderDestination.VERTEX
    );
    shaderBuilder.addUniform(
      "highp usampler2D",
      "u_transformA",
      Cesium.ShaderDestination.VERTEX
    );
    shaderBuilder.addUniform(
      "sampler2D",
      "u_transformB",
      Cesium.ShaderDestination.VERTEX
    );
    shaderBuilder.addUniform(
      "highp usampler2D",
      "u_splatOrder",
      Cesium.ShaderDestination.VERTEX
    );
    shaderBuilder.addUniform("vec4", "u_texParams", Cesium.ShaderDestination.VERTEX);
    shaderBuilder.addUniform("mat4", "u_modelMatrix", Cesium.ShaderDestination.VERTEX);
    shaderBuilder.addUniform("vec4", "u_pixelCull", Cesium.ShaderDestination.VERTEX);

    shaderBuilder.addVertexLines(GSplatStreamVS);
    shaderBuilder.addFragmentLines(GSplatStreamFS);

    const shaderProgram = shaderBuilder.buildShaderProgram(context);
    this._shaderProgram = shaderProgram;
    this._shaderBuilder = shaderBuilder;

    const uniformMap = {
      u_splatColor: () => {
        if (!Cesium.defined(this.splatColor)) {
          return undefined;
        }
        return this.splatColor;
      },
      u_transformA: () => {
        if (!Cesium.defined(this.transformA)) {
          return undefined;
        }
        return this.transformA;
      },
      u_transformB: () => {
        if (!Cesium.defined(this.transformB)) {
          return undefined;
        }
        return this.transformB;
      },
      u_splatOrder: () => {
        if (!Cesium.defined(this.splatOrder)) {
          return undefined;
        }
        return this.splatOrder;
      },
      u_texParams: () => {
        if (!Cesium.defined(this.texParams) || this.texParams.length !== 4) {
          return new Cesium.Cartesian4(0, 0, 0, 1.0);
        }
        if (!this._workerHasReturned && this.texParams[0] !== this._validCount) {
          this.texParams[0] = this._validCount;
        }
        return new Cesium.Cartesian4(
          this.texParams[0],
          this.texParams[1],
          this.texParams[2],
          this.texParams[3]
        );
      },
      u_modelMatrix: () => this.modelMatrix,
      u_pixelCull: () => {
        return new Cesium.Cartesian4(
          this._minPixelCoverage,
          this._maxPixelCoverage,
          this._maxPixelCullDistance,
          this._batchSize
        );
      },
    };
    this._uniformMap = uniformMap;

    const renderStateOptions = Cesium.RenderState.getState(
      Cesium.RenderState.fromCache({
        depthTest: {
          enabled: true,
          func: Cesium.DepthFunction.LESS_OR_EQUAL,
        },
        depthMask: false,
        cull: {
          enabled: false,
        },
        blending: Cesium.BlendingState.PRE_MULTIPLIED_ALPHA_BLEND,
      })
    );
    const renderState = Cesium.RenderState.fromCache(renderStateOptions);
    this._renderState = renderState;

    if (!Cesium.defined(this._vertexArray)) {
      const geometry = this._geometry.getGeometry();
      
      let screenQuadLocation = 1;
      let localSplatLocation = 2;
      
      if (shaderBuilder && shaderBuilder.attributeLocations) {
        const attrLocs = shaderBuilder.attributeLocations;
        if (attrLocs['a_screenQuadPosition'] !== undefined) {
          screenQuadLocation = attrLocs['a_screenQuadPosition'];
        }
        if (attrLocs['a_localSplatIndex'] !== undefined) {
          localSplatLocation = attrLocs['a_localSplatIndex'];
        }
      }
      
      const attributeLocations = {
        screenQuadPosition: screenQuadLocation,
        localSplatIndex: localSplatLocation,
      };
      
      this._vertexArray = Cesium.VertexArray.fromGeometry({
        context: context,
        geometry: geometry,
        attributeLocations: attributeLocations,
        bufferUsage: Cesium.BufferUsage.STATIC_DRAW,
        interleave: false,
      });
    }

    this.instanceCount = this._validCount > 0 ? Math.ceil(this._validCount / this._batchSize) : 0;

    if (!Cesium.defined(this.boundingSphere)) {
      this.boundingSphere = Cesium.BoundingSphere.fromVertices(this._positions);
    }

    const command = new Cesium.DrawCommand({
      boundingVolume: this.boundingSphere,
      modelMatrix: this.modelMatrix,
      uniformMap: uniformMap,
      renderState: renderState,
      vertexArray: this._vertexArray,
      shaderProgram: shaderProgram,
      cull: false,
      pass: Cesium.Pass.GAUSSIAN_SPLATS,
      count: this._geometry.getIndexCount(),
      owner: this,
      instanceCount: this.instanceCount,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      debugShowBoundingVolume: this.debugShowBoundingVolume,
      castShadows: false,
      receiveShadows: false,
    });

    this._drawCommand = command;
  }

  /**
   * Update the primitive for the current frame.
   * @param {FrameState} frameState The frame state
   */
  update(frameState) {
    const currentTimeStamp = new Date().getTime();
    const timeDiff = currentTimeStamp - this.lastTimeStamp;
    this.lastTimeStamp = currentTimeStamp;

    if (this.isDestroyed()) {
      return;
    }

    if (!this.show) {
      return;
    }

    if (Cesium.defined(this._drawCommand)) {
      frameState.commandList.push(this._drawCommand);
    }

    // Check pick pass
    if (frameState.passes.pick) {
      return;
    }

    if (this._validCount > 0 && Cesium.defined(frameState.camera) && this._frameCount % 10 === 0) {
      const viewMatrix = frameState.camera.viewMatrix;
      if (Cesium.defined(viewMatrix)) {
        this._scheduleOrder(viewMatrix);
      }
    }

    if (this._pendingUpdates.size > 0 && (this._frameCount >= this.flushFrameLimit || timeDiff >= this.flushInterval)) {
      this.flushUpdates();
    }
    if (this._frameCount >= this.flushFrameLimit && this._pendingUpdates.size === 0) {
      this._frameCount = 0;
    }
    this._frameCount++;

    this._updateTexParams();
    
    if (Cesium.defined(frameState.camera) && Cesium.defined(frameState.camera.viewMatrix)) {
      if (!this._dirty && Cesium.Matrix4.equals(frameState.camera.viewMatrix, this._prevViewMatrix)) {
        return;
      }
    }

    if (
      Cesium.defined(this._colorData) &&
      Cesium.defined(frameState.context) &&
      this.totalCount > 0 &&
      !Cesium.defined(this.splatColor)
    ) {
      this._updateTextures(this.size.x, this.size.y, frameState.context);
      this._dirty = true;
    }

    const currentParams = `${this._minPixelCoverage},${this._maxPixelCoverage},${this._maxPixelCullDistance},${this._batchSize}`;
    if (currentParams !== this._lastPixelCullParams) {
      this._lastPixelCullParams = currentParams;
    }

    if ((this._dirty || !Cesium.defined(this._drawCommand)) &&
        Cesium.defined(this.splatColor) && Cesium.defined(this.transformA) &&
        Cesium.defined(this.transformB) && Cesium.defined(this.splatOrder)) {
      this._buildDrawCommand(frameState);
      this._dirty = false;
    }

    if (Cesium.defined(frameState.camera) && Cesium.defined(frameState.camera.viewMatrix)) {
      Cesium.Matrix4.clone(frameState.camera.viewMatrix, this._prevViewMatrix);
    }
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * @returns {boolean} True if destroyed
   */
  isDestroyed() {
    return this._isDestroyed;
  }

  /**
   * Destroys the primitive and releases its resources.
   * @returns {undefined}
   */
  destroy() {
    if (this.isDestroyed()) {
      return undefined;
    }

    if (Cesium.defined(this._sortWorker)) {
      this._sortWorker.terminate();
      this._sortWorker = undefined;
    }

    if (Cesium.defined(this.splatColor)) {
      this.splatColor.destroy();
      this.splatColor = undefined;
    }
    if (Cesium.defined(this.transformA)) {
      this.transformA.destroy();
      this.transformA = undefined;
    }
    if (Cesium.defined(this.transformB)) {
      this.transformB.destroy();
      this.transformB = undefined;
    }
    if (Cesium.defined(this.splatOrder)) {
      this.splatOrder.destroy();
      this.splatOrder = undefined;
    }

    if (Cesium.defined(this._vertexArray)) {
      this._vertexArray.destroy();
      this._vertexArray = undefined;
    }
    if (Cesium.defined(this._shaderProgram)) {
      this._shaderProgram.destroy();
      this._shaderProgram = undefined;
    }

    this._positions = undefined;
    this._orderData = undefined;
    this._colorData = undefined;
    this._transformAData = undefined;
    this._transformBData = undefined;
    this.texParams = undefined;
    this._splatSetFlags = undefined;
    this._pendingUpdates.clear();

    return Cesium.destroyObject(this);
  }
}

export default GSplatStreamPrimitive;