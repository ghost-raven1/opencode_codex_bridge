"""Download only the public pinned model; inference never contacts Hugging Face."""
import sys
from pathlib import Path

sys.pycache_prefix = str(Path(__file__).resolve().parents[3] / ".local/tts/cache/pycache")
from local_paths import MODEL, MODEL_PATH, configure_environment

configure_environment(offline=False)

from huggingface_hub import snapshot_download

snapshot_download(
    repo_id=MODEL["id"], revision=MODEL["revision"], local_dir=MODEL_PATH,
    token=False, max_workers=3,
)
print(f"Model ready: {MODEL_PATH}")
