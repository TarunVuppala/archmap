"""Source parsing for the graph sync pipeline.

The result deliberately contains plain dictionaries so it can be passed to the
SQLite graph, daemon, MCP, or CLI layers without an adapter-specific schema.
"""

from __future__ import annotations

import ast
import hashlib
import posixpath
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


PYTHON_SUFFIXES = {".py", ".pyw"}
TYPESCRIPT_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}


@dataclass
class ParseResult:
    """The stable parser output consumed by the graph upsert layer."""

    path: str
    mode: str
    nodes: list[dict[str, Any]] = field(default_factory=list)
    edges: list[dict[str, Any]] = field(default_factory=list)
    diagnostics: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "mode": self.mode,
            "nodes": self.nodes,
            "edges": self.edges,
            "diagnostics": self.diagnostics,
        }


def parse_file(path: str | Path, workspace_root: str | Path | None = None) -> ParseResult:
    """Parse one source file and return graph-ready nodes and edges.

    Unsupported languages still produce a File and Module node, allowing the
    sync pipeline to represent the file without pretending to understand it.
    """

    source_path = Path(path)
    root = Path(workspace_root).resolve() if workspace_root else None
    if root:
        if not source_path.is_absolute():
            source_path = root / source_path
        source_path = source_path.resolve()
        try:
            relative = source_path.relative_to(root).as_posix()
        except ValueError as error:
            raise ValueError("source file must be inside workspace_root") from error
    else:
        source_path = source_path.resolve()
        relative = source_path.name if source_path.parent == Path.cwd() else source_path.as_posix().lstrip("/")

    text = source_path.read_text(encoding="utf-8")
    return parse_source(relative, text)


def parse_source(relative: str, text: str) -> ParseResult:
    """Parse source text using the same IDs as :func:`parse_file`."""

    suffix = Path(relative).suffix.lower()
    if suffix in PYTHON_SUFFIXES:
        return _parse_python(relative, text)
    if suffix in TYPESCRIPT_SUFFIXES:
        return _parse_typescript(relative, text)
    return _parse_shallow(relative, text)


def _base_result(relative: str, mode: str) -> ParseResult:
    result = ParseResult(path=relative, mode=mode)
    _add_node(result, _node(f"file:{relative}", "File", Path(relative).name, path=relative))
    _add_node(result, _node(f"mod:{relative}", "Module", Path(relative).stem, path=relative))
    _add_edge(result, "CONTAINS", f"file:{relative}", f"mod:{relative}", relative, 1, Path(relative).name)
    return result


def _parse_shallow(relative: str, text: str) -> ParseResult:
    result = _base_result(relative, "shallow")
    for line_number, line in enumerate(text.splitlines(), 1):
        match = re.search(r"\b(?:from|import)\s+['\"]([^'\"]+)['\"]", line)
        if not match:
            continue
        target = match.group(1)
        target_id, kind = _import_target(relative, target)
        if kind == "Module":
            _add_node(result, _node(target_id, kind, target, path=target))
        else:
            _add_node(result, _node(target_id, kind, target))
        _add_edge(result, "IMPORTS", f"mod:{relative}", target_id, relative, line_number, line.strip())
    return result


def _parse_python(relative: str, text: str) -> ParseResult:
    result = _base_result(relative, "python-ast")
    lines = text.splitlines()
    try:
        tree = ast.parse(text, filename=relative)
    except SyntaxError as error:
        result.mode = "shallow"
        result.diagnostics.append(f"python syntax error at line {error.lineno}: {error.msg}")
        return _add_shallow_imports(result, relative, lines)

    parser = _PythonVisitor(result, relative, lines)
    parser.visit(tree)
    parser.resolve_calls()
    return result


