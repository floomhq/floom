"""Domain service helpers for the Floom API.

Modules here hold business-logic helpers that are shared across multiple route
groups (e.g. git workspace resolution, worker access control, context access).
They depend on ``core`` and the existing leaf modules (``db``, ``auth``,
``models``, ``git_ops``, ``worker_registry``, ...), but never on ``main`` — so
routers can import them without an import cycle.
"""
