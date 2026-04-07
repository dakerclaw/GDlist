# GDList

> Google Drive 文件列表服务，带登录保护和免密下载链接

**特性：** 用户名+密码登录 · 文件夹无限层级导航 · 免登录下载 · Service Account 永久认证

---

## 🚀 快速开始

### 第一步：准备 Google Cloud

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，创建或选择项目
2. **创建 Service Account**
   - 左侧菜单 → **IAM 和管理** → **Service Accounts**
   - 点击「+ 创建 Service Account」→ 填写名称 → 完成
   - 进入详情 → 「密钥」→「添加密钥」→「创建新密钥」→「JSON」→ 下载文件
3. **共享 Drive 文件夹**
   - 打开你要分享的 Google Drive 文件夹
   - 右键 → 「共享」→ 添加 Service Account 邮箱
   - 邮箱格式：`xxxxx@yyyyyy.iam.gserviceaccount.com`

> ⚠️ **必须执行第 3 步！** Service Account 本身无权访问 Drive，必须共享文件夹才有权限。

### 第二步：安装服务（VPS）

```bash
# 下载并运行安装脚本（支持 Ubuntu/Debian/CentOS/Rocky Linux）
curl -fsSL https://raw.githubusercontent.com/dakerclaw/GDlist/main/install.sh -o install.sh
sudo bash install.sh
```

安装过程全交互式，会依次询问：
- 管理员用户名和密码
- Service Account JSON 文件（粘贴内容）
- 根目录文件夹 ID
- 服务端口（默认 3000）

### 第三步：访问使用

```
http://你的服务器IP:3000
```

---

## 📋 部署前检查清单

- [ ] 已下载 Service Account JSON 密钥文件
- [ ] 已将 Drive 文件夹共享给 Service Account 邮箱
- [ ] 准备好要分享的 Drive 文件夹 ID（URL 中 `/folders/` 后面的字符串）
- [ ] VPS 系统为 Ubuntu/Debian/CentOS/Rocky Linux

---

## 🔧 安装后管理

```bash
systemctl status gdlist        # 查看运行状态
journalctl -u gdlist -f        # 实时查看日志
systemctl restart gdlist       # 重启服务
bash /opt/gdlist/install.sh    # 重新配置
```

---

## 📁 项目结构

```
gdlist/
├── server.js              # Express 后端
├── install.sh             # 交互式安装脚本
├── package.json
└── public/
    └── index.html         # 前端（纯原生 HTML/CSS/JS，零依赖）
```

---

## ⚙️ 技术细节

| 项目 | 说明 |
|------|------|
| 认证方式 | Google Service Account（JWT 签名），凭据永久有效 |
| Drive 权限 | 仅 `drive.readonly` 最小权限 |
| 下载链接 | base64url 签名，默认 72 小时有效 |
| 会话管理 | express-session + HttpOnly Cookie，24 小时 |
| 前端 | 单 HTML 文件，无任何外部依赖 |

---

## ❓ 常见问题

**Q: 显示"找不到文件"？**  
A: Drive 文件夹没有共享给 Service Account 邮箱。请执行上述「第一步：准备 Google Cloud」的第 3 步。

**Q: 想更换密码？**  
A: 重新运行 `bash /opt/gdlist/install.sh`。

**Q: 下载链接过期了？**  
A: 重新登录后点击文件即可生成新链接。

**Q: 如何获取文件夹 ID？**  
A: 打开目标 Drive 文件夹，复制 URL 中 `/folders/` 后面的字符串（问号前）。
