"""Exercise voice-family transitions without loading a model or requesting audio permissions."""
from pathlib import Path
import sys
import tempfile
import unittest
import weakref

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages/companions/tts"))
from voice_profiles import VoiceModels


class Model:
    tokenizer = speech_tokenizer = object()
    sample_rate = 24000

    def generate(self, **kwargs):
        yield {"family": "base", **kwargs}

    def generate_custom_voice(self, **kwargs):
        yield {"family": "custom", **kwargs}


class ProfilesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ["custom", "base"]:
            (self.root / name).mkdir()
            (self.root / name / "model.safetensors").touch()
        (self.root / "reference.wav").touch()
        self.loads = []
        self.previous = None
        def clear():
            self.assertTrue(self.previous is None or self.previous() is None, "Previous model retained during next family load")
        def load(path):
            self.loads.append(path)
            model = Model()
            self.previous = weakref.ref(model)
            return model
        spec = {"model": {"directory": "base"}, "profiles": {
            name: {"refAudio": "reference.wav", "refText": name + " fixed synthetic reference"}
            for name in ["designer-local", "devops-local", "tester-local"]
        }}
        self.voices = VoiceModels(self.root / "custom", self.root, self.root, spec, load, clear)

    def generate(self, voice):
        results, sample_rate = self.voices.generate(voice, "Новая фраза.", "Russian", "Steady.", 187)
        self.assertEqual(sample_rate, 24000)
        self.assertEqual(results[0]["text"], "Новая фраза.")
        self.assertEqual(results[0]["max_tokens"], 187)
        return results[0]

    def test_base_first_is_lazy_and_reuses_one_model_for_all_references(self):
        self.assertEqual(self.loads, [])
        for voice in ["designer-local", "devops-local", "tester-local"]:
            result = self.generate(voice)
            self.assertEqual(result["family"], "base")
            self.assertEqual(result["ref_text"], voice + " fixed synthetic reference")
            self.assertEqual(result["lang_code"], "Russian")
        self.assertEqual(self.loads, [str(self.root / "base")])

    def test_switch_releases_previous_model_and_restores_existing_custom_voices(self):
        self.generate("Serena")
        self.generate("tester-local")
        result = self.generate("Vivian")
        self.assertEqual(result["speaker"], "Vivian")
        self.assertEqual(result["language"], "Russian")
        self.assertEqual(result["instruct"], "Steady.")
        self.assertEqual(self.loads, [str(self.root / name) for name in ["custom", "base", "custom"]])

    def test_missing_optional_model_does_not_discard_a_working_custom_model(self):
        self.generate("Serena")
        (self.root / "base/model.safetensors").unlink()
        with self.assertRaises(FileNotFoundError):
            self.generate("tester-local")
        self.generate("Vivian")
        self.assertEqual(len(self.loads), 1)

    def test_missing_reference_never_loads_base_or_changes_identity(self):
        (self.root / "reference.wav").unlink()
        with self.assertRaises(FileNotFoundError):
            self.generate("designer-local")
        self.assertEqual(self.loads, [])

    def test_incomplete_base_load_does_not_poison_the_following_custom_request(self):
        loader = self.voices.load_model
        def incomplete(path):
            if path.endswith("base"):
                model = Model()
                model.tokenizer = None
                return model
            return loader(path)
        self.voices.load_model = incomplete
        with self.assertRaises(RuntimeError):
            self.generate("tester-local")
        self.assertIsNone(self.voices.model)
        self.assertIsNone(self.voices.path)
        self.assertEqual(self.generate("Serena")["family"], "custom")


if __name__ == "__main__":
    unittest.main()
