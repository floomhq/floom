"""HTTP route groups for the WorkerOS API.

Each module here exposes an ``APIRouter`` that ``main`` mounts via
``app.include_router(...)``. Routers depend only on ``core``/``services`` and the
leaf modules (``db``, ``auth``, ``models``, ...), never on ``main``. Following the
established channels/* pattern, handlers import ``db``/``auth`` names lazily inside
the function body so the test suite's module-reload isolation keeps working.
"""
