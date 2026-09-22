# OGAD OSWorld harness benchmark

This adapter benchmarks the OGAD Computer Use harness. It does not compare or
train models. Every run pins the same Decision and recovery model. OSWorld
scores the behavior of the real `runElementTask` loop, including its structured
observations, factorized decisions, validation, no-progress detection,
verification, bounded writing, and recovery.

## Required access

Accept these gated Hugging Face datasets before setup:

- `xlangai/osworld_v2_tasks`
- `xlangai/osworld_v2_assets_gated`

Use the release tag `osworld-v2.1` for the OSWorld code, task classes, assets,
mock websites, and provider image.

## Fixed model inputs

The bridge uses these installed OGAD models by default:

- `decider-2b-q8_0.gguf` for bounded option selection
- `Qwen3.5-9B-Q4_K_M.gguf` for bounded text generation and recovery

Override their paths only to create a separate, named benchmark condition:

```bash
export OFFGRID_DECISION_MODEL=/absolute/path/to/decider.gguf
export OFFGRID_REASONER_MODEL=/absolute/path/to/reasoner.gguf
```

Keep both values unchanged when comparing harness revisions.

## OSWorld integration

Copy or link `ogad_harness_agent.py` into the OSWorld checkout under
`mm_agents/`, then instantiate `OGADHarnessAgent` from an OSWorld runner. The
environment must request the accessibility tree:

```python
agent = OGADHarnessAgent(desktop_root="/absolute/path/to/desktop")
env = DesktopEnv(
    provider_name="docker",
    action_space=agent.action_space,
    observation_type=agent.observation_type,
    require_a11y_tree=True,
    os_type="Ubuntu",
)
```

Use OSWorld's normal `lib_run_single.run_single_example` call. It will save the
official evaluator score and the OGAD response trace. Use `max_steps=200` for a
named local benchmark condition unless the public evaluation owner specifies a
different limit.

The bridge starts the local model servers once. The OSWorld runner executes each
returned `pyautogui` action inside the isolated Ubuntu environment. `DONE` and
`FAIL` use OSWorld's standard terminal actions.

## Result interpretation

Report these items together:

- OSWorld release: `osworld-v2.1`
- OGAD commit and dirty-state status
- Decision model file and SHA-256
- Recovery model file and SHA-256
- observation type: `a11y_tree`
- action space: `pyautogui`
- maximum steps
- task count and official OSWorld score
- success by task domain
- action count, recovery count, and elapsed time

Changing either model creates a different benchmark condition. Changing only
OGAD harness code while keeping the models and OSWorld release fixed measures a
harness change.
