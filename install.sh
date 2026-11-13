#!/bin/sh
# SourceBoard 安装：检查 Python、把 sourceboard 命令链接到 ~/.local/bin、跑一遍不联网的自检。
# 不需要 sudo，不用 pip 装任何东西。想换命令目录：SOURCEBOARD_BIN_DIR=/你的目录 ./install.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="${SOURCEBOARD_BIN_DIR:-$HOME/.local/bin}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "没有找到 python3。请先安装 Python 3.9 或更高版本。" >&2; exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
  echo "需要 Python 3.9 或更高版本，当前是 $(python3 -V 2>&1)。" >&2; exit 1
fi

chmod +x "$DIR/bin/sourceboard"
mkdir -p "$BIN"
ln -sf "$DIR/bin/sourceboard" "$BIN/sourceboard"
echo "已把 sourceboard 命令链接到 $BIN/sourceboard"

echo "运行不联网的自检……"
if python3 -B "$DIR/tests/test_offline.py" >/dev/null 2>&1; then
  echo "自检通过。"
else
  echo "自检没有通过，请运行 python3 -B $DIR/tests/test_offline.py 看具体哪一项。" >&2; exit 1
fi

CMD="sourceboard"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) CMD="$BIN/sourceboard"
     echo "提示：$BIN 不在 PATH 里。可以用完整路径 $CMD，或把下面这行加进你的 shell 配置："
     echo "  export PATH=\"$BIN:\$PATH\"" ;;
esac

echo
echo "下一步（必须）：在你自己的终端运行  $CMD setup"
echo "它会先说明能做什么、要花什么钱，再带你把 TikHub 钥匙配好。"
