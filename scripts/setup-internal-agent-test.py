#!/usr/bin/env python3
"""Create task-private fake Docker test configs after mock containers start."""
import argparse
import json
from pathlib import Path
import re
import subprocess


def address(container):
    data = json.loads(subprocess.check_output(["docker", "inspect", container], text=True))[0]
    networks = data["NetworkSettings"]["Networks"]
    if len(networks) != 1:
        raise RuntimeError("mock must have exactly one network")
    return next(iter(networks.values()))["IPAddress"]


def fresh(path, text, mode=None):
    with path.open("x", encoding="utf-8") as handle:
        handle.write(text)
    if mode is not None:
        path.chmod(mode)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True, help="new lowercase task-specific Docker project name")
    args = parser.parse_args()
    task = args.task
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", task):
        parser.error("invalid task name")
    root = Path("/tmp") / task
    build = root / "build"
    mock = root / "mock"
    if not build.is_dir() or not mock.is_dir() or not (mock / "cert.pem").is_file():
        parser.error("task build, mock directory and test certificate must exist")
    mock_ip = address(task + "-mock")
    forbidden_ip = address(task + "-forbidden")
    profile = (build / "internal-agent" / "config.example.json").read_text()
    models = (build / "internal-agent" / "models.example.json").read_text()
    gateway = json.loads((build / "internal-agent" / "gateway.example.json").read_text())
    gateway["upstreamUrl"] = "https://mock.corp.internal:8443/v1/chat/completions"
    gateway["upstreamAddress"] = mock_ip
    fresh(mock / "config.json", profile)
    fresh(mock / "models.json", models)
    fresh(mock / "gateway.json", json.dumps(gateway, indent=2) + "\n")
    fresh(mock / "gateway.env", "CORP_LLM_API_KEY=mock$literal-only-secret\nCORP_CLIENT_ID=mock-client\n", 0o600)
    settings = {
        "PI_INTERNAL_IMAGE": f"pi-internal-agent:{task}",
        "PI_INTERNAL_CONFIG_FILE": str(mock / "config.json"),
        "PI_INTERNAL_MODELS_FILE": str(mock / "models.json"),
        "PI_INTERNAL_GATEWAY_CONFIG_FILE": str(mock / "gateway.json"),
        "PI_INTERNAL_CA_FILE": str(mock / "cert.pem"),
        "PI_INTERNAL_GATEWAY_ENV_FILE": str(mock / "gateway.env"),
        "PI_INTERNAL_UPSTREAM_NETWORK": task + "-net",
    }
    fresh(mock / "compose.env", "".join(f"{key}={value}\n" for key, value in settings.items()))
    print(f"private mock config ready; mock_ip={mock_ip} forbidden_ip={forbidden_ip}")


if __name__ == "__main__":
    main()
