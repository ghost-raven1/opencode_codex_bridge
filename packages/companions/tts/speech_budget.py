"""Bound runaway speech without playing a token-truncated utterance."""
import json
import math
from pathlib import Path
import unicodedata

POLICY = json.loads(Path(__file__).with_name("speech-budget.json").read_text())


class SpeechLimitError(ValueError):
    pass


def speech_budget(text):
    """Allow slow delivery and extra time for numbers spoken as Russian words."""
    text = text.strip()
    digits = sum(unicodedata.category(character) == "Nd" for character in text)
    estimated = (len(text) + POLICY["extraCharactersPerDigit"] * digits) / POLICY["charactersPerSecond"]
    seconds = min(POLICY["maximumSeconds"], max(POLICY["minimumSeconds"], estimated + POLICY["paddingSeconds"]))
    return seconds, math.ceil(seconds * POLICY["framesPerSecond"])


def check_generation(token_count, max_tokens, duration, max_duration):
    """Reaching the token cap means the model may not have finished the sentence."""
    if token_count <= 0 or token_count >= max_tokens or not math.isfinite(duration) or not 0 < duration <= max_duration:
        raise SpeechLimitError("speech-limit")
