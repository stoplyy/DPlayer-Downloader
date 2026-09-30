import os
from pathlib import Path


PROXY_ENV_KEYS = {
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
}


def build_download_command(executable, url, output, proxy_url, cookie_file=None, ffmpeg_location=None):
    output = Path(output)
    output_template = str(output.with_suffix("")) + ".%(ext)s"
    command = [
        str(executable),
        "--continue",
        "--no-overwrites",
        "--retries",
        "10",
        "--fragment-retries",
        "20",
        "--retry-sleep",
        "fragment:5",
        "--concurrent-fragments",
        "1",
        "--downloader",
        "m3u8:native",
        "--proxy",
        proxy_url,
        "--remux-video",
        "mp4",
        "--output",
        output_template,
        "--newline",
        "--socket-timeout",
        "15",
    ]
    if cookie_file is not None:
        command.extend(["--cookies", str(cookie_file)])
    if ffmpeg_location is not None:
        command.extend(["--ffmpeg-location", str(ffmpeg_location)])
    command.append(url)
    return command


def build_download_environment(source=None, proxy_url=None):
    environment = dict(os.environ if source is None else source)
    for key in list(environment):
        if key.lower() in PROXY_ENV_KEYS:
            environment.pop(key, None)
    if proxy_url:
        environment["http_proxy"] = proxy_url
        environment["https_proxy"] = proxy_url
        environment["HTTP_PROXY"] = proxy_url
        environment["HTTPS_PROXY"] = proxy_url
    return environment
