# 第三方组件与许可声明

本项目「火线对决 · LAN 对战版」（a-very-simple-shooting-game）以 **MIT License** 开源，完整条款见仓库根目录的 [LICENSE](LICENSE)。

本项目在运行时会加载以下第三方组件，相关版权归各组件作者所有。本项目仅在其各自许可证允许的范围内使用这些组件。

## 1. Three.js

| 项目 | 说明 |
| --- | --- |
| 组件 | Three.js（3D 渲染引擎） |
| 版本 | r128 / 0.128.0 |
| 引入方式 | 由 `index.html` 在运行时通过 CDN 加载（主源 jsDelivr，备用源 BootCDN），本仓库不分发其源代码 |
| 许可证 | MIT |
| 官网 | <https://threejs.org/> |
| 源码 | <https://github.com/mrdoob/three.js> |

依据 MIT 许可证的要求，随附其版权声明与许可全文如下：

~~~~text
The MIT License

Copyright © 2010-2021 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
~~~~

## 2. Google Fonts 字体

| 组件 | 作者 | 许可证 | 引入方式 |
| --- | --- | --- | --- |
| Chakra Petch | Cadson Demak | SIL Open Font License 1.1 | Google Fonts CDN |
| Noto Sans SC | Google | SIL Open Font License 1.1 | Google Fonts CDN |

字体由页面在运行时从 `fonts.googleapis.com` / `fonts.gstatic.com` 加载，本仓库不分发字体文件。SIL Open Font License 1.1 全文见 <https://openfontlicense.org/open-font-license-official-text/>。

## 3. 原创素材说明

游戏中的地图、武器模型、贴图与音效均由项目代码在运行时程序化生成（Canvas 2D / Web Audio API），不包含第三方美术、模型或音频素材。

## 4. 联系方式

如对上述许可声明有疑问，请在本仓库提交 Issue：<https://github.com/leonardo-weasley/a-very-simple-shooting-game/issues>。
