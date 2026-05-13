# Markdown Viewer with Math

一个 Chrome 扩展，在浏览器里直接渲染 `.md` 文件：

- ✅ **LaTeX 公式**：`$...$` / `$$...$$` / `\(...\)` / `\[...\]`，KaTeX 渲染
- ✅ **公式边界处理**：代码块/内联代码内的 `$` 不会被误判为公式，`\$` 转义生效
- ✅ **代码高亮**：highlight.js，自动识别语言
- ✅ **GFM 表格、任务列表、删除线**
- ✅ **暗色模式**：跟随系统
- ✅ **本地文件**：支持 `file:///` 路径（需在扩展页手动勾选）

## 一、本地开发安装

```bash
# 1. 下载 vendor 依赖（marked / KaTeX / highlight.js）
./install.sh

# 2. 准备图标（先用占位）
# 把任意 PNG 命名为 icons/16.png  icons/48.png  icons/128.png

# 3. 在 Chrome 加载
#    chrome://extensions  →  开启「开发者模式」 →  「加载已解压扩展」 →  选此目录

# 4. 若要支持本地 .md：在扩展页面 → 详细信息 → 勾选「允许访问文件 URL」
```

## 二、目录结构

```
md-viewer/
├── manifest.json        Manifest V3 声明
├── content.js           注入入口：抓取原文 → 渲染 → 替换页面
├── lib/render.js        ★ 核心算法：公式提取 + 占位符替换流水线
├── styles/viewer.css    主题（亮/暗自动）
├── vendor/              依赖（由 install.sh 下载）
│   ├── marked.min.js
│   ├── katex.min.js + katex.min.css + fonts/
│   └── highlight.min.js + highlight-monokai.css
├── icons/               16/48/128 PNG
└── install.sh           一键下载 vendor
```

## 三、核心算法

公式与 Markdown 语法互相干扰是市面 MD 插件的普遍痛点。我们的处理流程：

1. **fenced code 状态机切块**：``` 包围的代码原样保留
2. **`applyOutsideInlineCode`**：在非代码段内，按 CommonMark 规则匹配等长反引号 inline code，跳过
3. **正则提取**（按顺序）：
   - `$$...$$`（display，可跨行，负回顾排除 `\$`）
   - `\[...\]`（display）
   - `\(...\)`（inline）
   - `$...$`（inline，前后不能是 `\` 或 `$`）
4. **占位符**：`KATEXPHnEND`，丢给 marked 处理 markdown
5. **回填**：把占位符替换回 KaTeX 渲染好的 HTML；display 公式从 `<p>` 解包，避免非法的 div-in-p

详见 `lib/render.js`。

## 四、Chrome Web Store 上架清单

| 项目 | 状态 | 备注 |
|------|------|------|
| Manifest V3 | ✅ | `manifest.json` |
| 无远程代码 | ✅ | 所有依赖打包在 `vendor/` |
| 权限最小化 | ✅ | 只有 content_scripts，无 `tabs` / `history` |
| 图标 16/48/128 | ⚠️ | **需要补**：用 Figma / Photopea 做一个，或临时用 KaTeX 的 logo |
| 1280×800 截图 | ⚠️ | **需要补**：渲染一个数学公式丰富的 md 截图即可 |
| 隐私政策 | ⚠️ | **需要补**：写一段「本扩展不收集任何数据，所有渲染在本地」 |
| 开发者账号 | ⚠️ | 一次性 $5 注册费 |

上架步骤：

1. 在 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) 注册开发者
2. 把整个 `md-viewer/` 目录（含 vendor）打成 zip 上传
3. 填写描述、上传截图、贴隐私政策链接
4. 提交审核（一般 1–7 天）

## 五、已知限制

- HTTP 服务器必须能让 Chrome 把 `.md` 当 `text/plain` 显示。如果服务器返回 `Content-Type: text/html`，扩展不接管（避免破坏用户内容）。
- 极少数 markdown 用 `` `` ` `` 这种嵌套反引号写 inline code，匹配仍依赖 CommonMark 规则。
- 不支持 Mermaid / PlantUML / 脚注扩展——需要时另加 marked 插件。

## 六、调试

打开任意 `.md` 文件，F12 打开 DevTools，Console 里报错都带 `[md-viewer]` 前缀。

渲染失败时检查：
- `chrome://extensions` → 扩展卡片 → 「错误」按钮看日志
- vendor 文件是否齐全（`ls vendor/`）
- 本地文件不渲染 → 「允许访问文件 URL」是否勾选