class _PythonVisitor(ast.NodeVisitor):
    def __init__(self, result: ParseResult, relative: str, lines: list[str]):
        self.result = result
        self.relative = relative
        self.lines = lines
        self.module_id = f"mod:{relative}"
        self.scope: list[str] = []
        self.class_scope: list[str] = []
        self.symbol_stack: list[str] = []
        self.symbol_names: dict[str, str] = {}
        self.pending_calls: list[tuple[str, str, int, str]] = []

    @property
    def owner_id(self) -> str:
        return self.symbol_stack[-1] if self.symbol_stack else self.module_id

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self._add_import(alias.name, node.lineno, self._line(node.lineno))

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        prefix = "." * node.level
        target = f"{prefix}{node.module or ''}" or "."
        self._add_import(target, node.lineno, self._line(node.lineno))

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        qualified = ".".join([*self.scope, node.name])
        node_id = f"cls:{self.relative}:{qualified}"
        _add_node(
            self.result,
            _node(
                node_id,
                "Class",
                node.name,
                path=self.relative,
                start_line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno),
                signature=f"class {node.name}",
            ),
        )
        _add_edge(self.result, "CONTAINS", self.owner_id, node_id, self.relative, node.lineno, self._line(node.lineno))
        self.scope.append(node.name)
        self.class_scope.append(node.name)
        for statement in node.body:
            self.visit(statement)
        self.class_scope.pop()
        self.scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function(node, "Function" if not self.class_scope else "Method")

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function(node, "Function" if not self.class_scope else "Method")

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef, kind: str) -> None:
        qualified = ".".join([*self.scope, node.name])
        node_id = f"fn:{self.relative}:{qualified}"
        end_line = getattr(node, "end_lineno", node.lineno)
        _add_node(
            self.result,
            _node(
                node_id,
                kind,
                node.name,
                path=self.relative,
                start_line=node.lineno,
                end_line=end_line,
                signature=f"{('async ' if isinstance(node, ast.AsyncFunctionDef) else '')}def {node.name}(...)" ,
            ),
        )
        _add_edge(self.result, "CONTAINS", self.owner_id, node_id, self.relative, node.lineno, self._line(node.lineno))
        self.symbol_names.setdefault(node.name, node_id)
        self._record_calls(node_id, node.body)
        self._record_routes(node_id, node.decorator_list)

        self.scope.append(node.name)
        self.symbol_stack.append(node_id)
        for statement in node.body:
            self.visit(statement)
        self.symbol_stack.pop()
        self.scope.pop()

    def _record_calls(self, owner_id: str, body: list[ast.stmt]) -> None:
        collector = _CallCollector()
        for statement in body:
            collector.visit(statement)
        for name, line_number in collector.calls:
            self.pending_calls.append((owner_id, name, line_number, self._line(line_number)))

    def _record_routes(self, function_id: str, decorators: list[ast.expr]) -> None:
        for decorator in decorators:
            method, path = _python_route(decorator)
            if not method or not path:
                continue
            api_id = f"api:{method}:{path}"
            _add_node(self.result, _node(api_id, "API", f"{method} {path}", extra={"method": method, "path": path}))
            line_number = getattr(decorator, "lineno", 1)
            _add_edge(self.result, "EXPOSES", function_id, api_id, self.relative, line_number, self._line(line_number))

    def _add_import(self, target: str, line_number: int, snippet: str) -> None:
        target_id, kind = _import_target(self.relative, target)
        _add_node(self.result, _node(target_id, kind, target, path=target if kind == "Module" else None))
        _add_edge(self.result, "IMPORTS", self.owner_id, target_id, self.relative, line_number, snippet)

    def resolve_calls(self) -> None:
        for owner_id, name, line_number, snippet in self.pending_calls:
            target = self.symbol_names.get(name)
            if not target or target == owner_id:
                continue
            _add_edge(self.result, "CALLS", owner_id, target, self.relative, line_number, snippet)

    def _line(self, line_number: int) -> str:
        if 1 <= line_number <= len(self.lines):
            return self.lines[line_number - 1].strip()
        return ""


class _CallCollector(ast.NodeVisitor):
    def __init__(self):
        self.calls: list[tuple[str, int]] = []

    def visit_FunctionDef(self, _: ast.FunctionDef) -> None:
        return

    def visit_AsyncFunctionDef(self, _: ast.AsyncFunctionDef) -> None:
        return

    def visit_Lambda(self, _: ast.Lambda) -> None:
        return

    def visit_Call(self, node: ast.Call) -> None:
        name = _python_call_name(node.func)
        if name:
            self.calls.append((name, node.lineno))
        self.generic_visit(node)


