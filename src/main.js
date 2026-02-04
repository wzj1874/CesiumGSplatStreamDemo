import * as Cesium from 'cesium';
import './main.css';
import GSplatStreamPrimitive from './GSplatStream/GSplatStreamPrimitive';
import { StreamLoader } from './GSplatStream/Loader/StreamLoader';
import { StreamingGaussianSplatParser } from './GSplatStream/Loader/StreamingGaussianSplatParser';
import { PlyStreamParser } from './GSplatStream/Loader/PlyStreamParser';

PlyStreamParser.sMaxProcessingTime = 16 * 60;
// 创建 Cesium Viewer
const viewer = new Cesium.Viewer('cesiumContainer', {
    msaaSamples: 1,
    requestRenderMode: true,
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
// const PLY_FILE_URL = '../assets/merged_gs.ply';
const PLY_FILE_URL = 'https://cc-store-dev.obs.cn-south-1.myhuaweicloud.com:443/404676969243742208/3D/model-gs-ply/merged_gs.ply';

let currentPrimitive = null;
let currentCancelFn = null;
let currentParser = null;

const loadBtn = document.getElementById('loadBtn');
const cancelBtn = document.getElementById('cancelBtn');
const deleteBtn = document.getElementById('deleteBtn');

async function loadStreamingPLY(url) {
    try {
        if (currentPrimitive) {
            deletePrimitive();
        }

        console.log("Starting stream load...");

        const primitive = new GSplatStreamPrimitive({
            totalCount: 0,
            batchSize: 128,
            show: true,
            debugShowBoundingVolume: false,
            scene: viewer.scene,
        });
        
        if (!viewer.scene.primitives.contains(primitive)) {
            viewer.scene.primitives.add(primitive);
        }
        
        currentPrimitive = primitive;
        window.primitive = primitive;
                    
        const transformMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
            destPosition,
            Cesium.Ellipsoid.WGS84
        );
        Cesium.Matrix4.clone(transformMatrix, primitive.modelMatrix);
        primitive._dirty = true;

        const parser = new StreamingGaussianSplatParser();
        parser.setPrimitive(primitive);
        currentParser = parser;

        const loader = new StreamLoader();

        loadBtn.disabled = true;
        cancelBtn.disabled = false;
        deleteBtn.disabled = false;

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
                    primitive._dirty = true;
                    loadBtn.disabled = false;
                    cancelBtn.disabled = true;
                    currentCancelFn = null;
                },
                onError: (error) => {
                    console.error('Stream load error:', error);
                    // 加载出错，恢复按钮状态
                    loadBtn.disabled = false;
                    cancelBtn.disabled = true;
                    currentCancelFn = null;
                }
            }
        );

        const progress = parser.getProgress();
        console.log(`Header parsed, streaming data... (${progress.total} splats total)`);
        
        currentCancelFn = result.cancel;
        window.cancelLoad = result.cancel;

    } catch (error) {
        console.error('Load error:', error);
        loadBtn.disabled = false;
        cancelBtn.disabled = true;
    }
}

function cancelLoad() {
    if (currentCancelFn) {
        try {
            currentCancelFn();
            console.log("Load cancelled");
        } catch (error) {
            console.error('Cancel load error:', error);
        }
        currentCancelFn = null;
    }
    
    if (currentParser) {
        try {
            currentParser.cancel();
        } catch (error) {
            console.error('Cancel parser error:', error);
        }
    }
    
    loadBtn.disabled = false;
    cancelBtn.disabled = true;
}

function deletePrimitive() {
    if (currentPrimitive) {
        try {
            cancelLoad();
            
            if (viewer.scene.primitives.contains(currentPrimitive)) {
                viewer.scene.primitives.remove(currentPrimitive);
            }
            
            if (!currentPrimitive.isDestroyed()) {
                currentPrimitive.destroy();
            }
            
            console.log("Primitive deleted");
        } catch (error) {
            console.error('Delete primitive error:', error);
        }
        
        currentPrimitive = null;
        currentCancelFn = null;
        currentParser = null;
        window.primitive = null;
        window.cancelLoad = null;
        
        loadBtn.disabled = false;
        cancelBtn.disabled = true;
        deleteBtn.disabled = true;
    }
}

loadBtn.addEventListener('click', () => {
    loadStreamingPLY(PLY_FILE_URL);
});

cancelBtn.addEventListener('click', () => {
    cancelLoad();
});

deleteBtn.addEventListener('click', () => {
    deletePrimitive();
});

if (!currentPrimitive) {
    deleteBtn.disabled = true;
}

