import * as Cesium from 'cesium';
import './main.css';
import GSplatStreamPrimitive from './GSplatStream/GSplatStreamPrimitive';
import { StreamLoader } from './GSplatStream/Loader/StreamLoader';
import { StreamingGaussianSplatParser } from './GSplatStream/Loader/StreamingGaussianSplatParser';


// 创建 Cesium Viewer
const viewer = new Cesium.Viewer('cesiumContainer', {
    // 禁用不必要的 UI 控件以提升性能
    baseLayerPicker: false,
    vrButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    animation: false,
    
    // 启用地球和默认影像图层
    // imageryProvider 使用默认值（会加载 Bing Maps 或 OpenStreetMap）
    // terrainProvider 使用默认值（Cesium World Terrain）
    
    requestRenderMode: false,
    maximumRenderTimeChange: Infinity,
});

const destLongitude = 114.22940300000002;
const destLatitude = 23.035746999999994;
const destHeight = 0.0;

const destPosition = Cesium.Cartesian3.fromDegrees(
    destLongitude,
    destLatitude,
    destHeight
);
const destViewPosition = Cesium.Cartesian3.fromDegrees(
    destLongitude,
    destLatitude,
    destHeight + 500.0
);

viewer.camera.setView({
    destination: destViewPosition
});

const entity = viewer.entities.add({
    name: '基地位置',
    position: destPosition,
    point: {
        pixelSize: 10,
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
    },
    label: {
        text: '基地',
        font: '14pt sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -32)
    }
});

const LOAD_MODE = 'stream';
const PLY_FILE_URL = '../assets/merged_gs.ply';

