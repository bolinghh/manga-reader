"""Group OCR fragments into dialogue, independently of physical line breaks."""
import math
import re
import statistics
import cv2
import numpy as np

CJK = r"\u3040-\u30ff\u3400-\u9fff"


def width(line):
    return line["right"] - line["left"]


def height(line):
    return line["bottom"] - line["top"]


def overlap(a, b, axis):
    start, end = ("left", "right") if axis == "x" else ("top", "bottom")
    return max(0, min(a[end], b[end]) - max(a[start], b[start])) / min(a[end] - a[start], b[end] - b[start])


def clusters(lines, axis):
    start, end = ("left", "right") if axis == "x" else ("top", "bottom")
    groups = []
    for line in sorted(lines, key=lambda item: (item[start] + item[end]) / 2):
        center = (line[start] + line[end]) / 2
        match = next((group for group in groups if abs(center - statistics.median((item[start] + item[end]) / 2 for item in group)) <= min(line[end] - line[start], statistics.median(item[end] - item[start] for item in group)) * .55), None)
        if match is None:
            groups.append([line])
        else:
            match.append(line)
    return groups


def vertical_layout(lines):
    tall = sum(width(line) * height(line) for line in lines if height(line) > width(line) * 1.3)
    wide = sum(width(line) * height(line) for line in lines if width(line) > height(line) * 1.3)
    if tall or wide:
        return tall > wide
    span = max(line["bottom"] for line in lines) - min(line["top"] for line in lines)
    return len(lines) > 1 and span > statistics.median(width(line) for line in lines) * 1.6 and any(len(group) > 1 for group in clusters(lines, "x"))


def order_lines(lines, direction, vertical=False):
    if vertical:
        columns = clusters(lines, "x")
        columns.sort(key=lambda column: statistics.median((line["left"] + line["right"]) / 2 for line in column), reverse=direction == "rtl")
        return [line for column in columns for line in sorted(column, key=lambda item: item["top"])]
    rows = clusters(lines, "y")
    rows.sort(key=lambda row: statistics.median(line["top"] for line in row))
    return [line for row in rows for line in sorted(row, key=lambda item: item["left"])]


def without_furigana(lines):
    result = []
    for line in lines:
        kana = re.fullmatch(r"[\u3040-\u30ff\sー]+", line["source"])
        ruby = kana and any(
            width(line) < width(main) * .55 and height(line) < height(main) * .9
            and re.search(r"[\u3400-\u9fff]", main["source"])
            and main["right"] - width(main) * .2 <= line["left"] <= main["right"] + width(main) * .8
            and overlap(line, main, "y") >= .75
            for main in lines if main is not line
        )
        if not ruby:
            result.append(line)
    return result


def clear_corridor(mask, a, b, axis):
    if axis == "x":
        left, right = sorted((a, b), key=lambda line: line["left"])
        x1, x2 = left["right"], right["left"]
        if x2 - x1 < 2:
            middle = (x1 + x2) / 2
            x1, x2 = middle - 1, middle + 1
        y1, y2 = max(a["top"], b["top"]), min(a["bottom"], b["bottom"])
    else:
        top, bottom = sorted((a, b), key=lambda line: line["top"])
        y1, y2 = top["bottom"], bottom["top"]
        if y2 - y1 < 2:
            middle = (y1 + y2) / 2
            y1, y2 = middle - 1, middle + 1
        x1, x2 = max(a["left"], b["left"]), min(a["right"], b["right"])
    patch = mask[max(0, math.floor(y1)):math.ceil(y2), max(0, math.floor(x1)):math.ceil(x2)]
    if not patch.size or patch.mean() < .7:
        return False
    # A panel or bubble outline is a continuous dark separator, even when thin.
    darkness = 1 - patch.mean(axis=0 if axis == "x" else 1)
    return float(np.max(darkness)) < .65


def neighboring(a, b, mask):
    if a["bubble"] and b["bubble"]:
        return a["bubble"] == b["bubble"]
    xgap = max(a["left"], b["left"]) - min(a["right"], b["right"])
    ygap = max(a["top"], b["top"]) - min(a["bottom"], b["bottom"])
    vertical = all(width(line) <= height(line) * 1.3 for line in (a, b))
    horizontal = all(height(line) <= width(line) * 1.3 for line in (a, b))
    if vertical and overlap(a, b, "x") >= .55 and 0 <= ygap <= min(width(a), width(b)) * 1.5:
        return clear_corridor(mask, a, b, "y")
    if vertical and any(height(line) > width(line) * 1.3 for line in (a, b)) and overlap(a, b, "y") >= .55 and xgap <= min(width(a), width(b)) * 1.1:
        return clear_corridor(mask, a, b, "x")
    if horizontal and overlap(a, b, "y") >= .6 and 0 <= xgap <= min(height(a), height(b)) * .9:
        return clear_corridor(mask, a, b, "x")
    if horizontal and overlap(a, b, "x") >= .55 and 0 <= ygap <= min(height(a), height(b)) * 1.3:
        return clear_corridor(mask, a, b, "y")
    return False


