import unittest

from host.media_identity import (
    BLOCKING_TASK_STATUSES,
    canonical_media_url,
    content_identity,
    find_duplicate_by_identity,
    find_duplicate_task,
    hash_media_key,
    media_identity,
    task_identity,
)


PAGE = "https://am.example.cc/watch/275863001"
VIDEO_ID = "275863001"
RENDITION_A = "https://hls.example.cn/videos5/ce2bf38864fd699164cb1747e8426a91/ce2bf38864fd699164cb1747e8426a91.m3u8?auth_key=111-aaa-0-bbb&v=3&time=0"
RENDITION_B = "https://hls.example.cn/m3m/ea9b17a586bb089077af06c6144781421cc6701f573fa89d5d72d5678f260d6a3980a14e4fdbf7ef613e07cb811627b80c40eeeb46d9f05c474c95c55acdb44c4ac584098da78e88e21ce0b9a40b30d0.m3u8?auth_key=222-ccc-0-ddd"
# Same rendition after a reload: the CDN path token itself rotated.
RENDITION_A_RESCAN = "https://hls.example.cn/videos5/9f8e7d6c5b4a39281706f5e4d3c2b1a0/9f8e7d6c5b4a39281706f5e4d3c2b1a0.m3u8?auth_key=999-zzz-0-yyy"


