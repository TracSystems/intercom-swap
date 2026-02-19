#!/data/data/com.termux/files/usr/bin/bash
set -e

PORT="${PORT:-8787}"

while true; do
  clear
  echo "==============================="
  echo " kulon666 BOT MENU (NEW BUILD)"
  echo "==============================="
  echo "1) Start Web Dashboard"
  echo "2) Open Dashboard URL"
  echo "3) Deploy (auto push GitHub)"
  echo "4) Exit"
  echo
  read -p "Select: " c

  case "$c" in
    1) node server.js ;;
    2) echo "Open: http://127.0.0.1:${PORT}"; read -p "Enter..." ;;
    3) ./scripts/deploy.sh "update: new dashboard + trac tracker + charts + swap loop" ;;
    4) exit 0 ;;
    *) echo "Invalid"; sleep 1 ;;
  esac
done
