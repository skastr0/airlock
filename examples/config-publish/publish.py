#!/usr/bin/env python3
"""Scratch configuration preparation and agent-only proposal submission."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

MARKER = "airlock/config-publish-fixture/v1\n"


def config(environment, workers):
    value = {"version": 1, "service": "scratch-api", "environment": environment,
             "workers": workers}
    # Validate the serialized candidate, not just the command-line input.
    encoded = json.dumps(value, indent=2) + "\n"
    decoded = json.loads(encoded)
    if (set(decoded) != {"version", "service", "environment", "workers"}
            or decoded["version"] != 1 or decoded["service"] != "scratch-api"
            or decoded["environment"] not in ("development", "staging")
            or type(decoded["workers"]) is not int
            or not 1 <= decoded["workers"] <= 16):
        raise ValueError("candidate configuration is invalid")
    return encoded


def initialize():
    root = Path(tempfile.mkdtemp(prefix="airlock-config-publish-")).resolve()
    for name in ("live", "candidate", "airlock-home"):
        (root / name).mkdir(mode=0o700)
    (root / ".fixture").write_text(MARKER)
    (root / "live/config.json").write_text(config("development", 1))
    print(root)


def stage(args):
    root = Path(args.fixture).absolute()
    # The only accepted target/home are fixed children of our existing fixture.
    # Reject redirects and missing state; never recreate an existing home.
    if root.resolve() != root or not root.name.startswith("airlock-config-publish-"):
        raise ValueError("expected the original scratch fixture path")
    for path in (root, root / "live", root / "candidate", root / "airlock-home"):
        if path.is_symlink() or not path.is_dir() or path.stat().st_uid != os.getuid():
            raise ValueError("scratch fixture directories must exist and be user-owned")
    marker = root / ".fixture"
    if marker.is_symlink() or marker.read_text() != MARKER:
        raise ValueError("not an initialized scratch fixture")
    target = root / "live/config.json"
    source = root / "candidate/config.json"
    for path in (target, source):
        if path.is_symlink() or (path.exists() and
                (not path.is_file() or path.stat().st_nlink != 1)):
            raise ValueError("scratch config must be an ordinary file without links")
    if not target.is_file():
        raise ValueError("scratch target is missing; inspect recovery state instead of resetting")
    encoded = config(args.environment, args.workers)
    agent = shutil.which("airlock-agent")
    if agent:
        command = [agent]
    else:
        bun = shutil.which("bun")
        entrypoint = Path(__file__).resolve().parents[2] / "src/agent-cli.ts"
        if not bun or not entrypoint.is_file():
            raise ValueError("install airlock-agent or run from a Bun-enabled checkout")
        command = [bun, str(entrypoint)]
    source.write_text(encoded)
    result = subprocess.run(
        [*command, "change", "stage", "--source", str(source), "--target", str(target)],
        env={**os.environ, "AIRLOCK_HOME": str(root / "airlock-home")},
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        # Do not echo arbitrary subprocess output, paths, or configuration secrets.
        raise ValueError("agent stage refused or failed; inspect the existing Airlock home with the operator")
    reply = json.loads(result.stdout)
    proposal_id = reply["id"]
    digest = reply["proposalDigest"]
    if (not isinstance(proposal_id, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]+", proposal_id)
            or not isinstance(digest, str)
            or not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest)):
        raise ValueError("agent stage returned an invalid proposal identity")
    print(json.dumps({
        "version": "airlock/config-publish-handoff/v1",
        "proposalId": proposal_id,
        "proposalDigest": digest,
        "target": str(target),
        "airlockHome": str(root / "airlock-home"),
        "operatorInstruction": (
            "Use the same AIRLOCK_HOME and review in the operator inbox or run "
            f"airlock change approve {proposal_id}. This handoff is not approval."
        ),
    }))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="create a new scratch fixture once")
    submit = commands.add_parser("stage", help="regenerate, validate, and submit; never approve")
    submit.add_argument("fixture")
    submit.add_argument("--environment", choices=("development", "staging"), default="staging")
    submit.add_argument("--workers", type=int, default=2)
    args = parser.parse_args()
    try:
        if args.command == "init":
            initialize()
        else:
            stage(args)
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"version": "airlock/config-publish-error/v1",
                          "error": "Preparation or staging failed; no approval was attempted. Check the fixture, candidate arguments, agent CLI, and existing home; do not reset retained state."}),
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
