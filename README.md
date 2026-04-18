# OpenDRIVE 地图工具

这是当前统一后的项目根目录，用来做两件事：

- 查看 OpenDRIVE 地图
- 在底图上辅助制作和导出 `.xodr`

当前项目已经整理为一个工程，目录职责如下：

- `public/`
  前端页面，当前主入口
- `src/`
  Node.js 本地服务、校验和导出逻辑
- `native/libOpenDRIVE/`
  `libOpenDRIVE` 开源 C++ 库，用于后续接入更准确的 OpenDRIVE 解析/几何能力
- `legacy/web_editor_prototype/`
  旧版网页原型，保留作参考，不再作为主入口
- `GESMHY.xodr`
  当前用于调试显示效果的示例地图

当前阶段的主目标：

- 先把 `.xodr` 地图显示正确
- 再叠加点云生成的图片作为底图
- 最后再补地图编辑能力

## 启动

```bash
cd /Users/jiang/Desktop/web/opendrive_web_tool
npm run build:native
npm start
```

打开 [http://localhost:5173](http://localhost:5173)

> `build:native` 会编译 `native/odr_json_parser`，导入 XODR 时页面会通过这个程序调用 `libOpenDRIVE` 原生解析结果进行显示。

## 当前功能

- 导入现有 `.xodr` 并在画布显示道路
- 上传图片作为底图（航拍图、CAD导出图截图等）
- 画布点击绘制道路中心线
- 选择道路并编辑 road/lane/link 属性
- 按 VTS `check_map` 核心规则输出 error/warning
- 生成并下载 OpenDRIVE `.xodr`

## 使用流程

1. 上传底图
2. 如需读取已有地图，先导入 `.xodr`
3. 选择 `绘制道路`，在图上点击形成道路折线
4. 点击 `完成当前道路`
5. 切换 `选择道路`，点选道路并在右侧改属性
6. 点击 `运行校验`
7. 点击 `生成 XODR` 并下载

## 当前规则覆盖（核心）

- Header: `east/west/south/north` 必填与数值关系检查
- Road: id/junction 纯数字，id 唯一，length 与 planView 几何总长一致
- Geometry: 起始 `s=0`，后续 `s` 按长度累计
- Lane: id 连续，center=0，left>0，right<0，type 合法性检查
- Junction规则: `junction!=-1` 时 predecessor/successor elementType 应为 `road`

## 说明

- 当前是“规则迁移版”校验器（未直接调用 C++ 可执行程序）。
- 当前已把 `libOpenDRIVE` 收纳到 `native/libOpenDRIVE/`，后续可以基于它补更可靠的解析与查看能力。
- 后续你给我图片后，我会继续加：底图标定、吸附、道路平滑、路口自动连接、缩放标尺、坐标校准（像素到米）。
