"""FoxDen tests — workflow editing, status normalization, config, upload.
No live ComfyUI: backend.routers.foxden._comfy is monkeypatched."""

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routers import foxden

# API/prompt-format klein skeleton with the VERIFIED ids (work order
# amendment 2026-10-13). If the real file is reachable, tests also run on it.
KLEIN = {
    "743": {"class_type": "LoaderGGUF", "inputs": {"gguf_name": "flux-2-klein-9b-Q8_0.gguf"}},
    "744": {"class_type": "ClipLoaderGGUF", "inputs": {"clip_name": "Qwen3-8B-Q8_0.gguf", "type": "flux2"}},
    "668": {"class_type": "YANC.MultilineString", "inputs": {"string": "old prompt"}},
    "669": {"class_type": "CLIPTextEncode", "inputs": {"text": ["668", 0], "clip": ["744", 0]}},
    "670": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["669", 0]}},
    "735": {"class_type": "CFGGuider", "inputs": {"model": ["743", 0], "positive": ["669", 0], "negative": ["670", 0], "cfg": 1.0}},
    "730": {"class_type": "RandomNoise", "inputs": {"noise_seed": 1}},
    "729": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
    "731": {"class_type": "Flux2Scheduler", "inputs": {"steps": 4, "width": 1024, "height": 1024}},
    "732": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
    "733": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["730", 0], "guider": ["735", 0], "sampler": ["732", 0], "sigmas": ["731", 0], "latent_image": ["729", 0]}},
    "734": {"class_type": "VAEDecode", "inputs": {"samples": ["733", 0], "vae": ["737", 0]}},
    "737": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}},
    "736": {"class_type": "SaveImage", "inputs": {"images": ["734", 0], "filename_prefix": "foxden"}},
}

REAL = Path("/mnt/e/comfyui/user/default/workflows/klein_gen_basic.json")


def graphs():
    out = [pytest.param(KLEIN, id="fixture")]
    if REAL.is_file():
        out.append(pytest.param(json.loads(REAL.read_text()), id="real-klein"))
    return out


class L:
    def __init__(self, name, s=1.0):
        self.name, self.strength_model = name, s


@pytest.fixture
def env(tmp_path, monkeypatch):
    wf = tmp_path / "wf"
    wf.mkdir()
    (wf / "klein_gen_basic.json").write_text(json.dumps(KLEIN))
    lo = tmp_path / "loras"
    (lo / "_Flux").mkdir(parents=True)
    (lo / "a.safetensors").write_bytes(b"x")
    (lo / "_Flux" / "b.safetensors").write_bytes(b"x")
    (lo / "notes.txt").write_text("no")
    monkeypatch.setenv("ELLIEEDIT_COMFY_WORKFLOWS_DIR", str(wf))
    monkeypatch.setenv("ELLIEEDIT_COMFY_LORAS_DIR", str(lo))
    monkeypatch.setenv("ELLIEEDIT_FOXDEN_DATA", str(tmp_path / "data"))
    monkeypatch.setenv("ELLIEEDIT_COMFY_LOG", str(tmp_path / "comfy.log"))
    (tmp_path / "share").mkdir()                    # the parent share exists...
    monkeypatch.setenv("ELLIEEDIT_FOXDEN_DELIVERY_DIR",
                       str(tmp_path / "share" / "_FoxDen"))  # ...the leaf doesn't
    foxden._pending_meta.clear()
    foxden._logged.clear()
    foxden._delivered.clear()
    monkeypatch.setattr(foxden, "_last_reconcile", 0.0)
    return tmp_path


@pytest.fixture
def client(env):
    return TestClient(app)


# ---------------------------------------------------- workflow editing

@pytest.mark.parametrize("g", graphs())
def test_slot_discovery_matches_verified_ids(g):
    s = foxden.find_slots(g)
    assert s["prompt"] == ("668", "string")
    assert s["seed"] == "730"
    assert s["guider"] == "735" and s["model_src"] == "743"
    assert sorted(s["size"]) == ["729", "731"] and s["steps"] == ["731"]