def _parse_typescript(relative: str, text: str) -> ParseResult:
    result = _base_result(relative, "typescript-shallow")
    lines = text.splitlines()
    definitions: list[dict[str, Any]] = []
    class_ranges: list[tuple[str, int, int]] = []

    for index, line in enumerate(lines):
        line_number = index + 1
        class_match = re.search(r"\bclass\s+([A-Za-z_$][\w$]*)", line)
        if class_match:
            class_name = class_match.group(1)
            class_ranges.append((class_name, line_number, _brace_end(lines, index)))
            node_id = f"cls:{relative}:{class_name}"
            definitions.append({"id": node_id, "kind": "Class", "name": class_name, "start": line_number, "end": class_ranges[-1][2], "class": None})

        function_match = re.search(
            r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", line
        )
        arrow_match = re.search(
            r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>",
            line,
        )
        symbol_match = function_match or arrow_match
        if symbol_match:
            name = symbol_match.group(1)
            start = line_number
            definitions.append({"id": f"fn:{relative}:{name}", "kind": "Function", "name": name, "start": start, "end": _brace_end(lines, index), "class": None})

    for class_name, start, end in class_ranges:
        for index in range(start, min(end, len(lines)) + 1):
            line = lines[index - 1]
            method_match = re.match(r"^\s*(?:public|private|protected|static|async|get|set\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{", line)
            if not method_match or method_match.group(1) in {"if", "for", "while", "switch", "catch"}:
                continue
            name = method_match.group(1)
            definitions.append({"id": f"fn:{relative}:{class_name}.{name}", "kind": "Method", "name": name, "start": index, "end": _brace_end(lines, index - 1), "class": class_name})

    definitions = _unique_definitions(definitions)
    known_names = {definition["name"]: definition["id"] for definition in definitions}
    for definition in definitions:
        node_kind = definition["kind"]
        _add_node(
            result,
            _node(
                definition["id"],
                node_kind,
                definition["name"],
                path=relative,
                start_line=definition["start"],
                end_line=definition["end"],
                signature=f"{node_kind.lower()} {definition['name']}(...)" ,
            ),
        )
        parent_id = f"cls:{relative}:{definition['class']}" if definition["class"] else f"mod:{relative}"
        _add_edge(result, "CONTAINS", parent_id, definition["id"], relative, definition["start"], lines[definition["start"] - 1].strip())

    for index, line in enumerate(lines, 1):
        import_match = re.search(r"\bimport\s+(?:[^;]*?\s+from\s+)?['\"]([^'\"]+)['\"]", line)
        require_match = re.search(r"\brequire\(\s*['\"]([^'\"]+)['\"]\s*\)", line)
        target = (import_match or require_match).group(1) if (import_match or require_match) else None
        if target:
            target_id, kind = _import_target(relative, target)
            _add_node(result, _node(target_id, kind, target, path=target if kind == "Module" else None))
            _add_edge(result, "IMPORTS", f"mod:{relative}", target_id, relative, index, line.strip())

        route_match = re.search(r"\b(?:app|router|server)\.(get|post|put|patch|delete|head|options)\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*([A-Za-z_$][\w$]*)", line, re.IGNORECASE)
        if route_match:
            method, path, handler = route_match.groups()
            method = method.upper()
            api_id = f"api:{method}:{path}"
            _add_node(result, _node(api_id, "API", f"{method} {path}", extra={"method": method, "path": path}))
            owner = known_names.get(handler, f"mod:{relative}")
            _add_edge(result, "EXPOSES", owner, api_id, relative, index, line.strip())

    for definition in definitions:
        start = definition["start"] - 1
        end = min(definition["end"], len(lines))
        for index in range(start, end):
            line = lines[index]
            for name, target_id in known_names.items():
                if target_id == definition["id"] and re.search(rf"\b(?:function\s+|(?:const|let|var)\s+){re.escape(name)}\b", line):
                    continue
                if re.search(rf"\b{re.escape(name)}\s*\(", line):
                    _add_edge(result, "CALLS", definition["id"], target_id, relative, index + 1, line.strip())
    return result


