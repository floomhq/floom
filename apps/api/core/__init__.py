"""Core building blocks for the WorkerOS API.

This package holds the cross-cutting pieces that the FastAPI application and its
routers are built from:

- ``config``    — environment-driven settings and static configuration constants.

It is intentionally dependency-light: modules here must not import ``main`` (the
application aggregator), so that routers and services can depend on ``core``
without creating an import cycle.
"""