@pytest.mark.parametrize("g", graphs())
def test_prompt_seed_size_steps(g):
    before = json.dumps(g, sort_keys=True)
    wf = foxden.apply_edits(g, "a fox", 42, 1024, 576, [], 8)
    assert wf["668"]["inputs"]["string"] == "a fox"
    assert wf["730"]["inputs"]["noise_seed"] == 42
    for nid in ("729", "731"):                     # BOTH literal sites
        assert (wf[nid]["inputs"]["width"], wf[nid]["inputs"]["height"]) == (1024, 576)
    assert wf["731"]["inputs"]["steps"] == 8
    assert wf["743"]["inputs"].get("gguf_name") == g["743"]["inputs"].get("gguf_name")
    assert json.dumps(g, sort_keys=True) == before  # input untouched
    foxden.validate_graph(wf)
    json.dumps(wf)


def test_size_requires_both_and_snaps():
    with pytest.raises(Exception):
        foxden.apply_edits(KLEIN, "x", 1, width=512)
    wf = foxden.apply_edits(KLEIN, "x", 1, 1000, 570)
    assert wf["729"]["inputs"]["width"] == 1008
    assert wf["729"]["inputs"]["height"] == 576


@pytest.mark.parametrize("g", graphs())
def test_single_lora_splice(g):
    wf = foxden.apply_edits(g, "x", 1, loras=[L("a.safetensors", 0.7)])
    new = [k for k, v in wf.items() if k not in g
           and v["class_type"] == "LoraLoaderModelOnly"]
    assert len(new) == 1
    n = wf[new[0]]
    assert n["class_type"] == "LoraLoaderModelOnly"
    assert n["inputs"]["model"] == ["743", 0]
    assert n["inputs"]["strength_model"] == 0.7
    assert wf["735"]["inputs"]["model"] == [new[0], 0]
    foxden.validate_graph(wf)


@pytest.mark.parametrize("g", graphs())
def test_chained_multi_lora_edges(g):
    wf = foxden.apply_edits(g, "x", 1, loras=[L("a"), L("b"), L("c")])
    new = sorted((k for k, v in wf.items() if k not in g
                  and v["class_type"] == "LoraLoaderModelOnly"), key=int)
    assert len(new) == 3
    assert wf[new[0]]["inputs"]["model"] == ["743", 0]
    assert wf[new[1]]["inputs"]["model"] == [new[0], 0]
    assert wf[new[2]]["inputs"]["model"] == [new[1], 0]
    assert wf["735"]["inputs"]["model"] == [new[2], 0]
    assert [wf[k]["inputs"]["lora_name"] for k in new] == ["a", "b", "c"]
    foxden.validate_graph(wf)


def test_validate_graph_catches_dangling_edge():
    bad = json.loads(json.dumps(KLEIN))
    bad["735"]["inputs"]["model"] = ["999", 0]
    with pytest.raises(ValueError):
        foxden.validate_graph(bad)


def test_workflow_loaded_fresh_each_request(env):
    p = env / "wf" / "klein_gen_basic.json"
    a = foxden.load_workflow("klein")
    changed = json.loads(json.dumps(KLEIN))
    changed["668"]["inputs"]["string"] = "edited on disk"
    p.write_text(json.dumps(changed))
    assert foxden.load_workflow("klein")["668"]["inputs"]["string"] == "edited on disk"
    assert a["668"]["inputs"]["string"] == "old prompt"


def test_ui_graph_format_rejected(env):
    (env / "wf" / "klein_gen_basic.json").write_text(json.dumps({"nodes": [], "links": []}))
    c = TestClient(app, raise_server_exceptions=False)
    assert c.post("/api/foxden/generate", json={"prompt": "x"}).status_code == 500


