# Salesforce AG Log Viewer for VS Code

A Visual Studio Code extension for viewing and managing Salesforce debug logs with advanced features like auto-refresh, filtering, and improved readability. 

## Features

### 📊 Interactive Log Viewer
- Real-time log monitoring with auto-refresh capability
- Sortable and customizable column layout
- Visual indicators for unread and downloading logs
- Search by user/operation, including optional regular expressions
- Filters for user, status, date, duration, size, exceptions, and favorites
- Load older logs in bounded 100-record increments
- Export the filtered log list to CSV and compare two logs in VS Code's diff editor
- Opening and downloading logs from your Salesforce Org
- Option to clear all debug logs from your org
- Filter logs displayed by current user or view logs from all users

![image](https://github.com/user-attachments/assets/73e03bac-09c0-4f5b-9e97-be263e9587df)

### 📝 Log Details & USER_DEBUG Filtering
- Open any Salesforce log in a detailed view with advanced navigation
- Instantly filter to show only USER_DEBUG statements for focused debugging
- Search within log details for specific events, operations, or debug output
- Collapse and expand method blocks for easier navigation of large logs
- Execution summary for debug, SOQL, DML, method, and exception events
- Export the raw log or its summary as JSON
  
![Captura de pantalla 2025-06-18 112620](https://github.com/user-attachments/assets/716e1df9-3786-4f35-bd4e-c2db7ba09d38)

### ⚡ Performance Features
- Efficient log caching to avoid redundant downloads
- GZIP compression support for large log files
- Background log processing for smooth UI experience
- Smart state preservation during auto-refresh when scrolling
- Configurable local cache retention by age and file count
- Large-log warning with a first-1,000-line in-memory preview option

### 🏳️ Trace Flag Management
- View and clear all expired trace flags from your org with a single click
- Set trace flags for specific users directly from the log viewer
- Automatically manage trace flag expiration intervals for continuous log capture

### 🛠️ Configuration Options
- Enable or disable automatic log refresh
- Set the auto-refresh interval (milliseconds)
- Show only current user's logs or all users' logs
- Set expiration interval for Salesforce trace flags (minutes)
- Show the output channel when the extension starts (for debugging purposes)

Extension Preview:
![Captura de pantalla 2025-06-18 180744](https://github.com/user-attachments/assets/5b0bbb9e-c548-4065-96b2-5c508f968a93)


## Requirements

* Visual Studio Code 1.100.0 or higher
* Salesforce CLI
* Active Salesforce org connection

## Installation

1. Install Visual Studio Code 1.100.0 or higher
2. Install the Salesforce CLI
3. Install this extension from the VS Code marketplace
4. Authenticate with your Salesforce org inside VSCode

## Usage

### Getting Started
1. Connect to your Salesforce org through VS Code
2. Open the Salesforce AG Log Viewer panel from the Activity Bar
3. Your debug logs will automatically appear in the viewer
4. Click the button "Log Details" in the top right corner


### Visual Indicators
- 🟢 Green dot: Unread log
- 🟡 Yellow dot: Downloading log
- ⚪ Gray dot: Read log

## Configuration Settings

The extension provides several settings to customize your log viewing experience. You can configure these in your VS Code settings (search for "Salesforce AG Log Viewer").

- `salesforceAgLogViewer.autoRefresh`: Enable or disable automatic log refresh in the viewer panel.
- `salesforceAgLogViewer.refreshInterval`: Set the interval (in milliseconds) for auto-refreshing logs when enabled. Minimum: 1000ms. Default: 5000ms.
- `salesforceAgLogViewer.currentUserOnly`: If enabled, only logs belonging to the currently authenticated Salesforce user are shown. Disable to view logs from all users.
- `salesforceAgLogViewer.traceFlagExpirationInterval`: Expiration interval (in minutes) for Salesforce trace flags. Minimum: 5, Default: 15.
- `salesforceAgLogViewer.showOutputOnStart`: Show the Salesforce AG Log Viewer output channel when the extension starts. Default: true.
- `salesforceAgLogViewer.largeLogWarningMb`: Ask before downloading uncached logs at or above this size. Default: 5 MB.
- `salesforceAgLogViewer.cacheMaxFiles`: Maximum downloaded logs retained in the workspace cache. Default: 100.
- `salesforceAgLogViewer.cacheRetentionDays`: Maximum downloaded-log cache age. Default: 14 days.

Salesforce Apex logs use the included syntax highlighting automatically. In remote workspaces, install and authenticate the Salesforce CLI in the remote environment where the extension runs.

## Release Notes

Check the CHANGELOG.md FILE for details


## License

This project is licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0). This means:

* You can share and adapt the code
* You must give appropriate credit and indicate if changes were made
* You cannot use this software for commercial purposes

For the full license text, see the LICENSE file or visit https://creativecommons.org/licenses/by-nc/4.0/legalcode
