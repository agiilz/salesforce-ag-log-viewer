# Salesforce AG Log Viewer for VS Code

A Visual Studio Code extension for viewing and managing Salesforce debug logs with advanced features like auto-refresh, filtering, and improved readability. Inspired by the log feature in [@Vlocode](https://github.com/Codeneos/vlocode)

Preview:
![image](https://github.com/user-attachments/assets/61c10221-c794-4865-8fcb-9beb7f40a28b)

## Features

* **Real-time Log Updates**: Automatically refresh logs at configurable intervals
* **Smart Auto-Refresh**: Saves resources by only refreshing when the log panel is visible
* **Log Filtering**: Filter logs by user or operation
* **Unread Log Indicators**: Green dots indicate unread logs, changing to gray once viewed
* **Current User Focus**: Option to show only logs from the currently authenticated user or all organization logs
* **Grid View**: Clear, organized display of logs with sortable columns
* **Column Resizing**: Customize column widths to your preference
* **Truncation Handling**: Long text is truncated with tooltips showing full content
* **Batch Operations**: Delete multiple logs at once
* **Improved Log Loading**: Better handling of large logs with gzip compression

## Requirements

* Visual Studio Code 1.60.0 or higher
* Salesforce CLI
* Active Salesforce org connection

## Installation

1. Install Visual Studio Code 1.60.0 or higher
2. Install the Salesforce CLI
3. Install this extension from the VS Code marketplace
4. Authenticate with your Salesforce org inside VSCode

## Usage

1. Open the Salesforce Log Viewer panel from the bottom panel area
2. Use the toolbar buttons to:
   * Refresh logs manually
   * Toggle auto-refresh
   * Filter logs
   * Switch between all users/current user
   * Delete downloaded logs
   * Delete all logs from the current org
   * Configure options
3. Visual Indicators:
   * Green dot: Unread log
   * Yellow dot: Downloading log
   * Gray dot: Read log
   * Selected row: Clearly highlighted current selection

## Extension Settings

This extension contributes the following settings:

* `salesforceAgLogViewer.autoRefresh`: Enable/disable automatic log refresh
* `salesforceAgLogViewer.refreshInterval`: Set the auto-refresh interval (milliseconds)
* `salesforceAgLogViewer.currentUserOnly`: Show logs only for the current user

## Future Improvements

   * Add option to enable logs for a specific user from extension
   * Add an option to filter to show only DEBUG_LOG in the downloaded log

## Release Notes

### 1.0.9

Visual Indicator Improvements:
* Added yellow circle indicator while logs are being downloaded
* Fixed state preservation during auto-refresh
* Improved visual feedback when downloading and reading logs

### 1.0.6

UI and Performance Improvements:
* Added visual indicators for unread logs
* Improved grid performance
* Fixed flickering during auto-refresh
* Improved hover state persistence for the current selected log
* Better handling of large logs with gzip compression
* Consolidated output channels for cleaner logging
* Added cache managment for already downloaded logs to avoid downloading them again

### 1.0.5

User experience improvements:
* Fixed auto-scroll issue during auto-refresh to maintain scroll position
* Changed extension default location to bottom panel instead of activity bar
* Fixed duplicate trace flag creation issue
* Improved grid layout and responsiveness
* Added button to clear downloaded local log files

### 1.0.0

Initial release with core functionality:
* Auto-refreshing log viewer
* Log filtering and management
* Column customization and sorting
* Performance optimizations

## License

This project is licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0). This means:

* You can share and adapt the code
* You must give appropriate credit and indicate if changes were made
* You cannot use this software for commercial purposes

For the full license text, see the LICENSE file or visit https://creativecommons.org/licenses/by-nc/4.0/legalcode