# ------------------------------------------------------------ generate

def fake_comfy(monkeypatch, routes):
    calls = []

    def f(path, data=None, headers=None, method=None, timeout=30):
        calls.append((path, data, headers, method))
        for prefix, resp in routes.items():
            if path.startswith(prefix):
                if isinstance(resp, Exception):
                    raise resp
                st, body = resp
                return st, (body if isinstance(body, bytes) else json.dumps(body).encode()), {}
        raise AssertionError(f"unmocked {path}")
    monkeypatch.setattr(foxden, "_comfy", f)
    return calls


def test_generate_submits_edited_graph(client, monkeypatch):
    calls = fake_comfy(monkeypatch, {"/prompt": (200, {"prompt_id": "pid-1", "node_errors": {}})})
    r = client.post("/api/foxden/generate", json={
        "prompt": "a fox", "seed": 7, "width": 576, "height": 1024,
        "loras": [{"name": "a.safetensors", "strength_model": 0.5}], "steps": 6})
    assert r.status_code == 200 and r.json()["prompt_id"] == "pid-1"
    sent = json.loads(calls[0][1])["prompt"]
    assert sent["668"]["inputs"]["string"] == "a fox"
    assert sent["731"]["inputs"]["steps"] == 6
    assert any(n["class_type"] == "LoraLoaderModelOnly" for n in sent.values())


def test_generate_node_errors_400(client, monkeypatch):
    fake_comfy(monkeypatch, {"/prompt": (400, {"error": {"message": "Prompt outputs failed validation"},
        "node_errors": {"743": {"class_type": "LoaderGGUF", "errors": [{"message": "Value not in list", "details": "gguf_name"}]}}})})
    r = client.post("/api/foxden/generate", json={"prompt": "x"})
    assert r.status_code == 400 and "node 743" in r.json()["detail"]
    # 200 with node_errors is still loud
    fake_comfy(monkeypatch, {"/prompt": (200, {"prompt_id": "p", "node_errors": {"1": {"class_type": "X", "errors": []}}})})
    assert client.post("/api/foxden/generate", json={"prompt": "x"}).status_code == 400


def test_generate_validation(client, monkeypatch):
    fake_comfy(monkeypatch, {})
    assert client.post("/api/foxden/generate", json={"prompt": "  "}).status_code == 400
    assert client.post("/api/foxden/generate", json={"prompt": "x", "workflow": "zzz"}).status_code == 400
    assert client.post("/api/foxden/generate", json={"prompt": "x", "loras": [{"name": "../../evil.safetensors"}]}).status_code == 400
    assert client.post("/api/foxden/generate", json={"prompt": "x", "loras": [{"name": "a.safetensors", "strength_model": 99}]}).status_code == 400


def test_generate_comfy_down_502(client, monkeypatch):
    fake_comfy(monkeypatch, {"/prompt": foxden.ComfyDown("refused")})
    assert client.post("/api/foxden/generate", json={"prompt": "x"}).status_code == 502


# ------------------------------------------------------------- status

IM = {"filename": "foxden_00001_.png", "subfolder": "", "type": "output"}


def hist(status_str="success", completed=True, outputs=None, messages=None):
    return {"status": {"status_str": status_str, "completed": completed, "messages": messages or []},
            "outputs": outputs if outputs is not None else {}}


def test_normalize_done_with_outputs():
    s = foxden.normalize_status("p", hist(outputs={"736": {"images": [IM]}}), None)
    assert s["state"] == "done" and len(s["outputs"]) == 1
    assert s["outputs"][0].startswith("/api/foxden/view?filename=foxden_00001_.png")


