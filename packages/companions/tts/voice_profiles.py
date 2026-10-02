"""Select local synthetic reference voices without retaining two MLX models in memory."""
import gc
import json
from pathlib import Path


def read_profiles(directory):
    path = Path(directory) / "profiles.json"
    return json.loads(path.read_text()) if path.is_file() else {"profiles": {}}


class VoiceModels:
    def __init__(self, custom_path, models_directory, references, spec, load_model, clear_cache):
        self.custom_path = Path(custom_path)
        self.models_directory = Path(models_directory)
        self.references = Path(references)
        self.spec = spec
        self.load_model = load_model
        self.clear_cache = clear_cache
        self.model = None
        self.path = None

    def select(self, voice):
        profile = self.spec["profiles"].get(voice)
        path = self.models_directory / self.spec["model"]["directory"] if profile else self.custom_path
        if profile and not (self.references / profile["refAudio"]).is_file():
            raise FileNotFoundError("Synthetic voice reference is missing")
        if not (path / "model.safetensors").is_file():
            raise FileNotFoundError("Local voice model is missing; run setup:tts")
        if path != self.path:
            # Release the previous family before loading: Apple Silicon uses shared system memory.
            self.model = None
            self.path = None
            gc.collect()
            self.clear_cache()
            model = self.load_model(str(path))
            if model.tokenizer is None or model.speech_tokenizer is None:
                raise RuntimeError("Incomplete local voice model")
            self.model = model
            self.path = path
        return self.model, profile

    def generate(self, voice, text, language, instructions, max_tokens, stream=False):
        model, profile = self.select(voice)
        streaming = {"stream": True, "streaming_interval": 2.0} if stream else {}
        if profile:
            results = model.generate(text=text, ref_audio=str(self.references / profile["refAudio"]),
                ref_text=profile["refText"], lang_code=language, temperature=0.6,
                max_tokens=max_tokens, verbose=False, **streaming)
        else:
            results = model.generate_custom_voice(text=text, speaker=voice, language=language,
                instruct=instructions, temperature=0.7, max_tokens=max_tokens, verbose=False, **streaming)
        return results if stream else list(results), model.sample_rate

    def reset_stream(self):
        """Generator.close does not execute cleanup after a yielded library chunk."""
        if self.model is not None:
            self.model.speech_tokenizer.decoder.reset_streaming_state()
