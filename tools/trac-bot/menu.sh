#!/data/data/com.termux/files/usr/bin/bash
set -e

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$BASE_DIR/config.env"

banner(){
  clear
  echo "=============================="
  echo " TRAC BOT (NEW) • MENU"
  echo "=============================="
  echo "Web: http://127.0.0.1:$WEB_PORT"
  echo "Chart: http://127.0.0.1:$WEB_PORT/chart.html"
  echo
}

pause(){ echo; read -r -p "Enter untuk lanjut..."; }

start_web(){
  cd "$BASE_DIR/web"
  echo "[+] Serving web on http://127.0.0.1:$WEB_PORT"
  python -m http.server "$WEB_PORT"
}

open_web(){
  if command -v termux-open-url >/dev/null 2>&1; then
    termux-open-url "http://127.0.0.1:$WEB_PORT"
  else
    echo "[i] Install termux-api: pkg install termux-api"
  fi
}

open_chart(){
  if command -v termux-open-url >/dev/null 2>&1; then
    termux-open-url "http://127.0.0.1:$WEB_PORT/chart.html"
  else
    echo "Open manual: http://127.0.0.1:$WEB_PORT/chart.html"
  fi
}

trac_tracker(){
  echo
  echo "TRAC TRACKER"
  echo "Address : $TRAC_ADDRESS"
  echo "Explorer: $TRAC_EXPLORER_BASE/$TRAC_ADDRESS"
  echo
  if command -v termux-open-url >/dev/null 2>&1; then
    read -r -p "Buka explorer? (y/n): " yn
    [ "$yn" = "y" ] && termux-open-url "$TRAC_EXPLORER_BASE/$TRAC_ADDRESS"
  fi
}

while true; do
  banner
  echo "1) Start Web (localhost)"
  echo "2) Open Web"
  echo "3) Open TNK 15m Chart"
  echo "4) TRAC Network Tracker (Explorer)"
  echo "0) Exit"
  echo
  read -r -p "Pilih: " c
  case "$c" in
    1) start_web ;;
    2) open_web; pause ;;
    3) open_chart; pause ;;
    4) trac_tracker; pause ;;
    0) exit 0 ;;
    *) echo "Salah"; sleep 1 ;;
  esac
done