def test_normalize_done_empty_is_error_with_log_tail(env):
    (env / "comfy.log").write_text("\n".join(f"line {i}" for i in range(100)))
    s = foxden.normalize_status("p", hist(outputs={}), None)
    assert s["state"] == "error" and "NO output" in s["error"]
    assert s["log_tail"][-1] == "line 99" and len(s["log_tail"]) == 30
    # temp-only previews are not outputs either
    s = foxden.normalize_status("p", hist(outputs={"9": {"images": [dict(IM, type="temp")]}}), None)
    assert s["state"] == "error"


def test_normalize_error_and_passthrough():
    msg = [["execution_error", {"exception_message": "CUDA out of memory"}]]
    s = foxden.normalize_status("p", hist("error", True, messages=msg), None)
    assert s["state"] == "error" and "CUDA" in s["error"]
    q = {"queue_running": [[0, "p", {}]], "queue_pending": [[1, "q", {}]]}
    assert foxden.normalize_status("p", None, q)["state"] == "running"
    assert foxden.normalize_status("q", None, q)["state"] == "queued"
    assert foxden.normalize_status("p", hist(completed=False, status_str="running"), None)["state"] == "running"


def test_status_endpoint_logs_recent_once(client, env, monkeypatch):
    fake_comfy(monkeypatch, {
        "/prompt": (200, {"prompt_id": "pid-9", "node_errors": {}}),
        "/history/pid-9": (200, {"pid-9": hist(outputs={"736": {"images": [IM]}})}),
        "/view?": (200, b"PNGBYTES"),
    })
    client.post("/api/foxden/generate", json={"prompt": "a fox", "seed": 5})
    for _ in range(2):
        r = client.get("/api/foxden/status/pid-9").json()
        assert r["state"] == "done"
    lines = (env / "data" / "recent.jsonl").read_text().splitlines()
    assert len(lines) == 1
    e = json.loads(lines[0])
    assert e["prompt"] == "a fox" and e["seed"] == 5 and e["outputs"][0]["filename"] == IM["filename"]
    items = client.get("/api/foxden/recent").json()["items"]
    assert len(items) == 1 and items[0]["urls"][0].startswith("/api/foxden/view")


def test_status_unknown_young_is_queued_old_is_error(client, monkeypatch):
    fake_comfy(monkeypatch, {"/history/": (200, {}), "/queue": (200, {"queue_running": [], "queue_pending": []})})
    r = client.get("/api/foxden/status/never-seen").json()
    assert r["state"] == "error"
    foxden._pending_meta["fresh"] = {"submitted": __import__("time").time()}
    assert client.get("/api/foxden/status/fresh").json()["state"] == "queued"


# -------------------------------------------------------------- config

def test_config_scans_loras_and_reports_reachability(client, monkeypatch):
    fake_comfy(monkeypatch, {"/system_stats": (200, {"system": {}})})
    c = client.get("/api/foxden/config").json()
    assert c["loras"] == ["_Flux\\b.safetensors", "a.safetensors"]   # no notes.txt
    assert c["comfy_reachable"] is True
    assert {w["id"]: w["available"] for w in c["workflows"]} == {"klein": True, "krea2": False}


def test_config_comfy_unreachable_is_graceful(client, monkeypatch):
    fake_comfy(monkeypatch, {"/system_stats": foxden.ComfyDown("refused")})
    r = client.get("/api/foxden/config")
    assert r.status_code == 200 and r.json()["comfy_reachable"] is False


def test_config_missing_lora_dir(client, monkeypatch, env):
    monkeypatch.setenv("ELLIEEDIT_COMFY_LORAS_DIR", str(env / "nope"))
    fake_comfy(monkeypatch, {"/system_stats": (200, {})})
    assert client.get("/api/foxden/config").json()["loras"] == []


# ------------------------------------------------------ upload / view

