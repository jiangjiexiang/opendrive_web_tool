# OpenDRIVE 地图工具（Vue + Vite）

项目已切到 `Vue + Vite` 前端架构，并保留原先编辑器能力作为 `legacy` 页面，确保功能不中断。

## 目录说明

- `webapp/`：Vue 前端入口与样式
- `public/editor-legacy.html`：现有地图编辑器（完整能力保留）
- `src/server.js`：Node 后端 API（校验、导出、native 解析）
- `native/libOpenDRIVE/`：`libOpenDRIVE` 开源库
- `native/odr_json_parser.cpp`：调用 `libOpenDRIVE` 的解析桥接程序

## 启动（开发）

最省事方式（一键启动）：

```bash
npm run dev:all
```

这个命令会自动：
- 检查并安装 `node_modules`（缺失时）
- 检查并编译 `native/bin/odr_json_parser`（缺失时）
- 启动后端 `5174` 和前端 `5173`

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

## 生产构建（可选）

```bash
npm run build
npm start
```

`npm start` 会优先托管 `dist/`，若未构建则回退到 `public/`。

## 当前状态

- 前端框架已经迁移到 Vue，并通过桥接同步 legacy 画布状态。
- `Road 列表` 与 `选中道路属性` 已在 Vue 侧渲染。
- 现有编辑能力仍由 `public/editor-legacy.html` 提供（渐进迁移中）。
- 下一步可逐步把编辑器功能拆到 Vue 组件里（画布、道路列表、属性面板、工具栏分模块迁移）。
