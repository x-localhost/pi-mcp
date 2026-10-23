#!/usr/bin/env python3
"""Run actual Docker boundary probes against an already started task project."""
import argparse
import os
import json
import select
import subprocess
import sys
import time


def call(command, *, expected=0, marker=None):
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    if (result.returncode == 0) != (expected == 0) or marker and marker not in result.stdout + result.stderr:
        raise RuntimeError(f"boundary probe failed: {command[-1]} (exit {result.returncode})")
    return result.stdout.strip()


class McpClient:
    def __init__(self, compose, project):
        self.process = subprocess.Popen(["docker", "compose", "-f", compose, "-p", project, "exec", "-T", "agent", "node", "/app/internal-agent/mcp.mjs"],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.buffer = b""
        self.request_id = 0
        self.request("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "internal-runtime-test", "version": "1.0.0"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def send(self, message):
        self.process.stdin.write(json.dumps(message, separators=(",", ":")).encode() + b"\n")
        self.process.stdin.flush()

    def read(self, deadline):
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                raise TimeoutError("MCP response timeout")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("MCP process exited before response")
            self.buffer += chunk
            if len(self.buffer) > 8 * 1024 * 1024:
                raise RuntimeError("MCP response exceeded bound")
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def request(self, method, params):
        self.request_id += 1
        self.send({"jsonrpc": "2.0", "id": self.request_id, "method": method, "params": params})
        deadline = time.monotonic() + 15
        while True:
            response = self.read(deadline)
            if response.get("id") != self.request_id:
                continue
            if "error" in response:
                raise RuntimeError(f"MCP {method} failed")
            return response["result"]

    def tool(self, name, args):
        result = self.request("tools/call", {"name": name, "arguments": args})
        if result.get("isError"):
            raise RuntimeError(f"MCP {name} reported error")
        return json.loads(result["content"][0]["text"])

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)


def wait_job(client, job_id):
    deadline = time.monotonic() + 75
    while time.monotonic() < deadline:
        status = client.tool("pi_status", {"job_id": job_id})
        if status["status"] not in ("starting", "running"):
            return status["status"]
        time.sleep(0.5)
    raise TimeoutError("Pi job did not settle")


def pi_roundtrip(compose, project, repository, base_ref):
    client = McpClient(compose, project)
    try:
        health = client.tool("pi_health", {})
        if health.get("version") != "1.4.0":
            raise RuntimeError("Pi version mismatch")
        started = client.tool("pi_delegate", {"repository": repository, "base_ref": base_ref, "title": "Internal mock round trip", "prompt": "Read AGENTS.md, then respond briefly.", "mode": "review", "max_turns": 2})
    finally:
        client.close()
    client = McpClient(compose, project)
    try:
        status = wait_job(client, started["id"])
        if status != "completed":
            raise RuntimeError(f"Pi first job ended with {status}")
        result = client.tool("pi_result", {"job_id": started["id"]})
        if "Internal mock completed." not in result.get("result", ""):
            raise RuntimeError("Pi mock response missing")
        print("actual_pi_tool_roundtrip=completed reconnect=completed")
        follow = client.tool("pi_followup", {"job_id": started["id"], "prompt": "Continue briefly."})
        if wait_job(client, follow["id"]) != "completed":
            raise RuntimeError("Pi followup failed")
        print("actual_pi_followup=completed")
        pending = client.tool("pi_delegate", {"repository": repository, "base_ref": base_ref, "title": "Cancel private mock", "prompt": "CANCEL_MARKER_TEST", "mode": "review", "max_turns": 2})
        cancelled = client.tool("pi_cancel", {"job_id": pending["id"]})
        if not cancelled.get("cancellationRequested") or wait_job(client, pending["id"]) != "cancelled":
            raise RuntimeError("Pi cancellation did not complete")
        print("actual_pi_cancel=cancelled")
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--compose", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "internal-agent", "compose.yaml")))
    parser.add_argument("--repository", help="already imported private repository, for actual Pi mock round trip")
    parser.add_argument("--base-ref", help="committed SHA imported into that repository")
    parser.add_argument("--forbidden-ip", help="private controlled service address for direct TCP/UDP denial")
    parser.add_argument("--forbidden-container", help="task-owned service container with /tmp/forbidden-count")
    parser.add_argument("--missing-gateway-test", action="store_true", help="stop/restart task-owned gateway to prove MCP refuses startup")
    args = parser.parse_args()
    check = os.path.join(os.path.dirname(__file__), "check-internal-agent.py")
    print(call([sys.executable, check, "--project", args.project, "--compose", args.compose]))
    base = ["docker", "compose", "-f", args.compose, "-p", args.project, "exec", "-T", "agent"]
    print(call(base + ["node", "--input-type=module", "-e", "import {assertSandbox} from '/app/internal-agent/sandbox.mjs'; await assertSandbox(); console.log('sandbox=validated')"]))
    print(call(base + ["python3", "/app/internal-agent/probe-network.py"]))
    if args.forbidden_ip or args.forbidden_container:
        if not args.forbidden_ip or not args.forbidden_container:
            parser.error("--forbidden-ip and --forbidden-container are required together")
        print(call(base + ["python3", "/app/internal-agent/probe-network.py", args.forbidden_ip]))
        count = call(["docker", "exec", args.forbidden_container, "cat", "/tmp/forbidden-count"])
        if count != "0":
            raise RuntimeError("forbidden private service received traffic")
        print("forbidden_service_requests=0")
    print(call(base + ["python3", "/app/internal-agent/probe-socket.py"]))
    call(base[:-2] + ["-T", "-e", "HTTPS_PROXY=http://198.51.100.1:8080", "agent", "node", "/app/internal-agent/mcp.mjs"], expected=1, marker="forbidden environment variable")
    print("proxy_override=denied")
    if args.repository or args.base_ref:
        if not args.repository or not args.base_ref:
            parser.error("--repository and --base-ref are required together")
        pi_roundtrip(args.compose, args.project, args.repository, args.base_ref)
    if args.missing_gateway_test:
        control = ["docker", "compose", "-f", args.compose, "-p", args.project]
        call(control + ["stop", "gateway"])
        try:
            call(base + ["node", "/app/internal-agent/mcp.mjs"], expected=1, marker="gateway unavailable")
            print("missing_gateway_mcp_start=denied")
        finally:
            call(control + ["start", "gateway"])


if __name__ == "__main__":
    try:
        main()
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, RuntimeError, OSError, TimeoutError, KeyError, ValueError) as error:
        print(f"runtime boundary test failed: {error}", file=sys.stderr)
        sys.exit(1)
