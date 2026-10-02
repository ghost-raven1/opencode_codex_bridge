"""Create fictional local voice references and verify reuse with Qwen Base; no runtime edits."""
from pathlib import Path
import json
import os
import sys
import time
import wave

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
LOCAL = ROOT / '.local/tts'
MODELS = {
    'design': ('mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-4bit', 'qwen3-1.7b-voicedesign-4bit'),
    'clone': ('mlx-community/Qwen3-TTS-12Hz-1.7B-Base-4bit', 'qwen3-1.7b-base-4bit'),
}
PROFILES = {
    'designer': 'An adult female Russian voice with a light airy mezzo-soprano, warm intimate resonance and clear gentle consonants. Friendly and thoughtful, neutral steady conversational Russian with a narrow pitch range. Medium natural pace, no whisper, no theatrical or singing inflection, no imitation of a real person.',
    'devops': 'An adult female Russian voice, low contralto, rich dark chest resonance with a very subtle husky texture. Calm, grounded and decisive, precise consonants, steady measured pace, dry confident delivery, no imitation of a real person.',
    'tester': 'An adult female Russian voice, bright clear soprano with forward resonant placement and a slight nasal sparkle. Curious attentive delivery, neutral steady conversational Russian with a narrow pitch range and crisp articulation. No theatrical pitch jumps, no childish voice or imitation of a real person.',
}
REFERENCE_TEXT = 'Привет, я рядом. Проверим задачу внимательно, найдём хорошее решение и доведём работу до конца.'
CLONE_TEXT = 'Проверка завершена. Теперь можно спокойно продолжать работу.'


def environment(offline):
    """Keep all downloads and caches in the ignored local model directory."""
    for name, suffix in {'HF_HOME': 'cache/huggingface', 'HF_HUB_CACHE': 'cache/huggingface/hub',
                         'HF_XET_CACHE': 'cache/huggingface/xet', 'XDG_CACHE_HOME': 'cache', 'TMPDIR': 'tmp'}.items():
        path = LOCAL / suffix
        path.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(path)
    os.environ.update(HF_HUB_DISABLE_IMPLICIT_TOKEN='1', HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false')
    if offline:
        os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')


def main():
    mode = sys.argv[1]
    environment(mode != 'download')
    if mode == 'download':
        from huggingface_hub import HfApi, snapshot_download
        revisions = {}
        for key, (repo, directory) in MODELS.items():
            info = HfApi(token=False).model_info(repo)
            revisions[key] = {'id': repo, 'revision': info.sha, 'directory': directory, 'license': 'Apache-2.0'}
            print(json.dumps(revisions[key]), flush=True)
            snapshot_download(repo_id=repo, revision=info.sha, local_dir=LOCAL/'models'/directory, token=False, max_workers=2)
        (HERE/'models.json').write_text(json.dumps(revisions, indent=2)+'\n')
        return
    import mlx.core as mx
    import numpy as np
    from mlx_audio.tts.utils import load_model
    model = load_model(str(LOCAL/'models'/MODELS['clone' if mode == 'validate' else mode][1]))
    report = []
    for index, (role, instruction) in enumerate(PROFILES.items()):
        mx.random.seed(20261002 + index)
        mx.reset_peak_memory()
        start = time.perf_counter()
        if mode == 'design':
            outputs = list(model.generate_voice_design(text=REFERENCE_TEXT, instruct=instruction, language='Russian', temperature=.7, max_tokens=500, verbose=False))
        else:
            text = ('Нашла важную деталь. Сначала проверю условия, затем покажу результат.' if mode == 'validate' else CLONE_TEXT)
            outputs = list(model.generate(text=text, ref_audio=str(HERE/f'{role}-reference.wav'), ref_text=REFERENCE_TEXT, lang_code='Russian', temperature=.6, max_tokens=350, verbose=False))
        audio = np.asarray(mx.concatenate([r.audio.reshape(-1) for r in outputs]))
        if not np.isfinite(audio).all() or len(audio) == 0:
            raise ValueError('empty or invalid waveform')
        path = HERE/f'{role}-{"reference" if mode == "design" else "validation" if mode == "validate" else "clone-preview"}.wav'
        with wave.open(str(path), 'wb') as f:
            f.setnchannels(1); f.setsampwidth(2); f.setframerate(model.sample_rate)
            f.writeframes((np.clip(audio, -1, 1)*32767).astype('<i2').tobytes())
        item = {'role': role, 'file': path.name, 'durationSeconds': len(audio)/model.sample_rate,
                'generationSeconds': time.perf_counter()-start, 'peakMemoryBytes': mx.get_peak_memory(),
                'description': instruction, 'text': REFERENCE_TEXT if mode == 'design' else text,
                'tokens': sum(r.token_count for r in outputs)}
        report.append(item)
        (HERE/f'{mode}-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps(item, ensure_ascii=False), flush=True)
        mx.clear_cache()


if __name__ == '__main__':
    main()
