# Actor: checkBureau

# How many invokes of this actor one worker runs at once. Above 1, the
# handler runs on several threads at once and must be thread-safe (no
# unguarded shared state, only thread-safe clients). Delivery is
# at-least-once, so the handler must also be idempotent: the same invoke can
# arrive more than once.
MAX_CONCURRENCY = 5


def checkBureau(input):
    # TODO: implement actor logic
    return {"input": input, "msg": "checkBureau actor invoked by python"}
