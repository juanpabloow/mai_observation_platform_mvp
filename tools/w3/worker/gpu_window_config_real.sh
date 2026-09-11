#!/bin/bash
# Ventana 2: la MISMA configuracion que tendra el servicio.
#   compute_type = el de .env.w3 (int8_float16)
#   backend      = pyannote_full, sobreescrito aqui porque .env.w3 aun dice wespeaker
# Sobre el commit c2614b2, que es exactamente lo que se va a desplegar.
set -u
UNIT=vanegas-w3-worker.service
E=$HOME/miniconda3/envs/mai-w3
A=$HOME/services/mai-w3-worker/transcript-worker

restore() { echo "=== [trap] devolviendo $UNIT ==="; systemctl --user start "$UNIT" 2>&1 | tail -2; }
trap restore EXIT INT TERM

setsid nohup bash -c "sleep 330; systemctl --user is-active $UNIT >/dev/null 2>&1 || systemctl --user start $UNIT" \
  </dev/null >/dev/null 2>&1 &
echo "vigilante independiente armado (330 s)"

echo "=== parando SOLO $UNIT ==="
systemctl --user stop "$UNIT"; sleep 4
echo "  estado: $(systemctl --user is-active $UNIT) · GPU libre: $(nvidia-smi --query-gpu=memory.free --format=csv,noheader)"
echo "  en GPU: $(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader | tr '\n' ' ')"

echo
echo "=== prueba sobre el commit c2614b2, con .env.w3 + backend sobreescrito ==="
cd $HOME/w3-work
set -a; . "$A/.env.w3"; set +a          # trae WHISPER_COMPUTE_TYPE=int8_float16 (y el token, que no se usa)
export DIARIZATION_BACKEND=pyannote_full  # .env.w3 aun dice wespeaker; esto es lo que se va a desplegar
export MEETINGS_PULL_ENABLED=false        # cinturon: la prueba NO reclama trabajos
unset MAI_WORKER_TOKEN                    # y sin token no podria hablar con mai aunque quisiera

HF_HUB_OFFLINE=1 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
LD_LIBRARY_PATH="$E/cuda12-runtime/nvidia/cublas/lib:$E/cuda12-runtime/nvidia/cudnn/lib" \
timeout 240 "$E/bin/python" gpu_test.py \
  --worker-root $HOME/w3-commit/transcript-worker \
  --expect-compute int8_float16 --expect-backend pyannote_full \
  --out $HOME/w3-work/gpu_result2.json --deadline-s 200 2>&1 \
  | grep -viE "^warning|deprecat|std\(\)|libtorch|TensorFloat|^\s*$|It can be re-enabled|torch.backends|See https|warnings.warn|>>> import"
echo "  codigo de salida: ${PIPESTATUS[0]}"
