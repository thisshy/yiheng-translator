# 译衡

译衡是一款开源双语翻译扩展。它支持网页逐段对照、独立翻译工作台、PDF 和字幕翻译，并能在工作台中渲染 LaTeX 公式。

## 主要功能

- **网页翻译**　在原文旁逐段显示译文，可切换双语或仅译文模式，也可只翻译正文、划词或输入框中的文字。
- **翻译工作台**　点击扩展图标，在独立标签页打开。同一窗口再次点击会切回已有工作台。宽窗口左侧显示原文、右侧显示译文，窄窗口自动改为上下排列。
- **工作台底色**　在字号旁点击「底色」，可选择暖灰纸、豆沙绿、雾蓝、柔灰，或自行调色。工作台使用黑字，并记住上次选用的底色。
- **阅读与对照**　原文和译文可分别朗读、调整语速，并支持本地历史和 LaTeX 公式预览。复制译文时会保留公式源码。
- **PDF 与字幕**　内置阅读器支持本地和在线 PDF，可导出双语 PDF。字幕文件页支持 SRT、WebVTT、ASS/SSA，可导出双语或仅译文字幕。部分视频站点的字幕适配仍属实验性。

## 在 Chrome 中加载

1. 安装 Node.js 和 pnpm，在仓库目录运行 `pnpm install` 和 `pnpm build`。
2. 打开 `chrome://extensions/`，开启右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择生成的 `dist/` 目录。
4. 点击工具栏的译衡图标打开工作台。打开普通网页后，按 `Alt+A` 可切换网页翻译。

在工作台粘贴原文后，点击「翻译文字」或按 `Ctrl+Enter`（macOS 为 `⌘+Enter`）。也可以先在网页上选中文字，再从右键菜单选择「打开翻译工作台」，将选区带入原文栏。翻译服务和目标语言可在设置中调整。

### 论文对照阅读

粘贴带有行末换行的 PDF 文字后，点击「整理断行」可合并段内换行，也可在编辑前一键撤销。翻译多段文字时，以空行区分原文段落。点击原文或译文中的段落，另一栏会定位到对应内容。语言栏会显示识别结果，点击中间的互换按钮可以把译文带回原文栏。

选中译文中的词或短语后，点击「备选译法」可查看其他译法，核对词对后可以替换这一次出现的词，或加入术语表。工作台支持按段复制双语文本，也可将译文加入本地收藏，在历史记录里按原文或译文搜索。

## 网页快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Alt+A` | 切换网页翻译 |
| `Alt+W` | 切换整页翻译 |
| `Alt+M` | 切换正文翻译 |
| `Alt+T` | 切换双语或仅译文模式 |

其他命令可以在 `chrome://extensions/shortcuts` 中分配快捷键。

## 站点规则

在设置页的「站点规则」中填写 JSON 数组。下面的规则匹配 `example.com`，在访问时自动翻译文章区域，跳过广告和代码。

```json
[
  {
    "id": "example-article",
    "matches": ["*://*.example.com/*"],
    "selectors": ["article"],
    "additionalExcludeSelectors": [".advertisement", "pre", "code"],
    "autoTranslate": true
  }
]
```

`matches` 接受 URL 匹配模式，`excludeMatches` 可排除特定 URL。`selectors` 限定翻译范围，`service`、`translationMode` 和 `theme` 可覆盖全局设置。「从不翻译的网站」优先于站点的自动翻译规则。

## 构建与测试

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Chrome 构建产物位于 `dist/`。修改源码并重新构建后，在扩展管理页重新加载。Firefox 和用户脚本可以分别通过 `pnpm build:firefox` 和 `pnpm build:userscript` 构建。

端到端测试需要先运行 `pnpm exec playwright install chromium`，然后运行 `pnpm e2e`。

## 许可证

采用 [MIT 许可证](LICENSE)。
