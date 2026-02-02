/**
 * Streaming PLY parser for Gaussian Splatting
 * 
 * Handles incremental parsing of PLY binary data as chunks arrive.
 * Maintains state to handle partial vertex data at chunk boundaries.
 */

import { byteSizeOfType, readByType } from './PlyUtils';

const splatProperties = ["x", "y", "z", "scale_0", "scale_1", "scale_2", "opacity", "rot_0", "rot_1", "rot_2", "rot_3"];
const splatColorProperties = ["red", "green", "blue", "f_dc_0", "f_dc_1", "f_dc_2"];

const PlyMode = {
  Splat: 0,
  PointCloud: 1,
  Mesh: 2
};

export class PlyStreamParser {
    constructor(onHeaderParsed, onSplatParsed, batchSize = 1000) {
      this._onHeaderParsed = onHeaderParsed;
      this._onSplatParsed = onSplatParsed;
      this._batchSize = batchSize;
      
      this._header = null;
      this._headerBuffer = new Uint8Array(4096);
      this._headerLength = 0;
      this._headerParsed = false;
      
      this._dataBuffer = null;
      this._dataOffset = 0;
      this._processedVertices = 0;
      this._vertexStride = 0;
      this._propOffsets = [];
      this._properties = [];
      this._cancelled = false;
    }

    processChunk(chunk) {
      if (this._cancelled) return;
      
      if (!this._headerParsed) {
        this._processHeaderChunk(chunk);
      } else {
        this._processDataChunk(chunk);
      }
    }

    cancel() {
      this._cancelled = true;
    }

    isCancelled() {
      return this._cancelled;
    }

    _processHeaderChunk(chunk) {
      const needed = this._headerLength + chunk.length;
      if (needed > this._headerBuffer.length) {
        const newBuffer = new Uint8Array(Math.max(needed, this._headerBuffer.length * 2));
        newBuffer.set(this._headerBuffer.subarray(0, this._headerLength));
        this._headerBuffer = newBuffer;
      }
      this._headerBuffer.set(chunk, this._headerLength);
      this._headerLength += chunk.length;

      const headerText = new TextDecoder('utf-8').decode(
        this._headerBuffer.subarray(0, this._headerLength)
      );

      const headerEnd = headerText.indexOf('end_header\n');
      if (headerEnd >= 0) {
        const headerEndPos = headerEnd + 'end_header\n'.length;
        const headerBuffer = this._headerBuffer.subarray(0, headerEndPos);
        
        const headerArrayBuffer = headerBuffer.buffer.slice(
          headerBuffer.byteOffset, 
          headerBuffer.byteOffset + headerBuffer.byteLength
        );
        const header = this._parseHeader(headerArrayBuffer);
        this._header = header;
        this._headerParsed = true;

        this._initializeDataParsing(header);
        
        if (this._onHeaderParsed) {
          this._onHeaderParsed(header);
        }

        const chunkStartInHeader = this._headerLength - chunk.length;
        const remainingStartInChunk = headerEndPos - chunkStartInHeader;
        if (remainingStartInChunk > 0 && remainingStartInChunk < chunk.length) {
          const remainingChunk = chunk.subarray(remainingStartInChunk);
          this._processDataChunk(remainingChunk);
        } else if (remainingStartInChunk === 0) {
          this._processDataChunk(chunk);
        }
      }
    }

