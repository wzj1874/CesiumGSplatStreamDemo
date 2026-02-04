/**
 * Streaming Gaussian Splat Parser
 * 
 * Supports progressive loading and rendering of Gaussian Splat files.
 * Parses header first, then streams vertex data as it arrives.
 */

import { PlyStreamParser } from './PlyStreamParser';

export class StreamingGaussianSplatParser {
    constructor() {
      this._streamParser = null;
      this._primitive = null;
      this._chunksPerBatch = 10000;
      this._headerParsed = false;
      this._onHeaderParsed = null;
      this._cancelled = false;
    }

    /**
     * Initialize streaming parser
     * @param {number} contentLength Total content length (if known)
     * @param {Function} onHeaderParsed Optional callback when header is parsed (parser is ready)
     */
    async initStream(contentLength, onHeaderParsed) {
      this._onHeaderParsed = onHeaderParsed || null;
    }

    /**
     * Set the primitive to receive parsed data
     * @param {GSplatStreamPrimitive} primitive The primitive instance
     */
    setPrimitive(primitive) {
      this._primitive = primitive;
      
      this._streamParser = new PlyStreamParser(
        (header) => {
          if (this._primitive) {
            this._primitive.initCount(header.vertexCount);
          }
          this._headerParsed = true;
          if (this._onHeaderParsed) {
            this._onHeaderParsed();
          }
        },
        (splatData, index) => {
          if (this._primitive) {
            this._primitive.setSplatData(index, splatData);
          }
        },
        this._chunksPerBatch
      );
    }

    /**
     * Process incoming data chunk
     * @param {Uint8Array} chunk Data chunk
     * @param {number} receivedLength Total bytes received so far
     * @param {number} contentLength Total content length (if known)
     */
    async processChunk(chunk, receivedLength, contentLength) {
      if (this._cancelled || !this._streamParser) return;
      this._streamParser.processChunk(chunk);
    }

    /**
     * Cancel streaming loading
     */
    cancel() {
      this._cancelled = true;
      if (this._streamParser) {
        this._streamParser.cancel();
      }
    }

    /**
     * Check if loading is cancelled
     */
    isCancelled() {
      return this._cancelled;
    }

    /**
     * Finalize streaming parsing
     */
    async finalizeStream() {
      // Finalize is handled by the stream parser automatically
    }

    /**
     * Get parsing progress
     */
    getProgress() {
      if (this._streamParser) {
        return this._streamParser.getProgress();
      }
      return { processed: 0, total: 0, percentage: 0 };
    }

    /**
     * Check if parser is ready (header parsed)
     */
    verification() {
      return this._headerParsed && !!this._primitive;
    }
  }


