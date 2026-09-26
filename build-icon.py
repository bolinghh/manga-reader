from PIL import Image, ImageDraw, ImageFont

W = 1024
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# ink-black rounded square background
d.rounded_rectangle([0, 0, W - 1, W - 1], radius=220, fill="#16130d")

# white speech bubble (comic dialogue box)
bx0, by0, bx1, by1 = 170, 150, 854, 770
d.ellipse([bx0, by0, bx1, by1], fill="white", outline="#16130d", width=16)

# tail (bottom-left)
tail = [(300, 720), (300, 880), (455, 740)]
d.polygon(tail, fill="white")

# bold red "L"
font_path = "C:/Windows/Fonts/ARIALBD.TTF"
try:
    font = ImageFont.truetype(font_path, 540)
except Exception:
    font = ImageFont.load_default()
text = "L"
tb = d.textbbox((0, 0), text, font=font)
tw, th = tb[2] - tb[0], tb[3] - tb[1]
tx = (W - tw) / 2 - tb[0]
ty = ((by0 + by1) / 2 - th / 2) - tb[1]
d.text((tx, ty), text, font=font, fill="#e23b2e")

img.save("src-tauri/icon-src.png")
print("wrote src-tauri/icon-src.png")
