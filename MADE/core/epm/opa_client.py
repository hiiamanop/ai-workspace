import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any


class OpaEvaluationError(RuntimeError):
    pass


def evaluate_hard_constraints(input_doc: dict[str, Any], policies_dir: Path) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(input_doc, f)
        input_path = f.name

    try:
        proc = subprocess.run(
            [
                "opa", "eval",
                "--format", "json",
                "--input", input_path,
                "--data", str(policies_dir),
                "data.made.hard",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        raise OpaEvaluationError(f"opa eval failed to run: {exc}") from exc
    finally:
        Path(input_path).unlink(missing_ok=True)

    if proc.returncode != 0:
        raise OpaEvaluationError(f"opa eval failed: {proc.stderr.strip()}")

    try:
        parsed = json.loads(proc.stdout)
        value = parsed["result"][0]["expressions"][0]["value"]
    except (KeyError, IndexError, json.JSONDecodeError) as exc:
        raise OpaEvaluationError(f"unexpected opa output: {proc.stdout}") from exc

    if "allow" not in value:
        raise OpaEvaluationError(f"opa result missing 'allow' key: {value}")

    return {
        "allow": value["allow"],
        "deny_reasons": sorted(value.get("deny", [])),
        "requires_human_approval": len(value.get("require_approval", [])) > 0,
        "approval_reasons": sorted(value.get("require_approval", [])),
    }
