'use strict';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
// Service Account 无法访问 'root'，需指定被共享的文件夹 ID
const ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID || 'root';

// ─── App Version (Cache Busting) ─────────────────────────────────────────────
const APP_VERSION = '20260414';

// ─── File Cache ────────────────────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_META_FILE = path.join(CACHE_DIR, 'meta.json');
const MAX_CACHE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB
const CACHE_TTL = 100 * 24 * 60 * 60 * 1000; // 100 天

// 确保缓存目录存在
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// 缓存索引：fileId -> { path, name, size, mimeType, cachedAt }
const cacheIndex = new Map();

// 加载/保存缓存元数据（持久化到 cache/meta.json，不再依赖 mtime）
function loadCacheIndex() {
  try {
    if (fs.existsSync(CACHE_META_FILE)) {
      const meta = JSON.parse(fs.readFileSync(CACHE_META_FILE, 'utf8'));
      for (const [fileId, info] of Object.entries(meta)) {
        if (fs.existsSync(info.path)) {
          cacheIndex.set(fileId, info);
        }
      }
    }
    console.log(`[Cache] 已加载 ${cacheIndex.size} 个缓存文件`);
  } catch (e) {
    console.error('[Cache] 加载元数据失败:', e.message);
  }
}

function saveCacheIndex() {
  try {
    const obj = Object.fromEntries(cacheIndex);
    fs.writeFileSync(CACHE_META_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[Cache] 保存元数据失败:', e.message);
  }
}

// 清理过期/超限缓存
function cleanCache() {
  try {
    const now = Date.now();
    let totalSize = 0;
    const toDelete = [];

    // 计算大小并找出过期文件
    for (const [fileId, info] of cacheIndex) {
      totalSize += info.size;
      if (now - info.cachedAt > CACHE_TTL) {
        toDelete.push(fileId);
      }
    }

    // 删除过期文件
    for (const fileId of toDelete) {
      const info = cacheIndex.get(fileId);
      if (fs.existsSync(info.path)) {
        fs.unlinkSync(info.path);
      }
      cacheIndex.delete(fileId);
      console.log(`[Cache] 删除过期文件: ${info.name}`);
    }
    saveCacheIndex(); // 过期清理后保存

    // 如果超限，删除最旧的文件
    while (totalSize > MAX_CACHE_SIZE && cacheIndex.size > 0) {
      let oldest = null;
      let oldestTime = Infinity;
      for (const [fileId, info] of cacheIndex) {
        if (info.cachedAt < oldestTime) {
          oldestTime = info.cachedAt;
          oldest = fileId;
        }
      }
      if (oldest) {
        const info = cacheIndex.get(oldest);
        totalSize -= info.size;
        if (fs.existsSync(info.path)) {
          fs.unlinkSync(info.path);
        }
        cacheIndex.delete(oldest);
        console.log(`[Cache] 清理空间，删除: ${info.name}`);
      }
    }
    saveCacheIndex(); // LRU 淘汰后也保存
  } catch (e) {
    console.error('[Cache] 清理失败:', e.message);
  }
}

// 下载文件到缓存
async function cacheFile(fileId) {
  if (cacheIndex.has(fileId)) {
    return cacheIndex.get(fileId); // 已缓存
  }

  const drive = getDriveClient();
  const meta = await drive.files.get({
    fileId,
    fields: 'name,mimeType,size'
  });

  const { name, mimeType } = meta.data;
  const safeName = name.replace(/[<>:"/\\|?*]/g, '_');
  const cachedFileName = `${fileId}_${encodeURIComponent(safeName)}`;
  const cachedPath = path.join(CACHE_DIR, cachedFileName);

  console.log(`[Cache] 下载中: ${name}`);

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(cachedPath);
    let size = 0;

    response.data.on('data', (chunk) => {
      size += chunk.length;
    });

    response.data.pipe(writeStream);
    writeStream.on('finish', () => {
      const info = {
        path: cachedPath,
        name,
        mimeType,
        size,
        cachedAt: Date.now()
      };
      cacheIndex.set(fileId, info);
      saveCacheIndex(); // 持久化缓存元数据
      console.log(`[Cache] 完成: ${name} (${(size / 1024 / 1024).toFixed(2)} MB)`);
      resolve(info);
    });
    writeStream.on('error', reject);
    response.data.on('error', reject);
  });
}

// ─── Preview Stream (直接流式，不缓存) ────────────────────────────────────
// /pv2/:token 直接从 Google Drive 流式下载，PDF.js 边下边渲染
// 支持 Range 请求（PDF.js 分片加载必需）
app.get('/pv2/:token', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.params.token, 'base64url').toString());
  } catch {
    return res.status(400).json({ error: 'Invalid token' });
  }

  const { id: fileId } = payload;

  try {
    const drive = getDriveClient();
    const meta = await drive.files.get({ fileId, fields: 'name,mimeType,size' });
    const { name, mimeType, size } = meta.data;

    res.setHeader('Content-Type', mimeType || 'application/pdf');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);

    const range = req.headers['range'];
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : size - 1;
      const chunkSize = end - start + 1;

      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', chunkSize);
      res.status(206);

      const dlRes = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
      );
      dlRes.data.pipe(res);
    } else {
      const dlRes = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );
      dlRes.data.pipe(res);
    }
  } catch (err) {
    console.error('[Preview] 流式预览失败:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── Security: Login Rate Limiter ────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分钟
  max: 10,                   // 最多 10 次尝试
  message: { error: '登录尝试过于频繁，请 15 分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24h
  }
}));
// 根路径单独处理：注入版本号 + 禁止缓存（确保部署后浏览器加载最新页面）
// 必须放在 express.static 之前，否则 / 会被 static 抢先匹配
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(htmlPath, 'utf8', (err, content) => {
    if (err) return res.status(500).send('Error loading index');
    // 将前端版本号替换为服务端当前版本
    const updated = content.replace(
      /var APP_VERSION = '[^']*';/,
      `var APP_VERSION = '${APP_VERSION}';`
    );
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html').send(updated);
  });
});

