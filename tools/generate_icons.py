"""Render the project's F + download-arrow mark (requires Pillow at development time)."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]


def main():
    directory = ROOT / "extensions/edge/icons"
    directory.mkdir(exist_ok=True)
    image = Image.new("RGBA", (512, 512))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, 511, 511), radius=112, fill="#173c39")
    draw.polygon([(104, 112), (304, 112), (304, 168), (166, 168), (166, 224), (270, 224), (270, 280), (166, 280), (166, 400), (104, 400)], fill="white")
    draw.polygon([(330, 216), (382, 216), (382, 326), (420, 326), (356, 402), (292, 326), (330, 326)], fill="#8dd0b6")
    for size in (16, 32, 48, 128):
        image.resize((size, size), Image.Resampling.LANCZOS).save(directory / f"icon-{size}.png")


if __name__ == "__main__":
    main()
