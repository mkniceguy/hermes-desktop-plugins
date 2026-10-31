"""plex-status — agent half of the unified Hermes package.

This package contributes no agent tools or hooks: everything it exposes runs
in its own backend (`dashboard/plugin_api.py`, mounted at
``/api/plugins/plex-status/``) and in its desktop half
(`desktop/plugin.js`). The file exists as the package's importable entry
point so the plugin loader can register it cleanly.
"""


def register(ctx):
    """No agent-side registrations — see the module docstring."""
    return None
