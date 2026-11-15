# 火线对决 · LAN 对战版

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

基于 Three.js 的 3D 网页 FPS，支持局域网联机对战。

## 运行方法

### 启动服务器（房主）

```bash
node server.js
```

### 局域网联机
1. 房主运行 `node server.js`，记下控制台显示的地址（如 http://192.168.1.10:8080）
2. 局域网内其他设备浏览器打开该地址
3. 输入代号 → 点「加入对战」

### 单人练习
直接点「离线练枪」，无需服务器。
You can play single-player here: https://leonardo-weasley.github.io/a-very-simple-shooting-game/

## 操作
| 按键 | 功能 |
|---|---|
| WASD | 移动 |
| 鼠标左键 | 开火 |
| 右键 | 瞄准（AWM） |
| R | 换弹 |
| 1-5 | 切枪 |
| Tab | 战绩板 |
| Enter | 聊天 |

## 环境要求
- Node.js 14+（零依赖，无需 npm install）
- Chrome / Edge 浏览器

## 许可证

本项目采用 [MIT License](LICENSE) 开源，Copyright (c) 2026 leonardo-weasley。

### 第三方组件
- [Three.js](https://threejs.org/) r128 — MIT License，运行时通过 CDN 加载，版权归 three.js authors 所有。
- 字体 Chakra Petch、Noto Sans SC — SIL Open Font License 1.1，运行时通过 Google Fonts 加载。

各组件的完整版权声明与许可证文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
