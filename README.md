# 素材工坊

独立的图片生成与素材管理工具。不依赖 MediaOps、Docker、PostgreSQL、MinIO 或外部 Worker。

## 功能

- OpenAI Images 兼容 Provider 配置与健康检测
- ComfyUI Provider：通过 SSH 隧道调用远程 ComfyUI 工作流生图
- API Key 本地 AES-256-GCM 加密存储
- 文生图任务、状态轮询、失败重试
- PNG、JPEG、WebP 上传、预览、下载、删除
- SQLite 元数据和本地文件存储

## 启动

需要 Node.js 22 或更高版本。

```bash
cp .env.example .env
pnpm install
pnpm dev
```

打开 `http://localhost:5374`。API 地址为 `http://localhost:5373`。

生产环境先运行 `pnpm build`，然后执行 `pnpm start`。API 会同时托管构建后的前端，默认访问 `http://localhost:5373`。

## ComfyUI Provider（SSH 隧道）

远程服务器（WaaS 算力实例）上跑着 ComfyUI（`127.0.0.1:8188`），通过 SSH 本地转发接入：

```bash
pnpm tunnel          # 启动隧道（断线自动重连），127.0.0.1:8188 -> 服务器 ComfyUI
pnpm tunnel:status   # 查看隧道与 ComfyUI API 状态
pnpm tunnel:stop     # 停止隧道
```

隧道使用专用密钥 `~/.ssh/material_workshop_comfy` 免密登录；服务器地址等参数见 `.env.example` 中的 `COMFY_SSH_*` / `COMFY_LOCAL_PORT`。

配置步骤：

1. `pnpm tunnel` 启动隧道，确认状态为 `ComfyUI API: OK`。
2. 界面右上角 `Provider` → 新增 Provider，类型选 **ComfyUI（SSH 隧道）**。
3. Base URL 填 `http://127.0.0.1:8188`，API Key 留空，模型名随意（如 `white-创作方案`）。
4. 「工作流模板」粘贴 ComfyUI API 格式的工作流 JSON——仓库里已存了一份 WHITE 文生图模板：`workflows/创作方案.json`。
5. 「节点绑定」一般留空即可（默认映射：提示词 `271.inputs.string`、种子 `210.inputs.seed`、尺寸 `264.inputs.width/height`、批量 `264.inputs.batch_size`）；换用其他工作流时按 `"271.inputs.string"` 格式覆盖。
6. 保存后点「测试」，状态变 healthy 即可正常生图。

注意：

- ComfyUI 任务的「质量」选项不生效，采样步数等参数以工作流模板为准；「数量」映射为 latent batch_size。
- 服务器实例重启后，需要先在服务器上运行 `bash /home/waas/white-linux-deploy/scripts/server-direct-start.sh` 拉起 ComfyUI，再启动本地隧道。

## 数据

- SQLite：`data/workshop.db`
- 素材文件：`data/assets/`

部署或迁移时备份整个 `data/` 目录即可。生产环境必须为 `APP_ENCRYPTION_KEY` 设置稳定的随机值；修改该值后，已保存的 Provider API Key 将无法解密。
