#!/usr/bin/env python3
"""Fail-closed Docker admission check before exposing the internal MCP command."""
import argparse
import json
import os
import re
import stat
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def regular_file(env_name):
    source = os.environ.get(env_name, "")
    require(source and os.path.isabs(source) and os.path.realpath(source) == source, f"{env_name} must be canonical absolute path")
    require(stat.S_ISREG(os.lstat(source).st_mode), f"{env_name} must be a regular file")
    return source


def inspect(compose, project, service):
    prefix = ["docker", "compose", "-f", compose, "-p", project]
    ids = subprocess.check_output(prefix + ["ps", "-q", service], text=True).strip().splitlines()
    require(len(ids) == 1, f"{service} must have exactly one running container")
    data = json.loads(subprocess.check_output(["docker", "inspect", ids[0]], text=True))
    require(len(data) == 1 and data[0]["State"]["Running"], f"{service} is not running")
    return data[0]


def secure_base(container, service):
    host = container["HostConfig"]
    require(container["Config"]["User"] == "1000:1000", f"{service} user mismatch")
    require(host["ReadonlyRootfs"] is True, f"{service} root must be read only")
    require(host["Privileged"] is False, f"{service} must be unprivileged")
    require("ALL" in (host.get("CapDrop") or []), f"{service} capabilities not dropped")
    require("no-new-privileges:true" in (host.get("SecurityOpt") or []), f"{service} no-new-privileges missing")
    require(not any("unconfined" in option or option == "label=disable" for option in (host.get("SecurityOpt") or [])), f"{service} security profile disabled")
    require(container.get("AppArmorProfile") or container.get("ProcessLabel"), f"{service} LSM profile missing")
    require(host.get("PidMode") in (None, "") and host.get("IpcMode") in (None, "", "private"), f"{service} host PID/IPC sharing forbidden")
    require(not host.get("Devices") and not host.get("DeviceRequests"), f"{service} device mounts forbidden")
    require(not host.get("PortBindings") and not container["NetworkSettings"].get("Ports"), f"{service} host ports forbidden")
    require(host.get("PidsLimit", 0) > 0 and host.get("Memory", 0) > 0, f"{service} resource limits missing")


def mounts(container, expected):
    actual = {mount["Destination"]: mount for mount in container["Mounts"]}
    require(set(actual) == set(expected), "unexpected mount destinations")
    for destination, (kind, read_only) in expected.items():
        mount = actual[destination]
        require(mount["Type"] == kind and mount["RW"] is not read_only, f"{destination} mount type or access mismatch")
    return actual


