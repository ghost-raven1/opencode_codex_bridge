"""Download only the public pinned model; inference never contacts Hugging Face."""
import sys
from pathlib import Path

sys.pycache_prefix = str(Path(__file__).resolve().parents[3] / ".local/tts/cache/pycache")
from local_paths import MODEL, MODEL_PATH, LOCAL, SOURCE, configure_environment
from voice_profiles import read_profiles

configure_environment(offline=False)

from huggingface_hub import snapshot_download

snapshot_download(
    repo_id=MODEL["id"], revision=MODEL["revision"], local_dir=MODEL_PATH,
    token=False, max_workers=3,
)
print(f"Model ready: {MODEL_PATH}")
profiles = read_profiles(SOURCE.parent / "assets/expansion/voices")
if profiles["profiles"]:
    clone = profiles["model"]
    snapshot_download(repo_id=clone["id"], revision=clone["revision"],
        local_dir=LOCAL / "models" / clone["directory"], token=False, max_workers=3)
    print(f"Synthetic reference voice model ready: {clone['directory']}")
