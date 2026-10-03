"""Regress sleeve/head ownership and exact neutral TESTER dance composition."""
from pathlib import Path
import json
import sys
import unittest
import numpy as np
from PIL import Image
import prepare

HERE = Path(__file__).resolve().parent
BASELINE = None
MASK_BASELINE = None
if "--baseline" in sys.argv:
    index = sys.argv.index("--baseline")
    BASELINE = Path(sys.argv[index + 1])
    del sys.argv[index:index + 2]
if "--mask-baseline" in sys.argv:
    index = sys.argv.index("--mask-baseline")
    MASK_BASELINE = Path(sys.argv[index + 1]) / "tester"
    del sys.argv[index:index + 2]

FIXTURES = json.loads((HERE / "ownership-fixtures.json").read_text())["poses"]


def layer(part):
    """Load old saved layers only when demonstrating the regression."""
    path = (BASELINE / f"tester-dance-2-{part}-original.png") if BASELINE else HERE / "dance-2" / f"{part}.png"
    return Image.open(path).convert("RGBA")


class LayerOwnershipTests(unittest.TestCase):
    def test_confirmed_fabric_pixels_belong_to_body(self):
        self.assertEqual(len(FIXTURES), 11)
        for pose, fixture in FIXTURES.items():
            head_path = MASK_BASELINE / f"{pose}-head-baseline.png" if MASK_BASELINE else HERE / pose / "head.png"
            head = np.array(Image.open(head_path))
            body = np.array(Image.open(HERE / pose / "body.png"))
            samples = fixture["fabricToBody"] + fixture.get("additionalFabricToBody", [])
            self.assertGreater(len(samples), 0)
            for sample in samples:
                x, y = sample["point"]
                with self.subTest(pose=pose, point=[x, y]):
                    self.assertEqual(int(head[y, x, 3]), 0, "Fabric still moves with head")
                    np.testing.assert_array_equal(body[y, x], sample["rgba"])

    def test_facial_features_and_glasses_survive_cuts(self):
        for pose, fixture in FIXTURES.items():
            head = np.array(Image.open(HERE / pose / "head.png"))
            for sample in fixture["preservedHeadFeatures"]:
                x, y = sample["point"]
                with self.subTest(pose=pose, point=[x, y]):
                    self.assertGreater(sample["rgba"][3], 0)
                    np.testing.assert_array_equal(head[y, x], sample["rgba"])

    def test_repaired_head_neutral_pixels_equal_source(self):
        spec = json.loads((HERE / "spec.json").read_text())["poses"]
        characters = json.loads((HERE / "manifest.json").read_text())["characters"]
        for pose in FIXTURES:
            with self.subTest(pose=pose):
                source, _ = prepare.registered(spec[pose])
                definition = characters["tester/" + pose]["layers"]
                layers = {item["id"]: Image.open(prepare.EXPANSION / item["file"]).convert("RGBA") for item in definition}
                np.testing.assert_array_equal(np.array(prepare.compose(layers, definition)), np.array(source))

    def test_yellow_sleeve_stays_on_body(self):
        spec = json.loads((HERE / "spec.json").read_text())["poses"]["dance-2"]
        original, _ = prepare.registered(spec)
        rectangle = (110, 116, 113, 127)
        expected = np.array(original.crop(rectangle))[:, :, 3]
        rejected = np.array(layer("head").crop(rectangle))[:, :, 3]
        accepted = np.array(layer("body").crop(rectangle))[:, :, 3]
        self.assertGreater(int(np.count_nonzero(expected)), 10, "Empty sleeve fixture")
        self.assertEqual(int(np.count_nonzero(rejected)), 0, "Yellow sleeve still moves with head")
        np.testing.assert_array_equal(accepted, expected)

    def test_neutral_pixels_equal_registered_source(self):
        spec = json.loads((HERE / "spec.json").read_text())["poses"]["dance-2"]
        original, _ = prepare.registered(spec)
        manifest = json.loads((HERE / "manifest.json").read_text())["characters"]["tester/dance-2"]
        layers = {item["id"]: layer(item["id"]) for item in manifest["layers"]}
        actual = prepare.compose(layers, manifest["layers"])
        np.testing.assert_array_equal(np.array(actual), np.array(original))


if __name__ == "__main__":
    unittest.main()
