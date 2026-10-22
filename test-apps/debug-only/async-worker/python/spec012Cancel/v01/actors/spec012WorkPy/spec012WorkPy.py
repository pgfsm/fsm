# Actor: spec012WorkPy — SPEC-012's end-to-end test (#545). Works for up to
# 5s, unless the gateway cancels it: then it stops before its side effect,
# writing the marker file at input["markerPath"].

MAX_CONCURRENCY = 4


def spec012WorkPy(input, token):
    marker_path = (input or {}).get("markerPath")
    token.wait(5)
    token.raise_if_cancelled()  # cancelled: stop here, no side effect
    if marker_path:
        with open(marker_path, "w") as f:
            f.write("python")
    return {"done": True, "language": "python"}
