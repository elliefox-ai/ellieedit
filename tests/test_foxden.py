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
    foxden._pending_meta.clear()
    foxden._logged.clear()
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
