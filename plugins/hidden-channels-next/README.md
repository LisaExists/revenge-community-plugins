# Hidden Channels (Next)

A Revenge Next port of [lioncat6/revenge-plugins](https://github.com/lioncat6/revenge-plugins) Hidden Channels.

## Features

- Permission-aware detection for channels hidden from the current account.
- Optional lock icon beside hidden channel names.
- Optional confirmation before opening a hidden channel.
- Channel topic, creation time, last message time, and last pin time in the confirmation dialog.
- Settings for the lock icon and confirmation prompt.

## Compatibility

Runtime behavior was confirmed by the maintainer on Discord Canary Android 350.4 (`35020400000000`) with the working v1.0.9 hook. Version 1.1.0 removes high-volume permission-call diagnostics while retaining the same `instead()` interception behavior and channel checks.

## Contributors

- Author: Lioncat6
- Contributors: cloudburst, Training Dummy, LisaExists
