#!/bin/bash
# Ventana de GPU: para SOLO vanegas-w3-worker.service, corre UNA prueba, y lo devuelve.
# El servicio historico (uvicorn:8001) no se toca en ningun momento.
set -u
UNIT=vanegas-w3-worker.service
E=/home/santiagov/miniconda3/envs/mai-w3

restore() {
  echo "=== [trap] devolviendo $UNIT ==="
  systemctl --user start "$UNIT" 2>&1 | tail -2
}
trap restore EXIT INT TERM

# VIGILANTE INDEPENDIENTE. El trap no protege de una desconexion ni de un SIGKILL, asi
# que ademas se deja un proceso desacoplado que arranca el worker pase lo que pase.
setsid nohup bash -c "sleep 330; systemctl --user is-active $UNIT >/dev/null 2>&1 || systemctl --user start $UNIT" \
  </dev/null >/dev/null 2>&1 &
echo "vigilante independiente armado (arranca el worker a los 330 s pase lo que pase)"

echo "=== parando SOLO $UNIT ==="
systemctl --user stop "$UNIT"
sleep 4
echo "  estado: $(systemctl --user is-active $UNIT)"
echo "  GPU libre tras parar: $(nvidia-smi --query-gpu=memory.free --format=csv,noheader)"
echo "  procesos en GPU: $(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader | tr '\n' ' ')"

echo
echo "=== LA prueba (limite duro de 240 s) ==="
cd /home/santiagov/w3-work
HF_HUB_OFFLINE=1 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
LD_LIBRARY_PATH="$E/cuda12-runtime/nvidia/cublas/lib:$E/cuda12-runtime/nvidia/cudnn/lib" \
timeout 240 "$E/bin/python" gpu_test.py --out /home/santiagov/w3-work/gpu_result.json --deadline-s 200 2>&1 \
  | grep -viE "^warning|deprecat|std\(\)|libtorch|TensorFloat|^\s*$|It can be re-enabled|torch.backends|See https|warnings.warn"
echo "  codigo de salida de la prueba: ${PIPESTATUS[0]}"
