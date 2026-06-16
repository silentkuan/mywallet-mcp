import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';

const WORKSPACE = '/root/.openclaw/workspace';

// 白名單：只允許這些檔案路徑（相對於 workspace）
const ALLOWED_FILES = new Set([
  'MEMORY.md', 'TOOLS.md', 'SOUL.md', 'USER.md', 'AGENTS.md', 'IDENTITY.md', 'HEARTBEAT.md',
]);

function isAllowed(filePath: string): boolean {
  // 防止路徑遍歷攻擊
  const normalized = path.normalize(filePath).replace(/^\/+/, '');
  if (normalized.startsWith('..')) return false;
  // 檢查是否在白名單中
  if (ALLOWED_FILES.has(normalized)) return true;
  // 檢查是否在 memory/ 目錄下的 .md 檔案
  if (normalized.startsWith('memory/') && normalized.endsWith('.md')) return true;
  return false;
}

const router = Router();

// GET /api/openclaw/files - 列出所有可編輯檔案
router.get('/files', async (_req: Request, res: Response) => {
  try {
    const files: { name: string; path: string; size: number; mtime: string }[] = [];

    // 掃描根目錄的白名單檔案
    for (const f of ALLOWED_FILES) {
      try {
        const fullPath = path.join(WORKSPACE, f);
        const stat = await fs.stat(fullPath);
        files.push({ name: f, path: f, size: stat.size, mtime: stat.mtime.toISOString() });
      } catch {
        // 檔案不存在則跳過
      }
    }

    // 掃描 memory/ 目錄
    try {
      const memoryDir = path.join(WORKSPACE, 'memory');
      const entries = await fs.readdir(memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const fullPath = path.join(memoryDir, entry.name);
          const stat = await fs.stat(fullPath);
          files.push({
            name: `memory/${entry.name}`,
            path: `memory/${entry.name}`,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        }
      }
    } catch {
      // memory/ 目錄不存在則跳過
    }

    res.json({ files });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/openclaw/files/:path - 讀取檔案內容
router.get('/files/:path(*)', async (req: Request, res: Response) => {
  const filePath = req.params.path;
  if (!isAllowed(filePath)) {
    return res.status(403).json({ error: 'File not allowed' });
  }
  try {
    const fullPath = path.join(WORKSPACE, filePath);
    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ content });
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

// PUT /api/openclaw/files/:path - 儲存檔案內容
router.put('/files/:path(*)', async (req: Request, res: Response) => {
  const filePath = req.params.path;
  if (!isAllowed(filePath)) {
    return res.status(403).json({ error: 'File not allowed' });
  }
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'Content must be a string' });
  }
  try {
    const fullPath = path.join(WORKSPACE, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export function registerOpenclawFileRoutes(app: import('express').Express): void {
  app.use('/api/openclaw', router);
}
