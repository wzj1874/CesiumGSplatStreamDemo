# Cesium Gaussian Splatting Stream Demo

一个基于 Cesium 的高斯点云（Gaussian Splatting）流式加载和渲染演示项目。支持大规模 3D 高斯点云数据的实时流式加载、渐进式渲染和交互式可视化。

## ✨ 功能特性

- 🌍 **Cesium 集成** - 基于 Cesium 3D 地球引擎，支持地理坐标系统
- 📦 **流式加载** - 支持大规模 PLY 格式高斯点云数据的流式加载
- 🚀 **渐进式渲染** - 支持数据的分批加载和渐进式显示
- ⚡ **性能优化** - 实现了批量更新、部分纹理更新等性能优化策略
- 🎨 **高质量渲染** - 使用 WebGL 实现高质量的高斯点云渲染
- 🔄 **动态更新** - 支持运行时动态添加和更新高斯点数据
- 📊 **自适应排序** - 基于相机位置的自动排序和剔除优化

## 🚀 快速开始

### 环境要求

- Node.js >= 18.0.0
- npm 或 yarn

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

项目将在 `http://localhost:3000` 启动。

### 构建生产版本

```bash
npm run build
```

### 预览生产构建

```bash
npm run preview
```

## 📁 项目结构

```
cesiumGSplatStreamDemo/
├── src/
│   ├── GSplatStream/              # 高斯点云流式加载核心模块
│   │   ├── GSplatStreamPrimitive.js      # 主要的渲染基元类
│   │   ├── GSplatStreamGeometry.js      # 几何体定义
│   │   ├── GSplatStreamUtils.js          # 工具函数
│   │   ├── Loader/                       # 数据加载器
│   │   │   ├── StreamLoader.js           # 流式加载器
│   │   │   ├── StreamingGaussianSplatParser.js  # 高斯点云解析器
│   │   │   ├── PlyStreamParser.js        # PLY 流式解析器
│   │   │   └── PlyUtils.js               # PLY 工具函数
│   │   └── Shaders/                      # WebGL 着色器
│   │       ├── GSplatStreamVS.js         # 顶点着色器
│   │       └── GSplatStreamFS.js         # 片段着色器
│   ├── main.js                     # 应用主入口
│   └── main.css                    # 样式文件
├── assets/                         # 资源文件
│   ├── biker.ply                   # 示例 PLY 文件
│   └── merged_gs.ply               # 示例高斯点云文件
├── index.html                      # HTML 模板
├── vite.config.js                  # Vite 配置文件
├── package.json                    # 项目依赖配置
└── README.md                       # 项目说明文档
```

## 🎯 核心组件

### GSplatStreamPrimitive

主要的渲染基元类，负责高斯点云的渲染和更新。

**主要功能：**
- 流式数据接收和更新
- GPU 纹理管理和更新
- Web Worker 排序优化
- 相机背面剔除
- 批量渲染优化

**使用示例：**

```javascript
import GSplatStreamPrimitive from './GSplatStream/GSplatStreamPrimitive';

// 创建基元
const primitive = new GSplatStreamPrimitive({
  totalCount: 1000000,  // 总点数
  batchSize: 128,       // 每批渲染的点数
  show: true
});

// 设置单个点数据
primitive.setSplatData(index, {
  position: [x, y, z],
  rotation: [qx, qy, qz, qw],
  scale: [sx, sy, sz],
  opacity: opacity,
  sh: {
    order: 3,
    coeffs: shCoeffs
  }
});

// 手动刷新更新
primitive.flushUpdates();

// 添加到场景
viewer.scene.primitives.add(primitive);
```

### StreamLoader

流式数据加载器，支持从文件或网络流式加载 PLY 格式的高斯点云数据。

**使用示例：**

```javascript
import { StreamLoader } from './GSplatStream/Loader/StreamLoader';

const loader = new StreamLoader({
  url: './assets/merged_gs.ply',
  onProgress: (loaded, total) => {
    console.log(`加载进度: ${(loaded / total * 100).toFixed(2)}%`);
  },
  onSplatData: (index, data) => {
    primitive.setSplatData(index, data);
  },
  onComplete: () => {
    console.log('加载完成');
    primitive.flushUpdates();
  }
});

loader.start();
```

## 🔧 配置选项

