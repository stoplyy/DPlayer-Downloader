import argparse
from html.parser import HTMLParser
import json
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit


class PlayerConfigParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.config = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        classes = attributes.get("class", "").split()
        if tag == "div" and "dplayer" in classes and "data-config" in attributes:
            self.config = json.loads(attributes["data-config"])


def build_download_command(yt_dlp, playlist_url, output):
    return [
        yt_dlp,
        "--continue",
        "--fragment-retries",
        "20",
        "--retry-sleep",
        "fragment:5",
        "--concurrent-fragments",
        "1",
        "--remux-video",
        "mp4",
        "--output",
        str(output),
        playlist_url,
    ]


def main():
    script_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Download an authorized DPlayer HLS video")
    parser.add_argument("--html", type=Path, default=script_dir / "tmp.html")
    parser.add_argument("--output", type=Path, default=script_dir / "downloaded_video.mp4")
    parser.add_argument("--source", choices=("video", "video_h265"), default="video")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.html.is_file():
        raise FileNotFoundError(f"HTML file not found: {args.html}")

    config_parser = PlayerConfigParser()
    config_parser.feed(args.html.read_text(encoding="utf-8"))
    if config_parser.config is None:
        raise ValueError("No DPlayer data-config found in the HTML file")

    try:
        playlist_url = config_parser.config[args.source]["url"]
    except (KeyError, TypeError) as error:
        raise ValueError(f"Video source not found: {args.source}") from error

    if not playlist_url.startswith(("https://", "http://")):
        raise ValueError("The selected video source is not an HTTP(S) URL")

    if args.dry_run:
        parsed_url = urlsplit(playlist_url)
        print(f"Source: {args.source}")
        print(f"Playlist: {parsed_url.scheme}://{parsed_url.netloc}{parsed_url.path}")
        print("Query parameters are hidden; no network request was made.")
        return

    yt_dlp = shutil.which("yt-dlp")
    if yt_dlp is None:
        raise RuntimeError("yt-dlp was not found on PATH. Install yt-dlp and try again.")
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg was not found on PATH. Install ffmpeg and try again.")
    if args.output.exists():
        raise FileExistsError(f"Output already exists; refusing to overwrite: {args.output}")

    subprocess.run(build_download_command(yt_dlp, playlist_url, args.output), check=True)


if __name__ == "__main__":
    main()