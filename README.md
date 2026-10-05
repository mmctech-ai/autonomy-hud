# autonomy-hud

A Claude Code mod for the [`autonomy`](https://github.com/mmctech-ai/autonomy) plugin. While the `autonomy` skill is active, a right-hand pane shows the running step, the plan, decisions and a live timeline.

## Install

```
/plugin marketplace add mmctech-ai/autonomy-hud
/plugin install autonomy-hud@autonomy-hud
```

The pane opens by itself when `autonomy` runs and the terminal is at least 144 columns wide. Below that, run `/autonomy-hud`.

## Develop

```
claude plugin validate .
claude plugin test .
```