def join_dialogue(lines, language):
    if language not in ("ja", "zh-Hans", "zh-Hant"):
        return "\n".join(line["source"] for line in lines)
    text = ""
    for line in lines:
        part = re.sub(rf"(?<=[{CJK}])\s+(?=[{CJK}])", "", line["source"])
        separator = " " if text and re.search(r"[A-Za-z0-9]$", text) and re.match(r"[A-Za-z0-9]", part) else ""
        text += separator + part
    return text


def result_blocks(result, image, direction, language=None):
    if result.boxes is None or not result.txts:
        return []
    page_width, page_height = image.size
    rgb = np.asarray(image)
    raw_mask = (np.min(rgb, axis=2) >= 210).astype("uint8")
    # Seal tiny white gaps in outlines caused by JPEG noise and anti-aliasing.
    mask = cv2.morphologyEx(raw_mask, cv2.MORPH_OPEN, np.ones((3, 3), dtype="uint8"))
    _, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    lines = []
    for points, text, score in zip(result.boxes, result.txts, result.scores):
        if not text.strip() or len(text) > 4000 or not math.isfinite(float(score)):
            continue
        left = max(0, min(page_width - 1, float(np.min(points[:, 0]))))
        top = max(0, min(page_height - 1, float(np.min(points[:, 1]))))
        right = max(left + 1, min(page_width, float(np.max(points[:, 0]))))
        bottom = max(top + 1, min(page_height, float(np.max(points[:, 1]))))
        patch = labels[int(top):math.ceil(bottom), int(left):math.ceil(right)]
        ids, counts = np.unique(patch[patch > 0], return_counts=True)
        component = int(ids[np.argmax(counts)]) if len(ids) else 0
        x, y, w, h, area = stats[component] if component else (0, 0, 0, 0, 0)
        enclosed = component and x > 0 and y > 0 and x + w < page_width and y + h < page_height
        bubble = enclosed and w * h < page_width * page_height * .25 and area > w * h * .35 and area > (right - left) * (bottom - top) * .35
        lines.append({"source": text.strip(), "left": left, "top": top, "right": right, "bottom": bottom, "score": float(score), "bubble": component if bubble else 0})
    if language == "ja":
        lines = without_furigana(lines)
    if len(lines) > 1500:
        raise ValueError("Too many OCR fragments; select a smaller area")
    parents = list(range(len(lines)))
    bubble_ids = [{line["bubble"]} if line["bubble"] else set() for line in lines]

    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for index, line in enumerate(lines):
        for other in range(index):
            if neighboring(line, lines[other], mask):
                left, right = find(index), find(other)
                if bubble_ids[left] and bubble_ids[right] and bubble_ids[left] != bubble_ids[right]:
                    continue
                parents[left] = right
                bubble_ids[right].update(bubble_ids[left])
    groups = {}
    for index, line in enumerate(lines):
        groups.setdefault(find(index), []).append(line)
    blocks = []
    for group in groups.values():
        vertical = vertical_layout(group)
        text_direction = "rtl" if vertical and language in ("ja", "zh-Hans", "zh-Hant") else direction
        group = order_lines(group, text_direction, vertical)
        source = join_dialogue(group, language)
        if len(source) > 4000:
            raise ValueError("Too much text in a bubble; select a smaller region")
        blocks.append({"source": source, "box": [
            max(0, math.floor(min(line["left"] for line in group) / page_width * 1000)),
            max(0, math.floor(min(line["top"] for line in group) / page_height * 1000)),
            min(1000, math.ceil(max(line["right"] for line in group) / page_width * 1000)),
            min(1000, math.ceil(max(line["bottom"] for line in group) / page_height * 1000)),
        ], "uncertain": any(line["score"] < .8 for line in group)})
    blocks.sort(key=lambda block: (block["box"][1] // 60, -block["box"][0] if direction == "rtl" else block["box"][0], block["box"][1]))
    if len(blocks) > 200:
        raise ValueError("Too many text regions; select a smaller area")
    return blocks
