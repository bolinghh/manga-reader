import unittest
from types import SimpleNamespace
import numpy as np
from PIL import Image, ImageDraw
from ocr_layout import result_blocks


def recognition(items):
    boxes, texts = [], []
    for text, (left, top, right, bottom) in items:
        texts.append(text)
        boxes.append([[left, top], [right, top], [right, bottom], [left, bottom]])
    return SimpleNamespace(boxes=np.array(boxes), txts=texts, scores=[.99] * len(items))


def bubble():
    image = Image.new("RGB", (400, 400), "gray")
    ImageDraw.Draw(image).ellipse((45, 35, 220, 245), fill="white", outline="black", width=3)
    return image


class JapaneseDialogue(unittest.TestCase):
    def test_vertical_columns_and_fragments_are_read_in_order_without_hard_breaks(self):
        items = [("みんなで", (152, 130, 179, 198)), ("今日も", (150, 70, 178, 115)), ("頑張ろう！", (110, 70, 139, 210))]
        result = result_blocks(recognition(items), bubble(), "rtl", "ja")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["source"], "今日もみんなで頑張ろう！")

    def test_page_direction_does_not_reverse_japanese_vertical_columns(self):
        items = [("行こう！", (110, 70, 139, 210)), ("一緒に", (150, 70, 179, 210))]
        self.assertEqual(result_blocks(recognition(items), bubble(), "ltr", "ja")[0]["source"], "一緒に行こう！")

    def test_cropped_bubbles_merge_nearby_columns_without_an_enclosed_outline(self):
        items = [("行こう！", (270, 60, 290, 140)), ("一緒に", (300, 60, 320, 140))]
        result = result_blocks(recognition(items), Image.new("RGB", (400, 400), "white"), "rtl", "ja")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["source"], "一緒に行こう！")

    def test_short_fragments_in_a_column_are_joined_despite_box_jitter(self):
        items = [("勝つ！", (149, 101, 178, 170)), ("絶対", (151, 50, 179, 85))]
        result = result_blocks(recognition(items), Image.new("RGB", (400, 400), "white"), "rtl", "ja")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["source"], "絶対勝つ！")

    def test_panel_border_prevents_merging_adjacent_dialogue(self):
        image = Image.new("RGB", (400, 400), "white")
        ImageDraw.Draw(image).line((180, 0, 180, 400), fill="black", width=3)
        items = [("右の声", (187, 60, 207, 160)), ("左の声", (155, 60, 175, 160))]
        self.assertEqual(len(result_blocks(recognition(items), image, "rtl", "ja")), 2)

    def test_distinct_closed_bubbles_are_not_combined(self):
        image = Image.new("RGB", (400, 400), "gray")
        draw = ImageDraw.Draw(image)
        draw.ellipse((45, 35, 145, 240), fill="white", outline="black", width=3)
        draw.ellipse((150, 35, 250, 240), fill="white", outline="black", width=3)
        items = [("別の人", (175, 70, 200, 180)), ("この人", (110, 70, 135, 180))]
        self.assertEqual(len(result_blocks(recognition(items), image, "rtl", "ja")), 2)

    def test_furigana_next_to_kanji_is_not_inserted_as_dialogue(self):
        items = [("漢字を読む", (150, 70, 180, 210)), ("練習だ", (110, 70, 140, 210)), ("かんじ", (183, 70, 190, 90))]
        result = result_blocks(recognition(items), bubble(), "rtl", "ja")
        self.assertEqual(result[0]["source"], "漢字を読む練習だ")

    def test_horizontal_japanese_is_read_left_to_right_then_top_to_bottom(self):
        image = Image.new("RGB", (500, 400), "gray")
        ImageDraw.Draw(image).ellipse((50, 30, 420, 200), fill="white", outline="black", width=3)
        items = [("明日", (220, 70, 290, 92)), ("会おう。", (110, 105, 260, 127)), ("また", (110, 70, 210, 92))]
        self.assertEqual(result_blocks(recognition(items), image, "rtl", "ja")[0]["source"], "また明日会おう。")


if __name__ == "__main__":
    unittest.main()
