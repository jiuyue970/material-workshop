#!/usr/bin/env bash
# 素材工坊 → 远程 ComfyUI 的 SSH 隧道管理
# 用法: scripts/comfy-tunnel.sh start|stop|status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 可选读取项目根目录 .env
if [[ -f "$ROOT/.env" ]]; then set -a; source "$ROOT/.env"; set +a; fi

SSH_HOST="${COMFY_SSH_HOST:-7f5704636c9a4178b83e1e4c1192d2fb.region1.waas.aigate.cc}"
SSH_PORT="${COMFY_SSH_PORT:-44878}"
SSH_USER="${COMFY_SSH_USER:-root}"
KEY_PATH="${COMFY_SSH_KEY_PATH:-$HOME/.ssh/material_workshop_comfy}"
LOCAL_PORT="${COMFY_LOCAL_PORT:-8188}"

DATA_DIR="$ROOT/data"
PID_FILE="$DATA_DIR/comfy-tunnel.pid"
LOG_FILE="$DATA_DIR/comfy-tunnel.log"
mkdir -p "$DATA_DIR"

is_running() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

api_ok() { curl -fsS -m 5 "http://127.0.0.1:${LOCAL_PORT}/system_stats" >/dev/null 2>&1; }

start() {
  if is_running; then
    echo "隧道已在运行: PID $(cat "$PID_FILE")"
    api_ok && echo "ComfyUI API: OK (http://127.0.0.1:${LOCAL_PORT})" || echo "警告: 端口暂未就绪"
    return 0
  fi
  echo "启动隧道: 127.0.0.1:${LOCAL_PORT} -> ${SSH_USER}@${SSH_HOST}:${SSH_PORT} -> ComfyUI:8188"
  nohup bash -c "
    while true; do
      ssh -N -T \
        -o BatchMode=yes -o IdentitiesOnly=yes \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o ExitOnForwardFailure=yes \
        -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
        -i '$KEY_PATH' -p '$SSH_PORT' \
        -L 127.0.0.1:${LOCAL_PORT}:127.0.0.1:8188 \
        '${SSH_USER}@${SSH_HOST}'
      echo \"\$(date '+%F %T') ssh 断开, 5 秒后重连...\" >> '$LOG_FILE'
      sleep 5
    done
  " >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "隧道守护进程 PID $(cat "$PID_FILE"), 日志: $LOG_FILE"
  for _ in $(seq 1 20); do
    if api_ok; then echo "ComfyUI API: OK (http://127.0.0.1:${LOCAL_PORT})"; return 0; fi
    sleep 1
  done
  echo "警告: 20 秒内 ComfyUI API 未就绪, 请查看日志" >&2
  return 1
}

stop() {
  if is_running; then
    PID="$(cat "$PID_FILE")"
    pkill -P "$PID" 2>/dev/null || true
    kill "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "隧道已停止"
  else
    echo "隧道未运行"
    rm -f "$PID_FILE"
  fi
}

status() {
  if is_running; then
    echo "隧道: running PID $(cat "$PID_FILE")"
  else
    echo "隧道: stopped"
  fi
  if api_ok; then
    echo "ComfyUI API: OK (http://127.0.0.1:${LOCAL_PORT})"
  else
    echo "ComfyUI API: FAIL"
    return 1
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "用法: $0 start|stop|status" >&2; exit 2 ;;
esac
