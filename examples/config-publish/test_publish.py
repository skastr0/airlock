"""Glue-only evidence using a fake agent, not real Airlock integration."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("publish.sh").resolve()
FAKE = '''#!{python}
import json, os, pathlib, sys
args = sys.argv[1:]
if args[0].endswith("agent-cli.ts"):
    args = args[1:]
assert args[:2] == ["change", "stage"], args
assert args[2] == "--source" and args[4] == "--target" and len(args) == 6
record = {{"args": args, "home": os.environ["AIRLOCK_HOME"],
           "candidate": json.loads(pathlib.Path(args[3]).read_text())}}
with open(os.environ["CALL_LOG"], "a") as log:
    log.write(json.dumps(record) + "\\n")
if os.environ.get("FAIL_STAGE"):
    print("sensitive-child-output", file=sys.stderr)
    sys.exit(1)
print(json.dumps({{"version": 1, "id": "fake-proposal", "proposalDigest": "sha256:" + "a" * 64}}))
'''


class PublishGlueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, executable in (("bash", "/bin/bash"), ("dirname", "/usr/bin/dirname"),
                                 ("python3", sys.executable)):
            (self.bin / name).symlink_to(executable)
        self.agent = self.bin / "airlock-agent"
        self.agent.write_text(FAKE.format(python=sys.executable))
        self.agent.chmod(0o700)
        self.log = self.root / "calls.jsonl"
        self.env = {**os.environ, "PATH": str(self.bin), "TMPDIR": str(self.root),
                    "CALL_LOG": str(self.log), "AIRLOCK_HOME": str(self.root / "wrong-home")}
        initialized = self.run_script("init")
        self.assertEqual(initialized.returncode, 0, initialized.stderr)
        self.fixture = Path(initialized.stdout.strip())

    def run_script(self, *args):
        return subprocess.run(["/bin/bash", str(SCRIPT), *args], env=self.env,
                              capture_output=True, text=True)

    def test_repeated_stage_same_target_home_without_live_write(self):
        original = (self.fixture / "live/config.json").read_bytes()
        for workers in (2, 4):
            result = self.run_script("stage", str(self.fixture), "--workers", str(workers))
            self.assertEqual(result.returncode, 0, result.stderr)
            handoff = json.loads(result.stdout)
            self.assertEqual(handoff["version"], "airlock/config-publish-handoff/v1")
            self.assertEqual(handoff["proposalId"], "fake-proposal")
            self.assertEqual(handoff["proposalDigest"], "sha256:" + "a" * 64)
            self.assertEqual(handoff["target"], str(self.fixture / "live/config.json"))
            self.assertIn("airlock change approve fake-proposal", handoff["operatorInstruction"])
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual([c["candidate"]["workers"] for c in calls], [2, 4])
        self.assertEqual(calls[0]["args"], calls[1]["args"])
        self.assertEqual({c["home"] for c in calls}, {str(self.fixture / "airlock-home")})
        self.assertEqual((self.fixture / "live/config.json").read_bytes(), original)
        self.assertFalse((self.root / "wrong-home").exists())

    def test_invalid_candidate_and_target_override_do_not_call_agent(self):
        for arguments in (("--workers", "0"), ("--workers", "17"),
                          ("--environment", "production"), ("--target", "/outside")):
            result = self.run_script("stage", str(self.fixture), *arguments)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.log.exists())

    def test_missing_home_is_not_reset(self):
        home = self.fixture / "airlock-home"
        home.rename(self.fixture / "retained-home")
        result = self.run_script("stage", str(self.fixture))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(home.exists())
        self.assertFalse(self.log.exists())

    def test_target_symlink_is_refused(self):
        target = self.fixture / "live/config.json"
        target.rename(self.fixture / "original.json")
        target.symlink_to(self.fixture / "original.json")
        result = self.run_script("stage", str(self.fixture))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.log.exists())

    def test_bun_checkout_fallback_uses_agent_entrypoint(self):
        self.agent.rename(self.bin / "bun")
        result = self.run_script("stage", str(self.fixture))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["proposalId"], "fake-proposal")

    def test_stage_failure_is_not_handoff_or_automatic_retry(self):
        self.env["FAIL_STAGE"] = "1"
        result = self.run_script("stage", str(self.fixture))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("sensitive-child-output", result.stderr)
        self.assertEqual(len(self.log.read_text().splitlines()), 1)
        self.assertEqual(json.loads(result.stderr)["version"], "airlock/config-publish-error/v1")


if __name__ == "__main__":
    unittest.main()
