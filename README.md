# Salesforce AG Log Viewer for VS Code

A Visual Studio Code extension for viewing and managing Salesforce debug logs with advanced features like auto-refresh, filtering, and improved readability. 

Preview:
![image](https://github.com/user-attachments/assets/5b517e1c-812e-4bb7-b07b-3c162ab024ca)


## Features

### 📊 Interactive Log Viewer
- Real-time log monitoring with auto-refresh capability
- Sortable and customizable column layout
- Visual indicators for unread and downloading logs
- Search functionality by User/Operation for quick log filtering
- Opening and downloading logs from your Salesforce Org
- Option to clear all debug logs from your org

### 🔍 Advanced Log Analysis
- Filter logs by current user or view logs from all users
- Quick button to show only USER_DEBUG statements 
- Intelligent line number preservation when switching views between USER_DEBUG statements or all log.
- Size-optimized display (KB/MB) and duration formatting (ms/s)

### ⚡ Performance Features
- Efficient log caching to avoid redundant downloads
- GZIP compression support for large log files
- Background log processing for smooth UI experience
- Smart state preservation during auto-refresh when scrolling

### 🛠️ Configuration Options
- Customizable auto-refresh interval
- Current user only/all users toggle
- Customizable refresh intervals

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

### Getting Started
1. Connect to your Salesforce org through VS Code
2. Open the Salesforce AG Log Viewer panel from the Activity Bar
3. Your debug logs will automatically appear in the viewer


### Visual Indicators
- 🟢 Green dot: Unread log
- 🟡 Yellow dot: Downloading log
- ⚪ Gray dot: Read log

## Configuration Settings

- `salesforceAgLogViewer.autoRefresh`: Enable/disable automatic log refresh
- `salesforceAgLogViewer.refreshInterval`: Set the auto-refresh interval
- `salesforceAgLogViewer.currentUserOnly`: Show only current user's logs

## Future Improvements

   * Add an option to manage traces flags for a specific user

## Release Notes

Check the CHANGELOG.md FILE for details


## License

This project is licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0). This means:

* You can share and adapt the code
* You must give appropriate credit and indicate if changes were made
* You cannot use this software for commercial purposes

For the full license text, see the LICENSE file or visit https://creativecommons.org/licenses/by-nc/4.0/legalcode
