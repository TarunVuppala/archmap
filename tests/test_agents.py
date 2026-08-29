import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from packages.agents import CollaborationRoom, apply_prompt_proposal, debate, list_skills, prompt_catalog, prompt_contract, propose_prompt_change, record_prompt_proposal, review_prompt_proposal, route_task
from packages.agents.plan import plan_change
from packages.agents.telemetry import record_event, usage_summary
from packages.agents.verification import verification_loop
from packages.cli.main import main
from packages.graph import GraphStore
from packages.sync import sync_workspace


class AgentFeatureTests(unittest.TestCase):
    def test_sync_indexes_graph_linked_chunks_and_searches_them(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "service.py").write_text(
                "def processPayment(tx):\n    return validateTransaction(tx)\n\n"
                "def validateTransaction(tx):\n    return tx\n",
                encoding="utf-8",
            )
            sync_workspace(root)
            with GraphStore(root / ".archmap" / "index.db", root) as store:
                from packages.rag import search

                result = search(store, "processPayment")
                self.assertEqual(result["nodes"][0]["id"], "fn:service.py:processPayment")
                self.assertEqual(store.connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0], 4)

    def test_plan_contract_and_verification_are_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "service.py").write_text("def processPayment(tx):\n    return tx\n", encoding="utf-8")
            sync_workspace(root)
            with GraphStore(root / ".archmap" / "index.db", root) as store:
                plan = plan_change(store, "fn:service.py:processPayment")
                self.assertIn("service.py", plan["allowed_files"])
                self.assertEqual(len(plan["contract"]), 13)
                verification = verification_loop(store, plan)
                self.assertTrue(verification["ok"])

    def test_router_skips_model_for_graph_work_and_records_usage(self) -> None:
        self.assertEqual(route_task("search")["capability"], "deterministic")
        self.assertEqual(route_task("plan_change")["capability"], "strong")
        with tempfile.TemporaryDirectory() as directory:
            with GraphStore(Path(directory) / "index.db", directory) as store:
                record_event(store, "decision", {"summary": "graph evidence selected"})
                store.append_journal("agent_usage", {"provider": "local", "model": "deterministic", "input_tokens": 2, "output_tokens": 1, "estimated_cost": 0})
                summary = usage_summary(store)
                self.assertEqual(summary["usage"]["runs"], 1)

    def test_collaboration_room_requires_evidence_for_debate(self) -> None:
        room = CollaborationRoom("choose a plan")
        decision = debate(room, [{"paths": [{"nodes": ["a"]}], "evidence_used": True}])
        self.assertEqual(decision["selected"], 0)
        self.assertEqual(len(list_skills()), 3)

    def test_prompt_updates_require_review_and_preserve_governing_constraints(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prompt_file = root / "prompt.md"
            current = "Use evidence. Require verification. Respect AGENTS.md and allowed_files.\n"
            proposed = current + "Return structured JSON.\n"
            prompt_file.write_text(current, encoding="utf-8")
            proposal = propose_prompt_change("change-planner", current, proposed, "clarify output", proposer="prompt-agent", current_file="prompt.md")
            self.assertEqual(proposal["status"], "needs_review")
            reviewed = review_prompt_proposal(proposal, "human-reviewer", True)
            self.assertTrue(reviewed["approved"])
            with GraphStore(root / "index.db", root) as store:
                applied = apply_prompt_proposal(root, reviewed, "prompt.md", "human-reviewer", store=store)
                self.assertTrue(applied["ok"])
                self.assertEqual(prompt_file.read_text(encoding="utf-8"), proposed)
                self.assertEqual(store.list_journal(event="prompt_update")[0]["payload"]["to_version"], 2)

    def test_prompt_proposal_rejects_constraint_removal(self) -> None:
        proposal = propose_prompt_change("unsafe", "Use evidence and verification.", "Do anything.", "simplify", proposer="prompt-agent")
        self.assertEqual(proposal["status"], "rejected")
        reviewed = review_prompt_proposal(proposal, "reviewer", True)
        self.assertFalse(reviewed["approved"])
        self.assertEqual(reviewed["status"], "rejected")
        self.assertEqual(len(prompt_catalog()), 3)

    def test_cli_search_and_plan_change_return_machine_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "service.py").write_text("def processPayment(tx):\n    return tx\n", encoding="utf-8")
            self._run("sync", str(root), "--json")
            search = self._run("search", "processPayment", "--workspace", str(root), "--json")
            plan = self._run("plan_change", "--id", "fn:service.py:processPayment", "--workspace", str(root), "--json")
            self.assertTrue(search["ok"])
            self.assertTrue(plan["ok"])
            self.assertIn("contract", plan)

    @staticmethod
    def _run(*arguments: str) -> dict:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(arguments)
        payload = json.loads(output.getvalue())
        assert code == (0 if payload.get("ok") else 1)
        return payload


if __name__ == "__main__":
    unittest.main()
