# OpenDRIVE 地图工具（Vue + Vite）

一个面向 OpenDRIVE 地图编辑与校验的 Web 工具。当前项目由 Vue 前端 + Node 后端 + native `libOpenDRIVE` 解析桥接组成，目标是提供“导入/编辑/导出/校验”的一体化工作流。

当前项目已切到 `Vue + Vite` 前端架构，并保留原先编辑器能力作为 `legacy` 页面，确保功能不中断。

## 目录说明

- `webapp/`：Vue 前端入口与样式
- `public/editor-legacy.html`：现有地图编辑器（完整能力保留）
- `src/server.js`：Node 后端 API（校验、导出、native 解析）
- `native/libOpenDRIVE/`：`libOpenDRIVE` 开源库
- `native/odr_json_parser.cpp`：调用 `libOpenDRIVE` 的解析桥接程序

## 启动（开发）

### 一键启动脚本

- 首次在新电脑启动（推荐）：

```bash
npm run dev:first
```

对应脚本：`scripts/first-run-dev.sh`  
会自动检查/安装基础依赖、编译 native、同步校验二进制并启动前后端。

- 日常开发一键启动：

```bash
npm run dev:all
```

对应脚本：`scripts/dev.sh`  
会检查依赖与 native 是否就绪，然后启动前后端。

最省事方式（一键启动）：

```bash
npm run dev:all
```

这个命令会自动：
- 检查并安装 `node_modules`（缺失时）
- 检查并编译 `native/bin/odr_json_parser`（缺失时）
- 启动后端 `5174` 和前端 `5173`

新电脑首次拉起（推荐）：

```bash
npm run dev:first
```

这个命令会自动：
- 检查 `node` / `npm` / `cmake` / 编译工具是否可用（缺失时尝试自动安装）
- 安装 `node_modules`（缺失时）
- 强制编译一次 `native/odr_json_parser`
- 同步 `mapcheck/route_test`（若存在）
- 启动后端和前端开发服务

说明：
- `native/odr_json_parser` 是运行导入/解析链路的必要组件，迁移到新电脑通常都需要重新编译。
- 自动安装目前优先支持：
  - macOS：`brew`
  - Ubuntu/Debian：`apt-get`

也可以手动分步启动：

1. 安装依赖

```bash
cd /Users/jiang/Desktop/web/opendrive_web_tool
npm install
```

2. 编译 native 解析器（首次或 C++ 变更后）

```bash
npm run build:native
```

3. 启后端 API（端口 `5174`）

```bash
npm run dev:server
```

4. 启前端（Vite，端口 `5173`）

```bash
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)。

## 环境要求

- Node.js（建议 18+）
- npm
- CMake
- C/C++ 构建工具链
  - macOS：Xcode Command Line Tools
  - Ubuntu：`build-essential`

## 原版 mapcheck + route_test 校验

`校验` 接口现在会按顺序调用：
- 原版 `check_map/mapcheck`
- 原版 `route_test`（来自 `cpp_route_test.cpp`）

两者结果会合并后返回到前端弹窗，不再使用 JS 迁移规则。
当地图来自“导入 XODR”且未编辑时，会直接校验原始 XODR 文本；一旦你编辑道路/属性，会自动切换为校验当前编辑状态生成的 XODR，保证导入与绘制使用同一套校验流程。

开发启动脚本会自动同步：
- `../vts_map_interface/build_unix/runtime/VTSMapCheckApp` -> `native/bin/check_map`
- `../vts_map_interface/build_unix/runtime/VTSMapRouteApp` -> `native/bin/route_test`

如果可执行文件不在默认位置，请设置环境变量：

```bash
MAPCHECK_BIN=/abs/path/to/check_map npm run dev:server
MAPROUTE_BIN=/abs/path/to/route_test npm run dev:server
```

默认会尝试这些位置：
- `native/bin/check_map`
- `native/bin/mapcheck`
- `../vts_map_interface/build_unix/runtime/VTSMapCheckApp`
- `check_map`（系统 PATH）

以及 route_test：
- `native/bin/route_test`
- `../vts_map_interface/build_unix/runtime/VTSMapRouteApp`
- `route_test`（系统 PATH）

### 无 VTS 部署（JS 校验模式）

现在支持纯 JS 校验，不依赖 `vts_map_interface` 的 `mapcheck/route_test` 二进制。

设置环境变量：

```bash
VALIDATION_MODE=js npm run dev:server
```

可选模式：
- `VALIDATION_MODE=auto`（默认）：优先 native，找不到时自动回退 JS
- `VALIDATION_MODE=native`：强制 native（缺失即报错）
- `VALIDATION_MODE=js`：强制 JS（不依赖 VTS）

## 生产构建（可选）

```bash
npm run build
npm start
```

`npm start` 会优先托管 `dist/`，若未构建则回退到 `public/`。

## 当前状态

- 前端框架已经迁移到 Vue，并通过桥接同步 legacy 画布状态。
- `Road 列表` 与 `选中道路属性` 已在 Vue 侧渲染。
- 已支持“自动路口生成（Junction Generation）”实验能力：3~4 端点选择、路口网格、道路自动延伸、内部连接路径与车道过渡元数据。
- 现有编辑能力仍由 `public/editor-legacy.html` 提供（渐进迁移中）。
- 下一步可逐步把编辑器功能拆到 Vue 组件里（画布、道路列表、属性面板、工具栏分模块迁移）。

## 已知问题（重要）

- 自动完成道路（补全/延伸相关）目前稳定性不足，存在结果不符合预期的情况。
- 生成弯道（连接道路）目前仍有精度与拓扑一致性问题，复杂场景下可能出现几何异常或连接关系不理想。

当前建议：
- 在关键地图上，优先使用手动检查 + `校验` + 导出后复核流程。
- 自动生成结果建议二次检查（道路关系、长度、车道数、连接方向）。

## 下一步计划

- 修复自动完成道路的稳定性问题，减少异常形状与连接错误。
- 优化弯道生成算法，提升几何平滑性和拓扑正确率。
- 增加针对复杂路网场景的回归样例与自动化验证。