def private_volume(name, project, role):
    volumes = json.loads(subprocess.check_output(["docker", "volume", "inspect", name], text=True))
    require(len(volumes) == 1, f"{role} volume missing")
    volume = volumes[0]
    require(volume.get("Driver") == "local" and not volume.get("Options"), f"{role} volume must use plain local driver")
    labels = volume.get("Labels") or {}
    require(labels.get("com.docker.compose.project") == project and labels.get("com.docker.compose.volume") == role, f"{role} volume ownership mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--compose", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "internal-agent", "compose.yaml")))
    parser.add_argument("--preflight-only", action="store_true", help="validate files and gateway env names before creating containers")
    args = parser.parse_args()
    for key in ["PI_INTERNAL_CONFIG_FILE", "PI_INTERNAL_MODELS_FILE", "PI_INTERNAL_GATEWAY_CONFIG_FILE", "PI_INTERNAL_CA_FILE", "PI_INTERNAL_GATEWAY_ENV_FILE"]:
        regular_file(key)
    with open(os.environ["PI_INTERNAL_CONFIG_FILE"], encoding="utf-8") as handle:
        config = json.load(handle)
    with open(os.environ["PI_INTERNAL_MODELS_FILE"], encoding="utf-8") as handle:
        models = json.load(handle)
    with open(os.environ["PI_INTERNAL_GATEWAY_CONFIG_FILE"], encoding="utf-8") as handle:
        gateway_config = json.load(handle)
    require(config.get("model") == gateway_config.get("model") == models.get("providers", {}).get("corporate", {}).get("models", [{}])[0].get("id"), "agent and gateway model IDs differ")
    require(gateway_config.get("caFile") == "/etc/pi-internal/ca.pem", "gateway CA path mismatch")
    header_templates = gateway_config.get("headers", {})
    require(isinstance(header_templates, dict), "gateway headers must be an object")
    references = set()
    for value in header_templates.values():
        require(isinstance(value, str), "gateway header template must be text")
        references.update(left or right for left, right in re.findall(r"\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}", value))
    env_path = os.environ["PI_INTERNAL_GATEWAY_ENV_FILE"]
    require(os.stat(env_path).st_mode & 0o077 == 0, "gateway env file must be owner-private")
    with open(env_path, encoding="utf-8") as handle:
        entries = [line.strip() for line in handle if line.strip() and not line.lstrip().startswith("#")]
    env_keys = set()
    for entry in entries:
        name, separator, _value = entry.partition("=")
        require(separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", name), "gateway env file must contain plain KEY=VALUE entries")
        env_keys.add(name)
    require(env_keys == references, "gateway env names must exactly match header references")
    require(not any(name.startswith(("NODE_", "LD_", "DYLD_", "GIT_CONFIG_", "NPM_", "PI_")) or name in {"HOME", "PATH", "SHELL", "ENV", "BASH_ENV", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSH_AUTH_SOCK", "GIT_CONFIG", "OPENSSL_CONF", "SSL_CERT_FILE", "SSL_CERT_DIR"} for name in env_keys), "gateway env contains unsafe variable name")
    if args.preflight_only:
        print("Configuration preflight passed")
        return
    agent = inspect(args.compose, args.project, "agent")
    gateway = inspect(args.compose, args.project, "gateway")
    secure_base(agent, "agent")
    secure_base(gateway, "gateway")
    require(agent["HostConfig"]["NetworkMode"] == "none", "agent network mode must be none")
    require(not agent["NetworkSettings"].get("Networks") or set(agent["NetworkSettings"]["Networks"]) == {"none"}, "agent has unexpected network")
    require(gateway["HostConfig"]["NetworkMode"] != "host", "gateway host network forbidden")
    require(len(gateway["NetworkSettings"].get("Networks", {})) == 1, "gateway must have one upstream network")
    require(set(gateway["NetworkSettings"].get("Networks", {})) == {os.environ.get("PI_INTERNAL_UPSTREAM_NETWORK")}, "gateway upstream network mismatch")
    agent_mounts = mounts(agent, {
        "/workspace": ("volume", False), "/var/lib/pi-mcp": ("volume", False),
        "/run/pi-internal": ("volume", True),
        "/etc/pi-internal/config.json": ("bind", True), "/etc/pi-internal/models.json": ("bind", True),
    })
    gateway_mounts = mounts(gateway, {
        "/run/pi-internal": ("volume", False),
        "/etc/pi-internal/gateway.json": ("bind", True), "/etc/pi-internal/ca.pem": ("bind", True),
    })
    require(agent_mounts["/run/pi-internal"]["Name"] == gateway_mounts["/run/pi-internal"]["Name"], "gateway socket volume mismatch")
    names = [agent_mounts[destination]["Name"] for destination in ["/workspace", "/var/lib/pi-mcp", "/run/pi-internal"]]
    require(len(set(names)) == 3, "private volumes must be separate")
    for name, role in zip(names, ["workspace", "state", "gateway_socket"]):
        private_volume(name, args.project, role)
    for mount, key in [(agent_mounts["/etc/pi-internal/config.json"], "PI_INTERNAL_CONFIG_FILE"),
                       (agent_mounts["/etc/pi-internal/models.json"], "PI_INTERNAL_MODELS_FILE"),
                       (gateway_mounts["/etc/pi-internal/gateway.json"], "PI_INTERNAL_GATEWAY_CONFIG_FILE"),
                       (gateway_mounts["/etc/pi-internal/ca.pem"], "PI_INTERNAL_CA_FILE")]:
        require(mount["Source"] == os.environ[key], f"{key} mount source mismatch")
    env_names = {entry.split("=", 1)[0].lower() for entry in agent["Config"]["Env"]}
    require(not env_names.intersection({"http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssh_auth_sock", "node_options"}), "agent has forbidden environment")
    print("Docker admission checks passed: isolated agent and dedicated gateway")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, IndexError, subprocess.CalledProcessError) as error:
        print(f"Docker admission refused: {error}", file=sys.stderr)
        sys.exit(1)
