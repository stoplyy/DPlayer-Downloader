import re


PERCENT_RE = re.compile(r"\[download\]\s+(?P<percent>\d+(?:\.\d+)?)%")
TOTAL_RE = re.compile(r"\bof\s+(?P<total>~?\s*[\d.]+\s*(?:[KMGT]?i?B))\b", re.IGNORECASE)
SPEED_RE = re.compile(r"\bat\s+(?P<speed>(?:Unknown speed|[\d.]+\s*(?:[KMGT]?i?B)/s))\b", re.IGNORECASE)
ETA_RE = re.compile(r"\bETA\s+(?P<eta>\d{2}:\d{2}(?::\d{2})?|Unknown)\b", re.IGNORECASE)


def parse_download_progress(line):
    percent_match = PERCENT_RE.search(line)
    if not percent_match:
        return None

    total_match = TOTAL_RE.search(line)
    speed_match = SPEED_RE.search(line)
    eta_match = ETA_RE.search(line)
    speed = speed_match.group("speed").strip() if speed_match else None
    eta = eta_match.group("eta") if eta_match else None

    return {
        "percent": float(percent_match.group("percent")),
        "total": re.sub(r"\s+", "", total_match.group("total")) if total_match else None,
        "speed": None if speed and speed.lower() == "unknown speed" else speed,
        "eta": None if eta and eta.lower() == "unknown" else eta,
    }
