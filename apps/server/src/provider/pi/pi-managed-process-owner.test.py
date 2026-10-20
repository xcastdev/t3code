"""Exercise bootstrap admission without any cgroup, owner or child allocation."""
import base64
import io
import pathlib
import runpy
import unittest
from unittest import mock


OWNER = pathlib.Path(__file__).with_name("pi-managed-process-owner.py")


class BootstrapBoundTest(unittest.TestCase):
    def run_bootstrap(self, argument):
        # Stop after the real strict base64 decoder, before any platform access.
        with mock.patch("sys.argv", [str(OWNER), argument]), mock.patch(
            "sys.stdout", buffer=io.BytesIO()
        ), mock.patch("json.loads", side_effect=RuntimeError("test decode boundary")) as decode:
            with self.assertRaises(SystemExit) as stopped:
                runpy.run_path(str(OWNER))
            self.assertEqual(stopped.exception.code, 1)
            return decode

    def test_long_bounded_bootstrap_reaches_json_decoder_unchanged(self):
        for encoded_bytes in (100000, 131068):
            with self.subTest(encoded_bytes=encoded_bytes):
                raw = b'{"padding":"' + b"x" * (encoded_bytes // 4 * 3 - 14) + b'"}'
                encoded = base64.b64encode(raw).decode("ascii")
                self.assertEqual(len(encoded), encoded_bytes)
                self.run_bootstrap(encoded).assert_called_once_with(raw)

    def test_bound_plus_one_is_rejected_before_decoding(self):
        self.run_bootstrap("A" * 131072).assert_not_called()

    def test_strict_base64_validation_is_retained(self):
        self.run_bootstrap("!" * 100000).assert_not_called()


if __name__ == "__main__":
    unittest.main()