def test_upload_proxy_roundtrip(client, monkeypatch):
    calls = fake_comfy(monkeypatch, {"/upload/image": (200, {"name": "cat.png", "subfolder": "", "type": "input"})})
    r = client.post("/api/foxden/upload", files={"image": ("cat.png", b"\x89PNG....", "image/png")})
    assert r.status_code == 200 and r.json()["name"] == "cat.png"
    path, data, headers, method = calls[0]
    assert method == "POST" and headers["Content-Type"].startswith("multipart/form-data")
    assert b'name="image"' in data and b"\x89PNG" in data


def test_upload_rejects_non_multipart_and_comfy_failure(client, monkeypatch):
    fake_comfy(monkeypatch, {"/upload/image": (500, {"error": "boom"})})
    assert client.post("/api/foxden/upload", content=b"x").status_code == 400
    r = client.post("/api/foxden/upload", files={"image": ("c.png", b"x", "image/png")})
    assert r.status_code == 400


def test_inputs_listing(client, monkeypatch):
    fake_comfy(monkeypatch, {"/object_info/LoadImage": (200, {"LoadImage": {"input": {"required": {"image": [["a.png", "b.png"], {}]}}}})})
    assert client.get("/api/foxden/inputs").json() == {"items": ["a.png", "b.png"]}


def test_view_proxy_and_jail(client, monkeypatch):
    fake_comfy(monkeypatch, {"/view?": (200, b"PNGDATA")})
    r = client.get("/api/foxden/view", params={"filename": "x.png"})
    assert r.status_code == 200 and r.content == b"PNGDATA"
    for bad in ({"filename": "../x.png"}, {"filename": "x.png", "subfolder": "../.."},
                {"filename": "x.png", "type": "weird"}, {"filename": "a/b.png"}):
        assert client.get("/api/foxden/view", params=bad).status_code == 400


def test_injects_saveimage_for_preview_only_graphs():
    """UI-exported baselines carry PreviewImage (temp outputs) — FoxDen must
    inject a real SaveImage so renders persist as type=output (2026-10-14)."""
    import copy
    g = copy.deepcopy(KLEIN)
    for k in [k for k, v in g.items() if v["class_type"] == "SaveImage"]:
        del g[k]
    g["738"] = {"class_type": "PreviewImage", "inputs": {"images": ["734", 0]}}
    wf = foxden.apply_edits(g, "x", 1)
    saves = [k for k, v in wf.items() if v["class_type"] == "SaveImage"]
    assert len(saves) == 1
    assert wf[saves[0]]["inputs"]["images"] == ["734", 0]
    assert wf[saves[0]]["inputs"]["filename_prefix"] == "foxden"
    foxden.validate_graph(wf)


# ------------------------------------------- Task 5: reconcile + delivery

def orphan_entry(pid, fname, prompt="a fox", seed=11, ts_ms=1_760_000_000_000,
                 loras=(), typ="output"):
    """A ComfyUI /history entry as a finished-but-unobserved render leaves it:
    the submitted graph rides along in entry['prompt'][2]."""
    graph = foxden.apply_edits(KLEIN, prompt, seed, 576, 1024, list(loras), 6)
    e = hist(outputs={"736": {"images": [{"filename": fname, "subfolder": "",
                                          "type": typ}]}},
             messages=[["execution_start", {"prompt_id": pid, "timestamp": ts_ms - 5000}],
                       ["execution_success", {"prompt_id": pid, "timestamp": ts_ms}]])
    e["prompt"] = [3, pid, graph, {}, ["736"]]
    return e


def seed_recent(env, *rows):
    d = env / "data"
    d.mkdir(parents=True, exist_ok=True)
    with (d / "recent.jsonl").open("a") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")


def fake_history(monkeypatch, hist_body, view_bytes=b"PNG", record=None):
    """Mock _comfy for /history + /view, recording (path, timeout)."""
    seen = record if record is not None else []

    def f(path, data=None, headers=None, method=None, timeout=30):
        seen.append((path, timeout))
        if path.startswith("/history"):
            return 200, json.dumps(hist_body).encode(), {}
        if path.startswith("/view?"):
            return 200, view_bytes, {}
        raise AssertionError(f"unmocked {path}")
    monkeypatch.setattr(foxden, "_comfy", f)
    return seen


