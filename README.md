# GDList

Google Drive 文件列表服务，带登录保护，支持免密下载链接。

- 用户名 + 密码登录后方可浏览 Drive 目录结构
- 支持文件夹无限层级导航
- 点击分享可生成公开下载链接（无需登录即可下载）
- Service Account 认证，纯服务端完成，**无需浏览器**，凭据永久有效

---

### 前置工作1：创建 Google Service Account

1. 打开 https://console.cloud.google.com/ ，选择或创建项目
2. 左侧菜单 → **IAM 和管理** → **Service Accounts**
3. 点击「+ 创建 Service Account」→ 填写名称 → 完成
4. 进入详情 → 「密钥」→「添加密钥」→「创建新密钥」→「JSON」→ 创建
   - 浏览器自动下载 JSON 文件
5. **将 JSON 文件用文本文档打开，将其内容在需求时填入交互界面**
6. **将你想让 GDList 访问的 Drive 文件夹共享给 Service Account 邮箱**
   - Drive 目标文件夹 → 右键 →「共享」→ 添加邮箱
   - 邮箱格式：`xxxxx@yyyyyy.iam.gserviceaccount.com`

> ⚠️ **必须执行第 6 步**，否则 GDList 读取不到任何文件。Service Account 本身无 Drive 文件，需共享才有权限。

---
### 前置工作2：获取共享文件夹的ID，
    -即：“https://drive.google.com/drive/folders/”后面的长串字母

## 一键安装（VPS）

> 支持 Ubuntu / Debian / CentOS / Rocky Linux，需要 root 权限。
> 安装脚本为**全交互式**，所有参数通过问答完成，无需手动编辑文件。

```bash
# 先下载（不能 pipe 进 bash，因为脚本需要交互）
curl -fsSL https://raw.githubusercontent.com/dakerclaw/GDlist/main/install.sh -o install.sh
sudo bash install.sh
```

脚本会依次询问：
1. 管理员用户名和密码（登陆页面用，自行设定）
2. Service Account JSON 密钥文件内容
3. 共享文件夹的ID
4. 服务端口（默认 3000）



## 安装后管理

```bash
systemctl status gdlist         # 查看运行状态
journalctl -u gdlist -f         # 实时查看日志
systemctl restart gdlist        # 重启服务
bash /opt/gdlist/install.sh     # 重新运行安装向导
```

---

## 目录结构

```
gdlist/
├── server.js              ← Express 后端
├── install.sh             ← 一键安装脚本（交互式）
├── package.json
├── .env.example           ← 配置模板
├── .gitignore
└── public/
    └── index.html         ← 前端（纯原生 HTML/CSS/JS，无依赖）
```

---

## 技术细节

- **认证**：Google Service Account（JWT 签名），纯服务端，无需浏览器，凭据不过期
- **Drive API**：仅 `drive.readonly` 最小权限
- **下载链接**：base64url 签名 `{fileId, exp}`，
- **会话**：express-session + HttpOnly Cookie，24 小时
- **前端**：单 HTML 文件，零依赖

---

## 彻底删除程序
```bash
sudo systemctl stop gdlist 2>/dev/null || true
sudo systemctl disable gdlist 2>/dev/null || true
sudo rm -f /etc/systemd/system/gdlist.service
sudo systemctl daemon-reload
sudo rm -rf /opt/gdlist
echo "GDList 已彻底删除！"
---

## 常见问题

**Q: 显示"找不到文件"？**  
A: Drive 文件夹没有共享给 Service Account 邮箱。请共享后再试。

**Q: 想更换密码？**  
A: 重新运行 `bash /opt/gdlist/install.sh`。
