#!/bin/zsh
cd "${0:A:h}"
if command -v node >/dev/null 2>&1; then
  exec node tools/server.mjs
fi
for candidate in "$HOME"/development/node*/bin/node(N); do
  exec "$candidate" tools/server.mjs
done
print '需要 Node.js 22 或更新版本。安装后再次打开此文件。'
read -k 1