### GSplatStreamPrimitive 选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `totalCount` | number | 0 | 总的高斯点数量 |
| `batchSize` | number | 128 | 每批渲染的点数 |
| `show` | boolean | true | 是否显示 |
| `debugShowBoundingVolume` | boolean | false | 是否显示边界框（调试用） |

### 性能优化参数

```javascript
// 设置自动刷新阈值（当待更新点数达到此值时自动刷新）
primitive.setAutoFlushThreshold(100);

// 设置排序节流间隔（毫秒）
primitive.setSortThrottle(16);

// 启用/禁用自适应排序
primitive.setAdaptiveSorting(true);

// 设置像素覆盖剔除参数
primitive.setPixelCulling(minPixels, maxPixels, maxDistance);
```

## 📊 API 参考

### 主要方法

#### `setSplatData(index, data)`
设置指定索引的高斯点数据。

**参数：**
- `index` (number): 点的索引
- `data` (object): 点数据对象
  - `position` (number[]): 位置 [x, y, z]
  - `rotation` (number[]): 旋转四元数 [x, y, z, w]（可选）
  - `scale` (number[]): 缩放 [x, y, z]（可选）
  - `opacity` (number): 不透明度（可选）
  - `sh` (object): 球谐函数数据（可选）
    - `order` (number): SH 阶数
    - `coeffs` (Float32Array): SH 系数

#### `flushUpdates()`
手动刷新所有待更新的数据到 GPU。

#### `getStreamingStats()`
获取流式加载统计信息。

**返回：**
```javascript
{
  totalCount: number,      // 总点数
  validCount: number,      // 已加载的有效点数
  pendingUpdates: number, // 待更新的点数
  progress: number         // 加载进度百分比
}
```

#### `getBatchingStats()`
获取批量渲染统计信息。

**返回：**
```javascript
{
  enabled: boolean,        // 是否启用批量渲染
  batchSize: number,       // 每批大小
  instanceCount: number,   // 实例数量
  splatCount: number,      // 点数量
  reduction: number        // 性能提升百分比
}
```

## 🎨 渲染特性

### 支持的格式

- **PLY 格式** - 支持标准 PLY 格式的高斯点云数据
- **球谐函数** - 支持球谐函数（Spherical Harmonics）颜色表示
- **各向异性缩放** - 支持各向异性的高斯点缩放

### 渲染优化

- **批量渲染** - 使用实例化渲染减少绘制调用
- **相机背面剔除** - 自动剔除相机背后的点
- **自适应排序** - 根据相机移动速度调整排序频率
- **部分纹理更新** - 只更新变化的部分，减少 GPU 传输
- **像素覆盖剔除** - 根据像素覆盖范围剔除过小或过大的点

## 🔍 调试

### 显示边界框

```javascript
primitive.debugShowBoundingVolume = true;
```

### 获取统计信息

```javascript
// 流式加载统计
const streamingStats = primitive.getStreamingStats();
console.log('加载进度:', streamingStats.progress + '%');

// 批量渲染统计
const batchingStats = primitive.getBatchingStats();
console.log('性能提升:', batchingStats.reduction + '%');
```

## 📝 注意事项

1. **Cesium Ion Token**: 如果需要使用 Cesium Ion 服务（如高精度地形、3D Tiles 等），请在 `src/main.js` 中设置访问令牌：
   ```javascript
   Cesium.Ion.defaultAccessToken = 'your-token-here';
   ```

2. **内存管理**: 大规模点云数据会占用大量内存，建议：
   - 合理设置 `totalCount`
   - 使用流式加载避免一次性加载所有数据
   - 及时调用 `destroy()` 释放资源

3. **性能优化**: 
   - 根据硬件性能调整 `batchSize`
   - 使用 `setAutoFlushThreshold()` 平衡更新频率和性能
   - 启用自适应排序以提升交互性能

4. **数据格式**: 确保 PLY 文件包含必要的高斯点属性：
   - 位置（x, y, z）
   - 旋转（可选）
   - 缩放（可选）
   - 不透明度
   - 球谐函数系数（可选）

## 🛠️ 技术栈

- **Cesium** - 3D 地球和地图 JavaScript 库
- **Vite** - 下一代前端构建工具
- **WebGL** - 硬件加速的 3D 图形渲染
- **Web Workers** - 后台排序计算

## 📄 License

MIT

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📚 相关资源

- [Cesium 官方文档](https://cesium.com/docs/)
- [Gaussian Splatting 论文](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)
- [PLY 格式规范](https://en.wikipedia.org/wiki/PLY_(file_format))
