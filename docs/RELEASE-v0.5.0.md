# Frame Agent v0.5.0

带项目记忆的浏览器视觉创作助手：选中文字或框选截图，由 Agent 自动选择 SVG 或图片 API 生成配图。

## 功能

- Chrome / Edge 右键直接生图、加入可编辑草稿、AI 解释与追问。
- ECharts 统计图、AntV 信息图、自定义 SVG skill 与独立图片模型。
- 项目记忆、历史版本、结构化数据保留、继续修改和 SVG / PNG 导出。
- 模型设置页分别接入语言模型和图片 API；中转站需兼容 Images 接口。
- SVG 数据与排版检查、有限自动修复。

## 安装

1. 下载并解压附件 frame-extension-0.5.0.zip。
2. 浏览器扩展管理页开启开发者模式，加载解压后的文件夹。
3. 下载本版本源码，安装 Node.js 24+，在项目目录执行 npm ci 和 npm run server。
4. 本机需 Edge / Chrome；其他环境执行 npx playwright install chromium，并安装中文字体。
5. 打开插件模型设置，填写自己的服务地址与密钥。默认演示模式无需付费调用。

插件压缩包只包含扩展构建文件。本地数据库、密钥、模型配置和依赖目录不在发布包中。

## 验证与范围

本地 42 项自动化测试通过；工作区交互回归及 DeepSeek 的人口图、保持数值改色和流程图实测通过。第三方 gpt-image-2 中转服务尚未实测；自由绘图视觉复核需语言模型支持图片输入。

GitHub Actions 配置随源码提供于 docs/github-actions-ci.yml，当前未启用云端自动测试。
