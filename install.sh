#!/bin/bash
# GDList — Interactive One-click Installer (Service Account)
set -e

REPO="https://github.com/dakerclaw/GDlist.git"
INSTALL_DIR="/opt/gdlist"
SERVICE_NAME="gdlist"
NODE_MIN=18

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${GREEN}[✔]${NC} $*"; }
error()   { echo -e "${RED}[✘]${NC} $*"; exit 1; }
section() { echo -e "\n${CYAN}${BOLD}── $* ──${NC}"; }
prompt()  { echo -ne "${BOLD}$*${NC} "; }

if [ ! -t 0 ]; then
  echo -e "${RED}[错误]${NC} 需要交互式终端，请先下载再运行："
  echo "  curl -fsSL https://raw.githubusercontent.com/dakerclaw/GDlist/main/install.sh -o install.sh"
  echo "  sudo bash install.sh"
  exit 1
fi
[[ $EUID -ne 0 ]] && error "请用 root 权限运行：sudo bash install.sh"

echo ""
echo -e "${CYAN}${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║   GDList — Service Account 认证安装   ║${NC}"
echo -e "${CYAN}${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""

# ── 1. 系统依赖 ──────────────────────────────────────────────────────────
section "步骤 1/5  安装系统依赖"
if command -v apt-get &>/dev/null; then PKG=apt-get
elif command -v yum &>/dev/null; then PKG=yum
elif command -v dnf &>/dev/null; then PKG=dnf
else error "不支持此系统"; fi

if ! command -v git &>/dev/null; then
  info "安装 git…"; $PKG install -y git
else
  info "git ✓"
fi

install_node() {
  info "安装 Node.js ${NODE_MIN}.x…"
  [[ "$PKG" == "apt-get" ]] && { curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN}.x | bash -; apt-get install -y nodejs; }
  [[ "$PKG" != "apt-get" ]] && { curl -fsSL https://rpm.nodesource.com/setup_${NODE_MIN}.x | bash -; $PKG install -y nodejs; }
}
if command -v node &>/dev/null; then
  [[ $(node -e "process.stdout.write(process.versions.node.split('.')[0])") -lt $NODE_MIN ]] && install_node || info "Node.js ✓"
else
  install_node
fi

# ── 2. 拉取代码 ───────────────────────────────────────────────────────────
section "步骤 2/5  获取代码"
if [ -d "$INSTALL_DIR/.git" ]; then
  info "更新已有安装…"; git -C "$INSTALL_DIR" pull --ff-only
else
  info "克隆仓库…"; git clone "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"; npm install --omit=dev --silent; info "依赖安装 ✓"

# ── 3. 管理员账号 ─────────────────────────────────────────────────────────
section "步骤 3/5  管理员账号"
prompt "用户名 [默认 admin]:"; read -r U; ADMIN_USERNAME="${U:-admin}"; info "用户名: $ADMIN_USERNAME"
while true; do
  prompt "密码:"; read -rs P1; echo ""; prompt "确认密码:"; read -rs P2; echo ""
  [[ "$P1" == "$P2" && -n "$P1" ]] && break || echo -e "${YELLOW}两次不一致，请重试${NC}"
done
ADMIN_HASH=$(node -e "const b=require('bcryptjs');b.hash(process.argv[1],10).then(h=>process.stdout.write(h))" "$P1")
info "密码哈希 ✓"

# ── 4. Service Account ───────────────────────────────────────────────────
section "步骤 4/5  Service Account 密钥"
echo ""
echo "  Service Account 是 Google 官方服务端认证方式："
echo "  - 无需浏览器，全程在服务器完成"
echo "  - 凭据永久有效，不会过期"
echo ""
echo "  ── 创建步骤 ─────────────────────────────────────"
echo "  1. 打开 https://console.cloud.google.com/"
echo "  2. 创建/选择项目 → IAM → Service Accounts"
echo "  3. 创建 Service Account，下载 JSON 密钥文件"
echo "  4. 将 JSON 文件上传到服务器（如 /opt/gdlist/key.json）"
echo "  5. 把你想访问的 Drive 文件夹共享给 Service Account 邮箱"
echo ""

prompt "请输入 JSON 密钥文件路径:"; read -r KEY_PATH
while [ -z "$KEY_PATH" ]; do prompt "路径不能为空，重输:"; read -r KEY_PATH; done
[ ! -f "$KEY_PATH" ] && error "文件不存在：$KEY_PATH"
SA_EMAIL=$(node -e "try{const k=require('$KEY_PATH');if(!k.client_email)process.exit(1);console.log(k.client_email);}catch(e){process.exit(1)}" 2>/dev/null) \
  || error "JSON 文件无效"

echo ""
info "Service Account 邮箱: $SA_EMAIL"
echo -e "  ${YELLOW}⚠  请确认已将 Drive 文件夹共享给 $SA_EMAIL${NC}"
echo -e "  否则 GDList 无法读取任何文件！"
prompt "确认已完成共享，按回车继续…"; read -r

# ── 5. 写入配置并启动 ─────────────────────────────────────────────────────
section "步骤 5/5  写入配置并启动"
prompt "端口 [默认 3000]:"; read -r PORT; PORT="${PORT:-3000}"
prompt "分享链接有效期（小时）[默认 72]:"; read -r TTL; TTL="${TTL:-72}"

node -e "const fs=require('fs');fs.writeFileSync('$INSTALL_DIR/.env',[
  'PORT=$PORT',
  'SESSION_SECRET='+require('crypto').randomBytes(32).toString('hex'),
  'ADMIN_USERNAME=$ADMIN_USERNAME',
  'ADMIN_PASSWORD_HASH=$ADMIN_HASH',
  'GOOGLE_SERVICE_ACCOUNT_JSON=$KEY_PATH',
  'SHARE_TTL_HOURS=$TTL',
].join('\n'))" && chmod 600 "$INSTALL_DIR/.env"

NODE_BIN=$(which node)
cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SVCEOF'
[Unit]
Description=GDList – Google Drive file listing
After=network.target
[Service]
Type=simple
User=root
WorkingDirectory=INSTALL_DIR_PLACEHOLDER
EnvironmentFile=INSTALL_DIR_PLACEHOLDER/.env
ExecStart=NODE_BIN_PLACEHOLDER INSTALL_DIR_PLACEHOLDER/server.js
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
SVCEOF
sed -i "s|INSTALL_DIR_PLACEHOLDER|${INSTALL_DIR}|g; s|NODE_BIN_PLACEHOLDER|${NODE_BIN}|g" /etc/systemd/system/${SERVICE_NAME}.service

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" &>/dev/null
systemctl restart "$SERVICE_NAME"
sleep 2

SERVER_IP=$(curl -s --connect-timeout 3 ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP')
echo ""
echo -e "${GREEN}${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║          安装完成！                     ║${NC}"
echo -e "${GREEN}${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "  访问地址: ${BOLD}http://${SERVER_IP}:${PORT}${NC}"
echo -e "  用户名:   ${BOLD}${ADMIN_USERNAME}${NC}"
echo -e "  ${YELLOW}SA 邮箱: ${SA_EMAIL}（需已共享 Drive 文件夹）${NC}"
echo ""
echo "  systemctl status gdlist   # 查看状态"
echo "  journalctl -u gdlist -f   # 查看日志"
echo "  bash ${INSTALL_DIR}/install.sh   # 重新配置"