def _add_shallow_imports(result: ParseResult, relative: str, lines: Iterable[str]) -> ParseResult:
    for line_number, line in enumerate(lines, 1):
        match = re.search(r"\b(?:from|import)\s+['\"]([^'\"]+)['\"]", line)
        if match:
            target = match.group(1)
            target_id, kind = _import_target(relative, target)
            _add_node(result, _node(target_id, kind, target, path=target if kind == "Module" else None))
            _add_edge(result, "IMPORTS", f"mod:{relative}", target_id, relative, line_number, line.strip())
    return result


def _import_target(relative: str, target: str) -> tuple[str, str]:
    if target.startswith(".") or target.startswith("/"):
        if target.startswith("."):
            levels = len(target) - len(target.lstrip("."))
            base = posixpath.dirname(relative)
            for _ in range(max(0, levels - 1)):
                base = posixpath.dirname(base)
            target = target.lstrip(".").lstrip("/")
            joined = posixpath.normpath(posixpath.join(base, target))
        else:
            joined = posixpath.normpath(target).lstrip("/")
        joined = re.sub(r"\.(?:py|pyw|ts|tsx|js|jsx|mjs|cjs)$", "", joined)
        return f"mod:{joined}", "Module"
    return f"ext:{target.split('.')[0]}", "External"


def _python_call_name(function: ast.expr) -> str | None:
    if isinstance(function, ast.Name):
        return function.id
    if isinstance(function, ast.Attribute):
        return function.attr
    return None


def _python_route(decorator: ast.expr) -> tuple[str | None, str | None]:
    if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
        return None, None
    method_name = decorator.func.attr.lower()
    if method_name == "route":
        method = "GET"
        for keyword in decorator.keywords:
            if keyword.arg == "methods" and isinstance(keyword.value, (ast.List, ast.Tuple)) and keyword.value.elts:
                first = keyword.value.elts[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    method = first.value.upper()
        path_node = decorator.args[0] if decorator.args else None
    elif method_name in HTTP_METHODS:
        method = method_name.upper()
        path_node = decorator.args[0] if decorator.args else None
    else:
        return None, None
    return method, path_node.value if isinstance(path_node, ast.Constant) and isinstance(path_node.value, str) else None


def _brace_end(lines: list[str], start_index: int) -> int:
    balance = 0
    saw_brace = False
    for index in range(start_index, len(lines)):
        balance += lines[index].count("{") - lines[index].count("}")
        saw_brace = saw_brace or "{" in lines[index]
        if saw_brace and balance <= 0:
            return index + 1
    return start_index + 1


def _unique_definitions(definitions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[str, dict[str, Any]] = {}
    for definition in definitions:
        unique.setdefault(definition["id"], definition)
    return list(unique.values())


def _node(node_id: str, kind: str, name: str, **fields: Any) -> dict[str, Any]:
    node = {"id": node_id, "kind": kind, "name": name}
    node.update({key: value for key, value in fields.items() if value is not None})
    return node


def _add_node(result: ParseResult, node: dict[str, Any]) -> None:
    if not any(existing["id"] == node["id"] for existing in result.nodes):
        result.nodes.append(node)


def _add_edge(result: ParseResult, edge_type: str, from_id: str, to_id: str, file: str, line: int, snippet: str) -> None:
    evidence = {"file": file, "line": line, "snippet": snippet or f"{from_id} -> {to_id}"}
    edge_id = "e_" + hashlib.sha1(f"{edge_type}\0{from_id}\0{to_id}".encode()).hexdigest()[:16]
    edge = {
        "id": edge_id,
        "type": edge_type,
        "from": from_id,
        "to": to_id,
        "evidence": evidence,
        "sources": ["parser"],
        "confidence": 1.0,
        "conflict": False,
    }
    if not any(existing["id"] == edge_id for existing in result.edges):
        result.edges.append(edge)
