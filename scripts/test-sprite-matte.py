"""Regression fixtures for neutral backdrop residue without erasing character details."""
import unittest
import numpy as np
from PIL import Image
from sprite_matte import clean_matte


class SpriteMatteTests(unittest.TestCase):
    def test_closed_checkerboard_inside_hair_is_removed(self):
        pixels = np.zeros((384, 256, 4), dtype=np.uint8)
        pixels[40:100, 30:70] = (115, 39, 31, 255)
        pixels[60:67, 45:52] = (223, 222, 225, 255)
        cleaned = np.array(clean_matte(Image.fromarray(pixels), 0))
        self.assertTrue((cleaned[60:67, 45:52] == 0).all())
        self.assertTrue((cleaned[40:55, 35:65] == pixels[40:55, 35:65]).all())

    def test_eyes_white_shoes_and_pale_hair_are_preserved(self):
        pixels = np.zeros((384, 256, 4), dtype=np.uint8)
        pixels[70:78, 122:145] = (250, 249, 251, 255)
        pixels[340:365, 60:100] = (245, 244, 245, 255)
        for column in range(4):
            result = np.array(clean_matte(Image.fromarray(pixels), column))
            self.assertTrue((result == pixels).all(), column)
        for column, color in [(2, (157, 177, 165, 255)), (3, (213, 204, 223, 255))]:
            pixels[30:55, 80:105] = color
            result = np.array(clean_matte(Image.fromarray(pixels), column))
            self.assertTrue((result == pixels).all(), column)

    def test_neutral_border_is_removed_without_blurring_interior(self):
        pixels = np.zeros((384, 256, 4), dtype=np.uint8)
        pixels[150:190, 90:150] = (28, 27, 41, 255)
        pixels[150, 90:150] = (175, 175, 180, 255)
        result = np.array(clean_matte(Image.fromarray(pixels), 1))
        self.assertTrue((result[150, 90:150] == 0).all())
        self.assertTrue((result[151:190, 90:150] == pixels[151:190, 90:150]).all())

    def test_warm_edge_halo_is_unmatted_against_the_existing_outline(self):
        pixels = np.zeros((384, 256, 4), dtype=np.uint8)
        pixels[30:45, 185:200] = (55, 24, 25, 255)
        pixels[30, 189:196] = (180, 145, 145, 255)
        result = np.array(clean_matte(Image.fromarray(pixels), 0))
        self.assertTrue((result[30, 189:196, :3] == [55, 24, 25]).all())
        self.assertTrue((result[30, 189:196, 3] < 255).all())
        self.assertTrue((result[31:45, 185:200] == pixels[31:45, 185:200]).all())


if __name__ == '__main__':
    unittest.main()
