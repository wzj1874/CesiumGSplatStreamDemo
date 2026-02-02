//This file is automatically rebuilt by the Cesium build process.
// Export shader code as global variable
const GSplatStreamFS = `
// Fragment shader for Gaussian splats (Streaming version)
//
// Variables are declared via ShaderBuilder, not here:
// - varying vec4 v_splatColor
// - varying vec2 v_vertPos

// Constants
const float ALPHA_THRESHOLD = 0.00392156863; // 1.0 / 255.0
const float EXP4 = exp(-4.0);
const float INV_EXP4 = 1.0 / (1.0 - EXP4);

// Normalized exponential function
float normExp(float x) {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

// Optimized gaussian evaluation
vec4 evalSplat(vec2 texCoord, vec4 color) {
    float A = dot(texCoord, texCoord);
    
    if (A > 1.0) {
        discard;
    }
    
    // Branch-less optimization using normalized exp
    float alpha = normExp(A) * color.a;
    
    if (alpha < ALPHA_THRESHOLD) {
        discard;
    }
    
    return vec4(color.rgb * alpha, alpha);
}

void main() {
    out_FragColor = evalSplat(v_vertPos, v_splatColor);
    // out_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
}
`;

export default GSplatStreamFS;
