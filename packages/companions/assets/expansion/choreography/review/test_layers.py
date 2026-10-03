"""Regress REVIEW micro prop cleanup and preserved neutral source composition."""
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
NECK_BASELINE = None
if "--baseline" in sys.argv:
    index = sys.argv.index("--baseline")
    BASELINE = Path(sys.argv[index + 1])
    del sys.argv[index:index + 2]
if "--mask-baseline" in sys.argv:
    index = sys.argv.index("--mask-baseline")
    MASK_BASELINE = Path(sys.argv[index + 1]) / "review"
    del sys.argv[index:index + 2]
if "--neck-baseline" in sys.argv:
    index = sys.argv.index("--neck-baseline")
    NECK_BASELINE = Path(sys.argv[index + 1])
    del sys.argv[index:index + 2]

OWNERSHIP = json.loads((HERE / "ownership-fixtures.json").read_text())
FIXTURES = OWNERSHIP["poses"]
NECK = json.loads((HERE / "neck-underlap-fixture.json").read_text())


class LayerOwnershipTests(unittest.TestCase):
    def assert_neutral_source(self, pose, actual, source):
        """Only the immutable measured neck pixels permit a bounded alpha delta."""
        if pose != NECK["pose"]:
            np.testing.assert_array_equal(actual, source)
            return
        allowed = np.zeros(source.shape[:2], dtype=bool)
        for x, y in NECK["whitelist"]:
            allowed[y, x] = True
        np.testing.assert_array_equal(actual[~allowed], source[~allowed])
        delta = np.abs(actual.astype(int) - source.astype(int))
        self.assertLessEqual(int(delta[allowed].max()), NECK["maxNeutralRgbaDelta"])

    def neck_layers(self):
        definition = json.loads((HERE / "manifest.json").read_text())["characters"]["review/" + NECK["pose"]]["layers"]
        layers = {item["id"]: Image.open(prepare.EXPANSION / item["file"]).convert("RGBA") for item in definition}
        if NECK_BASELINE:
            layers["body"] = Image.open(NECK_BASELINE).convert("RGBA")
        return definition, layers

    def test_measured_neck_underlap_uses_collar_donors(self):
        _, layers = self.neck_layers()
        body, head = np.array(layers["body"]), np.array(layers["head"])
        self.assertEqual(len(NECK["underlap"]), 52)
        self.assertEqual(NECK["whitelist"], [item["point"] for item in NECK["underlap"]])
        for item in NECK["underlap"]:
            x, y = item["point"]
            sx, sy = item["donor"]
            with self.subTest(point=[x, y]):
                np.testing.assert_array_equal(head[y, x], item["headRgba"])
                np.testing.assert_array_equal(body[y, x], item["bodyRgba"])
                np.testing.assert_array_equal(body[sy, sx], item["bodyRgba"])
                self.assertGreaterEqual(int(head[y, x, 3]), 245)

    def test_neck_allowance_rejects_unlisted_or_excess_changes(self):
        definition, layers = self.neck_layers()
        spec = json.loads((HERE / "spec.json").read_text())["poses"][NECK["pose"]]
        source = np.array(prepare.registered(spec)[0])
        actual = np.array(prepare.compose(layers, definition))
        outside = actual.copy()
        outside[94, 130, 0] = int(source[94, 130, 0]) + 1
        with self.assertRaises(AssertionError):
            self.assert_neutral_source(NECK["pose"], outside, source)
        excessive = actual.copy()
        x, y = NECK["witness"]
        excessive[y, x, 0] = int(source[y, x, 0]) + NECK["maxNeutralRgbaDelta"] + 1
        with self.assertRaises(AssertionError):
            self.assert_neutral_source(NECK["pose"], excessive, source)

    def test_moving_neck_has_no_transparent_gap(self):
        definition, layers = self.neck_layers()
        for angle in [-0.8, 0, 0.8]:
            for dx, dy in [(-0.75, -0.75), (-0.75, 0.75), (0.75, -0.75), (0.75, 0.75)]:
                moved = layers.copy()
                moved["head"] = layers["head"].rotate(angle, Image.Resampling.BICUBIC, center=(132, 98)).transform(
                    prepare.SIZE, Image.Transform.AFFINE, (1, 0, -dx, 0, 1, -dy), Image.Resampling.BICUBIC)
                alpha = np.array(prepare.compose(moved, definition))[:, :, 3]
                with self.subTest(angle=angle, dx=dx, dy=dy):
                    self.assertGreaterEqual(min(int(alpha[y, x]) for x, y in NECK["whitelist"]), 240)

    def test_confirmed_fabric_pixels_belong_to_body(self):
        self.assertEqual(len(FIXTURES), 11)
        for pose, fixture in FIXTURES.items():
            head_path = MASK_BASELINE / f"{pose}-head-baseline.png" if MASK_BASELINE else HERE / pose / "head.png"
            head = np.array(Image.open(head_path))
            body = np.array(Image.open(HERE / pose / "body.png"))
            self.assertGreater(len(fixture["fabricToBody"]), 0)
            for sample in fixture["fabricToBody"]:
                x, y = sample["point"]
                with self.subTest(pose=pose, point=[x, y]):
                    self.assertEqual(int(head[y, x, 3]), 0, "Fabric still moves with head")
                    np.testing.assert_array_equal(body[y, x], sample["rgba"])

    def test_facial_features_and_silver_hair_survive_cuts(self):
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
                definition = characters["review/" + pose]["layers"]
                layers = {item["id"]: Image.open(prepare.EXPANSION / item["file"]).convert("RGBA") for item in definition}
                self.assert_neutral_source(pose, np.array(prepare.compose(layers, definition)), np.array(source))

    def test_leaning_silver_strand_belongs_to_head(self):
        fixture = OWNERSHIP["armOwnership"]
        pose = fixture["pose"]
        path = MASK_BASELINE / f"{pose}-arm-left-baseline.png" if MASK_BASELINE else HERE / pose / "arm-left.png"
        arm = np.array(Image.open(path))
        head = np.array(Image.open(HERE / pose / "head.png"))
        self.assertGreater(len(fixture["hairToHead"]), 0)
        for sample in fixture["hairToHead"]:
            x, y = sample["point"]
            self.assertEqual(int(arm[y, x, 3]), 0, "Silver strand still moves with hand")
            np.testing.assert_array_equal(head[y, x], sample["rgba"])

    def test_leaning_chin_hand_belongs_to_arm(self):
        fixture = OWNERSHIP["armOwnership"]
        pose = fixture["pose"]
        head = np.array(Image.open(HERE / pose / "head.png"))
        arm = np.array(Image.open(HERE / pose / "arm-left.png"))
        self.assertGreater(len(fixture["handToArm"]), 0)
        for sample in fixture["handToArm"]:
            x, y = sample["point"]
            self.assertEqual(int(head[y, x, 3]), 0, "Hand still moves with head")
            np.testing.assert_array_equal(arm[y, x], sample["rgba"])

    def test_no_exported_micro_props(self):
        manifest = json.loads((HERE / "manifest.json").read_text())
        back = manifest["characters"]["review/work-back"]
        self.assertNotIn("prop", [item["id"] for item in back["layers"]])
        old_prop = BASELINE / "review-work-back-prop-before.png" if BASELINE else HERE / "work-back/prop.png"
        self.assertFalse(old_prop.exists(), "Unused micro prop file survived export")
        for pose in manifest["characters"].values():
            for item in pose["layers"]:
                if item["id"] == "prop":
                    image = Image.open(prepare.EXPANSION / item["file"])
                    self.assertGreater(int(np.count_nonzero(np.array(image)[:, :, 3] > 8)), 20, item["file"])

    def test_small_outline_pixels_stay_on_holding_arm(self):
        spec = json.loads((HERE / "spec.json").read_text())["poses"]["work-back"]
        original, _ = prepare.registered(spec)
        source = np.array(original)
        actual = np.array(Image.open(HERE / "work-back/arm-right.png"))
        for x, y in [(190, 151), (188, 154), (187, 155)]:
            self.assertGreater(int(source[y, x, 3]), 0)
            np.testing.assert_array_equal(actual[y, x], source[y, x])

    def test_neutral_pixels_equal_registered_source(self):
        spec = json.loads((HERE / "spec.json").read_text())["poses"]["work-back"]
        original, _ = prepare.registered(spec)
        definition = json.loads((HERE / "manifest.json").read_text())["characters"]["review/work-back"]
        layers = {item["id"]: Image.open(prepare.EXPANSION / item["file"]).convert("RGBA")
                  for item in definition["layers"]}
        np.testing.assert_array_equal(np.array(prepare.compose(layers, definition["layers"])), np.array(original))


if __name__ == "__main__":
    unittest.main()
