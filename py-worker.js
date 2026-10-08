/* Prof Python : moteur Python (Pyodide) exécuté dans un Web Worker */
let pyodide = null;
let inputResolve = null;
const decOut = new TextDecoder();
const decErr = new TextDecoder();

function post(type, data) { self.postMessage(Object.assign({ type }, data || {})); }

self.requestInput = function (prompt) {
  return new Promise(function (resolve) {
    inputResolve = resolve;
    post('input', { prompt: String(prompt) });
  });
};

const RUNNER = String.raw`
import ast, sys, traceback, linecache, builtins, json, io, types
import js

FILENAME = "main.py"
MAX_STEPS = 600

class _Tee(io.TextIOBase):
    def __init__(self, orig):
        self.orig = orig
        self.buf = []
    def write(self, s):
        s = str(s)
        self.buf.append(s)
        self.orig.write(s)
        if "\n" in s:
            self.orig.flush()
        return len(s)
    def flush(self):
        self.orig.flush()
    def value(self):
        return "".join(self.buf)

_state = {"queue": None, "tee": None}

def _sync_input(prompt=""):
    q = _state["queue"]
    if q is not None:
        v = q.pop(0) if q else ""
        sys.stdout.write(str(prompt) + str(v) + "\n")
        return str(v)
    raise RuntimeError("input() ne peut pas être utilisé à cet endroit (dans une méthode spéciale, un lambda ou un générateur). Place la saisie dans le programme principal ou dans une fonction simple.")

async def __dp_input(prompt=""):
    q = _state["queue"]
    if q is not None:
        v = q.pop(0) if q else ""
        sys.stdout.write(str(prompt) + str(v) + "\n")
        return str(v)
    sys.stdout.write(str(prompt))
    sys.stdout.flush()
    v = await js.requestInput(str(prompt))
    v = str(v)
    t = _state["tee"]
    if t is not None:
        t.buf.append(v + "\n")
    return v

builtins.input = _sync_input

# ---------- Transformation : rendre input() compatible avec le navigateur ----------
def _has_yield(fn):
    for n in ast.walk(fn):
        if isinstance(n, (ast.Yield, ast.YieldFrom)) and n is not fn:
            return True
    return False

def _callee(call):
    f = call.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None

def _own_calls(fn):
    names = set()
    stack = list(fn.body)
    while stack:
        n = stack.pop()
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        if isinstance(n, ast.Call):
            c = _callee(n)
            if c: names.add(c)
        stack.extend(ast.iter_child_nodes(n))
    return names

def _async_names(tree):
    funcs = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]
    ok = {}
    for f in funcs:
        bad = (f.name.startswith("__") and f.name.endswith("__")) or _has_yield(f)
        ok.setdefault(f.name, True)
        if bad:
            ok[f.name] = False
    calls = {f.name: set() for f in funcs}
    for f in funcs:
        calls[f.name] |= _own_calls(f)
    result = set()
    changed = True
    while changed:
        changed = False
        for name, cs in calls.items():
            if name in result or not ok.get(name):
                continue
            if "input" in cs or (cs & result):
                result.add(name)
                changed = True
    return result

class _Asyncify(ast.NodeTransformer):
    def __init__(self, names):
        self.names = names
        self.ctx = ["ok"]
    def _visit_in(self, node, c):
        self.ctx.append(c)
        self.generic_visit(node)
        self.ctx.pop()
        return node
    def visit_FunctionDef(self, node):
        if node.name in self.names:
            self.ctx.append("ok")
            self.generic_visit(node)
            self.ctx.pop()
            new = ast.AsyncFunctionDef(name=node.name, args=node.args, body=node.body,
                                       decorator_list=node.decorator_list, returns=node.returns,
                                       type_comment=getattr(node, "type_comment", None))
            if hasattr(node, "type_params"):
                new.type_params = node.type_params
            return ast.copy_location(new, node)
        return self._visit_in(node, "no")
    def visit_AsyncFunctionDef(self, node):
        return self._visit_in(node, "ok")
    def visit_Lambda(self, node):
        return self._visit_in(node, "no")
    def visit_ClassDef(self, node):
        return self._visit_in(node, "no")
    def visit_GeneratorExp(self, node):
        return self._visit_in(node, "no")
    def visit_Call(self, node):
        self.generic_visit(node)
        if self.ctx[-1] != "ok":
            return node
        c = _callee(node)
        if isinstance(node.func, ast.Name) and node.func.id == "input":
            node.func = ast.copy_location(ast.Name(id="__dp_input", ctx=ast.Load()), node.func)
            return ast.copy_location(ast.Await(value=node), node)
        if c in self.names:
            return ast.copy_location(ast.Await(value=node), node)
        return node

def _prepare(src):
    tree = ast.parse(src, FILENAME)
    if "input" in src:
        names = _async_names(tree)
        tree = _Asyncify(names).visit(tree)
        ast.fix_missing_locations(tree)
    return tree

# ---------- Erreurs ----------
def _error_info(e):
    tb = traceback.extract_tb(e.__traceback__)
    frames = [f for f in tb if f.filename == FILENAME]
    line = None
    if isinstance(e, SyntaxError) and e.filename == FILENAME:
        line = e.lineno
    elif frames:
        line = frames[-1].lineno
    text = "Traceback (most recent call last):\n" if frames else ""
    text += "".join(traceback.format_list(frames))
    text += "".join(traceback.format_exception_only(type(e), e))
    return {"ok": False, "etype": type(e).__name__, "emsg": str(e), "line": line, "tb": text}

# ---------- Radiographie (exécution pas à pas) ----------
class _TraceLimit(Exception):
    pass

def _short(v, depth=0):
    try:
        t = type(v)
        if depth < 2 and t.__module__ == "__main__" and hasattr(v, "__dict__") and not isinstance(v, type):
            r = t.__name__ + "(" + ", ".join(k + "=" + _short(x, depth + 1) for k, x in vars(v).items()) + ")"
        else:
            r = repr(v)
    except Exception:
        r = "<?>"
    if len(r) > 70:
        r = r[:67] + "..."
    return r

def _tname(v):
    if isinstance(v, types.FunctionType):
        return "fonction"
    if isinstance(v, type):
        return "classe"
    if isinstance(v, types.ModuleType):
        return "module"
    return type(v).__name__

def _vars(d, is_module):
    out = []
    for k, v in d.items():
        if k.startswith("__") or k in ("__dp_input",):
            continue
        if is_module and isinstance(v, types.ModuleType):
            out.append([k, "module " + v.__name__, "module"])
            continue
        if isinstance(v, (types.FunctionType, types.BuiltinFunctionType)):
            out.append([k, k + "()", "fonction"])
            continue
        if isinstance(v, type):
            out.append([k, "classe " + v.__name__, "classe"])
            continue
        out.append([k, _short(v), _tname(v)])
    return out

def _make_tracer(steps, tee):
    def tracer(frame, event, arg):
        if frame.f_code.co_filename != FILENAME:
            return None
        if event in ("line", "return", "exception"):
            if len(steps) >= MAX_STEPS:
                raise _TraceLimit()
            stack = []
            f = frame
            while f is not None and f.f_code.co_filename == FILENAME:
                is_mod = f.f_code.co_name == "<module>"
                stack.append({"name": "Programme principal" if is_mod else f.f_code.co_name + "()",
                              "vars": _vars(f.f_globals if is_mod else f.f_locals, is_mod)})
                f = f.f_back
            stack.reverse()
            step = {"line": frame.f_lineno, "event": event, "stack": stack, "out": len(tee.value())}
            if event == "return" and frame.f_code.co_name != "<module>":
                step["ret"] = _short(arg)
            steps.append(step)
        return tracer
    return tracer

# ---------- Exécution ----------
_repl_ns = {"__name__": "__main__", "__builtins__": builtins}

def reset_repl():
    _repl_ns.clear()
    _repl_ns.update({"__name__": "__main__", "__builtins__": builtins})

async def run(src, check_src="", mode="run", inputs_json="null"):
    inputs = json.loads(inputs_json)
    _state["queue"] = list(inputs) if isinstance(inputs, list) else None
    repl = mode == "repl"
    ns = _repl_ns if repl else {"__name__": "__main__", "__builtins__": builtins}
    ns["__dp_input"] = __dp_input
    linecache.cache[FILENAME] = (len(src), None, src.splitlines(True), FILENAME)
    old = sys.stdout
    tee = _Tee(old)
    _state["tee"] = tee
    sys.stdout = tee
    result = {"ok": True}
    steps = []
    try:
        try:
            tree = _prepare(src)
            last = None
            if repl and tree.body and isinstance(tree.body[-1], ast.Expr):
                last = ast.Expression(body=tree.body.pop().value)
                ast.copy_location(last, last.body)
                ast.fix_missing_locations(last)
            code = compile(tree, FILENAME, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
            if mode == "trace":
                sys.settrace(_make_tracer(steps, tee))
            try:
                coro = eval(code, ns)
                if coro is not None:
                    await coro
                if last is not None:
                    v = eval(compile(last, FILENAME, "eval", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), ns)
                    if hasattr(v, "__await__") and type(v).__name__ == "coroutine":
                        v = await v
                    if v is not None:
                        print(repr(v))
            finally:
                sys.settrace(None)
        except _TraceLimit:
            result = {"ok": True, "limit": True}
        except BaseException as e:
            if isinstance(e, SystemExit):
                result = {"ok": True}
            else:
                result = _error_info(e)
        if check_src and result.get("ok"):
            cns = dict(ns)
            out = tee.value()
            cns["__out__"] = out
            cns["__lignes__"] = out.strip().splitlines()
            cns["__source__"] = src
            def verifie(cond, msg="Ce n'est pas encore tout à fait ça."):
                if not cond:
                    raise AssertionError(msg)
            cns["verifie"] = verifie
            _state["queue"] = []
            sys.stdout = io.StringIO()
            try:
                exec(check_src, cns)
                result["check"] = {"ok": True}
            except AssertionError as e:
                result["check"] = {"ok": False, "msg": str(e) or "Le résultat ne correspond pas encore à la consigne."}
            except BaseException as e:
                result["check"] = {"ok": False, "msg": "Il manque quelque chose : " + type(e).__name__ + " : " + str(e)}
    finally:
        try:
            tee.flush()
        except Exception:
            pass
        sys.stdout = old
        sys.stdout.flush()
        _state["tee"] = None
        _state["queue"] = None
    if mode == "trace":
        result["steps"] = steps
        result["fullout"] = tee.value()
    return json.dumps(result)
`;

