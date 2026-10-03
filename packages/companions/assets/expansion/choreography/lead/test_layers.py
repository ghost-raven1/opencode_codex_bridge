"""Regress measured hair/chest ownership and exact neutral dance composition."""
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
    MASK_BASELINE = Path(sys.argv[index + 1]) / "lead"
    del sys.argv[index:index + 2]

FIXTURES = json.loads((HERE / "ownership-fixtures.json").read_text())["poses"]


def layer(pose, part):
    """Load old saved layers only when demonstrating the regression."""
    path = (BASELINE / f"lead-{pose}-{part}-original.png") if BASELINE else HERE / pose / f"{part}.png"
    return Image.open(path).convert("RGBA")


class LayerOwnershipTests(unittest.TestCase):
    def test_confirmed_fabric_pixels_belong_to_body(self):
        self.assertEqual(len(FIXTURES), 14)
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

    def test_facial_features_hair_and_green_eyes_survive_cuts(self):
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
                definition = characters["lead/" + pose]["layers"]
                layers = {item["id"]: Image.open(prepare.EXPANSION / item["file"]).convert("RGBA") for item in definition}
                np.testing.assert_array_equal(np.array(prepare.compose(layers, definition)), np.array(source))

    def assert_owner(self, pose, rectangle, owner, rejected):
        spec = json.loads((HERE / "spec.json").read_text())["poses"][pose]
        source, _ = prepare.registered(spec)
        alpha = np.array(source.crop(rectangle))[:, :, 3]
        accepted = np.array(layer(pose, owner).crop(rectangle))[:, :, 3]
        excluded = np.array(layer(pose, rejected).crop(rectangle))[:, :, 3]
        self.assertGreater(int(np.count_nonzero(alpha)), 10, "Empty ownership fixture")
        self.assertEqual(int(np.count_nonzero(excluded)), 0, f"{pose}/{rejected} still owns {owner} pixels")
        np.testing.assert_array_equal(accepted, alpha)

    def test_dance_three_hair_stays_on_head(self):
        self.assert_owner("dance-3", (59, 94, 86, 102), "head", "arm-left")

    def test_dance_three_chest_stays_on_body(self):
        self.assert_owner("dance-3", (74, 126, 85, 137), "body", "arm-left")

    def test_dance_four_loose_hair_stays_on_head(self):
        self.assert_owner("dance-4", (94, 69, 98, 82), "head", "arm-left")

    def test_dance_four_collar_stays_on_body(self):
        self.assert_owner("dance-4", (127, 113, 130, 118), "body", "head")

    def test_dance_four_jacket_stays_on_body(self):
        self.assert_owner("dance-4", (115, 115, 122, 119), "body", "head")

    def test_no_exported_micro_props(self):
        manifest = json.loads((HERE / "manifest.json").read_text())
        for name in ["work-profile", "work-right-profile"]:
            profile = manifest["characters"]["lead/" + name]
            self.assertNotIn("prop", [item["id"] for item in profile["layers"]])
            old_prop = BASELINE / f"lead-{name}-prop-original.png" if BASELINE else HERE / name / "prop.png"
            self.assertFalse(old_prop.exists(), "Unused micro prop file survived export")
        for pose in manifest["characters"].values():
            for item in pose["layers"]:
                if item["id"] == "prop":
                    image = Image.open(prepare.EXPANSION / item["file"])
                    self.assertGreater(int(np.count_nonzero(np.array(image)[:, :, 3] > 8)), 20, item["file"])

    def test_neutral_pixels_equal_registered_source(self):
        spec = json.loads((HERE / "spec.json").read_text())["poses"]
        manifest = json.loads((HERE / "manifest.json").read_text())["characters"]
        for pose in ["dance-3", "dance-4", "work-profile", "work-right-profile"]:
            with self.subTest(pose=pose):
                original, _ = prepare.registered(spec[pose])
                definitions = manifest["lead/" + pose]["layers"]
                layers = {item["id"]: layer(pose, item["id"]) for item in definitions}
                actual = prepare.compose(layers, definitions)
                np.testing.assert_array_equal(np.array(actual), np.array(original))


if __name__ == "__main__":
    unittest.main()