class MediaIdentityTests(unittest.TestCase):
    def test_strips_volatile_signing_parameters(self):
        self.assertEqual(
            canonical_media_url(
                "https://hls.example.com/videos5/abc/abc.m3u8?auth_key=1790752302-6abcb62e99a28-0-9d57&v=3&time=0"
            ),
            "https://hls.example.com/videos5/abc/abc.m3u8",
        )
        self.assertEqual(
            canonical_media_url("https://media.example.com/video.mp4?quality=720p&token=abc"),
            "https://media.example.com/video.mp4?quality=720p",
        )
        self.assertEqual(
            canonical_media_url("https://media.example.com/video.mp4?X-Amz-Signature=abc&X-Amz-Expires=60&part=2"),
            "https://media.example.com/video.mp4?part=2",
        )

    def test_rejects_non_http_urls(self):
        for value in ("blob:https://site.example/id", "file:///tmp/video.mp4", "not a url", "", None):
            with self.subTest(value=value):
                self.assertIsNone(canonical_media_url(value))

    def test_matches_the_javascript_implementation(self):
        # Must stay in sync with extensions/shared/media_identity.mjs.
        self.assertEqual(
            hash_media_key("https://media.example.com/video.mp4"),
            "1a6ead580cbcb0e8",
        )

    def test_same_video_with_different_signatures_shares_one_identity(self):
        first = media_identity("https://hls.example.com/videos5/abc/abc.m3u8?auth_key=aaa&v=3&time=0")
        second = media_identity("https://hls.example.com/videos5/abc/abc.m3u8?auth_key=bbb&v=3&time=99")

        self.assertEqual(first["mediaKey"], second["mediaKey"])
        self.assertEqual(first["canonicalUrl"], second["canonicalUrl"])

    def test_different_videos_get_different_identities(self):
        first = media_identity("https://hls.example.com/videos5/abc/abc.m3u8")
        second = media_identity("https://hls.example.com/videos5/def/def.m3u8")

        self.assertNotEqual(first["mediaKey"], second["mediaKey"])

    def test_finds_duplicates_only_for_blocking_statuses(self):
        key = media_identity("https://media.example.com/video.mp4")["mediaKey"]
        tasks = [
            {"taskId": "a", "mediaKey": key, "status": "completed"},
            {"taskId": "b", "mediaKey": "other", "status": "downloading"},
        ]

        self.assertEqual(find_duplicate_task(key, tasks)["taskId"], "a")
        self.assertIsNone(find_duplicate_task("missing", tasks))
        self.assertIsNone(find_duplicate_task(None, tasks))

    def test_cancelled_and_failed_tasks_can_be_retried(self):
        key = media_identity("https://media.example.com/video.mp4")["mediaKey"]
        for status in ("cancelled", "failed"):
            with self.subTest(status=status):
                self.assertIsNone(find_duplicate_task(key, [{"taskId": "x", "mediaKey": key, "status": status}]))
        for status in BLOCKING_TASK_STATUSES:
            with self.subTest(status=status):
                self.assertIsNotNone(find_duplicate_task(key, [{"taskId": "x", "mediaKey": key, "status": status}]))

    def test_content_identity_ignores_the_rotating_cdn_path(self):
        first = content_identity(PAGE, VIDEO_ID)
        second = content_identity(PAGE, VIDEO_ID)

        self.assertEqual(first["contentKey"], second["contentKey"])
        self.assertRegex(first["contentKey"], r"^[0-9a-f]{16}$")

    def test_content_identity_requires_a_host_and_a_video_id(self):
        for page_url, video_id in (
            (PAGE, ""),
            (PAGE, "   "),
            (PAGE, None),
            ("", VIDEO_ID),
            ("not a url", VIDEO_ID),
            (None, VIDEO_ID),
        ):
            with self.subTest(page_url=page_url, video_id=video_id):
                self.assertIsNone(content_identity(page_url, video_id))

    def test_the_same_video_id_on_another_site_is_different_content(self):
        here = content_identity(PAGE, VIDEO_ID)
        there = content_identity("https://other.example.net/watch", VIDEO_ID)

        self.assertNotEqual(here["contentKey"], there["contentKey"])

    def test_task_identity_prefers_content_and_keeps_the_media_key(self):
        identity = task_identity(RENDITION_A, page_url=PAGE, video_id=VIDEO_ID)

        self.assertEqual(identity["contentKey"], content_identity(PAGE, VIDEO_ID)["contentKey"])
        self.assertEqual(identity["mediaKey"], media_identity(RENDITION_A)["mediaKey"])
        self.assertEqual(identity["canonicalUrl"], canonical_media_url(RENDITION_A))

    def test_task_identity_falls_back_to_the_url_without_a_video_id(self):
        identity = task_identity(RENDITION_A, page_url=PAGE, video_id=None)

        self.assertIsNone(identity["contentKey"])
        self.assertEqual(identity["mediaKey"], media_identity(RENDITION_A)["mediaKey"])
        self.assertIsNone(task_identity("blob:https://x/y"))

    def test_matches_the_same_video_across_renditions_and_rotated_paths(self):
        content_key = content_identity(PAGE, VIDEO_ID)["contentKey"]
        tasks = [{
            "taskId": "t1",
            "status": "completed",
            "contentKey": content_key,
            "mediaKey": media_identity(RENDITION_A)["mediaKey"],
        }]

        # A different rendition of the same video.
        other_rendition = task_identity(RENDITION_B, page_url=PAGE, video_id=VIDEO_ID)
        self.assertEqual(find_duplicate_by_identity(other_rendition, tasks)["taskId"], "t1")

        # The same video re-scanned after the CDN rotated its path token.
        rescanned = task_identity(RENDITION_A_RESCAN, page_url=PAGE, video_id=VIDEO_ID)
        self.assertEqual(find_duplicate_by_identity(rescanned, tasks)["taskId"], "t1")

    def test_does_not_match_a_different_video(self):
        content_key = content_identity(PAGE, VIDEO_ID)["contentKey"]
        tasks = [{"taskId": "t1", "status": "completed", "contentKey": content_key, "mediaKey": "other"}]

        other_video = task_identity("https://hls.example.cn/a/other.m3u8", page_url=PAGE, video_id="999")

        self.assertIsNone(find_duplicate_by_identity(other_video, tasks))

    def test_content_matching_respects_blocking_statuses(self):
        content_key = content_identity(PAGE, VIDEO_ID)["contentKey"]
        identity = task_identity(RENDITION_B, page_url=PAGE, video_id=VIDEO_ID)

        for status in BLOCKING_TASK_STATUSES:
            with self.subTest(status=status):
                self.assertIsNotNone(find_duplicate_by_identity(identity, [{"taskId": "x", "status": status, "contentKey": content_key}]))
        for status in ("cancelled", "failed"):
            with self.subTest(status=status):
                self.assertIsNone(find_duplicate_by_identity(identity, [{"taskId": "x", "status": status, "contentKey": content_key}]))


if __name__ == "__main__":
    unittest.main()
