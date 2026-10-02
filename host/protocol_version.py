"""Shared protocol version for the Native Messaging contract.

The extension and the host must agree on this number. Bumping it means an older
peer is incompatible and the user has to reinstall; the mismatch is reported
explicitly instead of surfacing as unrelated "unsupported message" errors.
"""

# v1: ping/list/start/resume/pause/cancel/delete/openDirectory
# v2: probeSize
# v3: getSettings/setDownloadDirectory/health
# v4: checkDuplicate
PROTOCOL_VERSION = 4