async function init() {
  try {
    post('status', { state: 'loading', text: 'Téléchargement de Python…', pct: 10 });
    const base = new URL('pyodide/', self.location.href).href;
    importScripts(base + 'pyodide.js');
    post('status', { state: 'loading', text: 'Démarrage de Python…', pct: 45 });
    pyodide = await loadPyodide({ indexURL: base, stdLibURL: base + "python_stdlib.wasm", fullStdLib: false });
    post('status', { state: 'loading', text: 'Préparation du cabinet…', pct: 85 });
    pyodide.setStdout({ write: function (buf) { post('out', { text: decOut.decode(buf, { stream: true }) }); return buf.length; } });
    pyodide.setStderr({ write: function (buf) { post('out', { text: decErr.decode(buf, { stream: true }), err: true }); return buf.length; } });
    await pyodide.runPythonAsync(RUNNER);
    const ver = pyodide.runPython('import sys; sys.version.split()[0]');
    post('ready', { version: ver });
  } catch (e) {
    post('fatal', { error: String((e && e.message) || e) });
  }
}

let busy = Promise.resolve();
self.onmessage = function (ev) {
  const m = ev.data || {};
  if (m.type === 'input') {
    if (inputResolve) { const r = inputResolve; inputResolve = null; r(m.value); }
    return;
  }
  if (m.type === 'run') {
    busy = busy.then(async function () {
      try {
        const run = pyodide.globals.get('run');
        const res = await run(m.code, m.check || '', m.mode || 'run', JSON.stringify(m.inputs === undefined ? null : m.inputs));
        run.destroy();
        post('done', { id: m.id, result: JSON.parse(res) });
      } catch (e) {
        post('done', { id: m.id, result: { ok: false, etype: 'ErreurInterne', emsg: String((e && e.message) || e), tb: String((e && e.message) || e) } });
      }
    });
    return;
  }
  if (m.type === 'reset-repl') {
    try { pyodide.runPython('reset_repl()'); } catch (e) {}
    post('repl-reset', {});
  }
};

init();
