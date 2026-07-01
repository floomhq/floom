# Agent quality eval fixtures

This directory contains launch-critical golden fixtures for Floom's workspace
agent and worker-author behavior. The fixtures are intentionally deterministic:
they describe the user prompt, expected tool choices, forbidden tool choices,
and assertions that a model-scored evaluator or replay harness can enforce.

The current unit test validates fixture shape so future CI can add a live LLM
or transcript replay gate without first inventing the corpus.