    _parseHeader(buffer) {
      const ascii = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
      const headerEnd = ascii.indexOf('end_header\n');
      if (headerEnd < 0) {
        throw new Error('PLY: Invalid PLY header');
      }

      const headerText = ascii.substring(0, headerEnd + 'end_header\n'.length);
      const lines = headerText.split(/\r?\n/);
      
      let format = '';
      let vertexCount = 0;
      let faceCount = 0;
      const properties = [];
      const faceProperties = [];
      const textureFiles = [];

      let inVertexElement = false;
      let inFaceElement = false;
      for (const line of lines) {
        if (line.startsWith('format ')) {
          format = line.split(/\s+/)[1];
        } else if (line.startsWith('comment TextureFile ')) {
          const texturePath = line.substring('comment TextureFile '.length).trim();
          if (texturePath) {
            textureFiles.push(texturePath);
          }
        } else if (line.startsWith('element ')) {
          const toks = line.split(/\s+/);
          inVertexElement = toks[1] === 'vertex';
          inFaceElement = toks[1] === 'face';
          if (inVertexElement) {
            vertexCount = parseInt(toks[2]);
            inFaceElement = false;
          }
          if (inFaceElement) {
            faceCount = parseInt(toks[2]);
            inVertexElement = false;
          }
        } else if (inVertexElement && line.startsWith('property ')) {
          const toks = line.split(/\s+/);
          const type = toks[1];
          const name = toks[2];
          properties.push({ name, type });
        } else if (inFaceElement && line.startsWith('property ')) {
          const toks = line.split(/\s+/);
          if (toks[1] === 'list') {
            const countType = toks[2];
            const itemType = toks[3];
            const name = toks[4];
            faceProperties.push({ name, type: `list ${countType} ${itemType}` });
          } else {
            const type = toks[1];
            const name = toks[2];
            faceProperties.push({ name, type });
          }
        }
      }

      if (format !== 'binary_little_endian' && format !== 'ascii') {
        throw new Error(`PLY: Unsupported format: ${format}`);
      }

      let splatPropertyCount = 0;
      let splatPropertyColorCount = 0;
      for (const property of properties) {
        if (splatProperties.includes(property.name)) {
          splatPropertyCount++;
        }
        if (splatColorProperties.includes(property.name)) {
          splatPropertyColorCount++;
        }
      }

      let mode;
      if (faceCount > 0) {
        mode = PlyMode.Mesh;
      } else if (splatPropertyCount === splatProperties.length && splatPropertyColorCount === 3) {
        mode = PlyMode.Splat;
      } else {
        mode = PlyMode.PointCloud;
      }

      return {
        format,
        vertexCount,
        faceCount,
        properties,
        faceProperties: faceProperties.length > 0 ? faceProperties : undefined,
        textureFiles,
        headerByteLength: headerText.length,
        mode,
      };
    }

    _initializeDataParsing(header) {
      this._properties = header.properties;
      
      this._propOffsets = [];
      this._vertexStride = 0;
      for (const p of this._properties) {
        this._propOffsets.push(this._vertexStride);
        this._vertexStride += byteSizeOfType(p.type);
      }

      const estimatedSize = header.vertexCount * this._vertexStride;
      this._dataBuffer = new Uint8Array(Math.min(estimatedSize, 1024 * 1024 * 10));
      this._dataOffset = 0;
      this._processedVertices = 0;
    }

    _processDataChunk(chunk) {
      if (!this._header || !this._dataBuffer) return;

      const needed = this._dataOffset + chunk.length;
      if (needed > this._dataBuffer.length) {
        const newSize = Math.max(needed, this._dataBuffer.length * 2);
        const newBuffer = new Uint8Array(newSize);
        newBuffer.set(this._dataBuffer);
        this._dataBuffer = newBuffer;
      }

      this._dataBuffer.set(chunk, this._dataOffset);
      this._dataOffset += chunk.length;

      this._parseVertices();
    }

