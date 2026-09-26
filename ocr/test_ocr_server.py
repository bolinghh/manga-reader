import base64
import io
import unittest
from types import SimpleNamespace
import numpy as np
from PIL import Image, ImageDraw
from ocr_server import allowed_origin, decode_image, result_blocks


class LocalOCRBoundaries(unittest.TestCase):
    def test_remote_image_urls_are_rejected(self):
        with self.assertRaises(ValueError):
            decode_image("https://example.com/image.jpg")

    def test_invalid_base64_is_rejected(self):
        with self.assertRaises(ValueError):
            decode_image("data:image/png;base64,%%%")

    def test_image_dimensions_are_bounded(self):
        image = Image.new("RGB", (3000, 2000))
        buffer = io.BytesIO(); image.save(buffer, "PNG")
        with self.assertRaises(ValueError):
            decode_image("data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode())

    def test_only_local_web_origins_can_use_service(self):
        self.assertTrue(allowed_origin(None))
        self.assertTrue(allowed_origin("http://localhost:5173"))
        self.assertTrue(allowed_origin("http://tauri.localhost"))
        self.assertFalse(allowed_origin("https://example.com"))
        self.assertFalse(allowed_origin("http://127.0.0.1.attacker.com"))

    def test_empty_result_contains_no_invented_text(self):
        self.assertEqual(result_blocks(SimpleNamespace(boxes=None, txts=None), Image.new("RGB", (100, 100)), "rtl"), [])

    def test_lines_inside_the_same_bubble_are_grouped_and_normalized(self):
        image = Image.new("RGB", (400, 400), "gray")
        ImageDraw.Draw(image).ellipse((50, 50, 190, 190), fill="white", outline="black", width=3)
        result = SimpleNamespace(boxes=np.array([[[80, 90], [150, 90], [150, 110], [80, 110]], [[80, 120], [150, 120], [150, 140], [80, 140]]]), txts=("Hello", "world"), scores=(.99, .7))
        blocks = result_blocks(result, image, "rtl")
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0]["source"], "Hello\nworld")
        self.assertEqual(blocks[0]["box"], [200, 225, 375, 350])
        self.assertTrue(blocks[0]["uncertain"])

    def test_white_page_background_does_not_merge_unrelated_captions(self):
        image = Image.new("RGB", (400, 400), "white")
        result = SimpleNamespace(boxes=np.array([[[40, 50], [150, 50], [150, 80], [40, 80]], [[250, 250], [350, 250], [350, 280], [250, 280]]]), txts=("Caption one", "Caption two"), scores=(.99, .99))
        self.assertEqual(len(result_blocks(result, image, "rtl")), 2)


if __name__ == "__main__":
    unittest.main()
