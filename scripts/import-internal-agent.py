#!/usr/bin/env python3
"""Import one committed local branch into the private agent volume via Git bundle stdin."""
import argparse
import os
import re
import subprocess
import sys


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="absolute source Git repository")
    parser.add_argument("--branch", required=True, help="selected committed local branch")
    parser.add_argument("--name", required=True, help="new private workspace directory name")
    parser.add_argument("--project", required=True, help="task-specific Docker Compose project")
    parser.add_argument("--compose", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "internal-agent", "compose.yaml")))
    args = parser.parse_args()
    if not os.path.isabs(args.repo) or os.path.realpath(args.repo) != args.repo:
        parser.error("--repo must be an absolute canonical path")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", args.name):
        parser.error("--name must be lowercase letters, digits and hyphens")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", args.project):
        parser.error("--project must be lowercase letters, digits and hyphens")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", args.branch) or ".." in args.branch or "//" in args.branch or args.branch.endswith("/"):
        parser.error("--branch must be a simple local branch name")
    base = ["git", "-C", args.repo, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false"]
    root = run(base + ["rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    if root != args.repo:
        parser.error("--repo must be a repository root")
    branch_ref = "refs/heads/" + args.branch
    run(base + ["show-ref", "--verify", "--quiet", branch_ref])
    commit = run(base + ["rev-parse", "--verify", branch_ref + "^{commit}"], capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise RuntimeError("selected branch did not resolve to SHA-1 commit")
    docker = ["docker", "compose", "-f", args.compose, "-p", args.project, "exec", "-T", "agent", "node", "/app/internal-agent/import-bundle.mjs", args.name, commit]
    producer = subprocess.Popen(base + ["bundle", "create", "-", branch_ref], stdout=subprocess.PIPE)
    try:
        consumer = subprocess.Popen(docker, stdin=producer.stdout)
        producer.stdout.close()
        consumer_code = consumer.wait()
        producer_code = producer.wait()
    finally:
        if producer.poll() is None:
            producer.kill()
            producer.wait()
    if producer_code or consumer_code:
        raise RuntimeError(f"import failed (bundle={producer_code}, agent={consumer_code})")


if __name__ == "__main__":
    try:
        main()
    except (subprocess.CalledProcessError, OSError, RuntimeError) as error:
        print(f"import refused: {error}", file=sys.stderr)
        sys.exit(1)