    _parseVertices() {
      if (!this._header || !this._dataBuffer) return;

      const payload = new DataView(
        this._dataBuffer.buffer, 
        this._dataBuffer.byteOffset, 
        this._dataBuffer.byteLength
      );
      const vertexCount = this._header.vertexCount;
      
      const has = (n) => this._properties.find((p) => p.name === n) != null;
      const propIndex = (n) => this._properties.findIndex((p) => p.name === n);

      while (this._processedVertices < vertexCount && !this._cancelled) {
        const v = this._processedVertices;
        const vOffset = v * this._vertexStride;

        if (vOffset + this._vertexStride > this._dataOffset) {
          break;
        }

        if (this._cancelled) {
          break;
        }

        const ix = propIndex('x');
        const iy = propIndex('y');
        const iz = propIndex('z');
        if (ix < 0 || iy < 0 || iz < 0) {
          throw new Error('PLY: Missing required x/y/z properties for vertex');
        }

        const splatData = {
          position: [
          readByType(payload, vOffset + this._propOffsets[ix], this._properties[ix].type),
          readByType(payload, vOffset + this._propOffsets[iy], this._properties[iy].type),
          readByType(payload, vOffset + this._propOffsets[iz], this._properties[iz].type),
          ],
        };

        if (has('scale_0')) {
          splatData.scale = [
            readByType(payload, vOffset + this._propOffsets[propIndex('scale_0')], this._properties[propIndex('scale_0')].type),
            readByType(payload, vOffset + this._propOffsets[propIndex('scale_1')], this._properties[propIndex('scale_1')].type),
            readByType(payload, vOffset + this._propOffsets[propIndex('scale_2')], this._properties[propIndex('scale_2')].type),
          ];
        }

        if (has('rot_0')) {
          const w = readByType(payload, vOffset + this._propOffsets[propIndex('rot_0')], this._properties[propIndex('rot_0')].type);
          const x = readByType(payload, vOffset + this._propOffsets[propIndex('rot_1')], this._properties[propIndex('rot_1')].type);
          const y = readByType(payload, vOffset + this._propOffsets[propIndex('rot_2')], this._properties[propIndex('rot_2')].type);
          const z = readByType(payload, vOffset + this._propOffsets[propIndex('rot_3')], this._properties[propIndex('rot_3')].type);
          splatData.rotation = [x, y, z, w];
        }

        if (has('opacity')) {
          splatData.opacity = readByType(payload, vOffset + this._propOffsets[propIndex('opacity')], this._properties[propIndex('opacity')].type);
        }

        const dcIdx = [propIndex('f_dc_0'), propIndex('f_dc_1'), propIndex('f_dc_2')];
        if (dcIdx[0] >= 0 && dcIdx[1] >= 0 && dcIdx[2] >= 0) {
          const restIndices = [];
          for (let i = 0; i < this._properties.length; i++) {
            if (this._properties[i].name.startsWith('f_rest_')) restIndices.push(i);
          }
          const coeffsPerColor = 1 + restIndices.length / 3;
          const coeffs = new Float32Array(coeffsPerColor * 3);
          
          coeffs[0] = readByType(payload, vOffset + this._propOffsets[dcIdx[0]], this._properties[dcIdx[0]].type);
          coeffs[coeffsPerColor + 0] = readByType(payload, vOffset + this._propOffsets[dcIdx[1]], this._properties[dcIdx[1]].type);
          coeffs[2 * coeffsPerColor + 0] = readByType(payload, vOffset + this._propOffsets[dcIdx[2]], this._properties[dcIdx[2]].type);
          
          let rPtr = 1;
          let gPtr = 1;
          let bPtr = 1;
          for (let i = 0; i < restIndices.length; i += 3) {
            const ri = restIndices[i + 0];
            const gi = restIndices[i + 1];
            const bi = restIndices[i + 2];
            coeffs[rPtr] = readByType(payload, vOffset + this._propOffsets[ri], this._properties[ri].type);
            coeffs[coeffsPerColor + gPtr] = readByType(payload, vOffset + this._propOffsets[gi], this._properties[gi].type);
            coeffs[2 * coeffsPerColor + bPtr] = readByType(payload, vOffset + this._propOffsets[bi], this._properties[bi].type);
            rPtr++;
            gPtr++;
            bPtr++;
          }

          splatData.sh = {
            order: Math.floor(Math.sqrt(coeffsPerColor)),
            coeffs: coeffs,
          };
        }

        if (this._onSplatParsed) {
          this._onSplatParsed(splatData, v);
        }

        this._processedVertices++;

        if (this._processedVertices % this._batchSize === 0) {
          setTimeout(() => {
            this._parseVertices();
          }, 0);
          return;
        }
      }
    }

    getProgress() {
      const total = this._header?.vertexCount || 0;
      return {
        processed: this._processedVertices,
        total,
        percentage: total > 0 ? (this._processedVertices / total) * 100 : 0,
      };
    }
  }


