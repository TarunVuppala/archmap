import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from packages.cli.main import main


class SyncCliTests(unittest.TestCase):
    def test_sync_is_incremental_and_impact_uses_same_json_shape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "service.py"
            source.write_text(
                "def validateTransaction(tx):\n    return tx\n\n"
                "def processPayment(tx):\n    return validateTransaction(tx)\n",
                encoding="utf-8",
            )
            first = self._run("sync", str(root), "--json")
            self.assertTrue(first["ok"])
            self.assertEqual(first["counts"]["changed_files"], 1)

            second = self._run("sync", str(root), "--json")
            self.assertTrue(second["ok"])
            self.assertEqual(second["counts"]["changed_files"], 0)
            self.assertEqual(second["counts"]["skipped_files"], 1)

            impact = self._run(
                "impact",
                "fn:service.py:validateTransaction",
                "--workspace",
                str(root),
                "--json",
            )
            self.assertTrue(impact["ok"])
            self.assertIn("fn:service.py:processPayment", {node["id"] for node in impact["nodes"]})
            self.assertIn("paths", impact)
            self.assertTrue(impact["evidence_used"])

            source.write_text("def processPayment(tx):\n    return tx\n", encoding="utf-8")
            third = self._run("sync", str(root), "--json")
            self.assertEqual(third["counts"]["changed_files"], 1)
            removed = self._run(
                "impact",
                "fn:service.py:validateTransaction",
                "--workspace",
                str(root),
                "--json",
            )
            self.assertFalse(removed["ok"])

    def test_diff_without_git_returns_structured_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = main(("diff", "--workspace", directory, "--json"))
            self.assertEqual(code, 2)
            payload = json.loads(output.getvalue())
            self.assertFalse(payload["ok"])
            self.assertIn("error", payload)

    def test_docs_command_uses_local_cache_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "requirements.txt").write_text("requests==2.31.0\n", encoding="utf-8")
            payload = self._run("docs", "requests", "--workspace", str(root), "--no-fetch", "--json")
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["docs"][0]["status"], "available")

    def test_graph_mermaid_and_health_commands_share_index(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "service.py").write_text("def processPayment(tx):\n    return tx\n", encoding="utf-8")
            self._run("sync", str(root), "--json")
            graph = self._run("graph", "--workspace", str(root), "--format", "mermaid", "--json")
            health = self._run("health", "--workspace", str(root), "--json")
            self.assertTrue(graph["ok"])
            self.assertIn("flowchart LR", graph["mermaid"])
            self.assertTrue(health["ok"])

    @staticmethod
    def _run(*arguments: str) -> dict:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(arguments)
        payload = json.loads(output.getvalue())
        if payload.get("ok"):
            assert code == 0
        return payload


if __name__ == "__main__":
    unittest.main()
