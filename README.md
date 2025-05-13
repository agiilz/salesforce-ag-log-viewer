# Salesforce AG Log Viewer for VS Code

A Visual Studio Code extension for viewing and managing Salesforce debug logs with advanced features like auto-refresh, filtering, and improved readability.

## Features

* **Real-time Log Updates**: Automatically refresh logs at configurable intervals
* **Smart Auto-Refresh**: Saves resources by only refreshing when the log panel is visible
* **Log Filtering**: Filter logs by user or operation
* **Current User Focus**: Option to show only logs from the currently authenticated user
* **Grid View**: Clear, organized display of logs with sortable columns
* **Column Resizing**: Customize column widths to your preference
* **Truncation Handling**: Long text is truncated with tooltips showing full content
* **Batch Operations**: Delete multiple logs at once
* **Performance Optimized**: Efficient handling of large log volumes

## Requirements

* Visual Studio Code 1.60.0 or higher
* Salesforce CLI
* Active Salesforce org connection

## Installation

1. Install Visual Studio Code 1.60.0 or higher
2. Install the Salesforce CLI
3. Install this extension from the VS Code marketplace
4. Authenticate with your Salesforce org using `sf org login web`

## Usage

1. Open the Salesforce Log Viewer panel from the activity bar
2. Use the toolbar buttons to:
   * Refresh logs manually
   * Toggle auto-refresh
   * Filter logs
   * Switch between all users/current user
   * Delete logs
   * Configure options

## Extension Settings

This extension contributes the following settings:

* `salesforceAgLogViewer.autoRefresh`: Enable/disable automatic log refresh
* `salesforceAgLogViewer.refreshInterval`: Set the auto-refresh interval (milliseconds)
* `salesforceAgLogViewer.currentUserOnly`: Show logs only for the current user

## Known Issues

None at this time.

## Release Notes

### 1.0.0

Initial release with core functionality:
* Auto-refreshing log viewer
* Log filtering and management
* Column customization
* Performance optimizations

## License

This project is licensed under the MIT License - see the LICENSE file for details.