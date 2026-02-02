import * as Cesium from 'cesium';
/**
 * GSplat Stream Geometry
 * Creates geometry for batch rendering of Gaussian splats.
 * - batchSize splats per draw call (default 128)
 * - Each splat = 4 vertices (x, y, local_index)
 * - Each splat = 6 indices (2 triangles)
 * 
 * @constructor
 * @param {number} [batchSize=128] Number of splats per batch
 */
class GSplatStreamGeometry {
  constructor(batchSize = 128) {
    this.batchSize = batchSize;
    this._geometry = this._createGeometry();
  }

  /**
   * Create the geometry with batchSize quads
   * @private
   */
  _createGeometry() {
    const batchSize = this.batchSize;
    
    // Build vertex positions
    // Each vertex: (x, y, local_splat_index)
    // x, y: quad corner coordinates (-1 to 1)
    // local_splat_index: index within the batch (0 to batchSize-1)
    const meshPositions = new Float32Array(12 * batchSize); // 3 components * 4 vertices * batchSize
    for (let i = 0; i < batchSize; ++i) {
      const baseIdx = i * 12;
      // Quad vertices: (-1,-1), (1,-1), (1,1), (-1,1)
      meshPositions[baseIdx + 0] = -1; meshPositions[baseIdx + 1] = -1; meshPositions[baseIdx + 2] = i;
      meshPositions[baseIdx + 3] =  1; meshPositions[baseIdx + 4] = -1; meshPositions[baseIdx + 5] = i;
      meshPositions[baseIdx + 6] =  1; meshPositions[baseIdx + 7] =  1; meshPositions[baseIdx + 8] = i;
      meshPositions[baseIdx + 9] = -1; meshPositions[baseIdx + 10] = 1; meshPositions[baseIdx + 11] = i;
    }
    
    // Cesium uses TRIANGLE_STRIP, so we need to match that format
    // For TRIANGLE_STRIP with 4 vertices: no index buffer needed, vertices are used directly
    // Vertex order: (-1,-1), (1,-1), (1,1), (-1,1)
    // This creates triangles: [0,1,2] and [1,2,3]
    
    // Split meshPositions into two attributes
    const quadPositions = new Float32Array(8 * batchSize); // 2 components * 4 vertices * batchSize
    const localIndices = new Float32Array(4 * batchSize); // 1 component * 4 vertices * batchSize
    
    for (let i = 0; i < batchSize; ++i) {
      const baseIdx = i * 8;
      const idxBase = i * 4;
      // Quad positions matching Cesium's order: (-1,-1), (1,-1), (1,1), (-1,1)
      // This matches TRIANGLE_STRIP vertex order
      quadPositions[baseIdx + 0] = -1; quadPositions[baseIdx + 1] = -1;
      quadPositions[baseIdx + 2] =  1; quadPositions[baseIdx + 3] = -1;
      quadPositions[baseIdx + 4] =  1; quadPositions[baseIdx + 5] =  1;
      quadPositions[baseIdx + 6] = -1; quadPositions[baseIdx + 7] =  1;
      // Local indices: all vertices of quad i have index i
      localIndices[idxBase + 0] = i;
      localIndices[idxBase + 1] = i;
      localIndices[idxBase + 2] = i;
      localIndices[idxBase + 3] = i;
    }
    
    const meshIndices = new Uint32Array(6 * batchSize); // 2 triangles * 3 indices * batchSize
    for (let i = 0; i < batchSize; ++i) {
      const baseVertex = i * 4;
      const baseIdx = i * 6;
      // Triangle 1: 0, 1, 2
      meshIndices[baseIdx + 0] = baseVertex + 0;
      meshIndices[baseIdx + 1] = baseVertex + 1;
      meshIndices[baseIdx + 2] = baseVertex + 2;
      meshIndices[baseIdx + 3] = baseVertex + 0;
      meshIndices[baseIdx + 4] = baseVertex + 2;
      meshIndices[baseIdx + 5] = baseVertex + 3;
    }
    
    // Create attributes object
    // Note: Cesium's Geometry constructor accepts both GeometryAttributes instance and plain object
    // GaussianSplatPrimitive uses plain object for custom attributes (screenQuadPosition, splatIndex)
    // This matches Cesium's actual implementation pattern
    // Create attributes object matching Cesium's GaussianSplatPrimitive pattern
    const attributes = {
      screenQuadPosition: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: quadPositions,
        name: "_SCREEN_QUAD_POS", // Internal name for debugging/identification
        variableName: "screenQuadPosition", // Shader variable name (without 'a_' prefix)
      }),
      localSplatIndex: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 1,
        values: localIndices,
        name: "_LOCAL_SPLAT_INDEX", // Internal name for debugging/identification
        variableName: "localSplatIndex", // Shader variable name (without 'a_' prefix)
      }),
    };
    
    // Calculate bounding sphere (unit quad, so simple sphere)
    const boundingSphere = Cesium.BoundingSphere.fromVertices(meshPositions);
    
    // Create Cesium Geometry
    const geometry = new Cesium.Geometry({
      attributes: attributes,
      indices: meshIndices,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: boundingSphere,
    });
    
    return geometry;
  }

  /**
   * Get the Cesium Geometry object
   * @returns {Geometry} The geometry object
   */
  getGeometry() {
    return this._geometry;
  }

  /**
   * Get the number of indices per batch
   * @returns {number} Index count (6 * batchSize for TRIANGLES)
   */
  getIndexCount() {
    return 6 * this.batchSize; // 2 triangles * 3 indices per splat
  }

  /**
   * Get the number of vertices per batch
   * @returns {number} Vertex count (4 * batchSize)
   */
  getVertexCount() {
    return 4 * this.batchSize;
  }
}

export default GSplatStreamGeometry;