def test_reconcile_adopts_orphans_and_skips_known(client, env, monkeypatch):
    known = {"prompt_id": "pid-known", "ts": 1_759_000_000, "prompt": "old",
             "outputs": [{"filename": "foxden_00001_.png", "subfolder": "", "type": "output"}]}
    backfilled = {"prompt_id": "manual-backfill", "ts": 1_759_500_000, "prompt": "rescued",
                  "outputs": [{"filename": "foxden_00002_.png", "subfolder": "", "type": "output"}]}
    seed_recent(env, known, backfilled)
    h = {
        "pid-known": orphan_entry("pid-known", "foxden_00001_.png"),
        "pid-rescued": orphan_entry("pid-rescued", "foxden_00002_.png"),  # same file, new pid
        "pid-orphan": orphan_entry("pid-orphan", "foxden_00003_.png",
                                   prompt="a fox in snow", seed=99,
                                   loras=[L("a.safetensors", 0.6)]),
        "pid-gallery": orphan_entry("pid-gallery", "ComfyUI_00007_.png"),   # not ours
        "pid-temp": orphan_entry("pid-temp", "foxden_00004_.png", typ="temp"),
        "pid-junk": {"status": {}, "outputs": {}},
    }
    fake_history(monkeypatch, h)
    r = client.post("/api/foxden/recent/reconcile").json()
    assert r["added"] == 1 and r["scanned"] == len(h)
    rows = [json.loads(x) for x in (env / "data" / "recent.jsonl").read_text().splitlines()]
    assert len(rows) == 3
    new = rows[-1]
    assert new["prompt_id"] == "pid-orphan" and new["reconciled"] is True
    assert new["outputs"] == [{"filename": "foxden_00003_.png", "subfolder": "", "type": "output"}]
    # metadata recovered from the graph ComfyUI kept, so Reuse settings works
    assert new["prompt"] == "a fox in snow" and new["seed"] == 99
    assert (new["width"], new["height"], new["steps"]) == (576, 1024, 6)
    assert new["loras"] == [{"name": "a.safetensors", "strength_model": 0.6}]
    assert new["ts"] == 1_760_000_000          # from execution_success, not "now"
    # running it again adds nothing (known now), and /recent shows it newest-first
    assert client.post("/api/foxden/recent/reconcile?force=true").json()["added"] == 0
    items = client.get("/api/foxden/recent").json()
    assert items["total"] == 3 and items["items"][0]["prompt_id"] == "pid-orphan"


def test_reconcile_metadata_falls_back_when_graph_unrecognizable(client, env, monkeypatch):
    e = orphan_entry("pid-x", "foxden_00009_.png")
    e["prompt"] = [3, "pid-x", {"1": {"class_type": "Mystery", "inputs": {}}}, {}, []]
    e2 = orphan_entry("pid-y", "foxden_00010_.png")
    del e2["prompt"]
    fake_history(monkeypatch, {"pid-x": e, "pid-y": e2})
    assert client.post("/api/foxden/recent/reconcile").json()["added"] == 2
    rows = [json.loads(x) for x in (env / "data" / "recent.jsonl").read_text().splitlines()]
    for r in rows:
        assert r["prompt"] == "(reconciled)" and r["seed"] is None and r["loras"] == []
        assert r["workflow"] is None and r["outputs"]


def test_reconcile_orders_by_completion_time_not_append_order(client, env, monkeypatch):
    seed_recent(env, {"prompt_id": "mid", "ts": 1_760_000_500, "prompt": "mid",
                      "outputs": [{"filename": "foxden_00005_.png", "subfolder": "", "type": "output"}]})
    fake_history(monkeypatch, {
        "late": orphan_entry("late", "foxden_00007_.png", ts_ms=1_760_001_000_000),
        "early": orphan_entry("early", "foxden_00003_.png", ts_ms=1_760_000_000_000)})
    client.post("/api/foxden/recent/reconcile")
    order = [i["prompt_id"] for i in client.get("/api/foxden/recent").json()["items"]]
    assert order == ["late", "mid", "early"]


