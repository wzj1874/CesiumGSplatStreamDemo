//This file is automatically rebuilt by the Cesium build process.
// Export shader code as global variable
const GSplatStreamVS = `
// Vertex shader for Gaussian splats (Streaming version)
//
// Variables are declared via ShaderBuilder, not here:
// - attribute vec2 a_screenQuadPosition
// - attribute float a_localSplatIndex
// - varying vec4 v_splatColor
// - varying vec2 v_vertPos
// - uniform sampler2D u_splatColor
// - uniform usampler2D u_transformA
// - uniform sampler2D u_transformB
// - uniform usampler2D u_splatOrder
// - uniform vec4 u_texParams      // [numSplats, texWidth, validCount, visBoost]
// - uniform mat4 u_modelMatrix
// - uniform vec4 u_pixelCull       // [minPixels, maxPixels, maxPixelCullDistance, batchSize]

// Constants
const float ALPHA_THRESHOLD = 0.00392156863; // 1.0 / 255.0
const float COV_COMPENSATION = 0.3;
const float MAX_SPLAT_SIZE = 1024.0;
const float MIN_LAMBDA = 0.1;

// Helper function to discard splat
vec4 discardSplat() {
    return vec4(0.0, 0.0, 2.0, 1.0);
}

// Get splat ID from order texture
uint getSplatId(uint orderId, uint textureWidth, uint numSplats) {
    ivec2 orderUV = ivec2(
        int(orderId % textureWidth),
        int(orderId / textureWidth)
    );
    return uint(texelFetch(u_splatOrder, orderUV, 0).r);
}

// Calculate splat UV coordinates
ivec2 calcSplatUV(uint splatId, uint textureWidth, uint numSplats) {
    return ivec2(
        int(splatId % textureWidth),
        int(splatId / textureWidth)
    );
}

// Get splat data from textures
// Returns covariance data via out parameters (GLSL ES 3.00 compatible)
void getSplatData(ivec2 splatUV, out vec3 center, out vec3 covA, out vec3 covB) {
    // Load both textures once
    uvec4 tA = texelFetch(u_transformA, splatUV, 0);
    vec4 tB = texelFetch(u_transformB, splatUV, 0);
    vec2 tC = unpackHalf2x16(tA.w);
    
    // Extract center (floatBits)
    center = vec3(
        uintBitsToFloat(tA.x),
        uintBitsToFloat(tA.y),
        uintBitsToFloat(tA.z)
    );
    
    // Extract covariance
    // transformB: RGBA16F = (cAx, cAy, cAz, cBz)
    // transformA.w: packHalf2x16(cBx, cBy)
    covA = tB.xyz;  // (cAx, cAy, cAz)
    covB = vec3(tC.x, tC.y, tB.w);  // (cBx, cBy, cBz)
}

// Calculate v1v2 (screen-space ellipse axes)
vec4 calcV1V2(vec3 splat_cam, vec3 covA, vec3 covB, mat3 W, vec2 viewport, mat4 projMat) {
    // Construct symmetric covariance matrix
    mat3 Vrk = mat3(
        vec3(covA.x, covA.y, covA.z),      // Column 0: [cAx, cAy, cAz]
        vec3(covA.y, covB.x, covB.y),      // Column 1: [cAy, cBx, cBy]
        vec3(covA.z, covB.y, covB.z)       // Column 2: [cAz, cBy, cBz]
    );
    
    // Calculate Jacobian
    float focal = viewport.x * projMat[0][0];
    float inv_z = 1.0 / splat_cam.z;
    float J1 = focal * inv_z;
    vec2 J2 = -J1 * inv_z * splat_cam.xy;
    mat3 J = mat3(
        vec3(J1, 0.0, J2.x),
        vec3(0.0, J1, J2.y),
        vec3(0.0, 0.0, 0.0)
    );
    
    // Project covariance to screen space
    mat3 T = W * J;
    mat3 cov = transpose(T) * Vrk * T;
    
    // Eigenvalue decomposition with compensation
    float diagonal1 = cov[0][0] + COV_COMPENSATION;
    float offDiagonal = cov[0][1];
    float diagonal2 = cov[1][1] + COV_COMPENSATION;
    
    float mid = 0.5 * (diagonal1 + diagonal2);
    float radius = length(vec2((diagonal1 - diagonal2) * 0.5, offDiagonal));
    float lambda1 = mid + radius;
    float lambda2 = max(mid - radius, MIN_LAMBDA);
    
    // Calculate axis vectors with size clamping
    float vmin = min(MAX_SPLAT_SIZE, min(viewport.x, viewport.y));
    float l1 = 2.0 * min(sqrt(2.0 * lambda1), vmin);
    float l2 = 2.0 * min(sqrt(2.0 * lambda2), vmin);
    
    vec4 centerProj = projMat * vec4(splat_cam, 1.0);
    vec2 c = centerProj.ww * vec2(1.0 / viewport.x, 1.0 / viewport.y);
    
    vec2 diagonalVector = normalize(vec2(offDiagonal, lambda1 - diagonal1));
    
    // Calculate axis vectors
    vec2 v1 = l1 * diagonalVector;
    vec2 v2 = l2 * vec2(diagonalVector.y, -diagonalVector.x);
    
    // WebGL Y-axis: no flip needed (opposite of WebGPU)
    return vec4(v1.x, v1.y, v2.x, v2.y);
}

void main() {
    // Calculate splat ID
    uint batchSize = uint(u_pixelCull.w);
    uint localIndex = uint(a_localSplatIndex);
    uint instanceID = uint(gl_InstanceID);
    uint orderId = instanceID * batchSize + localIndex;
    
    // Early bounds check
    uint textureWidth = uint(u_texParams.y);
    uint numSplats = uint(u_texParams.x);
    if (orderId >= numSplats) {
        gl_Position = discardSplat();
        v_splatColor = vec4(0.0);
        v_vertPos = vec2(0.0);
        return;
    }
    
    uint splatId = getSplatId(orderId, textureWidth, numSplats);
    
    // Calculate splat UV and load all data
    ivec2 splatUV = calcSplatUV(splatId, textureWidth, numSplats);
    vec3 splatCenter;
    vec3 covA;
    vec3 covB;
    getSplatData(splatUV, splatCenter, covA, covB);
    
    // Load color early for alpha test
    vec4 color = texelFetch(u_splatColor, splatUV, 0);
    if (color.a < ALPHA_THRESHOLD) {
        gl_Position = discardSplat();
        v_splatColor = vec4(0.0);
        v_vertPos = vec2(0.0);
        return;
    }
    
    // Transform matrices
    // Note: splatCenter from texture is in local space (not transformed)
    // We need to transform: local -> world -> camera
    // czm_modelView = view * model, which does both transformations in one step
    mat4 matrix_model = u_modelMatrix;
    mat4 matrix_projection = czm_projection;
    mat4 model_view = czm_modelView;  // Cesium's modelView matrix (view * model)
    
    // Transform center from local space to camera space
    // splatCenter is in local space, so use modelView matrix (view * model)
    vec4 splat_cam = model_view * vec4(splatCenter, 1.0);
    
    // Note: Cesium's official implementation does NOT use early depth culling (splat_cam.z <= 0.0)
    // It relies on clip space culling instead, which is more accurate for Cesium's coordinate system
    // Early depth culling can cause issues with Cesium's reversed depth buffer
    
    vec4 splat_proj = matrix_projection * splat_cam;
    
    // Frustum culling: Use clip space check (matching Cesium's approach for WebGL)
    // Clip space: z range is [-w, w], after perspective division becomes NDC [0, 1] in Cesium
    float clip = 1.2 * splat_proj.w;
    if (splat_proj.z < -clip || splat_proj.x < -clip || splat_proj.x > clip ||
        splat_proj.y < -clip || splat_proj.y > clip) {
        gl_Position = discardSplat();
        v_splatColor = vec4(0.0);
        v_vertPos = vec2(0.0);
        return;
    }
    
    // Calculate v1v2 (screen-space ellipse axes)
    vec2 viewport = czm_viewport.zw;  // viewport width and height
    mat3 W = transpose(mat3(
        model_view[0].xyz,
        model_view[1].xyz,
        model_view[2].xyz
    ));
    vec4 v1v2 = calcV1V2(splat_cam.xyz, covA, covB, W, viewport, matrix_projection);
    
    // Calculate scale based on alpha
    float t = pow(splat_cam.z + 0.5, 5.0);
    float scale = min(1.0, sqrt(-log(1.0 / (255.0 * color.a))) / 2.0);
    
    // Apply visBoost (size multiplier)
    float visBoost = u_texParams.w;
    float expt = exp(-1.0 / t);
    vec4 v1v2_scaled = v1v2 * (scale * visBoost * expt);
    
    // Pixel coverage culling
    vec4 v1v2_sq = v1v2_scaled * v1v2_scaled;
    float v1_len_sq = v1v2_sq.x + v1v2_sq.y;
    float v2_len_sq = v1v2_sq.z + v1v2_sq.w;
    
    float minPixels = u_pixelCull.x;
    float maxPixels = u_pixelCull.y;
    
    // Early out tiny splats
    if (v1_len_sq < minPixels && v2_len_sq < minPixels) {
        gl_Position = discardSplat();
        v_splatColor = vec4(0.0);
        v_vertPos = vec2(0.0);
        return;
    }
    
    // Cull oversized splats
    if (maxPixels > 0.0) {
        float maxPixelCullDistance = u_pixelCull.z;
        float splatDistance = length(splat_cam.xyz);
        if (maxPixelCullDistance <= 0.0 || splatDistance < maxPixelCullDistance) {
            float maxAxisSq = maxPixels * maxPixels;
            if (v1_len_sq > maxAxisSq || v2_len_sq > maxAxisSq) {
                gl_Position = discardSplat();
                v_splatColor = vec4(0.0);
                v_vertPos = vec2(0.0);
                return;
            }
        }
    }
    
    // Final position calculation
    // For TRIANGLES, use a_screenQuadPosition directly
    vec2 vertex_pos = a_screenQuadPosition;
    vec2 inv_viewport = 1.0 / viewport;
    vec2 offset = (vertex_pos.x * v1v2_scaled.xy + vertex_pos.y * v1v2_scaled.zw) * inv_viewport * splat_proj.w;
    
    gl_Position = splat_proj + vec4(offset, 0.0, 0.0);
    gl_Position.z = clamp(gl_Position.z, -abs(gl_Position.w), abs(gl_Position.w));
    
    v_vertPos = vertex_pos * scale;
    v_splatColor = color;
}
`;

export default GSplatStreamVS;
