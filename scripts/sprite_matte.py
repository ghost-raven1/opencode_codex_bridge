"""Technical cleanup of the measured neutral matte in the original 256x384 sprites."""
import numpy as np
from PIL import Image

FACE_BOXES = [(87, 46, 166, 112), (105, 45, 175, 110),
              (92, 48, 170, 115), (112, 43, 177, 115)]


def clean_matte(image: Image.Image, column: int) -> Image.Image:
    """Remove backdrop residue, protecting faces, pale hair, ivory fabric and shoes."""
    pixels = np.array(image.convert('RGBA'))
    rgb = pixels[:, :, :3].astype(np.int16)
    red, green, blue = rgb.transpose(2, 0, 1)
    spread = rgb.max(2) - rgb.min(2)
    neutral = (red > 85) & (spread < 32) & (blue >= red - 4) & (green >= red - 5)
    # Pale green/silver strands are actual artwork, not grey backdrop.
    if column >= 2:
        neutral &= spread < 10
    neutral[290:] = False
    x0, y0, x1, y1 = FACE_BOXES[column]
    neutral[y0:y1, x0:x1] = False
    # Closed checkerboard islands inside warm/purple hair never touch the outside flood.
    if column < 2:
        islands = (red > 85) & (spread < 40) & (blue >= red - 12) & (green >= red - 12)
        islands[112:] = False
        islands[y0:y1, x0:x1] = False
        if column == 0:
            # Warm-tinted checkerboard trapped inside the left red lock.
            islands[35:104, 28:85] |= ((red > 120) & (spread < 60)
                                      & (blue >= red - 35) & (green >= red - 35))[35:104, 28:85]
        pixels[islands] = 0
    # At most two source pixels of neutral matte; preserve all interior colours.
    for _ in range(2):
        padded = np.pad(pixels[:, :, 3] > 0, 1)
        interior = np.ones(pixels.shape[:2], dtype=bool)
        for y, x in [(0, 1), (1, 0), (1, 2), (2, 1)]:
            interior &= padded[y:y + 384, x:x + 256]
        pixels[(pixels[:, :, 3] > 0) & ~interior & neutral] = 0
    if column < 2:
        pixels = defringe_hair(pixels, FACE_BOXES[column])
    pixels[pixels[:, :, 3] == 0] = 0
    return Image.fromarray(pixels)


def defringe_hair(pixels: np.ndarray, face_box: tuple) -> np.ndarray:
    """Unmatte bright edge pixels against a nearby existing dark outline, never the face."""
    result = pixels.copy()
    rgb = pixels[:, :, :3].astype(np.int16)
    alpha = pixels[:, :, 3] > 0
    padded = np.pad(alpha, 1)
    interior = np.ones(alpha.shape, dtype=bool)
    for y, x in [(0, 1), (1, 0), (1, 2), (2, 1)]:
        interior &= padded[y:y + 384, x:x + 256]
    candidate = alpha & ~interior & (rgb.min(2) > 95) & (rgb.max(2) - rgb.min(2) < 85)
    candidate[112:] = False
    x0, y0, x1, y1 = face_box
    candidate[y0:y1, x0:x1] = False
    for y, x in zip(*np.where(candidate)):
        neighbours = [(dx * dx + dy * dy, y + dy, x + dx)
                      for dy in range(-3, 4) for dx in range(-3, 4)
                      if 0 <= y + dy < 384 and 0 <= x + dx < 256
                      and alpha[y + dy, x + dx] and rgb[y + dy, x + dx].max() <= 110]
        if not neighbours:
            continue
        _, yy, xx = min(neighbours)
        foreground = rgb[yy, xx]
        opacity = np.clip(np.mean((235 - rgb[y, x]) / np.maximum(1, 235 - foreground)), 0, 1)
        result[y, x, :3] = foreground
        result[y, x, 3] = round(255 * opacity)
    return result