def test_reconcile_delivers_copies_and_never_overwrites(client, env, monkeypatch):
    dest = env / "share" / "_FoxDen"
    assert not dest.exists()
    seed_recent(env, {"prompt_id": "k", "ts": 5, "prompt": "k",
                      "outputs": [{"filename": "foxden_00001_.png", "subfolder": "", "type": "output"}]})
    dest.mkdir()
    (dest / "foxden_00003_.png").write_bytes(b"ALREADY-THERE")   # collision: leave it
    seen = fake_history(monkeypatch, {
        "pid-3": orphan_entry("pid-3", "foxden_00003_.png"),
        "pid-4": orphan_entry("pid-4", "foxden_00004_.png")}, view_bytes=b"NEWPNG")
    r = client.post("/api/foxden/recent/reconcile").json()
    assert r["added"] == 2
    assert (dest / "foxden_00004_.png").read_bytes() == b"NEWPNG"      # new orphan copied
    assert (dest / "foxden_00001_.png").read_bytes() == b"NEWPNG"      # known render backfilled
    assert (dest / "foxden_00003_.png").read_bytes() == b"ALREADY-THERE"
    assert r["delivered"] == 2
    assert not list(dest.glob("*.part"))                               # atomic writes
    fetched = [p for p, _t in seen if p.startswith("/view?")]
    assert not any("foxden_00003_" in p for p in fetched)              # no needless fetch
    assert all("type=output" in p for p in fetched)                    # copy from output only


def test_normal_done_delivers_once(client, env, monkeypatch):
    seen = []

    def f(path, data=None, headers=None, method=None, timeout=30):
        seen.append(path)
        if path.startswith("/prompt"):
            return 200, json.dumps({"prompt_id": "pid-d", "node_errors": {}}).encode(), {}
        if path.startswith("/history/pid-d"):
            return 200, json.dumps({"pid-d": hist(outputs={"736": {"images": [IM]}})}).encode(), {}
        if path.startswith("/view?"):
            return 200, b"RENDER", {}
        raise AssertionError(path)
    monkeypatch.setattr(foxden, "_comfy", f)
    client.post("/api/foxden/generate", json={"prompt": "a fox"})
    for _ in range(3):
        assert client.get("/api/foxden/status/pid-d").json()["state"] == "done"
    assert (env / "share" / "_FoxDen" / IM["filename"]).read_bytes() == b"RENDER"
    assert sum(p.startswith("/view?") for p in seen) == 1             # once, not per poll


def test_delivery_unavailable_never_breaks_anything(client, env, monkeypatch):
    monkeypatch.setenv("ELLIEEDIT_FOXDEN_DELIVERY_DIR", str(env / "no-such-share" / "_FoxDen"))
    fake_history(monkeypatch, {"p": orphan_entry("p", "foxden_00003_.png")})
    r = client.post("/api/foxden/recent/reconcile")
    assert r.status_code == 200 and r.json()["added"] == 1 and r.json()["delivered"] == 0
    assert not (env / "no-such-share").exists()    # parent share is never conjured up


def test_reconcile_throttled_unless_forced(client, env, monkeypatch):
    seen = fake_history(monkeypatch, {})
    assert "skipped" not in client.post("/api/foxden/recent/reconcile").json()
    again = client.post("/api/foxden/recent/reconcile").json()
    assert again["skipped"] == "recent" and again["added"] == 0
    assert len([p for p, _ in seen if p.startswith("/history")]) == 1
    assert "skipped" not in client.post("/api/foxden/recent/reconcile?force=true").json()
    assert len([p for p, _ in seen if p.startswith("/history")]) == 2