if (LOAD_MODE === 'stream') {
    async function loadStreamingPLY(url) {
        try {
            console.log("Starting stream load...");

            const primitive = new GSplatStreamPrimitive({
                totalCount: 0,
                batchSize: 128,
                show: true,
                debugShowBoundingVolume: false,
            });
            window.primitive = primitive;
                        
            // 使用 eastNorthUpToFixedFrame 创建变换矩阵
            // 这个函数会根据地球表面的法线方向自动计算旋转，使模型正确贴合地球表面
            // 返回的矩阵会将本地坐标系（东-北-上）变换到 WGS84 坐标系
            const transformMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
                destPosition,
                Cesium.Ellipsoid.WGS84
            );
            Cesium.Matrix4.clone(transformMatrix, primitive.modelMatrix);
            primitive._dirty = true;

            const parser = new StreamingGaussianSplatParser();
            parser.setPrimitive(primitive);

            const loader = new StreamLoader();

            const result = await loader.loadStream(
                url,
                parser,
                {
                    onProgress: (receivedLength, contentLength, url, parser) => {
                        const percentage = contentLength > 0 
                            ? Math.floor((receivedLength / contentLength) * 100) 
                            : 0;
                        const progress = parser.getProgress();
                        console.log(`Loading: ${percentage}% (${progress.processed}/${progress.total} splats)`);
                    },
                    onComplete: (url) => {
                        console.log("Stream load complete!");
                        primitive.flushUpdates();
                        if (!viewer.scene.primitives.contains(primitive)) {
                            viewer.scene.primitives.add(primitive);
                        }
                    },
                    onError: (error) => {
                        console.error('Stream load error:', error);
                    }
                }
            );

            const progress = parser.getProgress();
            console.log(`Header parsed, streaming data... (${progress.total} splats total)`);
            viewer.scene.primitives.add(primitive);            
            
            // 存储函数到全局，方便控制
            window.cancelLoad = result.cancel;
            window.testPrimitive = primitive;
            

        } catch (error) {
            console.error('Load error:', error);
        }
    }

    window.loadStreamingPLY = () => {
        loadStreamingPLY(PLY_FILE_URL);
    }

} else if (LOAD_MODE === 'test') {
    const primitive = new GSplatStreamPrimitive({
        totalCount: 100, // Create 100 splats for testing
        batchSize: 128,
        show: true,
        debugShowBoundingVolume: false,
    });

    // Initialize
    primitive.initCount(100, 128);

    const centerLon = 116.3974;
    const centerLat = 39.9093;
    const centerHeight = 500.0;
    const gridSize = 10;
    const spacing = 0.01;

    console.log("Generating test splats...");

    for (let i = 0; i < 100; i++) {
        const row = Math.floor(i / gridSize);
        const col = i % gridSize;

        const lon = centerLon + (col - gridSize / 2) * spacing;
        const lat = centerLat + (row - gridSize / 2) * spacing;
        const height = centerHeight + Math.sin(i * 0.1) * 50;

        const position = Cesium.Cartesian3.fromDegrees(lon, lat, height);

        const hue = (i / 100) * 360;
        const r = Math.sin((hue * Math.PI) / 180) * 0.5 + 0.5;
        const g = Math.sin(((hue + 120) * Math.PI) / 180) * 0.5 + 0.5;
        const b = Math.sin(((hue + 240) * Math.PI) / 180) * 0.5 + 0.5;

        const scaleX = 1.0 + Math.sin(i * 0.2) * 0.5;
        const scaleY = 1.0 + Math.cos(i * 0.3) * 0.5;
        const scaleZ = 1.0 + Math.sin(i * 0.4) * 0.5;

        const angle = i * 0.1;
        const qx = 0;
        const qy = 0;
        const qz = Math.sin(angle / 2);
        const qw = Math.cos(angle / 2);

        primitive.setSplatData(i, {
            position: [position.x, position.y, position.z],
            rotation: [qx, qy, qz, qw],
            scale: [
                Math.log(scaleX),
                Math.log(scaleY),
                Math.log(scaleZ),
            ],
            opacity: Math.log(0.8),
            sh: {
                order: 0,
                coeffs: new Float32Array([
                    r * 2.0 - 1.0,
                    g * 2.0 - 1.0,
                    b * 2.0 - 1.0,
                ]),
            },
        });
    }

    console.log("Flushing updates to GPU...");
    primitive.flushUpdates();

    viewer.scene.primitives.add(primitive);

    function updateStats() {
        const stats = document.getElementById("stats");
        if (stats) {
            stats.innerHTML = `
        <div>Total Splats: ${primitive.totalCount}</div>
        <div>Valid Splats: ${primitive._validCount}</div>
        <div>Instance Count: ${primitive.instanceCount}</div>
        <div>Batch Size: ${primitive._batchSize}</div>
        <div>Texture Size: ${primitive.size.x} x ${primitive.size.y}</div>
      `;
        }
    }

    setInterval(updateStats, 1000);
    updateStats();

    setTimeout(() => {
        const positions = [];
        for (let i = 0; i < 100; i++) {
            const row = Math.floor(i / gridSize);
            const col = i % gridSize;
            const lon = centerLon + (col - gridSize / 2) * spacing;
            const lat = centerLat + (row - gridSize / 2) * spacing;
            const height = centerHeight + Math.sin(i * 0.1) * 50;
            const pos = Cesium.Cartesian3.fromDegrees(lon, lat, height);
            positions.push(pos.x, pos.y, pos.z);
        }

        const boundingSphere = Cesium.BoundingSphere.fromVertices(positions);
        primitive.boundingSphere = boundingSphere;

        console.log("Camera adjusting to view splats...");
        console.log("Bounding sphere:", boundingSphere);
        console.log("Primitive state:", {
            validCount: primitive._validCount,
            instanceCount: primitive.instanceCount,
            texturesReady: Cesium.defined(primitive.splatColor) && Cesium.defined(primitive.transformA),
            drawCommand: Cesium.defined(primitive._drawCommand)
        });

        viewer.camera.viewBoundingSphere(
            boundingSphere,
            new Cesium.HeadingPitchRange(0, -0.5, boundingSphere.radius * 3)
        );

        console.log("Camera adjusted to view splats");
    }, 2000);

    console.log("GSplat Stream Demo initialized!");
}

