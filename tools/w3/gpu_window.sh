#!/bin/bash
# Ventana controlada: para SÓLO el worker W3 (ocioso, cola vacía), mide, y lo
# rearranca pase lo que pase. El histórico (uvicorn:8001) no se toca.
set -u
restore() {
  echo "=== rearrancando worker W3 ==="
  systemctl --user start vanegas-w3-worker.service
  sleep 8
  systemctl --user is-active vanegas-w3-worker.service
  nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader
  curl -s -o /dev/null -w "historico 8001 -> HTTP %{http_code}\n" --max-time 5 http://127.0.0.1:8001/health
}
trap restore EXIT INT TERM

echo "=== antes ==="
journalctl --user -u vanegas-w3-worker.service -n 2 --no-pager | tail -2
systemctl --user stop vanegas-w3-worker.service
sleep 5
echo "VRAM libre tras parar el worker: $(nvidia-smi --query-gpu=memory.free --format=csv,noheader)"
nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader

cd /home/santiagov/w3-diag
HF_HUB_OFFLINE=1 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
  /home/santiagov/miniconda3/envs/mai-w3/bin/python probe_gpu.py 2>&1 \
  | grep -viE "^warning|deprecat|std\(\)|libtorch|TensorFloat|does not|^\s*$" | head -60