def test_reconcile_busy_is_a_noop(client, monkeypatch):
    fake_history(monkeypatch, {})
    assert foxden._reconcile_lock.acquire(blocking=False)
    try:
        r = client.post("/api/foxden/recent/reconcile?force=true").json()
    finally:
        foxden._reconcile_lock.release()
    assert r["skipped"] == "busy"


def test_reconcile_survives_huge_history(client, env, monkeypatch):
    """Real history is 50MB+: the fetch must be bounded (max_items) with a long
    timeout, and a multi-MB body must still parse and find the orphan."""
    pad = {"1": {"class_type": "Pad", "inputs": {"blob": "x" * 2000}}}
    big = {f"junk-{i}": {"status": {"status_str": "success", "completed": True, "messages": []},
                         "outputs": {"9": {"images": [{"filename": f"ComfyUI_{i:05d}_.png",
                                                       "subfolder": "", "type": "output"}]}},
                         "prompt": [i, f"junk-{i}", pad, {}, []]}
           for i in range(3000)}
    big["pid-needle"] = orphan_entry("pid-needle", "foxden_00042_.png")
    assert len(json.dumps(big)) > 6_000_000
    seen = fake_history(monkeypatch, big)
    r = client.post("/api/foxden/recent/reconcile").json()
    assert r["added"] == 1 and r["scanned"] == 3001
    hist_calls = [(p, t) for p, t in seen if p.startswith("/history")]
    assert len(hist_calls) == 1
    path, timeout = hist_calls[0]
    assert "max_items=500" in path and timeout >= 120


def test_reconcile_failure_modes_are_loud(client, monkeypatch):
    fake_comfy(monkeypatch, {"/history": foxden.ComfyDown("refused")})
    assert client.post("/api/foxden/recent/reconcile?force=true").status_code == 502
    fake_comfy(monkeypatch, {"/history": (500, {"error": "boom"})})
    assert client.post("/api/foxden/recent/reconcile?force=true").status_code == 502
    fake_comfy(monkeypatch, {"/history": (200, [1, 2])})            # wrong shape
    assert client.post("/api/foxden/recent/reconcile?force=true").status_code == 502


def test_suspended_loras_never_reach_graph_but_are_recorded(client, env, monkeypatch):
    """Task 5 add.6: parked pins stay out of the submitted graph yet ride into
    recent.jsonl so Reuse settings can restore the tray."""
    calls = fake_comfy(monkeypatch, {
        "/prompt": (200, {"prompt_id": "pid-s", "node_errors": {}}),
        "/history/pid-s": (200, {"pid-s": hist(outputs={"736": {"images": [IM]}})}),
        "/view?": (200, b"PNGBYTES"),
    })
    r = client.post("/api/foxden/generate", json={
        "prompt": "a fox", "seed": 3,
        "loras": [{"name": "a.safetensors", "strength_model": 0.5}],
        "suspended_loras": [{"name": "_Flux\\b.safetensors", "strength_model": 1.25}]})
    assert r.status_code == 200, r.text
    sent = json.loads(calls[0][1])["prompt"]
    lora_nodes = [n for n in sent.values() if n["class_type"] == "LoraLoaderModelOnly"]
    assert len(lora_nodes) == 1                              # active only
    assert "b.safetensors" not in json.dumps(sent)           # parked one absent
    assert client.get("/api/foxden/status/pid-s").json()["state"] == "done"
    e = json.loads((env / "data" / "recent.jsonl").read_text().splitlines()[0])
    assert e["loras"][0]["strength_model"] == 0.5
    assert e["suspended_loras"] == [{"name": "_Flux\\b.safetensors", "strength_model": 1.25}]
    # old clients (no suspended_loras) still work and record an empty tray
    client.post("/api/foxden/generate", json={"prompt": "x", "seed": 1})
