# 素材工坊

独立的图片生成与素材管理工具。不依赖 MediaOps、Docker、PostgreSQL、MinIO 或外部 Worker。

## 功能

- OpenAI Images 兼容 Provider 配置与健康检测
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

打开 `http://localhost:5274`。API 地址为 `http://localhost:5273`。

生产环境先运行 `pnpm build`，然后执行 `pnpm start`。API 会同时托管构建后的前端，默认访问 `http://localhost:5273`。

## 数据

- SQLite：`data/workshop.db`
- 素材文件：`data/assets/`

部署或迁移时备份整个 `data/` 目录即可。生产环境必须为 `APP_ENCRYPTION_KEY` 设置稳定的随机值；修改该值后，已保存的 Provider API Key 将无法解密。
