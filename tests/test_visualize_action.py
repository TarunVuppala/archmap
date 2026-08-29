import tempfile
import unittest
from pathlib import Path

from packages.action.comment import render_comment
from packages.visualize import render_graph, to_mermaid


class VisualizeActionTests(unittest.TestCase):
    def payload(self):
        return {
            "ok": True,
            "nodes": [
                {"id": "svc:payments", "kind": "Service", "name": "Payments"},
                {"id": "api:POST:/payments", "kind": "API", "name": "POST /payments"},
            ],
            "edges": [{"id": "e1", "type": "EXPOSES", "from": "svc:payments", "to": "api:POST:/payments", "evidence": {"file": "service.py", "line": 1, "snippet": "post"}}],
            "paths": [], "counts": {"API": 1}, "risk": ["downstream"], "evidence_used": True,
        }

    def test_views_keep_same_query_data_and_select_renderer(self) -> None:
        graph = self.payload()
        map_view = render_graph(graph, "architecture")
        galaxy_view = render_graph(graph, "galaxy")
        self.assertEqual(map_view["nodes"], galaxy_view["nodes"])
        self.assertEqual(map_view["edges"], galaxy_view["edges"])
        self.assertEqual(map_view["renderer"], "react-flow")
        self.assertEqual(galaxy_view["renderer"], "cosmograph")

    def test_mermaid_and_pr_comment_are_bounded(self) -> None:
        graph = self.payload()
        mermaid = to_mermaid(graph)
        self.assertIn("flowchart LR", mermaid)
        self.assertIn("EXPOSES", mermaid)
        comment = render_comment(graph)
        self.assertIn("architecture-mapper", comment)
        self.assertIn("Impact counts", comment)


if __name__ == "__main__":
    unittest.main()