// 静态文件服务（public/）
app.use(express.static(path.join(__dirname, 'public')));

// ─── Google Drive — Service Account Auth ──────────────────────────────────
//
// Service Account 认证优势：
//   - 纯服务端完成，无需浏览器
//   - 凭据永久有效，不会过期
//   - 不需要配置"已授权重定向 URI"
//
// 使用方式：
//   1. 在 Google Cloud Console 创建 Service Account，下载 JSON 密钥文件
//   2. 将你想让 GDList 访问的 Drive 文件夹共享给 Service Account 邮箱
//      （Service Account 邮箱格式：<name>@<project>.iam.gserviceaccount.com）
//   3. 将 JSON 密钥文件上传到服务器，在 .env 中指定路径
//
let _drive = null;

function getDriveClient() {
  if (_drive) return _drive;

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyPath) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 环境变量未设置。请在 .env 中指定 Service Account JSON 密钥文件路径。');
  }

  // 动态加载（避免 require 找不到文件时报错）
  let credentials;
  try {
    credentials = require(path.resolve(keyPath));
  } catch (e) {
    throw new Error(`无法读取 Service Account 密钥文件: ${keyPath}，错误: ${e.message}`);
  }

  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/drive']
  );

  _drive = google.drive({ version: 'v3', auth, timeout: 30 * 1000 }); // 30s 超时
  return _drive;
}

// ─── Auth Guard ───────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── Routes ───────────────────────────────────────────────────────────────

