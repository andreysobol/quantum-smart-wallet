import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sponsored_swap", Path(__file__).with_name("sponsored_swap.py"))
swap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(swap)


class SignerErrorPrivacyTests(unittest.TestCase):
    def test_timeout_does_not_render_signer_arguments(self):
        private_key = "0x" + "ab" * 32
        args = ["cast", "send", "--private-key", private_key]
        with patch.object(swap.subprocess, "run", side_effect=subprocess.TimeoutExpired(args, 180)):
            with self.assertRaisesRegex(RuntimeError, "^cast could not finish$") as raised:
                swap.command(args, sensitive=True)
        self.assertNotIn(private_key, str(raised.exception))
        self.assertTrue(raised.exception.__suppress_context__)

    def test_sensitive_stderr_is_not_rendered(self):
        private_key = "0x" + "cd" * 32
        result = subprocess.CompletedProcess(["cast"], 1, "", private_key)
        with patch.object(swap.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "^cast failed$"):
                swap.command(["cast", "send", "--private-key", private_key], sensitive=True)


if __name__ == "__main__":
    unittest.main()