// Login (with rate limiting)
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.ADMIN_USERNAME || 'admin';
  const validHash = process.env.ADMIN_PASSWORD_HASH;

  if (!validHash) {
    return res.status(500).json({ error: 'Server not configured (missing ADMIN_PASSWORD_HASH)' });
  }

  const userOk = username === validUser;
  const passOk = await bcrypt.compare(password, validHash);

  if (userOk && passOk) {
    req.session.authenticated = true;
    req.session.username = username;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid username or password' });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Auth status
app.get('/api/auth', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// List files in a folder
app.get('/api/files', requireLogin, async (req, res) => {
  const folderId = req.query.folderId || ROOT_FOLDER_ID;
  try {
    const drive = getDriveClient();
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,size,modifiedTime,parents)',
      orderBy: 'folder,name',
      pageSize: 1000
    });
    res.json({ files: response.data.files || [] });
  } catch (err) {
    console.error('[Drive] 文件列表错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get folder breadcrumb path
app.get('/api/path', requireLogin, async (req, res) => {
  const folderId = req.query.folderId || ROOT_FOLDER_ID;
  if (folderId === ROOT_FOLDER_ID) {
    // 根目录：直接返回根节点名称（尝试从 Drive 读取，失败则用 'My Drive'）
    try {
      const drive = getDriveClient();
      if (ROOT_FOLDER_ID === 'root') {
        return res.json({ path: [{ id: ROOT_FOLDER_ID, name: 'My Drive' }] });
      }
      const meta = await drive.files.get({ fileId: ROOT_FOLDER_ID, fields: 'id,name' });
      return res.json({ path: [{ id: ROOT_FOLDER_ID, name: meta.data.name }] });
    } catch {
      return res.json({ path: [{ id: ROOT_FOLDER_ID, name: 'My Drive' }] });
    }
  }

  try {
    const drive = getDriveClient();
    const chain = [];
    let current = folderId;

    while (current && current !== ROOT_FOLDER_ID) {
      const meta = await drive.files.get({
        fileId: current,
        fields: 'id,name,parents'
      });
      chain.unshift({ id: meta.data.id, name: meta.data.name });
      current = meta.data.parents ? meta.data.parents[0] : null;
    }
    // 把根节点名称也补进面包屑（复用已创建的 drive 实例）
    try {
      const rootName = ROOT_FOLDER_ID === 'root' ? 'My Drive'
        : (await drive.files.get({ fileId: ROOT_FOLDER_ID, fields: 'name' })).data.name;
      chain.unshift({ id: ROOT_FOLDER_ID, name: rootName });
    } catch {
      chain.unshift({ id: ROOT_FOLDER_ID, name: 'My Drive' });
    }
    res.json({ path: chain });
  } catch (err) {
    console.error('[Drive] 路径错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate a direct share link (no caching, streams from Drive)
// GET /api/link/:fileId → { url, name }
app.get('/api/link/:fileId', requireLogin, async (req, res) => {
  const { fileId } = req.params;
  try {
    const drive = getDriveClient();
    const meta = await drive.files.get({ fileId, fields: 'name,size' });
    const token = Buffer.from(JSON.stringify({ id: fileId })).toString('base64url');
    const host = `${req.protocol}://${req.get('host')}`;
    res.json({
      url: `${host}/dl/${token}`,
      name: meta.data.name,
      size: meta.data.size
    });
  } catch (err) {
    console.error('[Link] 生成链接失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cache file to server & return download link
// GET /api/cache/:fileId → { status, url, name, size, message }
// status: 'cached' | 'error'
app.get('/api/cache/:fileId', requireLogin, async (req, res) => {
  const { fileId } = req.params;
  try {
    const info = await cacheFile(fileId);
    const token = Buffer.from(JSON.stringify({
      fileId,
      name: info.name,
      cached: true
    })).toString('base64url');
    const host = `${req.protocol}://${req.get('host')}`;
    res.json({
      status: 'cached',
      url: `${host}/cache/${token}`,
      name: info.name,
      size: info.size,
      message: `缓存完成 (${(info.size / 1024 / 1024).toFixed(2)} MB)`
    });
  } catch (err) {
    console.error('[Cache] 缓存失败:', err.message);
    res.status(500).json({ status: 'error', error: '缓存失败: ' + err.message });
  }
});

// Check cache status for a file
// GET /api/cache-status/:fileId → { cached: bool, size?, cachedAt? }
app.get('/api/cache-status/:fileId', requireLogin, (req, res) => {
  const { fileId } = req.params;
  if (cacheIndex.has(fileId)) {
    const info = cacheIndex.get(fileId);
    res.json({ cached: true, size: info.size, cachedAt: info.cachedAt });
  } else {
    res.json({ cached: false });
  }
});

// Generate a download link (cached on server) — kept for compatibility
// GET /api/share/:fileId → { status, url, message }
// status: 'cached' | 'downloading' | 'error'
app.get('/api/share/:fileId', requireLogin, async (req, res) => {
  const { fileId } = req.params;

  // 已缓存 → 直接返回链接
  if (cacheIndex.has(fileId)) {
    const info = cacheIndex.get(fileId);
    const token = Buffer.from(JSON.stringify({
      fileId,
      name: info.name,
      cached: true
    })).toString('base64url');
    const host = `${req.protocol}://${req.get('host')}`;
    return res.json({
      status: 'cached',
      url: `${host}/cache/${token}`,
      name: info.name,
      size: info.size,
      message: '文件已在缓存中，可直接下载'
    });
  }

  // 正在缓存（通过缓存文件名判断是否正在下载）
  // 这里简化处理：直接开始缓存
  try {
    const info = await cacheFile(fileId);
    const token = Buffer.from(JSON.stringify({
      fileId,
      name: info.name,
      cached: true
    })).toString('base64url');
    const host = `${req.protocol}://${req.get('host')}`;
    res.json({
      status: 'cached',
      url: `${host}/cache/${token}`,
      name: info.name,
      size: info.size,
      message: `文件已缓存 (${(info.size / 1024 / 1024).toFixed(2)} MB)`
    });
  } catch (err) {
    console.error('[Cache] 缓存失败:', err.message);
    res.status(500).json({
      status: 'error',
      error: '文件缓存失败: ' + err.message
    });
  }
});

// Serve cached file
app.get('/cache/:token', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.params.token, 'base64url').toString());
  } catch {
    return res.status(400).send('Invalid token');
  }

  const { fileId, name } = payload;

  // 缓存命中 → 直接从本地提供文件
  if (cacheIndex.has(fileId)) {
    const info = cacheIndex.get(fileId);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`);
    res.setHeader('Content-Type', info.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', info.size);
    return res.sendFile(info.path);
  }

  // 缓存已过期/被清理 → 自动回退到直连 Drive 下载
  console.log(`[Cache] 缓存已失效，回退直链: ${fileId}`);
  try {
    const drive = getDriveClient();
    const meta = await drive.files.get({ fileId, fields: 'name,mimeType,size' });
    const { name: fileName, mimeType, size } = meta.data;

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    if (size) res.setHeader('Content-Length', size);

    const dlRes = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    dlRes.data.pipe(res);
  } catch (err) {
    console.error('[Cache] 回退直链失败:', err.message);
    if (!res.headersSent) res.status(502).send('文件下载失败，请重新获取链接');
  }
});

// Generate a signed preview token (login required)
app.get('/api/preview/:fileId', requireLogin, (req, res) => {
  const { fileId } = req.params;
  const token = Buffer.from(JSON.stringify({ id: fileId })).toString('base64url');
  const host = `${req.protocol}://${req.get('host')}`;
  // 异步获取文件信息（用于前端 PDF.js 显示文件名和大小）
  getDriveClient().files.get({ fileId, fields: 'name,size' })
    .then(({ data }) => {
      res.json({
        token,
        url: `${host}/pv2/${token}`,
        name: data.name,
        size: data.size || 0
      });
    })
    .catch(() => {
      res.json({ token, url: `${host}/pv2/${token}`, name: '', size: 0 });
    });
});

// Public inline preview endpoint (serves raw file, no conversion)
app.get('/pv/:token', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.params.token, 'base64url').toString());
  } catch {
    return res.status(400).send('Invalid token');
  }

  try {
    const drive = getDriveClient();
    const meta = await drive.files.get({
      fileId: payload.id,
      fields: 'name,mimeType,size'
    });
    const { name, mimeType } = meta.data;

    const disposition = mimeType.startsWith('text/')
      || mimeType === 'application/json'
      || mimeType.startsWith('image/')
      || mimeType === 'application/pdf'
      || mimeType.startsWith('video/')
      || mimeType.startsWith('audio/')
      ? 'inline'
      : 'attachment';

    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');

    const stream = await drive.files.get(
      { fileId: payload.id, alt: 'media' },
      { responseType: 'stream' }
    );
    stream.data.pipe(res);
  } catch (err) {
    console.error('[Drive] 预览错误:', err.message);
    res.status(500).send('Preview failed: ' + err.message);
  }
});

// Binary preview data endpoint (returns raw bytes, for client-side Office renderers)
// Supports Google Workspace export (docx/xlsx) natively
app.get('/api/preview-data/:fileId', requireLogin, async (req, res) => {
  const { fileId } = req.params;
  try {
    const drive = getDriveClient();
    const meta = await drive.files.get({
      fileId,
      fields: 'name,mimeType,size'
    });
    const { name, mimeType } = meta.data;

    // Google Workspace native formats → export as docx/xlsx
    const EXPORT_TYPES = {
      'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const exportMime = EXPORT_TYPES[mimeType];

    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Type', exportMime || mimeType);

    const stream = exportMime
      ? await drive.files.export({ fileId, mimeType: exportMime }, { responseType: 'stream' })
      : await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

    stream.data.pipe(res);
  } catch (err) {
    console.error('[Drive] preview-data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Public download endpoint — no login required
app.get('/dl/:token', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.params.token, 'base64url').toString());
  } catch {
    return res.status(400).send('Invalid link');
  }
  try {
    const drive = getDriveClient();
    const meta = await drive.files.get({
      fileId: payload.id,
      fields: 'name,mimeType,size'
    });

    const { name, mimeType } = meta.data;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');

    const stream = await drive.files.get(
      { fileId: payload.id, alt: 'media' },
      { responseType: 'stream' }
    );
    stream.data.pipe(res);
  } catch (err) {
    console.error('[Drive] 下载错误:', err.message);
    res.status(500).send('Download failed: ' + err.message);
  }
});

// Fallback → SPA index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`GDList running on http://localhost:${PORT}`);
});
